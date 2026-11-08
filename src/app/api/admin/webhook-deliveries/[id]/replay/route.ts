import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { deliverWebhookDelivery, WEBHOOK_TEST_EVENT } from "@/lib/webhook-delivery";
import type { AdminReplayData } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/webhook-deliveries/[id]/replay — re-attempt a delivery FOR REAL.
//
// C2.8 (Phase 2.3): this operation used to FORGE delivery success (it wrote
// status:"success", responseCode:200 without any HTTP request — the F-25
// remediation had at least restricted that to superadmin). Replays now go
// through the REAL delivery engine (lib/webhook-delivery.ts): the row is
// force-claimed (failed → pending), the endpoint is POSTed with a signed
// payload via the SSRF-guarded fetcher, and the outcome recorded is whatever
// the endpoint ACTUALLY answered — success is only written for a real 2xx.
// Still superadmin-only (`settings.manage`): a replay bypasses the backoff
// schedule, which makes it an operational instrument, not a data fix.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("settings.manage");
  const { id } = await ctx.params;

  const delivery = await db.webhookDelivery.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      attempts: true,
      event: true,
      responseCode: true,
      endpoint: {
        select: { id: true, url: true, isActive: true, eventsJson: true, store: { select: { name: true } } },
      },
    },
  });
  if (!delivery) throw new ApiError(404, "NOT_FOUND", "Webhook delivery not found");
  if (delivery.status === "success") {
    throw new ApiError(409, "ALREADY_DELIVERED", "This delivery already succeeded (terminal state) — nothing to replay");
  }
  if (!delivery.endpoint.isActive) {
    throw new ApiError(409, "ENDPOINT_INACTIVE", "The endpoint is paused — re-enable it before replaying");
  }
  const subscribed = parseJson<string[]>(delivery.endpoint.eventsJson, []);
  if (delivery.event !== WEBHOOK_TEST_EVENT && !subscribed.includes(delivery.event)) {
    throw new ApiError(409, "EVENT_UNSUBSCRIBED", "The endpoint no longer subscribes to this event");
  }

  // Real attempt NOW (force claim: skips the backoff due-check, revives a
  // terminal `failed` row to pending for this attempt).
  const outcome = await deliverWebhookDelivery(id, { trigger: "replay", force: true });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "webhook_delivery.replay",
    entityType: "webhook_delivery",
    entityId: id,
    before: {
      status: delivery.status,
      attempts: delivery.attempts,
      responseCode: delivery.responseCode,
      event: delivery.event,
      endpointUrl: delivery.endpoint.url,
    },
    after: {
      // the REAL outcome of the real HTTP attempt (never a forged 200)
      status: outcome.status,
      attempts: outcome.attempts,
      responseCode: outcome.responseCode,
      error: outcome.error,
      nextRetryAt: outcome.nextRetryAt,
    },
  });

  const payload: AdminReplayData = {
    replayed: outcome.attempted,
    deliveryId: id,
    status: outcome.status,
    attempts: outcome.attempts,
    responseCode: outcome.responseCode,
    error: outcome.error,
    responseBody: outcome.responseBody,
    durationMs: outcome.durationMs,
    nextRetryAt: outcome.nextRetryAt,
    endpointUrl: delivery.endpoint.url,
    storeName: delivery.endpoint.store.name,
  };
  return ok(payload);
});

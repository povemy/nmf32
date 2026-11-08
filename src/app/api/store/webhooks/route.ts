import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { randomToken } from "@/lib/password";
import { parseJson } from "@/lib/json";
import type { SellerWebhookEndpoint, SellerWebhookDelivery, SellerWebhookBody, SellerWebhookCreateData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

const DEFAULT_EVENTS = ["order.paid", "order.shipped", "order.refunded"];

/** D1 — mask a signing secret for list/display responses. Never returns the
 *  full value: long secrets keep first 6 + last 4 chars, short ones collapse
 *  to bullets. The plaintext secret is revealed exactly once (create/rotate). */
function maskSecret(secret: string): string {
  if (secret.length > 14) return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
  return "•••••";
}

// GET /api/store/webhooks — endpoints with their last 10 deliveries.
// D1: secrets are masked; the plaintext is only ever returned by POST
// (create) and POST [id]/rotate — each exactly once, at generation time.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const endpoints = await db.webhookEndpoint.findMany({
    where: { storeId: store.id },
    include: { deliveries: { orderBy: { createdAt: "desc" }, take: 10 } },
    orderBy: { createdAt: "desc" },
  });
  const payload: SellerWebhookEndpoint[] = endpoints.map((ep) => ({
    id: ep.id,
    url: ep.url,
    secretMasked: maskSecret(ep.secret),
    events: parseJson<string[]>(ep.eventsJson, []),
    isActive: ep.isActive,
    createdAt: ep.createdAt.toISOString(),
    deliveries: ep.deliveries.map<SellerWebhookDelivery>((d) => ({
      id: d.id,
      endpointId: d.endpointId,
      event: d.event,
      payloadJson: d.payloadJson,
      status: d.status,
      attempts: d.attempts,
      responseCode: d.responseCode,
      lastAttemptAt: d.lastAttemptAt ? d.lastAttemptAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    })),
  }));
  return ok(payload);
});

// POST /api/store/webhooks {url, events: [...]}
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as SellerWebhookBody;

  const url = String(body.url ?? "").trim();
  if (!/^https?:\/\/.+/.test(url)) {
    throw new ApiError(400, "VALIDATION", "url must be a valid http(s) URL");
  }
  const events = Array.isArray(body.events) && body.events.length > 0
    ? body.events.map((e) => String(e))
    : DEFAULT_EVENTS;

  const endpoint = await db.webhookEndpoint.create({
    data: {
      storeId: store.id,
      url,
      secret: `whsec_${randomToken(12)}`,
      eventsJson: JSON.stringify(events),
      isActive: true,
    },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "webhook.created",
    entityType: "webhook_endpoint",
    entityId: endpoint.id,
    meta: { url, events },
  });

  const payload: SellerWebhookCreateData = {
    id: endpoint.id,
    url: endpoint.url,
    secret: endpoint.secret,
    events: parseJson<string[]>(endpoint.eventsJson, []),
    isActive: endpoint.isActive,
    deliveries: [],
  };
  return ok(payload, { status: 201 });
});

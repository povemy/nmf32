import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { latestAttemptLogs, webhookNextRetryAt, MAX_WEBHOOK_ATTEMPTS } from "@/lib/webhook-delivery";

export const dynamic = "force-dynamic";

// GET /api/admin/webhook-deliveries?status=&endpointId=&event=&page=&size=
// (RBAC logs.view — superadmin / ops / finance, the observability tier that
// already reads audit-logs; the heavier replay action stays superadmin-only
// under settings.manage at /api/admin/webhook-deliveries/[id]/replay.)
//
// C2.8 (Phase 2.3) — admin visibility for REAL webhook delivery. Before the
// remediation, WebhookDelivery rows were written with forged success
// (status:"success", responseCode:200, no HTTP request), so any list built on
// them would have displayed fiction. This listing shows the honest state
// machine (pending = queued/retrying, success = a real 2xx was received,
// failed = attempt budget exhausted / unsubscribed / stale) plus:
//   • attempts + lastAttemptAt + the DERIVED next retry time
//     (lastAttemptAt + backoff[attempts] — schedule in lib/webhook-delivery.ts);
//   • lastError / lastResponse (body snippet) from the per-attempt audit table
//     WebhookDeliveryAttempt — NEW table whose migration
//     (20261108000000_phase23_webhook_delivery) is authored but NOT applied in
//     this environment, so the lookup degrades gracefully to the delivery
//     columns (responseCode stays authoritative either way).
// Max 50 rows/page (bounded admin surface); ordered createdAt desc to match
// the (status, createdAt) index used by the retry sweep.
// UI note: no dedicated admin panel was built for this (per the task's
// "minimal" instruction) — this endpoint is the observability contract; the
// cron GET /api/cron/webhook-delivery complements it with backlog + lastRun.
export const GET = handle(async (req: NextRequest) => {
  await requireCap("logs.view");
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url, 50);
  const status = url.searchParams.get("status");
  const endpointId = url.searchParams.get("endpointId");
  const event = url.searchParams.get("event");

  const where: Prisma.WebhookDeliveryWhereInput = {
    ...(status ? { status } : {}),
    ...(endpointId ? { endpointId } : {}),
    ...(event ? { event } : {}),
  };

  const [rows, total] = await Promise.all([
    db.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      // Explicit select everywhere: no default include, so the payload column
      // (potentially large) is never dragged into an admin listing.
      select: {
        id: true,
        event: true,
        status: true,
        attempts: true,
        responseCode: true,
        lastAttemptAt: true,
        createdAt: true,
        endpoint: {
          select: { id: true, url: true, isActive: true, store: { select: { id: true, name: true } } },
        },
      },
    }),
    db.webhookDelivery.count({ where }),
  ]);

  // Best-effort last-attempt detail (graceful while the attempt-log migration
  // is pending — see latestAttemptLogs).
  const logs = await latestAttemptLogs(rows.map((r) => r.id));

  const data = rows.map((r) => {
    const log = logs.get(r.id) ?? null;
    const nextRetry = r.status === "pending" ? webhookNextRetryAt(r.attempts, r.lastAttemptAt) : null;
    return {
      id: r.id,
      event: r.event,
      status: r.status,
      attempts: r.attempts,
      maxAttempts: MAX_WEBHOOK_ATTEMPTS,
      responseCode: r.responseCode,
      lastAttemptAt: r.lastAttemptAt,
      createdAt: r.createdAt,
      nextRetryAt: nextRetry,
      endpoint: { id: r.endpoint.id, url: r.endpoint.url, isActive: r.endpoint.isActive },
      store: r.endpoint.store ? { id: r.endpoint.store.id, name: r.endpoint.store.name } : null,
      lastError: log?.error ?? null,
      lastResponseBody: log?.responseBody ?? null,
      lastAttemptSigned: log?.signed ?? null,
      replayPath: r.status === "pending" || r.status === "failed" ? `/api/admin/webhook-deliveries/${r.id}/replay` : null,
    };
  });

  return okPaged(data, { page, size, total });
});

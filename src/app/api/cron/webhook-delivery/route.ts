import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { toJson } from "@/lib/json";
import { assertCronAuth } from "@/lib/cron-auth";
import { sweepDueWebhookDeliveries, MAX_WEBHOOK_ATTEMPTS, WEBHOOK_BACKOFF_SCHEDULE_MS } from "@/lib/webhook-delivery";

export const dynamic = "force-dynamic";

// ============================================================================
// C2.8 (Phase 2.3) — WEBHOOK DELIVERY RETRY SWEEP (cron tick)
// ----------------------------------------------------------------------------
// WHY: dispatchStoreWebhooks (lib/api.ts → lib/webhook-delivery.ts) now
// performs REAL HTTP delivery and fires the first attempt inline on the
// order/fulfilment paths. A delivery that is not accepted on the spot
// (non-2xx, timeout, DNS/SSRF refusal) stays `pending` with the REAL
// response recorded — this rail retries it on the deterministic backoff
// schedule until it is accepted (2xx ⇒ success, terminal) or the attempt
// budget is exhausted (⇒ failed, terminal). Success is only ever written for
// a genuine 2xx response; nothing here simulates outcomes.
//
// The per-delivery state machine, atomic claim (idempotency: at most one
// attempt per row per 60 s window — a racing claim loses with count 0) and
// the ±10-minute receiver replay window are documented in
// lib/webhook-delivery.ts, which is the single authoritative implementation.
//
// SCHEDULING (durable): this route is the worker TICK. The recurring
// invocation lives in mini-services/expiry-scheduler (port 3005) under the
// `webhook` kind — same rail as expiry-sweep / refund-reconcile — POSTing
// here every 30 s; a platform cron is the production equivalent. Every run
// records its outcome in Setting `cron.webhook_delivery.last` (survives
// restarts) so ops can observe backlog and failures.
// The sweep is deadline-aware (≈35 s) so the scheduler's 45 s tick timeout is
// never breached; leftover due rows roll to the next tick.
// AUTH: assertCronAuth (lib/cron-auth.ts) — production without CRON_SECRET
// fails CLOSED (503); with a secret the `x-cron-secret` header is compared
// timing-safely; dev without a secret stays open for sandbox testing.
// ============================================================================

const SWEEP_THROTTLE_MS = 5_000;

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__webhookDeliverySweepAt === "number" ? (g.__webhookDeliverySweepAt as number) : 0;
  const now = Date.now();
  if (now - last < SWEEP_THROTTLE_MS) {
    return ok({ throttled: true, attempted: 0, auth: auth.mode });
  }
  g.__webhookDeliverySweepAt = now;

  // Shared core — identical state transitions to the inline first attempt.
  const outcome = await sweepDueWebhookDeliveries();

  // Durable observability — survives restarts, queryable by ops/admin
  // (mirrors the cron.expiry_sweep.last pattern).
  await db.setting.upsert({
    where: { key: "cron.webhook_delivery.last" },
    create: {
      key: "cron.webhook_delivery.last",
      valueJson: toJson(outcome),
      description: "Last webhook-delivery retry sweep outcome (C2.8 — real seller webhook delivery)",
    },
    update: { valueJson: toJson(outcome) },
  });

  return ok(outcome);
});

// GET — backlog + last-run observability without triggering a sweep.
// Same auth posture as POST.
export const GET = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const coarseDue = { status: "pending" as const, attempts: { lt: MAX_WEBHOOK_ATTEMPTS } };
  const [backlog, oldest, dueNow, lastSetting] = await Promise.all([
    db.webhookDelivery.count({ where: coarseDue }).catch(() => null),
    db.webhookDelivery
      .findFirst({ where: coarseDue, orderBy: { createdAt: "asc" }, select: { createdAt: true, event: true, attempts: true } })
      .catch(() => null),
    db.webhookDelivery
      .count({
        where: {
          status: "pending",
          attempts: { lt: MAX_WEBHOOK_ATTEMPTS },
          OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(Date.now() - WEBHOOK_BACKOFF_SCHEDULE_MS[1]) } }],
        },
      })
      .catch(() => null),
    db.setting.findUnique({ where: { key: "cron.webhook_delivery.last" } }),
  ]);
  return ok({
    backlog,
    dueNowApprox: dueNow,
    oldestPending: oldest ? { createdAt: oldest.createdAt, event: oldest.event, attempts: oldest.attempts } : null,
    lastRun: lastSetting ? JSON.parse(lastSetting.valueJson) : null,
    auth: auth.mode,
    schedulingNote:
      "Recurring invocation: mini-services/expiry-scheduler (`webhook` kind, this deployment) or a platform cron in production; this endpoint is the tick, not the scheduler",
    receiverContract:
      "POST {url} with x-nomofee-event / x-nomofee-timestamp (unix s) / x-nomofee-signature = hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`); unsigned when the endpoint has no secret; verify within ±10 min",
  });
});

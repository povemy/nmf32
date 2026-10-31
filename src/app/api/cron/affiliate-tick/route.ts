import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { parseJson, toJson } from "@/lib/json";
import { assertCronAuth } from "@/lib/cron-auth";
import { sweepAffiliateLifecycle } from "@/lib/affiliate";

export const dynamic = "force-dynamic";

// ============================================================================
// AFFILIATE LIFECYCLE TICK (cron) — commission state machine maintenance.
// ----------------------------------------------------------------------------
// Durable-tick pattern shared with the analytics/expiry/refund ticks (the
// recurring invocation is mini-services/expiry-scheduler, port 3005); every
// run records its outcome in Setting `cron.affiliate.last`.
//
//   • Approves PENDING affiliate commission entries whose order reached an
//     authoritative completion state (delivered / completed). The deliver /
//     receive routes approve inline for immediacy; this sweep is the
//     safety net that also covers courier-webhook deliveries.
//   • Matures APPROVED entries whose review window
//     (affiliate.review_days) elapsed → AVAILABLE.
//   • Bounded batches (50 orders per tick) — the 30 s scheduler cadence
//     drains any backlog; per-order approval is idempotent (status CAS).
//   • cron-auth guarded (fail-closed in production, timing-safe secret).
// ============================================================================

const LAST_RUN_KEY = "cron.affiliate.last";

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const t0 = performance.now();

  const outcome = await sweepAffiliateLifecycle();

  // Count any residual pending backlog for observability.
  const remainingPending = await db.affiliateCommission.count({ where: { status: "pending" } });

  const durationMs = Math.round(performance.now() - t0);
  const payload = {
    approved: outcome.approved,
    matured: outcome.matured,
    remainingPending,
    durationMs,
    at: new Date().toISOString(),
    authMode: auth.mode,
  };
  await db.setting.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, valueJson: toJson(payload), description: "Affiliate lifecycle tick — last run outcome" },
    update: { valueJson: toJson(payload) },
  });

  return ok(payload);
});

export const GET = handle(async (req: Request) => {
  assertCronAuth(req); // same posture as the other tick routes — no unauthenticated ops telemetry
  const row = await db.setting.findUnique({ where: { key: LAST_RUN_KEY } });
  return ok({ last: parseJson<Record<string, unknown> | null>(row?.valueJson ?? null, null) });
});

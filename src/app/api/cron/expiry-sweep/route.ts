import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { toJson } from "@/lib/json";
import { assertCronAuth } from "@/lib/cron-auth";
import { recordEvent } from "@/lib/metrics";
import { bustPublicProductCache } from "@/lib/public-cache";
import { runExpirySweep } from "@/lib/expiry-sweep";
import type { ExpirySweepOutcome, ExpirySweepStatusData, ExpirySweepThrottledData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// ============================================================================
// F3 REMEDIATION — PAYMENT-WINDOW EXPIRY SWEEP (cron tick)
// ----------------------------------------------------------------------------
// WHY: checkout decrements stock AT CREATE; an unpaid PaymentGroup keeps that
// stock reserved until it is paid or expired. Before this sweep, `expiresAt`
// (+30 min, written by /api/checkout/create) was enforced NOWHERE — measured
// evidence: an unpaid checkout held its stock 75 s past expiry with the order
// still payment_pending (performance/REPORT.md §3.4). Abandoned checkouts
// leaked stock forever.
//
// The per-group transaction logic now lives in ONE shared primitive —
// `expireUnpaidPaymentGroups` (lib/expiry-sweep.ts) — so this rail and
// /api/orders/expiry/tick execute IDENTICAL state transitions (C1.1):
//   1. CLAIM the group first: conditional `requires_payment|failed → expired`.
//   2. Per-order guard: `payment_pending → payment_expired` (conditional).
//      An order that somehow became paid is skipped, not restocked.
//   3. Stock release: increment per item + InventoryLog (`expiry:{ref}`) +
//      salesCount decrement (floor-guarded). Atomic with the claim → a
//      committed expiry always owns its restock exactly once.
//   4. Voucher/coupon redemption restoration (C2.3) in the same transaction.
//
// LATE PAYMENT AFTER RELEASE (defined recovery policy, exercised by the
// webhook path): a payment.succeeded arriving for an expired group is refused
// with 409 GROUP_EXPIRED and converges on the durable PaymentReconciliation
// refund obligation — no money moves, no order is resurrected, the PSP treats
// it as a permanent failure and (in production) refunds per its own cadence.
//
// SCHEDULING (durable): this route is the worker TICK, not the scheduler. The
// recurring invocation lives in mini-services/expiry-scheduler (port 3005,
// interval + durable state + alerts — see its README), which POSTs this
// endpoint; a platform cron / uptime pinger is the production equivalent.
// Every run records its outcome in Setting `cron.expiry_sweep.last` (survives
// restarts) so ops can observe backlog, failures and last-success age.
// AUTH (mission: final operational gaps): assertCronAuth (lib/cron-auth.ts) —
// in production a MISSING CRON_SECRET fails CLOSED (503, never publicly
// callable); when set, the `x-cron-secret` header is compared timing-safely.
// Dev without a secret stays open for direct sandbox testing.
// ============================================================================

const SWEEP_THROTTLE_MS = 1_500;

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__expirySweepAt === "number" ? (g.__expirySweepAt as number) : 0;
  const now = Date.now();
  if (now - last < SWEEP_THROTTLE_MS) {
    // P2.3-7 (monitoring honesty): real expiry-sweep outcome counters on
    // /api/metrics (events: "cron.expiry_sweep:*").
    recordEvent("cron.expiry_sweep", "throttled");
    const throttled: ExpirySweepThrottledData = { throttled: true, expired: 0, auth: auth.mode };
    return ok(throttled);
  }
  g.__expirySweepAt = now;

  const t0 = performance.now();
  // Shared core (C1.1): the SAME primitive the /api/orders/expiry/tick rail
  // runs — one authoritative set of state-transition rules. C1.1 verification
  // fix (G4): this rail now runs BOTH phases (groups + legacy single-intent
  // orders) instead of Phase A only, so a deployment that wires only the
  // mini-service scheduler still expires legacy reservations.
  const stats = await runExpirySweep();

  const remaining = await db.paymentGroup.count({
    where: { status: { in: ["requires_payment", "failed"] }, expiresAt: { lt: new Date() } },
  });
  const outcome: ExpirySweepOutcome = { ...stats, remainingBacklog: remaining, durationMs: Math.round(performance.now() - t0), at: new Date().toISOString(), auth: auth.mode };

  // PHASE 2.1 (§9-A): released reservations restored stock — cached public
  // product/market data is stale. Bust ONLY when something was actually
  // restocked (group restocks AND legacy Phase B releases; the sweep ticks
  // every 30 s with an overwhelmingly empty outcome; busting unconditionally
  // would defeat the cache entirely).
  if (stats.itemsRestocked > 0 || stats.released > 0) bustPublicProductCache();

  // Durable observability — survives restarts, queryable by ops/admin.
  await db.setting.upsert({
    where: { key: "cron.expiry_sweep.last" },
    create: { key: "cron.expiry_sweep.last", valueJson: toJson(outcome), description: "Last expiry-sweep outcome (F3 remediation)" },
    update: { valueJson: toJson(outcome) },
  });

  // P2.3-7 (monitoring honesty): in-memory outcome counter for /api/metrics
  // (durable truth stays the Setting row above + /api/health/scheduler).
  recordEvent("cron.expiry_sweep", stats.failures > 0 ? "ran-with-failures" : "ran");

  return ok(outcome);
});

// GET — backlog + last-run observability without triggering a sweep.
// Same auth posture as POST (scheduler/ops surface: fail-closed in production
// without a secret; timing-safe header check when configured).
export const GET = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const [backlog, oldest, lastSetting] = await Promise.all([
    db.paymentGroup.count({ where: { status: { in: ["requires_payment", "failed"] }, expiresAt: { lt: new Date() } } }),
    db.paymentGroup.findFirst({
      where: { status: { in: ["requires_payment", "failed"] }, expiresAt: { lt: new Date() } },
      orderBy: { expiresAt: "asc" },
      select: { expiresAt: true },
    }),
    db.setting.findUnique({ where: { key: "cron.expiry_sweep.last" } }),
  ]);
  const payload: ExpirySweepStatusData = {
    backlog,
    oldestExpiredAt: oldest?.expiresAt?.toISOString() ?? null,
    lastRun: lastSetting ? (JSON.parse(lastSetting.valueJson) as ExpirySweepOutcome) : null,
    auth: auth.mode,
    schedulingNote: "Recurring invocation: mini-services/expiry-scheduler (this deployment) or a platform cron in production; this endpoint is the tick, not the scheduler",
  };
  return ok(payload);
});

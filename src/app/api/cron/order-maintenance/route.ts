import { db } from "@/lib/db";
import { handle, ok, transitionOrder } from "@/lib/api";
import { assertCronAuth } from "@/lib/cron-auth";
import { maybeSyncTracking, MOCK_PROVIDER_ID, ACTIVE_SHIPMENT_STATUSES } from "@/lib/shipping";
import { toJson, parseJson } from "@/lib/json";

export const dynamic = "force-dynamic";

// ============================================================================
// ORDER MAINTENANCE TICK (cron) — Phase 2 / A5.
// ----------------------------------------------------------------------------
// Two maintenance sweeps that previously ran LAZILY on the shopper request
// path (GET /api/me/orders) now run HERE, on the scheduler rail
// (mini-services/expiry-scheduler, port 3005), so a buyer's purchases-page
// latency never pays for marketplace-wide upkeep:
//
//   1. Auto-complete sweep — "delivered" orders older than 14 days become
//      "completed" with an OrderStatusHistory row (actor "system"). GLOBAL
//      scope, batch 50 per tick, same query/transition semantics as the old
//      lazy sweep; bounded backlog drain.
//   2. Tracking tick — advance stale in-flight MOCK shipments one step via
//      maybeSyncTracking (45s idle guard preserved EXACTLY: shipments only
//      advance when they have been idle — the demo cadence is unchanged from
//      the buyer-driven era, it just no longer rides the buyer's request).
//      Batch 100 per tick.
//
// Durable-tick pattern shared with the analytics/expiry/refund/affiliate
// ticks: every run records its outcome in Setting `cron.orders.last`;
// cron-auth guarded (fail-closed in production, timing-safe secret).
// Idempotency: the auto-complete candidates filter excludes already-completed
// orders (a second run over the same window is a no-op); tracking sync
// advances at most one step per 45s window per shipment. Concurrent
// overlapping ticks are safe for the same reason the expiry sweep is:
// candidate filters + status transitions, not in-memory flags, decide the work.
// ============================================================================

const LAST_RUN_KEY = "cron.orders.last";
const AUTO_COMPLETE_BATCH = 50;
const TRACKING_BATCH = 100;
const AUTO_COMPLETE_DAYS = 14;
const TRACKING_IDLE_MS = 45_000; // same as the buyer-era lazy tick
const THROTTLE_MS = 20_000; // guard against manual bursts; scheduler cadence is 30s

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);

  // In-process throttle (globalThis — Turbopack duplicates module instances).
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__orderMaintenanceAt === "number" ? g.__orderMaintenanceAt : 0;
  const now = Date.now();
  if (now - last < THROTTLE_MS) {
    return ok({ throttled: true, skippedForMs: THROTTLE_MS - (now - last), auth: auth.mode });
  }
  g.__orderMaintenanceAt = now;

  const t0 = performance.now();

  // --- 1. Auto-complete sweep (global; same semantics as the lazy original) ---
  const cutoff = new Date(now - AUTO_COMPLETE_DAYS * 24 * 3600 * 1000);
  const stale = await db.order.findMany({
    where: { status: "delivered", deliveredAt: { lt: cutoff } },
    select: { id: true },
    take: AUTO_COMPLETE_BATCH,
    orderBy: { deliveredAt: "asc" },
  });
  let completed = 0;
  const errors: string[] = [];
  for (const o of stale) {
    try {
      await transitionOrder({
        orderId: o.id,
        toStatus: "completed",
        actor: "system",
        note: "Auto-confirmed 14 days after delivery",
        timestamps: { completedAt: new Date() },
      });
      completed++;
    } catch (e) {
      // One failing order must not hide the rest of the batch.
      errors.push(`${o.id}:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
    }
  }

  // --- 2. Tracking tick (mock network; 45s idle guard inside maybeSyncTracking) ---
  const inflight = await db.shipment.findMany({
    where: { providerId: MOCK_PROVIDER_ID, status: { in: [...ACTIVE_SHIPMENT_STATUSES] } },
    select: { id: true },
    take: TRACKING_BATCH,
    orderBy: { lastSyncedAt: "asc" },
  });
  let advanced = 0;
  for (const s of inflight) {
    try {
      const snap = await maybeSyncTracking(s.id, TRACKING_IDLE_MS);
      if (snap) advanced++;
    } catch (e) {
      errors.push(`shipment:${s.id}:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
    }
  }

  const payload = {
    ranAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    autoComplete: { candidates: stale.length, completed, cutoff: cutoff.toISOString() },
    tracking: { scanned: inflight.length, advanced },
    errors: errors.slice(0, 10),
    auth: auth.mode,
  };
  await db.setting.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, valueJson: toJson(payload), description: "Order maintenance tick — last run outcome (auto-complete + mock tracking)" },
    update: { valueJson: toJson(payload) },
  });

  return ok(payload);
});

// GET — operator observability without triggering a tick (cron-auth guarded).
export const GET = handle(async (req: Request) => {
  assertCronAuth(req);
  const row = await db.setting.findUnique({ where: { key: LAST_RUN_KEY } });
  const [autoBacklog, inflightCount] = await Promise.all([
    db.order.count({ where: { status: "delivered", deliveredAt: { lt: new Date(Date.now() - AUTO_COMPLETE_DAYS * 86_400_000) } } }),
    db.shipment.count({ where: { providerId: MOCK_PROVIDER_ID, status: { in: [...ACTIVE_SHIPMENT_STATUSES] } } }),
  ]);
  return ok({
    lastRun: parseJson<Record<string, unknown> | null>(row?.valueJson ?? null, null),
    autoCompleteBacklog: autoBacklog,
    inflightMockShipments: inflightCount,
  });
});

import { db } from "@/lib/db";
import { handle, ok, transitionOrder } from "@/lib/api";
import { assertCronAuth } from "@/lib/cron-auth";
import { maybeSyncTracking, MOCK_PROVIDER_ID, ACTIVE_SHIPMENT_STATUSES } from "@/lib/shipping";
import { toJson, parseJson } from "@/lib/json";

export const dynamic = "force-dynamic";

// ============================================================================
// ORDER MAINTENANCE TICK (cron) — Phase 2 / A5.
// ----------------------------------------------------------------------------
// The maintenance sweeps that previously ran LAZILY on the shopper request
// path (GET /api/me/orders) now run HERE, on the scheduler rail
// (mini-services/expiry-scheduler, port 3005), so a buyer's purchases-page
// latency never pays for marketplace-wide upkeep:
//
//   1. Auto-RECEIPT sweep (stage 1) — "delivered" orders older than 14 days
//      (buyer-protection window elapsed with no receipt confirmation) become
//      "received" with receivedAt now (actor "system") — they enter the To
//      Rate bucket exactly as if the buyer had tapped "Order received".
//   2. Auto-COMPLETE sweep (stage 2) — "received" orders whose 30-day rating
//      window elapsed become "completed" (actor "system").
//   3. Tracking tick — advance stale in-flight MOCK shipments one step via
//      maybeSyncTracking (45s idle guard preserved EXACTLY: shipments only
//      advance when they have been idle — the demo cadence is unchanged from
//      the buyer-driven era, it just no longer rides the buyer's request).
//      Batch 100 per tick.
//
// Durable-tick pattern shared with the analytics/expiry/refund/affiliate
// ticks: every run records its outcome in Setting `cron.orders.last`;
// cron-auth guarded (fail-closed in production, timing-safe secret).
// Idempotency: both sweep candidate filters exclude already-advanced orders
// (a second run over the same window is a no-op); tracking sync
// advances at most one step per 45s window per shipment. Concurrent
// overlapping ticks are safe for the same reason the expiry sweep is:
// candidate filters + status transitions, not in-memory flags, decide the work.
// ============================================================================

const LAST_RUN_KEY = "cron.orders.last";
const AUTO_RECEIPT_BATCH = 50;
const TRACKING_BATCH = 100;
const AUTO_RECEIPT_DAYS = 14; // courier-delivered without buyer confirmation → auto-receive
const RATE_WINDOW_DAYS = 30; // received without a rating → auto-complete
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

  // --- 1. Auto-RECEIPT sweep (delivered + 14d, no buyer confirmation) ---
  const receiptCutoff = new Date(now - AUTO_RECEIPT_DAYS * 24 * 3600 * 1000);
  const unconfirmed = await db.order.findMany({
    where: { status: "delivered", deliveredAt: { lt: receiptCutoff } },
    select: { id: true },
    take: AUTO_RECEIPT_BATCH,
    orderBy: { deliveredAt: "asc" },
  });
  let autoReceived = 0;
  const errors: string[] = [];
  for (const o of unconfirmed) {
    try {
      await transitionOrder({
        orderId: o.id,
        toStatus: "received",
        actor: "system",
        note: `Auto-confirmed receipt ${AUTO_RECEIPT_DAYS} days after delivery — rate within ${RATE_WINDOW_DAYS} days`,
        timestamps: { receivedAt: new Date() },
      });
      autoReceived++;
    } catch (e) {
      // One failing order must not hide the rest of the batch.
      errors.push(`${o.id}:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
    }
  }

  // --- 2. Auto-COMPLETE sweep (received + 30d rating window elapsed) ---
  const completeCutoff = new Date(now - RATE_WINDOW_DAYS * 24 * 3600 * 1000);
  const unrated = await db.order.findMany({
    where: { status: "received", receivedAt: { lt: completeCutoff } },
    select: { id: true },
    take: AUTO_RECEIPT_BATCH,
    orderBy: { receivedAt: "asc" },
  });
  let completed = 0;
  for (const o of unrated) {
    try {
      await transitionOrder({
        orderId: o.id,
        toStatus: "completed",
        actor: "system",
        note: `Completed ${RATE_WINDOW_DAYS} days after receipt confirmation`,
        timestamps: { completedAt: new Date() },
      });
      completed++;
    } catch (e) {
      errors.push(`${o.id}:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
    }
  }

  // --- 3. Tracking tick (mock network; 45s idle guard inside maybeSyncTracking) ---
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
    autoReceipt: { candidates: unconfirmed.length, received: autoReceived, cutoff: receiptCutoff.toISOString() },
    autoComplete: { candidates: unrated.length, completed, cutoff: completeCutoff.toISOString() },
    tracking: { scanned: inflight.length, advanced },
    errors: errors.slice(0, 10),
    auth: auth.mode,
  };
  await db.setting.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, valueJson: toJson(payload), description: "Order maintenance tick — last run outcome (auto-receipt + auto-complete + mock tracking)" },
    update: { valueJson: toJson(payload) },
  });

  return ok(payload);
});

// GET — operator observability without triggering a tick (cron-auth guarded).
export const GET = handle(async (req: Request) => {
  assertCronAuth(req);
  const row = await db.setting.findUnique({ where: { key: LAST_RUN_KEY } });
  const [receiptBacklog, completeBacklog, inflightCount] = await Promise.all([
    db.order.count({ where: { status: "delivered", deliveredAt: { lt: new Date(Date.now() - AUTO_RECEIPT_DAYS * 86_400_000) } } }),
    db.order.count({ where: { status: "received", receivedAt: { lt: new Date(Date.now() - RATE_WINDOW_DAYS * 86_400_000) } } }),
    db.shipment.count({ where: { providerId: MOCK_PROVIDER_ID, status: { in: [...ACTIVE_SHIPMENT_STATUSES] } } }),
  ]);
  return ok({
    lastRun: parseJson<Record<string, unknown> | null>(row?.valueJson ?? null, null),
    autoReceiptBacklog: receiptBacklog,
    autoCompleteBacklog: completeBacklog,
    inflightMockShipments: inflightCount,
  });
});

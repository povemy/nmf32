// ============================================================================
// ORDER COMPLETION (Task 10-a) — closes the order lifecycle.
// ============================================================================
// THE GAP this closes: nothing in the codebase ever set status="completed", so
// the buyer's "Completed" bucket (BUCKETS.completed in /api/me/orders) was
// unreachable. Orders now complete through two paths:
//
//   1. BUYER CONFIRM — POST /api/me/orders/[orderNumber]/receive ("Order
//      received" button) transitions shipped|delivered → completed directly.
//   2. AUTO-CONFIRM — sweep below: delivered orders auto-complete
//      AUTO_COMPLETE_DAYS after delivery (Shopee-style buyer protection
//      window). The sweep runs lazily on the buyer/seller order READS (see the
//      wiring in those routes) so no cron/worker is needed in the sandbox.
//
// Both paths write an OrderStatusHistory row via transitionOrder (single
// source of truth for status changes).
// ============================================================================

import { db } from "./db";
import { transitionOrder } from "./api";

/** Delivered orders auto-complete this many days after delivery. */
export const AUTO_COMPLETE_DAYS = 14;

/** Max orders swept per call — keeps a read-request sweep bounded. */
const SWEEP_BATCH = 100;

/**
 * Auto-complete delivered orders whose delivery is older than
 * AUTO_COMPLETE_DAYS. Idempotent and read-safe: only rows still in
 * "delivered" with deliveredAt <= cutoff are picked, and each transition is
 * individually guarded so one bad row never breaks the sweep (or the read it
 * runs inside). Safe to call on every read.
 *
 * Returns the number of orders transitioned to "completed".
 */
export async function autoCompleteDeliveredOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_COMPLETE_DAYS * 24 * 60 * 60 * 1000);

  const stale = await db.order.findMany({
    where: { status: "delivered", deliveredAt: { lte: cutoff } },
    select: { id: true },
    orderBy: { deliveredAt: "asc" },
    take: SWEEP_BATCH,
  });
  if (stale.length === 0) return 0;

  let completed = 0;
  for (const order of stale) {
    try {
      // transitionOrder writes the history row; the status filter above makes
      // this idempotent (already-completed orders are never re-selected).
      await transitionOrder({
        orderId: order.id,
        toStatus: "completed",
        actor: "system",
        note: "Auto-confirmed 14 days after delivery",
        timestamps: { completedAt: new Date() },
      });
      completed += 1;
    } catch {
      // Race (concurrent transition) or transient failure — skip this row;
      // the next sweep picks it up if still eligible.
    }
  }
  return completed;
}

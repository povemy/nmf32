// ============================================================================
// ORDER COMPLETION (Task 10-a) — closes the order lifecycle.
// ============================================================================
// ORDER-FLOW CORRECTION (buyer-confirmed receipt): the lifecycle now runs
//   shipped → delivered (courier) → received (buyer "Order received" tap, or
//   the auto-receipt sweep AUTO_RECEIPT_DAYS after delivery) → completed
//   (buyer rating, or the auto-complete sweep RATE_WINDOW_DAYS after
//   receivedAt). Completion paths:
//
//   1. BUYER CONFIRM — POST /api/me/orders/[orderNumber]/receive ("Order
//      received" button) transitions shipped|delivered → "received" (To Rate).
//   2. BUYER RATING — a verified-purchase review submission transitions
//      received → completed (see the reviews POST route).
//   3. AUTO-CONFIRM — sweeps below:
//        stage 1: delivered + AUTO_RECEIPT_DAYS → received (buyer-protection
//                 window elapsed without a confirmation — Shopee-style).
//        stage 2: received + RATE_WINDOW_DAYS → completed (rating window).
//      The live sweeps run on the scheduler rail
//      (POST /api/cron/order-maintenance, mini-services/expiry-scheduler);
//      this module keeps the same semantics exported for local/manual runs.
//
// All transitions write an OrderStatusHistory row via transitionOrder (single
// source of truth for status changes).
// ============================================================================

import { db } from "./db";
import { transitionOrder } from "./api";

/** Courier-delivered orders auto-confirm receipt this many days after delivery. */
export const AUTO_RECEIPT_DAYS = 14;

/** Received orders auto-complete this many days after receipt confirmation. */
export const RATE_WINDOW_DAYS = 30;

/** Max orders swept per call — keeps a read-request sweep bounded. */
const SWEEP_BATCH = 100;

/**
 * Stage 1 — auto-confirm RECEIPT for delivered orders whose buyer-protection
 * window (AUTO_RECEIPT_DAYS) elapsed without the buyer tapping "Order
 * received". Idempotent and read-safe: only rows still in "delivered" with
 * deliveredAt <= cutoff are picked, and each transition is individually
 * guarded so one bad row never breaks the sweep. Returns the number of orders
 * transitioned to "received".
 */
export async function autoReceiveDeliveredOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_RECEIPT_DAYS * 24 * 60 * 60 * 1000);

  const stale = await db.order.findMany({
    where: { status: "delivered", deliveredAt: { lte: cutoff } },
    select: { id: true },
    orderBy: { deliveredAt: "asc" },
    take: SWEEP_BATCH,
  });
  if (stale.length === 0) return 0;

  let received = 0;
  for (const order of stale) {
    try {
      // transitionOrder writes the history row; the status filter above makes
      // this idempotent (already-received orders are never re-selected).
      await transitionOrder({
        orderId: order.id,
        toStatus: "received",
        actor: "system",
        note: `Auto-confirmed receipt ${AUTO_RECEIPT_DAYS} days after delivery — rate within ${RATE_WINDOW_DAYS} days`,
        timestamps: { receivedAt: new Date() },
      });
      received += 1;
    } catch {
      // Race (concurrent transition) or transient failure — skip this row;
      // the next sweep picks it up if still eligible.
    }
  }
  return received;
}

/**
 * Stage 2 — auto-COMPLETE received orders whose 30-day rating window
 * (RATE_WINDOW_DAYS after receivedAt) elapsed without a review. Idempotent
 * and read-safe in the same way as stage 1. Returns the number of orders
 * transitioned to "completed".
 */
export async function autoCompleteReceivedOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const unrated = await db.order.findMany({
    where: { status: "received", receivedAt: { lte: cutoff } },
    select: { id: true },
    orderBy: { receivedAt: "asc" },
    take: SWEEP_BATCH,
  });
  if (unrated.length === 0) return 0;

  let completed = 0;
  for (const order of unrated) {
    try {
      await transitionOrder({
        orderId: order.id,
        toStatus: "completed",
        actor: "system",
        note: `Completed ${RATE_WINDOW_DAYS} days after receipt confirmation`,
        timestamps: { completedAt: new Date() },
      });
      completed += 1;
    } catch {
      // Race (concurrent transition) or transient failure — skip this row.
    }
  }
  return completed;
}

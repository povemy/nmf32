// ============================================================================
// inventory-release.ts — the ONE authoritative reservation-release primitive
// (F3, performance/f3-inventory-audit.md §3).
//
// Logical lifecycle mapped onto the existing schema (no new tables):
//   RESERVED   = Order.status "payment_pending" + stock already deducted at
//                checkout + PaymentGroup "requires_payment" (30-min expiry)
//   COMMITTED  = Order.status "paid" (webhook claim; stock stays deducted)
//   RELEASED   = Order.status "cancelled" + inventoryLog(+qty) per item
//
// Exactly-once guarantee: a compare-and-set claim on the ORDER ROW is the
// single gate. `updateMany({ where: { id, status: "payment_pending" } })`
// returns count=1 only for the winner; every loser (another sweep worker, a
// concurrent webhook success, a redelivery) observes count=0 and must NOT
// touch stock. Claim, restock and history commit in ONE transaction — a crash
// leaves either the fully reserved order or the fully released one.
//
// Restock is an UNCONDITIONAL increment, but only ever runs after winning the
// claim, so stock returns to its exact pre-checkout value and can never exceed
// capacity through duplicate release. Re-reservation (late payment) is the
// reverse: a CONDITIONAL decrement that can never drive stock negative.
// ============================================================================

import { Prisma } from "@prisma/client";
import { db } from "./db";
import { ApiError } from "./api";

export type ReleaseOutcome = {
  released: boolean;
  /** "missing" = order not found; "committed" = order no longer payment_pending (paid+);
   *  "released" = already released by a previous/competing claim. */
  already?: "committed" | "released" | "missing";
  orderId: string;
  restockedItems: number;
  status: string;
};

/**
 * Atomically release one unpaid order's reservation (stock + audit + history).
 * Safe to call repeatedly and concurrently: the CAS claim makes every call
 * after the first a no-op. Never throws for already-released/committed —
 * those are valid idempotent outcomes.
 */
export async function releaseOrderReservation(input: {
  orderId: string;
  actor?: string;
  /** Drives the history note + inventoryLog reason, e.g. "expired unpaid" or "payment failed". */
  reason: "expired unpaid" | "payment failed" | string;
}): Promise<ReleaseOutcome> {
  return db.$transaction(async (tx) => {
    // (1) CAS claim — the ONLY writer allowed to restock is the one that
    // flips the order out of payment_pending.
    const claim = await tx.order.updateMany({
      where: { id: input.orderId, status: "payment_pending" },
      data: { status: "cancelled" },
    });
    if (claim.count === 0) {
      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        select: { status: true },
      });
      const status = order?.status ?? "";
      const already = !order ? "missing" : status === "payment_pending" ? "released" : "committed";
      return { released: false, already, orderId: input.orderId, restockedItems: 0, status };
    }

    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: { id: true, orderNumber: true, status: true, items: { select: { id: true, variantId: true, qty: true, title: true } } },
    });

    // (2) Restore the exact reserved quantity for every item, with audit rows.
    let restockedItems = 0;
    for (const item of order.items) {
      if (!item.variantId || item.qty <= 0) continue;
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { stock: { increment: item.qty } },
      });
      await tx.inventoryLog.create({
        data: { variantId: item.variantId, delta: item.qty, reason: `${input.reason}:${order.orderNumber}`, refId: order.id },
      });
      restockedItems++;
    }

    // (3) Terminal history row using the current audit conventions.
    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: "payment_pending",
        toStatus: "cancelled",
        actor: input.actor ?? "system",
        note: `Reservation released (${input.reason})`,
      },
    });

    return { released: true, orderId: order.id, restockedItems, status: "cancelled" };
  });
}

/**
 * Re-reserve stock for a released order inside the CALLER's transaction (the
 * late-payment-after-release policy). CONDITIONAL decrements only — can never
 * drive stock negative. Throws ApiError(409, STOCK_LOST_AFTER_RELEASE) when
 * any line cannot be re-reserved; the caller's tx aborts atomically.
 */
export async function reReserveOrderStock(
  tx: Prisma.TransactionClient,
  input: { order: { id: string; orderNumber: string; items: { variantId: string | null; qty: number }[] }; providerRef: string }
) {
  for (const item of input.order.items) {
    if (!item.variantId || item.qty <= 0) continue;
    const moved = await tx.productVariant.updateMany({
      where: { id: item.variantId, isActive: true, stock: { gte: item.qty } },
      data: { stock: { decrement: item.qty } },
    });
    if (moved.count === 0) {
      throw new ApiError(
        409,
        "STOCK_LOST_AFTER_RELEASE",
        `Stock for "${item.title ?? item.variantId}" was released after the reservation expired and is no longer available — payment must be refunded.`
      );
    }
    await tx.inventoryLog.create({
      data: { variantId: item.variantId, delta: -item.qty, reason: `late_payment_reserve:${input.providerRef}`, refId: input.order.id },
    });
  }
}

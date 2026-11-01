// ============================================================================
// inventory-release.ts — the ONE authoritative reservation-release primitive
// (F3, performance/f3-inventory-audit.md §3) — C1.1-hardened.
//
// Logical lifecycle mapped onto the existing schema (no new tables):
//   RESERVED   = Order.status "payment_pending" + stock already deducted at
//                checkout + PaymentGroup "requires_payment" (30-min expiry)
//   COMMITTED  = Order.status "paid" (webhook claim; stock stays deducted)
//   RELEASED   = Order.status "cancelled"/"payment_expired" + inventoryLog(+qty)
//
// Exactly-once guarantee: a compare-and-set claim on the ORDER ROW is the
// single gate. `updateMany({ where: { id, status: "payment_pending" } })`
// returns count=1 only for the winner; every loser (another sweep worker, a
// concurrent webhook success, a redelivery) observes count=0 and must NOT
// touch stock. Claim, restock and history commit in ONE transaction — a crash
// leaves either the fully reserved order or the fully released one.
//
// C1.1 (Phase 2.2) — GROUP COORDINATION: when the order belongs to a
// PaymentGroup, the group is claimed FIRST (conditional
// `requires_payment|failed → expired`) inside the same transaction. An
// order-level release can therefore never leave an eligible group claimable
// for a late webhook (the stock-resurrection race). Lock ordering is
// GROUP → ORDER on every path (webhook group claim, group sweep, this
// primitive) — no AB-BA deadlock window. Losing the GROUP claim means the
// payment won (or another worker owns the release): the order is never
// touched, so stock is restocked exactly once.
//
// C2.3 (Phase 2.2) — REDEMPTION RESTORATION: a released unpaid order also
// restores the voucher/coupon redemptions it consumed at checkout (status-
// guarded, idempotent — see lib/checkout-compensation.ts).
//
// Restock is an UNCONDITIONAL increment, but only ever runs after winning the
// claim, so stock returns to its exact pre-checkout value and can never exceed
// capacity through duplicate release.
// ============================================================================

import { db } from "./db";
import { restoreRedemptionsForOrder } from "./checkout-compensation";

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
 * Atomically release one unpaid order's reservation (stock + audit + history
 * + redemptions). Safe to call repeatedly and concurrently: the CAS claims
 * make every call after the first a no-op. Never throws for
 * already-released/committed — those are valid idempotent outcomes.
 */
export async function releaseOrderReservation(input: {
  orderId: string;
  actor?: string;
  /** Drives the history note + inventoryLog reason, e.g. "expired unpaid" or "payment failed". */
  reason: "expired unpaid" | "payment failed" | string;
}): Promise<ReleaseOutcome> {
  return db.$transaction(async (tx) => {
    // (0) GROUP COORDINATION (C1.1) — claim the group BEFORE the order row so
    // the lock order (group → order) matches the webhook and group-sweep
    // paths. Losing this claim means: group "succeeded" (webhook won — the
    // order is paid/being paid, never release) or group "expired" (another
    // worker owns the release — idempotent no-op).
    const head = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, paymentGroupId: true },
    });
    if (!head) {
      return { released: false, already: "missing" as const, orderId: input.orderId, restockedItems: 0, status: "" };
    }
    if (head.paymentGroupId) {
      const gClaim = await tx.paymentGroup.updateMany({
        where: { id: head.paymentGroupId, status: { in: ["requires_payment", "failed"] } },
        data: { status: "expired" },
      });
      if (gClaim.count === 0) {
        // Group no longer claimable. Report the order's actual state without
        // touching stock or redemptions.
        const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { status: true } });
        const status = order?.status ?? "";
        const already = !order ? ("missing" as const) : status === "payment_pending" ? ("released" as const) : ("committed" as const);
        return { released: false, already, orderId: input.orderId, restockedItems: 0, status };
      }
    }

    // (1) CAS claim — the ONLY writer allowed to restock is the one that
    // flips the order out of payment_pending.
    const claim = await tx.order.updateMany({
      where: { id: input.orderId, status: "payment_pending" },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
    if (claim.count === 0) {
      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        select: { status: true },
      });
      const status = order?.status ?? "";
      // Terminal-unpaid order already released (e.g. by the group sweep, or
      // pre-fix code): heal any unrestored redemptions — idempotent no-op
      // when they were already restored. Paid orders are never touched.
      if (status === "cancelled" || status === "payment_expired") {
        await restoreRedemptionsForOrder(tx, input.orderId);
      }
      const already = !order ? ("missing" as const) : status === "payment_pending" ? ("released" as const) : ("committed" as const);
      return { released: false, already, orderId: input.orderId, restockedItems: 0, status };
    }

    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: {
        id: true, orderNumber: true, status: true,
        items: { select: { id: true, variantId: true, productId: true, qty: true, title: true } },
      },
    });

    // (2) Restore the exact reserved quantity for every item, with audit rows
    // + floor-guarded salesCount decrement (matches the group-sweep rail).
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
      if (item.productId) {
        await tx.product.updateMany({
          where: { id: item.productId, salesCount: { gte: item.qty } },
          data: { salesCount: { decrement: item.qty } },
        });
      }
      restockedItems++;
    }

    // (3) C2.3 — the abandoned unpaid order must not keep its voucher/coupon.
    await restoreRedemptionsForOrder(tx, order.id);

    // (4) Terminal history row using the current audit conventions.
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

// NOTE (Phase 5 cleanup): `reReserveOrderStock` was removed — it was written
// for a late-payment-after-release RE-RESERVATION policy that never shipped
// (zero callers, and its item type had drifted off the schema). The
// late-payment policy that DID land is refund-based: PaymentReconciliation
// obligations + the refund-reconcile cron sweep (see lib/psp-refund.ts,
// /api/cron/refund-reconcile, docs/late-payment-refund-runbook.md).

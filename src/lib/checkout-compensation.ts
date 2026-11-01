// ============================================================================
// checkout-compensation.ts — redemption restoration for cancelled UNPAID
// orders (Phase 2.2, C2.3).
// ----------------------------------------------------------------------------
// WHY: voucher/coupon redemption is recorded at ORDER CREATE (inside the
// checkout transaction — see /api/checkout/create). Before this module, an
// abandoned checkout that expired unpaid left the redemption permanently
// consumed: UserVoucher stayed USED, Voucher.claimedCount and
// Coupon.timesUsed kept counting against their quotas, and CouponRedemption
// rows survived — a customer could permanently lose a one-shot voucher to an
// order that was never paid.
//
// WHAT: `restoreRedemptionsForOrder(tx, orderId)` reverses exactly the writes
// the checkout made, INSIDE the caller's transaction and IDEMPOTENTLY:
//   • UserVoucher: USED → AVAILABLE (status-guarded conditional update,
//     clears usedAt/usedOrderId) + Voucher.claimedCount −1 (floor-guarded).
//   • CouponRedemption rows deleted + Coupon.timesUsed −1 (floor-guarded).
// Called from BOTH expiry paths (the shared group sweep core in
// lib/expiry-sweep.ts and releaseOrderReservation for legacy orders), and
// again — as a healing no-op — for orders released by pre-fix code.
//
// SAFETY RULES:
//   1. Only ever called for an order in a terminal unpaid state
//      (cancelled / payment_expired). A paid order's redemptions are
//      legitimate and must never be restored — callers enforce this with the
//      order-row CAS claim BEFORE calling.
//   2. Status guards make re-invocation a no-op: a second sweep, a retry, or
//      the healing path can never restore twice (the conditional updates
//      simply match 0 rows).
//   3. Floor guards (`{ gte: 1 }`) keep counters from going negative even if
//      historical data drifted.
//   4. "Manipulating expiry cycles" cannot multiply promotions: each cycle
//      needs a real order create (which re-consumes the redemption) followed
//      by a genuine unpaid expiry (which restores it). Net effect: a voucher
//      is only permanently consumed by an order that actually completes.
// ============================================================================

import { Prisma } from "@prisma/client";

export type RedemptionsRestored = {
  vouchers: number;
  coupons: number;
};

/** Restore voucher + coupon redemptions consumed by an unpaid cancelled order.
 *  Runs on the caller's transaction client; idempotent; never throws for
 *  already-restored state. Returns per-kind restore counts (for stats/audit). */
export async function restoreRedemptionsForOrder(tx: Prisma.TransactionClient, orderId: string): Promise<RedemptionsRestored> {
  let vouchers = 0;
  let coupons = 0;

  // --- Wallet vouchers (UserVoucher USED → AVAILABLE) -----------------------
  const usedVouchers = await tx.userVoucher.findMany({
    where: { usedOrderId: orderId, status: "USED" },
    select: { id: true, voucherId: true },
  });
  for (const uv of usedVouchers) {
    // Status-guarded flip: exactly one worker wins; everyone else no-ops.
    const flip = await tx.userVoucher.updateMany({
      where: { id: uv.id, status: "USED", usedOrderId: orderId },
      data: { status: "AVAILABLE", usedAt: null, usedOrderId: null },
    });
    if (flip.count === 0) continue;
    vouchers++;
    // Return the redeemed unit to the campaign pool (floor-guarded).
    await tx.voucher.updateMany({
      where: { id: uv.voucherId, claimedCount: { gte: 1 } },
      data: { claimedCount: { decrement: 1 } },
    });
  }

  // --- Coupons (delete redemption + give the usage slot back) ---------------
  const redemptions = await tx.couponRedemption.findMany({
    where: { orderId },
    select: { id: true, couponId: true },
  });
  for (const r of redemptions) {
    const del = await tx.couponRedemption.deleteMany({ where: { id: r.id, orderId } });
    if (del.count === 0) continue;
    coupons++;
    await tx.coupon.updateMany({
      where: { id: r.couponId, timesUsed: { gte: 1 } },
      data: { timesUsed: { decrement: 1 } },
    });
  }

  return { vouchers, coupons };
}

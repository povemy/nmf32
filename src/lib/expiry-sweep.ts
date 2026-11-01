// ============================================================================
// expiry-sweep.ts — THE shared unpaid-reservation expiry core (F3 + C1.1).
// ----------------------------------------------------------------------------
// ONE primitive for both schedulers:
//   • POST /api/cron/expiry-sweep   (driven by mini-services/expiry-scheduler,
//     30 s cadence, assertCronAuth-protected)
//   • POST /api/orders/expiry/tick  (crontab/ops rail, now ALSO
//     assertCronAuth-protected — previously unauthenticated)
//
// Phase A — `expireUnpaidPaymentGroups`: for every PaymentGroup past its
// expiry in requires_payment|failed, ONE transaction per group:
//   1. CLAIM the GROUP first: conditional `requires_payment|failed → expired`.
//   2. Per-order guard: conditional `payment_pending → payment_expired`
//      (+ cancelledAt). An order that became paid is skipped, never restocked.
//   3. Stock release: increment per item + InventoryLog (`expiry:{ref}`) +
//      floor-guarded salesCount decrement.
//   4. Redemption restoration (C2.3): vouchers/coupons consumed by the order
//      are restored inside the same transaction.
//
// Phase B — legacy single-PaymentIntent orders (paymentGroupId null):
// `releaseOrderReservation` (lib/inventory-release.ts), which now performs the
// SAME group coordination for any order that still carries a group, plus
// voucher/coupon restoration — identical state-transition rules on every path.
//
// C1.1 (stock-resurrection race) is closed by the group claim being the FIRST
// write on every path: an order-level release can never leave a PaymentGroup
// claimable, and the payment webhook additionally re-verifies every member
// order is still `payment_pending` INSIDE its Serializable claim transaction
// (see webhooks/payments/process.ts). A cancelled/expired order can never be
// resurrected by a late successful webhook; late payments converge on the
// durable PaymentReconciliation refund obligation instead.
//
// Lock ordering is group → order on ALL paths (webhook, group sweep, legacy
// release) — no AB-BA deadlock window. The DB-side CAS claims are the
// correctness mechanism; in-memory throttling is only a load valve.
// ============================================================================

import { db } from "./db";
import { releaseOrderReservation } from "./inventory-release";
import { restoreRedemptionsForOrder } from "./checkout-compensation";

const SWEEP_BATCH = 50;

export type SweepResult = GroupExpiryStats & {
  scanned: number;
  released: number;
  skipped: number;
  errors: { orderId: string; error: string }[];
  throttled: boolean;
};

export type GroupExpiryStats = {
  examined: number;
  expired: number;
  ordersExpired: number;
  itemsRestocked: number;
  skippedConcurrent: number;
  anomalies: number;
  failures: number;
  vouchersRestored: number;
  couponsRestored: number;
};

/**
 * Phase A — expire unpaid PaymentGroups past their window. Extracted verbatim
 * in behaviour from the former /api/cron/expiry-sweep loop so both scheduler
 * rails execute the SAME transitions. Safe under concurrency: the conditional
 * group claim is the single gate; losers touch nothing.
 */
export async function expireUnpaidPaymentGroups(opts?: { batch?: number; actor?: string }): Promise<GroupExpiryStats> {
  const batch = opts?.batch ?? SWEEP_BATCH;
  const actor = opts?.actor ?? "expiry-sweep";
  const stats: GroupExpiryStats = {
    examined: 0, expired: 0, ordersExpired: 0, itemsRestocked: 0,
    skippedConcurrent: 0, anomalies: 0, failures: 0, vouchersRestored: 0, couponsRestored: 0,
  };

  const nowDate = new Date();
  // requires_payment OR failed (E1): a `payment.failed` webhook flips the
  // group to "failed"; the buyer's abandoned retry must not hold the reserved
  // stock forever. The retry window is untouched — release only happens AFTER
  // expiresAt.
  const candidates = await db.paymentGroup.findMany({
    where: { status: { in: ["requires_payment", "failed"] }, expiresAt: { lt: nowDate } },
    include: { orders: { include: { items: { select: { variantId: true, productId: true, qty: true } } } } },
    orderBy: { expiresAt: "asc" },
    take: batch,
  });
  stats.examined = candidates.length;

  for (const group of candidates) {
    try {
      // ONE transaction per group: claim + order transitions + restock +
      // redemption restoration are atomic. READ COMMITTED + conditional
      // claims: the group claim is the first write and the only gate.
      const result = await db.$transaction(async (tx) => {
        const claim = await tx.paymentGroup.updateMany({
          where: { id: group.id, status: { in: ["requires_payment", "failed"] } },
          data: { status: "expired" },
        });
        if (claim.count === 0) return { claimed: false as const };

        let ordersExpired = 0;
        let itemsRestocked = 0;
        let vouchersRestored = 0;
        let couponsRestored = 0;
        for (const order of group.orders) {
          // Per-order guard: only still-unpaid orders expire; an order paid by
          // a racing confirmation is skipped (its group claim would have lost
          // anyway — belt-and-braces).
          const moved = await tx.order.updateMany({
            where: { id: order.id, status: "payment_pending" },
            data: { status: "payment_expired", cancelledAt: nowDate },
          });
          if (moved.count === 0) {
            // Anomaly: the order already left payment_pending while its group
            // was still claimable. Two legitimate cases: (a) a racing webhook
            // paid it in flight (its tx will win the group row on commit/abort
            // — no restock, no restoration), or (b) a PRE-FIX order-level
            // release cancelled it without expiring the group (historical
            // C1.1 residue). For (b) the redemptions were never restored —
            // heal that now; for terminal-unpaid statuses only, idempotently.
            const st = await tx.order.findUnique({ where: { id: order.id }, select: { status: true } });
            if (st && (st.status === "cancelled" || st.status === "payment_expired")) {
              const healed = await restoreRedemptionsForOrder(tx, order.id);
              vouchersRestored += healed.vouchers;
              couponsRestored += healed.coupons;
            }
            stats.anomalies++;
            continue; // never restock an order that is not safely unpaid
          }
          ordersExpired++;
          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: "payment_pending",
              toStatus: "payment_expired",
              actor,
              note: `Payment window expired (${group.ref}) — stock released by expiry sweep`,
            },
          });
          for (const item of order.items) {
            // OrderItem.variantId is nullable (legacy/product-level lines have
            // no variant row) — there is nothing to restock or log for them.
            if (!item.variantId) continue;
            await tx.productVariant.update({
              where: { id: item.variantId },
              data: { stock: { increment: item.qty } },
            });
            await tx.inventoryLog.create({
              data: { variantId: item.variantId, delta: item.qty, reason: `expiry:${group.ref}`, refId: order.id },
            });
            if (item.productId) {
              // Floor-guarded decrement: salesCount must never go negative.
              await tx.product.updateMany({
                where: { id: item.productId, salesCount: { gte: item.qty } },
                data: { salesCount: { decrement: item.qty } },
              });
            }
            itemsRestocked++;
          }
          // C2.3 — the abandoned unpaid order must not keep its voucher/coupon.
          const restored = await restoreRedemptionsForOrder(tx, order.id);
          vouchersRestored += restored.vouchers;
          couponsRestored += restored.coupons;
        }
        return { claimed: true as const, ordersExpired, itemsRestocked, vouchersRestored, couponsRestored };
      });

      if (result.claimed) {
        stats.expired++;
        stats.ordersExpired += result.ordersExpired;
        stats.itemsRestocked += result.itemsRestocked;
        stats.vouchersRestored += result.vouchersRestored;
        stats.couponsRestored += result.couponsRestored;
      } else {
        stats.skippedConcurrent++;
      }
    } catch (e) {
      stats.failures++;
      console.error(`[expiry-sweep] group ${group.ref} failed (will retry next tick):`, e instanceof Error ? e.message : e);
    }
  }
  return stats;
}

/** Run one bounded sweep of eligible expired unpaid reservations.
 *  Phase A: PaymentGroup-coordinated expiry (shared with the cron rail).
 *  Phase B: legacy single-intent orders.
 *  C1.1 verification fix (G4, Phase 2.2): BOTH scheduler rails now execute
 *  BOTH phases — the returned GroupExpiryStats fields flow through so the
 *  cron rail's outcome record, cache-busting and health checks see the same
 *  shape the tick rail produces (one authoritative set of state-transition
 *  rules on every rail, as the C1.1 spec requires). */
export async function runExpirySweep(): Promise<SweepResult> {
  // ---- Phase A: groups. ONE primitive with /api/cron/expiry-sweep. --------
  // Group orders transition payment_pending → payment_expired with the group
  // claimed atomically — they can no longer be released order-by-order while
  // leaving the group claimable (the C1.1 race).
  const groupStats = await expireUnpaidPaymentGroups({ actor: "expiry-sweep" });

  // ---- Phase B: LEGACY single-PaymentIntent orders (paymentGroupId null). --
  const eligible = await db.order.findMany({
    where: {
      status: "payment_pending",
      paymentGroupId: null,
      paymentIntents: { some: { status: { in: ["requires_payment", "failed"] }, expiresAt: { lt: new Date() } } },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH,
  });

  let released = 0;
  let skipped = 0;
  const errors: { orderId: string; error: string }[] = [];
  // Sequential per-order processing keeps DB pressure bounded (pool=10); the
  // per-order claim makes concurrent workers redundant, not harmful.
  for (const o of eligible) {
    try {
      const outcome = await releaseOrderReservation({ orderId: o.id, actor: "expiry-sweep", reason: "expired unpaid" });
      if (outcome.released) released++;
      else skipped++;
    } catch (e) {
      // One failing order must not hide the rest of the batch.
      errors.push({ orderId: o.id, error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) });
    }
  }
  return { ...groupStats, scanned: eligible.length, released, skipped, errors, throttled: false };
}

// Phase 2.4 cleanup: `maybeRunExpirySweepLazy` (lazy in-process trigger) was
// removed — it had ZERO callers since introduction; both scheduler rails
// (/api/cron/expiry-sweep, /api/orders/expiry/tick) call runExpirySweep /
// expireUnpaidPaymentGroups directly.

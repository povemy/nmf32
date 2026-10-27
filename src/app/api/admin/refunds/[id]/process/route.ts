import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify, dispatchStoreWebhooks, transitionOrder } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postRefund, walletTruth } from "@/lib/ledger";
import { allocateProportionally, divHalfUp, formatMinor } from "@/lib/money";

type Ctx = { params: Promise<{ id: string }> };

// ============================================================================
// FIN-3a — REFUND PROCESS (the ONLY step that moves refund money)
//
// Money-move invariants (GLOBAL GUARD RULES 6/7/8):
//  1. The ledger T5, the refund status claim and ALL order bookkeeping commit
//     in ONE db.$transaction — no partial states.
//  2. The conditional updateMany claim + Order/Wallet row locks make the step
//     race-safe: concurrent processes on the same order serialize, and the
//     loser is rejected with 409 instead of double-posting.
//  3. Cumulative refunds (approved + processed) are re-validated against the
//     order total HERE — the seller request-time cap is not trusted (approvals
//     can race, legacy rows exist).
//  4. Wallet sufficiency is verified from ledger truth BEFORE T5: negative
//     seller balances are never silently created. The documented recovery path
//     for refunds after a payout is Admin → Wallets → Adjust (T6) → retry
//     (docs/finance-refund-policy.md).
// ============================================================================

/** Shape of the M09 commission snapshot stored on OrderItem.breakdownJson at
 *  checkout (src/lib/commission.ts breakdown object). Only the fields needed
 *  to reconstruct the customer-paid gross per line are declared. */
type StoredBreakdown = {
  percent_part?: unknown;
  fixed_fee_allocated?: unknown;
  discount_allocated?: unknown;
  shipping_allocated?: unknown;
};

/** Parse a stored breakdownJson. Returns null for legacy/absent snapshots —
 *  callers fall back to the pre-FIN-3a single-item percent rule. A usable
 *  snapshot must carry the allocation parts that reconstruct the customer-paid
 *  gross of the line (discount + shipping allocations) and both commission
 *  components (percent part + allocated fixed fee). */
function parseStoredBreakdown(json: string): StoredBreakdown | null {
  try {
    const v = JSON.parse(json) as StoredBreakdown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    return num(v.percent_part) && num(v.fixed_fee_allocated) && num(v.discount_allocated) && num(v.shipping_allocated)
      ? v
      : null;
  } catch {
    return null;
  }
}

type RefundItem = {
  id: string;
  lineSubtotalMinor: number;
  commissionPercent: number;
  commissionMinor: number;
  refundedMinor: number;
  breakdownJson: string;
};

export type CommissionReversalDerivation = {
  commissionReversalMinor: number;
  /** Which rule produced the number — recorded in the audit log for traceability. */
  rule: "breakdown_snapshot_proportional" | "single_item_percent_legacy";
};

/**
 * FIN-3a commission-reversal composition (fixes the single-item-percent gap).
 *
 * RULE (breakdown path — used when EVERY order item carries a valid M09
 * snapshot, i.e. all orders created by the current checkout):
 *   1. Customer-paid gross per item:
 *        gross_i = lineSubtotalMinor − discount_allocated + shipping_allocated
 *      (tax is currently always 0; the FIN-1 Option-B invariant guarantees
 *      Σ gross_i === order.totalMinor).
 *   2. The refund amount is allocated across items proportional to gross_i
 *      with `allocateProportionally` — the SAME helper and remainder-to-
 *      largest-line rule the checkout used for discount/shipping/fixed-fee
 *      splits.
 *   3. Per item the commission embedded in the refunded money is
 *        reversal_i = divHalfUp(alloc_i × commissionMinor_i, gross_i)
 *      i.e. the item's STORED commission (percent part + allocated fixed fee,
 *      whatever the snapshot says) taken at the same effective rate as the
 *      original order — this restores the fixed-fee allocation that the old
 *      `round(refund × oneItemPercent/100)` formula ignored.
 *   4. Σ reversal_i is clamped to [0, refundAmountMinor] and capped at the
 *      remaining reversible commission
 *        max(0, Σ item.commissionMinor − Σ prior PROCESSED refunds' stored
 *                 commissionReversalMinor)
 *      so cumulative reversals across multiple partial refunds can never
 *      exceed the commission the platform actually earned on the order.
 *   A FULL refund reproduces the stored composition exactly:
 *   alloc_i === gross_i ⇒ Σ reversal_i === Σ commissionMinor_i.
 *
 * FALLBACK (any item missing a valid snapshot — legacy/pre-M09 rows): the
 * pre-FIN-3a behavior, byte-compatible: first item with un-refunded capacity,
 * reversal = Math.round(refundAmount × item.commissionPercent / 100). No cap
 * is applied on this path so historical behavior is unchanged.
 *
 * This affects the NEW T5 posting only — stored financial history (past
 * LedgerTransactions / Refund.commissionReversalMinor) is never rewritten.
 */
function deriveCommissionReversal(input: {
  refundAmountMinor: number;
  items: RefundItem[];
  /** Σ commissionReversalMinor of prior PROCESSED refunds on this order. */
  priorProcessedReversalMinor: number;
}): CommissionReversalDerivation {
  const { refundAmountMinor, items, priorProcessedReversalMinor } = input;
  if (items.length === 0) return { commissionReversalMinor: 0, rule: "single_item_percent_legacy" };

  const breakdowns = items.map((it) => parseStoredBreakdown(it.breakdownJson));
  const allSnapshotsValid = breakdowns.every((b) => b !== null);

  if (!allSnapshotsValid) {
    // Legacy fallback — exactly the old rule (see doc block above).
    const item = items.find((it) => it.lineSubtotalMinor - it.refundedMinor > 0) ?? items[0];
    return {
      commissionReversalMinor: Math.round((refundAmountMinor * item.commissionPercent) / 100),
      rule: "single_item_percent_legacy",
    };
  }

  // 1) Customer-paid gross per item (breakdown path).
  const grossArr = items.map((it, i) => {
    const bd = breakdowns[i] as StoredBreakdown;
    const gross = it.lineSubtotalMinor - (bd.discount_allocated as number) + (bd.shipping_allocated as number);
    return Math.max(0, gross);
  });

  // 2) Refund allocated like checkout: proportional to gross, remainder to the
  //    largest line (allocateProportionally).
  const allocs = allocateProportionally(refundAmountMinor, grossArr);

  // 3) Effective stored commission per refunded share (integer half-up math —
  //    same rounding family as commissionOf at checkout).
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (grossArr[i] <= 0 || allocs[i] <= 0) continue;
    total += divHalfUp(allocs[i] * items[i].commissionMinor, grossArr[i]);
  }

  // 4) Sanity clamp + cumulative cap (never reverse more commission than the
  //    platform earned on this order across ALL its refunds).
  const orderCommissionMinor = items.reduce((s, it) => s + it.commissionMinor, 0);
  const remainingReversible = Math.max(0, orderCommissionMinor - priorProcessedReversalMinor);
  total = Math.min(Math.max(0, total), refundAmountMinor, remainingReversible);

  return { commissionReversalMinor: total, rule: "breakdown_snapshot_proportional" };
}

// POST /api/admin/refunds/[id]/process — posts ledger T5 + updates order/items/stock (RBAC refunds.manage)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("refunds.manage");
  const { id } = await ctx.params;

  // ---- Load refund + order (+items, wallet, ALL sibling refunds) in ONE place.
  const refund = await db.refund.findUnique({
    where: { id },
    include: {
      order: {
        include: {
          items: { orderBy: { id: "asc" } },
          store: { include: { seller: { include: { wallet: true } } } },
          refunds: true,
        },
      },
    },
  });
  if (!refund) throw new ApiError(404, "NOT_FOUND", "Refund not found");
  // Re-invocation guard (kept from pre-FIN-3a): a processed refund must never
  // run the money move again — the ledger replay below is the second net.
  if (refund.status === "processed") throw new ApiError(409, "ALREADY_PROCESSED", "Refund already processed");
  if (refund.status === "rejected") throw new ApiError(409, "CONFLICT", "Rejected refund cannot be processed");
  // FIN-3a (deviation, documented): processing a still-"requested" refund used
  // to be possible, which let money move WITHOUT the approval control. The
  // admin UI always approves first; enforce approve → process ordering so the
  // audit trail shows who authorized the money movement.
  if (refund.status !== "approved") {
    throw new ApiError(409, "NOT_APPROVED", "Refund must be approved before processing (approve first, then process)");
  }

  const order = refund.order;
  // Store.sellerId is nullable — a missing seller surfaces as the existing
  // NO_WALLET 400 instead of a TypeError 500.
  const wallet = order.store.seller?.wallet;
  if (!wallet) throw new ApiError(400, "NO_WALLET", "Seller has no wallet");

  // ---- 3a.1a Cumulative cap (fast-fail on the stale read; re-validated under
  // lock inside the tx). Approved refunds count: they are committed intents —
  // processing another refund past the total would over-commit the order.
  const cumulative = (statuses: string[], excludeCurrent: boolean) =>
    order.refunds
      .filter((r) => (!excludeCurrent || r.id !== refund.id) && statuses.includes(r.status))
      .reduce((s, r) => s + r.amountMinor, 0);
  const preCommitted = cumulative(["approved", "processed"], true) + refund.amountMinor;
  if (preCommitted > order.totalMinor) {
    // WHY: the seller request route caps single requests, but racing requests
    // or crafted/legacy rows can still sum past the total — the money move
    // must not trust request-time validation.
    throw new ApiError(
      409,
      "OVER_REFUND",
      `Over-refund blocked: cumulative refunds (${formatMinor(preCommitted, order.currency)}) would exceed the order total (${formatMinor(order.totalMinor, order.currency)})`
    );
  }

  // ---- 3a.2 Commission reversal composition (rule documented on the helper).
  const priorProcessedReversal = order.refunds
    .filter((r) => r.id !== refund.id && r.status === "processed")
    .reduce((s, r) => s + r.commissionReversalMinor, 0);

  const result = await db.$transaction(async (tx) => {
    // ---- Serialize concurrent refund processing per order. The cumulative
    // cap and wallet sufficiency are ORDER/WALLET-level invariants that a
    // per-refund claim cannot protect (two different refund rows = two
    // different claims). Locking the order row makes check-then-post atomic
    // against any other refund process on this order; every other flow that
    // touches this order/wallet acquires the same rows in a compatible order
    // (order → refund → wallet), so no deadlock cycle exists.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

    // ---- Re-read under the lock: fresh statuses/amounts (a sibling approve,
    // reject or process may have committed since the stale read above).
    const fresh = await tx.order.findUnique({
      where: { id: order.id },
      include: { items: { orderBy: { id: "asc" } }, refunds: true },
    });
    if (!fresh) throw new ApiError(404, "NOT_FOUND", "Order not found");
    const freshRefund = fresh.refunds.find((r) => r.id === refund.id);
    if (!freshRefund) throw new ApiError(404, "NOT_FOUND", "Refund not found");
    if (freshRefund.status === "processed") throw new ApiError(409, "ALREADY_PROCESSED", "Refund already processed");
    if (freshRefund.status === "rejected") throw new ApiError(409, "CONFLICT", "Rejected refund cannot be processed");
    if (freshRefund.status !== "approved") {
      throw new ApiError(409, "NOT_APPROVED", "Refund must be approved before processing (approve first, then process)");
    }

    // ---- Authoritative cumulative cap (fresh data, under the lock).
    const priorCommitted = fresh.refunds
      .filter((r) => r.id !== refund.id && (r.status === "approved" || r.status === "processed"))
      .reduce((s, r) => s + r.amountMinor, 0);
    const cumulativeRefunded = priorCommitted + refund.amountMinor;
    if (cumulativeRefunded > order.totalMinor) {
      throw new ApiError(
        409,
        "OVER_REFUND",
        `Over-refund blocked: cumulative refunds (${formatMinor(cumulativeRefunded, order.currency)}) would exceed the order total (${formatMinor(order.totalMinor, order.currency)})`
      );
    }

    // ---- Serialize against every other wallet-affecting flow (payouts,
    // adjustments, sibling refunds) before reading ledger truth: whoever
    // commits first wins, the next one checks the fresh balance.
    await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${wallet.id} FOR UPDATE`;

    // ---- 3a.1c Conditional claim FIRST (FIN-2a atomic-claim pattern): the
    // status flip is the race guard. count 0 ⇒ a concurrent update moved the
    // refund on ⇒ reject before any posting. On any throw below the whole tx
    // (claim included) rolls back — status is only "processed" if the money
    // actually moved.
    const claim = await tx.refund.updateMany({
      where: { id: refund.id, status: { not: "processed" } },
      data: { status: "processed", processedAt: new Date() },
    });
    if (claim.count === 0) throw new ApiError(409, "ALREADY_PROCESSED", "Refund already processed (concurrent update)");

    // ---- 3a.1b Wallet sufficiency BEFORE T5, from LEDGER TRUTH (not the
    // cached columns). WHY the full refund amount: T5 debits the seller wallet
    // for the seller share and the platform revenue account for the reversal;
    // requiring the whole amount available is deliberately conservative — the
    // wallet always retains headroom and a negative seller balance can never
    // be silently created (prompt rule 7). Refunds after a payout are exactly
    // the case this blocks; the documented recovery path is Admin → Wallets →
    // Adjust (T6, audited) to add funds, then process again
    // (docs/finance-refund-policy.md). No posting, no status flip on failure —
    // the throw rolls the claim back.
    const truth = await walletTruth(wallet.id, tx);
    if (truth.availableMinor < refund.amountMinor) {
      throw new ApiError(
        409,
        "INSUFFICIENT_WALLET",
        `Seller available balance (${formatMinor(truth.availableMinor, order.currency)}) cannot absorb this refund. Use Admin → Wallets → Adjust (T6) to add funds, then process again.`
      );
    }

    // ---- Derive the reversal from FRESH rows (prior processed refunds may
    // have changed under the lock — the cap must see them).
    const priorProcessedReversalFresh = fresh.refunds
      .filter((r) => r.id !== refund.id && r.status === "processed")
      .reduce((s, r) => s + r.commissionReversalMinor, 0);
    const reversal = deriveCommissionReversal({
      refundAmountMinor: refund.amountMinor,
      items: fresh.items,
      priorProcessedReversalMinor: priorProcessedReversalFresh,
    });
    const commissionReversalMinor = reversal.commissionReversalMinor;

    // ---- T5 — ledger refund (balanced): DR seller payable + DR commission
    // revenue | CR gateway. dedupKey `refund:refund:{refundId}` (FIN-1) makes
    // replays converge on the original posting instead of double-posting.
    const txn = await postRefund({
      orderId: order.id,
      orderNumber: order.orderNumber,
      walletId: wallet.id,
      provider: order.paymentProvider ?? "fpx_toyyibpay",
      amountMinor: refund.amountMinor,
      commissionReversalMinor,
      refundId: refund.id, // FIN-1: T5 dedup key is per Refund row
      tx,
    });

    // Persist the reversal on the Refund row — the pre-FIN-3a flow stored it
    // there (admin refunds list + audit consumers), so the semantics are
    // preserved; it commits atomically with the T5 that used the number.
    await tx.refund.update({ where: { id: refund.id }, data: { commissionReversalMinor } });

    // ---- Order-level bookkeeping, same tx. totalRefunded counts PROCESSED
    // refunds including this one (response semantics preserved).
    const priorProcessed = fresh.refunds
      .filter((r) => r.id !== refund.id && r.status === "processed")
      .reduce((s, r) => s + r.amountMinor, 0);
    const totalRefunded = priorProcessed + refund.amountMinor;
    const fullyRefunded = totalRefunded >= order.totalMinor;

    // advance order status (writes history row)
    await transitionOrder({
      orderId: order.id,
      toStatus: fullyRefunded ? "refunded" : "partially_refunded",
      actor: `admin:${admin.email}`,
      note: `Refund ${refund.amountMinor / 100} processed (reason: ${refund.reason ?? "n/a"})`,
      tx,
    });

    // item refund bookkeeping + optional restock (fresh refundedMinor under
    // the lock — a sibling process's allocation is never overwritten)
    const item = fresh.items.find((it) => it.lineSubtotalMinor - it.refundedMinor > 0) ?? fresh.items[0];
    if (!item) throw new ApiError(400, "NO_ITEMS", "Order has no items");
    const remaining = item.lineSubtotalMinor - item.refundedMinor;
    const applied = Math.min(refund.amountMinor, Math.max(0, remaining));
    await tx.orderItem.update({ where: { id: item.id }, data: { refundedMinor: item.refundedMinor + applied } });
    if (refund.restock && item.variantId) {
      await tx.productVariant.update({ where: { id: item.variantId }, data: { stock: { increment: item.qty } } });
      await tx.inventoryLog.create({
        data: { variantId: item.variantId, delta: item.qty, reason: "refund_restock", refId: refund.id },
      });
    }

    // gateway intent reflects refund
    await tx.paymentIntent.updateMany({
      where: { orderId: order.id, status: "succeeded" },
      data: { status: "refunded" },
    });

    return { txnId: txn.id, totalRefunded, fullyRefunded, commissionReversalMinor, reversalRule: reversal.rule };
  });

  // ---- Post-commit side effects (log-only; a failure here does not move
  // money — same semantics as before, just after an atomic commit).
  const processed = await db.refund.findUnique({ where: { id } });
  if (!processed) throw new ApiError(404, "NOT_FOUND", "Refund not found");

  // notifications: customer + seller
  await notify({
    event: "refund.approved",
    channel: "email",
    recipient: order.customerEmail,
    subject: `Refund processed for order ${order.orderNumber}`,
  });
  if (order.store.seller?.email) {
    await notify({
      event: "refund.approved",
      channel: "email",
      recipient: order.store.seller.email,
      subject: `Refund processed for order ${order.orderNumber}`,
    });
  }

  // store webhooks
  await dispatchStoreWebhooks({
    storeId: order.storeId,
    event: "order.refunded",
    payload: {
      orderNumber: order.orderNumber,
      refundId: refund.id,
      amountMinor: refund.amountMinor,
      commissionReversalMinor: result.commissionReversalMinor,
      status: result.fullyRefunded ? "refunded" : "partially_refunded",
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "refund.process",
    entityType: "refund",
    entityId: id,
    before: { status: refund.status, orderStatus: order.status, amountMinor: refund.amountMinor },
    after: {
      status: "processed",
      orderStatus: result.fullyRefunded ? "refunded" : "partially_refunded",
      totalRefundedMinor: result.totalRefunded,
      commissionReversalMinor: result.commissionReversalMinor,
      reversalRule: result.reversalRule,
      restocked: refund.restock,
      txnId: result.txnId,
    },
  });

  return ok({
    refund: processed,
    txnId: result.txnId,
    orderStatus: result.fullyRefunded ? "refunded" : "partially_refunded",
    totalRefundedMinor: result.totalRefunded,
  });
});

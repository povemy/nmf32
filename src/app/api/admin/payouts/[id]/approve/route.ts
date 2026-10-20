import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postPayoutInitiated, buildLedgerStatementFromLedger, refreshWalletCache } from "@/lib/ledger";
import { assertTransition } from "@/lib/payout-state";
import { rateLimit } from "@/lib/ratelimit";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/approve — seller payout request → processing.
// Posts T3 (DR SELLER:PAYABLE | CR PAYOUT_CLEARING) so the requested amount
// leaves the seller's available balance the moment finance approves — the
// same money movement a platform payout batch performs at initiation.
//
// FIN-2a ATOMIC CLAIM PATTERN (fixes double-spend TOCTOU):
// The old flow was read status → post ledger → unconditional update. Two
// concurrent approvals BOTH passed the status check and BOTH posted T3,
// double-spending the wallet. Now the money-critical steps run in ONE
// transaction whose FIRST statement is a conditional updateMany claim
// (requested → processing). updateMany is atomic at the row level: the loser
// of the race re-evaluates the WHERE clause against the winner's committed
// write, matches 0 rows, and is rejected before any ledger posting happens.
// FIN-3c: that transaction now also takes the Wallet row lock FOR UPDATE as
// its very first statement (see inline) so the balance re-verification reads
// ledger truth serialized against refund/adjust flows.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const rl = rateLimit(req, { limit: 20, windowMs: 60000 });
  if (!rl.ok) throw new ApiError(429, "RATE_LIMITED", "Too many requests, retry later");

  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  // Readable fast-fail (stale read) — the updateMany claim below is the real guard.
  assertTransition(payout.status, "processing");

  const seller = await db.seller.findUnique({
    where: { id: payout.sellerId },
    include: { store: { select: { name: true } } },
  });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  // Statement period: since the seller's previous PAID payout (fallback:
  // wallet creation). Ledger-derived numbers only — INTEGRITY RULE.
  // Built OUTSIDE the tx on purpose: buildLedgerStatementFromLedger reads
  // period aggregates via the plain db client (no tx param) and the statement
  // is a derived snapshot — it does not need to be transactional with the claim.
  const prevPaid = await db.payout.findFirst({
    where: { walletId: payout.walletId, status: "paid" },
    orderBy: { paidAt: "desc" },
    select: { paidAt: true },
  });
  const walletRow = await db.wallet.findUnique({ where: { id: payout.walletId }, select: { createdAt: true } });
  const periodFrom = prevPaid?.paidAt ?? walletRow?.createdAt ?? new Date(Date.now() - 30 * 86400000);
  const periodTo = new Date();
  const periodFromSafe = periodFrom > periodTo ? new Date(Date.now() - 30 * 86400000) : periodFrom;
  const orderCount = await db.order.count({
    where: { storeId: seller.store?.id, paidAt: { not: null, gte: periodFromSafe, lte: periodTo } },
  });
  const statementJson = await buildLedgerStatementFromLedger({
    walletId: payout.walletId,
    sellerName: seller.store?.name ?? seller.displayName,
    payoutAmountMinor: payout.amountMinor,
    orderCount,
    periodFrom: periodFromSafe,
    periodTo,
  });

  const txn = await db.$transaction(async (tx) => {
    // FIN-3c lock order: the Wallet row is locked FIRST inside this tx — the
    // refund flow locks Order→Wallet and approve locks Wallet only (no cycle),
    // so this serializes the balance re-verify below against an in-flight T5
    // (previously the truth read could pass on pre-refund ledger state).
    await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${payout.walletId} FOR UPDATE`;

    // 1) CLAIM — conditional update is the atomic race guard. If another
    // request already claimed (or the state moved on) this matches 0 rows.
    const claim = await tx.payout.updateMany({
      where: { id, status: "requested" },
      data: { status: "processing" },
    });
    if (claim.count === 0) {
      throw new ApiError(409, "CONFLICT", "Payout is not in requested state (or already claimed)");
    }

    // 2) Re-verify seller + balance inside the tx against ledger truth
    // (refunds/adjustments may have landed between request and approval).
    const sellerNow = await tx.seller.findUnique({ where: { id: payout.sellerId }, select: { id: true } });
    if (!sellerNow) throw new ApiError(404, "NOT_FOUND", "Seller not found");
    const truth = await refreshWalletCache(payout.walletId, tx);
    if (truth.availableMinor < payout.amountMinor) {
      // Defensive revert of the claim inside the same tx before failing. The
      // throw below aborts the transaction, which rolls the claim back anyway —
      // this explicit revert documents intent and keeps the invariant intact
      // even if the claim is ever moved outside the tx.
      await tx.payout.updateMany({
        where: { id, status: "processing" },
        data: { status: "requested" },
      });
      throw new ApiError(
        409,
        "INSUFFICIENT_BALANCE",
        `Seller available balance (${(truth.availableMinor / 100).toFixed(2)} MYR) no longer covers this request (${(payout.amountMinor / 100).toFixed(2)} MYR) — reject it instead`
      );
    }

    // 3) Money movement — T3 with FIN-1 dedupKey (`payout_initiated:payout:{id}`)
    // inside the same tx; a replay converges on the original posting.
    const txn = await postPayoutInitiated({
      walletId: payout.walletId,
      payoutId: payout.id,
      referenceNo: payout.referenceNo,
      amountMinor: payout.amountMinor,
      tx,
    });

    // 4) Derived fields last: the statement snapshot commits atomically with
    // the claim + T3, so a committed "processing" payout always has its statement.
    await tx.payout.update({ where: { id }, data: { statementJson } });
    return txn;
  });

  // FIN-3b (3b.1) — dedupKey pattern: each notification carries a stable
  // `{event}.{channel}:{payoutId}` key; the FIN-1 unique index on
  // (channel, dedupKey) makes any replayed delivery (retry, racing processor)
  // a silent skip instead of a duplicate email/in-app row.
  await notify({
    event: "payout.approved",
    channel: "email",
    recipient: seller.email,
    subject: `Payout ${payout.referenceNo} approved — transfer on the way`,
    dedupKey: `payout.approved.email:${payout.id}`,
  });
  await notify({
    event: "payout.approved",
    channel: "inapp",
    recipient: seller.email,
    subject: `Payout ${payout.referenceNo} approved`,
    dedupKey: `payout.approved.inapp:${payout.id}`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.request.approve",
    entityType: "payout",
    entityId: id,
    before: { status: payout.status, amountMinor: payout.amountMinor },
    after: { status: "processing", txnId: txn.id },
  });

  const updated = await db.payout.findUnique({ where: { id } });
  if (!updated) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  return ok(updated);
});

import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postPayoutInitiated, buildLedgerStatementFromLedger, refreshWalletCache } from "@/lib/ledger";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/approve — seller payout request → processing.
// Posts T3 (DR SELLER:PAYABLE | CR PAYOUT_CLEARING) so the requested amount
// leaves the seller's available balance the moment finance approves — the
// same money movement a platform payout batch performs at initiation.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  if (payout.status !== "requested") {
    throw new ApiError(409, "CONFLICT", `Payout is ${payout.status}, only requested payouts can be approved`);
  }

  const seller = await db.seller.findUnique({
    where: { id: payout.sellerId },
    include: { store: { select: { name: true } } },
  });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  // Re-verify available balance covers the request (refunds may have landed
  // between request and approval).
  const truth = await refreshWalletCache(payout.walletId);
  if (truth.availableMinor < payout.amountMinor) {
    throw new ApiError(
      409,
      "INSUFFICIENT_BALANCE",
      `Seller available balance (${(truth.availableMinor / 100).toFixed(2)} MYR) no longer covers this request (${(payout.amountMinor / 100).toFixed(2)} MYR) — reject it instead`
    );
  }

  // Statement period: since the seller's previous PAID payout (fallback:
  // wallet creation). Ledger-derived numbers only — INTEGRITY RULE.
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

  const txn = await postPayoutInitiated({
    walletId: payout.walletId,
    payoutId: payout.id,
    referenceNo: payout.referenceNo,
    amountMinor: payout.amountMinor,
  });

  const updated = await db.payout.update({
    where: { id },
    data: { status: "processing", statementJson },
  });

  await notify({
    event: "payout.approved",
    channel: "email",
    recipient: seller.email,
    subject: `Payout ${payout.referenceNo} approved — transfer on the way`,
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

  return ok(updated);
});

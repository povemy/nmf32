import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { walletTruth, buildLedgerStatementFromLedger } from "@/lib/ledger";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/sync — READ-ONLY reconciliation (RBAC payouts.manage).
//
// FIN-2a: payouts today are 100% manual — "the PSP is a human" (finance marks
// paid/failed from bank evidence). This endpoint is the reconciliation hook:
// it recomputes ledger truth vs the wallet cache, verifies the expected ledger
// postings exist (T3/T4/T4f via FIN-1 dedupKeys), and rebuilds the payout
// statement if it is missing or not ledger-derived. When a REAL PSP adapter
// lands, THIS is where provider-API status retrieval plugs in (fetch the PSP
// transfer state here, then drive transitions through the normal claim
// pattern — the endpoint itself still never flips status on its own).
//
// HARD RULES: never transitions status, never posts money, never touches the
// wallet cache. The ONLY write allowed is `statementJson` — a derived field.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  const wallet = await db.wallet.findUnique({ where: { id: payout.walletId } });
  if (!wallet) throw new ApiError(404, "NOT_FOUND", "Wallet not found");

  const findings: string[] = [];

  // ---------------------------------------------------------- wallet truth vs cache
  const truth = await walletTruth(payout.walletId);
  const cacheMatches = truth.availableMinor === wallet.availableMinor && truth.pendingMinor === wallet.pendingMinor;
  if (!cacheMatches) {
    findings.push(
      `wallet cache drift: available cache=${wallet.availableMinor} truth=${truth.availableMinor}, pending cache=${wallet.pendingMinor} truth=${truth.pendingMinor}`
    );
  }

  // ---------------------------------------------------------- expected ledger postings
  // dedupKeys are FIN-1 contract: payout_{initiated,confirmed,failed}:payout:{id}
  const [t3, t4, t4f] = await Promise.all([
    db.ledgerTransaction.findUnique({ where: { dedupKey: `payout_initiated:payout:${id}` }, select: { id: true } }),
    db.ledgerTransaction.findUnique({ where: { dedupKey: `payout_confirmed:payout:${id}` }, select: { id: true } }),
    db.ledgerTransaction.findUnique({ where: { dedupKey: `payout_failed:payout:${id}` }, select: { id: true } }),
  ]);
  const expectedTxns = { T3: t3 != null, T4: t4 != null, T4f: t4f != null };

  const status = payout.status;
  if (["processing", "paid", "failed"].includes(status)) {
    // T3 must exist for anything past "requested" (failed keeps T3 + T4f).
    if (!t3) findings.push(`T3 (payout_initiated) missing but status is ${status}`);
  } else if (t3) {
    findings.push(`T3 (payout_initiated) present but status is ${status} — no money should have moved yet`);
  }
  if (status === "paid" && !t4) findings.push("T4 (payout_confirmed) missing but status is paid");
  if (status === "failed" && !t4f) findings.push("T4f (payout_failed) missing but status is failed");
  if (status === "processing" && t4) findings.push("T4 (payout_confirmed) present but status is processing");
  if (status === "processing" && t4f) findings.push("T4f (payout_failed) present but status is processing");
  if (status === "rejected" && (t3 || t4 || t4f)) {
    findings.push("ledger postings exist but status is rejected — rejected requests never move money");
  }
  if (status === "returned" || status === "reversed") {
    findings.push(`status ${status} is webhook-only/future — no PSP adapter wired yet, postings not reconciled`);
  }

  // ---------------------------------------------------------- statement rebuild (the only allowed write)
  let statementRebuilt = false;
  if ((status === "processing" || status === "paid") && !statementLooksValid(payout.statementJson)) {
    const seller = await db.seller.findUnique({
      where: { id: payout.sellerId },
      include: { store: { select: { id: true, name: true } } },
    });
    if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

    // Same period logic as approve: since the seller's previous PAID payout
    // (fallback: wallet creation → 30d). For an already-paid payout we must
    // exclude ITSELF from the prevPaid lookup or the period would start at its
    // own paidAt and aggregate nothing.
    const prevPaid = await db.payout.findFirst({
      where: { walletId: payout.walletId, status: "paid", id: { not: payout.id } },
      orderBy: { paidAt: "desc" },
      select: { paidAt: true },
    });
    const periodFrom = prevPaid?.paidAt ?? wallet.createdAt ?? new Date(Date.now() - 30 * 86400000);
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
    await db.payout.update({ where: { id: payout.id }, data: { statementJson } });
    statementRebuilt = true;
    findings.push("statementJson rebuilt from ledger (was missing/malformed or not ledger-derived)");
  }

  const report = {
    payoutId: id,
    status,
    walletTruth: truth,
    cacheMatches,
    expectedTxns,
    statementRebuilt,
    findings,
  };

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.sync",
    entityType: "payout",
    entityId: id,
    before: null,
    after: report,
  });

  return ok(report);
});

/** A statement is valid only if it is the ledger-derived shape
 *  (buildLedgerStatementFromLedger output: reconciled + lines + periodFrom).
 *  Legacy buildPayoutStatement snapshots (decorated numbers) and the "{}"
 *  default are treated as malformed → rebuilt from the ledger. */
function statementLooksValid(json: string | null | undefined): boolean {
  if (!json) return false;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const p = parsed as { reconciled?: unknown; lines?: unknown; periodFrom?: unknown };
    return p.reconciled === true && Array.isArray(p.lines) && typeof p.periodFrom === "string";
  } catch {
    return false;
  }
}

import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { ACCOUNTS, safeRefreshWalletCache } from "@/lib/ledger";
import { parseMaybeJson } from "@/app/api/admin/_helpers";
import type { SellerWallet, SellerWalletLine, SellerWalletData, SellerPayoutRow } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/wallet — ledger-truth wallet + recent lines + payouts.
// Refresh-on-read keeps the cache self-healing; safeRefresh means a concurrent
// payment tx holding the wallet row degrades to last-known values (with a
// fresh truth fallback) instead of 500ing the seller's money view.
export const GET = handle(async () => {
  const { me } = await requireActiveSellerStore();

  const wallet = await db.wallet.findUnique({ where: { sellerId: me.id } });
  if (!wallet) throw new ApiError(404, "NOT_FOUND", "Wallet not found");

  const refreshed = await safeRefreshWalletCache(wallet.id);
  const fresh = refreshed.refreshed
    ? await db.wallet.findUnique({ where: { id: wallet.id } })
    : refreshed.cached;

  const [recentLines, payouts, minSetting] = await Promise.all([
    db.ledgerLine.findMany({
      where: { accountCode: ACCOUNTS.sellerPayable(wallet.id) },
      include: { txn: { select: { id: true, txnType: true, description: true, occurredAt: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.payout.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.setting.findUnique({ where: { key: "payout.min_minor" } }),
  ]);

  const openRequest = payouts.find((p) => p.status === "requested") ?? null;

  // The wallet row was confirmed above; the refresh path only re-reads it.
  const walletView: SellerWallet = {
    ...fresh!,
    createdAt: fresh!.createdAt.toISOString(),
    updatedAt: fresh!.updatedAt.toISOString(),
  };
  const lines: SellerWalletLine[] = recentLines.map((r) => ({
    ...r,
    availableAt: r.availableAt ? r.availableAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    txn: { ...r.txn, occurredAt: r.txn.occurredAt.toISOString() },
  }));
  const payoutRows: SellerPayoutRow[] = payouts.map((p) => ({
    ...p,
    paidAt: p.paidAt ? p.paidAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
  const payload: SellerWalletData = {
    wallet: walletView,
    recentLines: lines,
    payouts: payoutRows,
    minPayoutMinor: parseMaybeJson<number>(minSetting?.valueJson, 1000),
    openRequest: openRequest
      ? { id: openRequest.id, referenceNo: openRequest.referenceNo, amountMinor: openRequest.amountMinor, createdAt: openRequest.createdAt.toISOString() }
      : null,
  };
  return ok(payload);
});

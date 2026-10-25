import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { ACCOUNTS, safeRefreshWalletCache } from "@/lib/ledger";
import { parseMaybeJson } from "@/app/api/admin/_helpers";

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

  return ok({
    wallet: fresh,
    recentLines,
    payouts,
    minPayoutMinor: parseMaybeJson<number>(minSetting?.valueJson, 1000),
    openRequest: openRequest
      ? { id: openRequest.id, referenceNo: openRequest.referenceNo, amountMinor: openRequest.amountMinor, createdAt: openRequest.createdAt }
      : null,
  });
});

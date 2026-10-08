import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { ACCOUNTS, refreshWalletCache } from "@/lib/ledger";

export const dynamic = "force-dynamic";

// GET /api/store/wallet — ledger-truth wallet + recent lines + payouts.
export const GET = handle(async () => {
  const { me } = await requireActiveSellerStore();

  const wallet = await db.wallet.findUnique({ where: { sellerId: me.id } });
  if (!wallet) throw new ApiError(404, "NOT_FOUND", "Wallet not found");

  await refreshWalletCache(wallet.id);
  const fresh = await db.wallet.findUnique({ where: { id: wallet.id } });

  const [recentLines, payouts] = await Promise.all([
    db.ledgerLine.findMany({
      where: { accountCode: ACCOUNTS.sellerPayable(wallet.id) },
      include: { txn: { select: { id: true, txnType: true, description: true, occurredAt: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.payout.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  return ok({ wallet: fresh, recentLines, payouts });
});

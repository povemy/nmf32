import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseStatement } from "@/lib/ledger";

export const dynamic = "force-dynamic";

// GET /api/store/payouts — payout history for the seller's wallet.
export const GET = handle(async () => {
  const { me } = await requireActiveSellerStore();
  const wallet = await db.wallet.findUnique({ where: { sellerId: me.id } });
  const payouts = wallet
    ? await db.payout.findMany({
        where: { walletId: wallet.id },
        include: { batch: { select: { id: true, runType: true, status: true } } },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    : [];
  return ok(payouts.map((p) => ({ ...p, statement: parseStatement(p.statementJson) })));
});

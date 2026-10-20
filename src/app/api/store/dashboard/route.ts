import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { refreshWalletCache } from "@/lib/ledger";

export const dynamic = "force-dynamic";

type Card = { orders: number; revenueMinor: number; commissionMinor: number; netMinor: number };

const EMPTY: Card = { orders: 0, revenueMinor: 0, commissionMinor: 0, netMinor: 0 };

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/store/dashboard — cards, low stock, latest orders, pending actions.

/** R2-UI — ledger-truth wallet snapshot for the dashboard e-wallet card:
 *  refresh the cached Wallet columns from the ledger (same pattern as
 *  /api/store/wallet) then read them back; a seller without a wallet yet
 *  degrades to zeros so the dashboard never breaks. */
async function loadWalletSummary(sellerId: string): Promise<{ availableMinor: number; pendingMinor: number }> {
  const wallet = await db.wallet.findUnique({ where: { sellerId } });
  if (!wallet) return { availableMinor: 0, pendingMinor: 0 };
  await refreshWalletCache(wallet.id);
  const fresh = await db.wallet.findUnique({ where: { id: wallet.id } });
  return { availableMinor: fresh?.availableMinor ?? 0, pendingMinor: fresh?.pendingMinor ?? 0 };
}

export const GET = handle(async () => {
  const { me, store } = await requireActiveSellerStore();
  const now = new Date();
  const t0 = startOfToday();
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);

  const paidOrders = await db.order.findMany({
    // TS1117 fix (R2-UI): the two `paidAt` keys were merged — Prisma ANDs the
    // conditions, so this is behavior-identical to the previous duplicate key.
    where: { storeId: store.id, paidAt: { not: null, gte: d30 } },
    include: { items: { select: { commissionMinor: true } } },
  });

  const cards: Record<string, Card> = { today: { ...EMPTY }, "7d": { ...EMPTY }, "30d": { ...EMPTY } };
  const inWindow = (paidAt: Date, from: Date) => paidAt >= from;
  for (const o of paidOrders) {
    const paidAt = o.paidAt as Date;
    const commission = o.items.reduce((s, i) => s + i.commissionMinor, 0);
    const windows: [string, boolean][] = [
      ["today", inWindow(paidAt, t0)],
      ["7d", inWindow(paidAt, d7)],
      ["30d", true],
    ];
    for (const [key, hit] of windows) {
      if (!hit) continue;
      cards[key].orders += 1;
      cards[key].revenueMinor += o.totalMinor;
      cards[key].commissionMinor += commission;
      cards[key].netMinor += o.totalMinor - commission;
    }
  }

  const [lowStock, latestOrders, unfulfilled, refundRequests, pendingProducts, wallet] = await Promise.all([
    db.productVariant.findMany({
      where: {
        isActive: true,
        stock: { lte: 100000 },
        product: { is: { storeId: store.id, status: { notIn: ["archived", "banned"] } } },
      },
      include: { product: { select: { id: true, title: true, slug: true, status: true } } },
      orderBy: { stock: "asc" },
      take: 50,
    }),
    db.order.findMany({
      where: { storeId: store.id },
      include: { items: { select: { id: true } } },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    db.order.count({ where: { storeId: store.id, status: { in: ["paid", "processing"] } } }),
    db.refund.count({ where: { order: { is: { storeId: store.id } }, status: "requested" } }),
    db.product.count({ where: { storeId: store.id, status: "pending_review" } }),
    loadWalletSummary(me.id),
  ]);

  return ok({
    cards,
    // R2-UI — e-wallet snapshot (available + pending from ledger truth).
    wallet,
    lowStock: lowStock
      .filter((v) => v.stock <= v.lowStockThreshold)
      .slice(0, 10)
      .map((v) => ({
        id: v.id,
        name: v.name,
        optionValue: v.optionValue,
        sku: v.sku,
        stock: v.stock,
        lowStockThreshold: v.lowStockThreshold,
        productId: v.product.id,
        productTitle: v.product.title,
      })),
    latestOrders: latestOrders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      status: o.status,
      totalMinor: o.totalMinor,
      itemCount: o.items.length,
      createdAt: o.createdAt,
    })),
    pendingActions: {
      unfulfilledPaidOrders: unfulfilled,
      openRefundRequests: refundRequests,
      productsPendingReview: pendingProducts,
    },
  });
});

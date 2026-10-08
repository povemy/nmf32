import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { dayKey, startOfToday, daysAgo } from "@/app/api/admin/_helpers";

// GET /api/admin/dashboard — command centre KPIs
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();

  const todayStart = startOfToday();
  const d30Start = daysAgo(29);
  d30Start.setHours(0, 0, 0, 0);

  const [
    ordersTodayAgg,
    ordersTodayCount,
    commissionToday,
    activeStores,
    pendingKyc,
    productsToModerate,
    refundsQueue,
    disputesOpen,
    wallets,
    seriesOrders,
    topStoreGroups,
    stores,
    recentSellers,
  ] = await Promise.all([
    // GMV today
    db.order.aggregate({ where: { paidAt: { gte: todayStart, not: null } }, _sum: { totalMinor: true } }),
    db.order.count({ where: { paidAt: { gte: todayStart, not: null } } }),
    // commission today = sum commissionMinor on items of orders paid today
    db.orderItem.findMany({ where: { order: { paidAt: { gte: todayStart } } }, select: { commissionMinor: true } }),
    db.store.count({ where: { status: "live" } }),
    db.seller.count({ where: { status: "pending_review" } }),
    db.product.count({ where: { status: "pending_review" } }),
    db.refund.count({ where: { status: "requested" } }),
    db.dispute.count({ where: { status: { in: ["open", "under_review"] } } }),
    db.wallet.findMany({ select: { availableMinor: true } }),
    // 30d series (compute per-day in JS)
    db.order.findMany({
      where: { paidAt: { gte: d30Start, not: null } },
      select: { paidAt: true, totalMinor: true },
    }),
    // top stores by 30d GMV
    db.order.groupBy({
      by: ["storeId"],
      where: { paidAt: { gte: d30Start, not: null } },
      _sum: { totalMinor: true },
      _count: { _all: true },
      orderBy: { _sum: { totalMinor: "desc" } },
      take: 5,
    }),
    db.store.findMany({ select: { id: true, name: true } }),
    db.seller.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, displayName: true, status: true, createdAt: true, store: { select: { name: true } } },
    }),
  ]);

  // payouts due: wallets with availableMinor >= 1000 (RM 10.00)
  const dueWallets = wallets.filter((w) => w.availableMinor >= 1000);

  // gmv series 30d
  const seriesMap = new Map<string, { gmvMinor: number; orders: number }>();
  for (let i = 0; i < 30; i++) {
    seriesMap.set(dayKey(daysAgo(29 - i)), { gmvMinor: 0, orders: 0 });
  }
  for (const o of seriesOrders) {
    const key = o.paidAt ? dayKey(o.paidAt) : "";
    if (key && seriesMap.has(key)) {
      const cell = seriesMap.get(key)!;
      cell.gmvMinor += o.totalMinor;
      cell.orders += 1;
    }
  }

  const storeNameById = new Map(stores.map((s) => [s.id, s.name]));

  return ok({
    gmvTodayMinor: ordersTodayAgg._sum.totalMinor ?? 0,
    ordersToday: ordersTodayCount,
    commissionTodayMinor: commissionToday.reduce((s, it) => s + it.commissionMinor, 0),
    activeStores,
    pendingKyc,
    productsToModerate,
    refundsQueue,
    disputesOpen,
    payoutsDueMinor: dueWallets.reduce((s, w) => s + w.availableMinor, 0),
    payoutsDueSellers: dueWallets.length,
    gmvSeries30d: [...seriesMap.entries()].map(([date, v]) => ({ date, gmvMinor: v.gmvMinor, orders: v.orders })),
    topStores: topStoreGroups.map((g) => ({
      storeName: storeNameById.get(g.storeId) ?? "Unknown store",
      gmv30dMinor: g._sum.totalMinor ?? 0,
      orders30d: g._count._all,
    })),
    recentSellers: recentSellers.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      storeName: s.store?.name ?? null,
      status: s.status,
      createdAt: s.createdAt,
    })),
  });
});

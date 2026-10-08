import { NextRequest } from "next/server";
import { handle, ok, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { dayKey, daysAgo } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ type: string }> };

// GET /api/admin/reports/[type]?days=30 — type in sales | sellers | commission | payouts
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAdmin();
  const { type } = await ctx.params;
  if (!["sales", "sellers", "commission", "payouts"].includes(type)) {
    throw new ApiError(400, "BAD_TYPE", "type must be sales | sellers | commission | payouts");
  }

  const url = new URL(req.url);
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
  const since = daysAgo(days - 1);
  since.setHours(0, 0, 0, 0);

  if (type === "payouts") {
    const batches = await db.payoutBatch.findMany({
      include: { payouts: { orderBy: { createdAt: "asc" } } },
      orderBy: { startedAt: "desc" },
    });
    const payouts = batches.flatMap((b) => b.payouts);

    // seller names resolved manually (no relation declared on Payout)
    const sellerIds = [...new Set(payouts.map((p) => p.sellerId))];
    const sellers = sellerIds.length
      ? await db.seller.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, displayName: true, email: true, store: { select: { name: true } } },
        })
      : [];
    const sMap = new Map(sellers.map((s) => [s.id, s]));
    const sellerNameOf = (sellerId: string) => {
      const s = sMap.get(sellerId);
      return s?.store?.name ?? s?.displayName ?? "Unknown";
    };

    return ok({
      batches: batches.map((b) => ({
        id: b.id,
        runType: b.runType,
        status: b.status,
        totalMinor: b.totalMinor,
        payoutCount: b.payoutCount,
        startedAt: b.startedAt,
        finishedAt: b.finishedAt,
        payouts: b.payouts.map((p) => ({
          id: p.id,
          referenceNo: p.referenceNo,
          sellerName: sellerNameOf(p.sellerId),
          amountMinor: p.amountMinor,
          status: p.status,
          method: p.method,
          paidAt: p.paidAt,
        })),
      })),
      totals: {
        totalMinor: payouts.reduce((s, p) => s + p.amountMinor, 0),
        count: payouts.length,
        paidMinor: payouts.filter((p) => p.status === "paid").reduce((s, p) => s + p.amountMinor, 0),
        processingMinor: payouts.filter((p) => p.status === "processing").reduce((s, p) => s + p.amountMinor, 0),
        failedMinor: payouts.filter((p) => p.status === "failed").reduce((s, p) => s + p.amountMinor, 0),
        batchCount: batches.length,
      },
      days,
    });
  }

  // sales / sellers / commission — all built from paid orders in window
  const orders = await db.order.findMany({
    where: { paidAt: { gte: since, not: null } },
    select: {
      id: true,
      paidAt: true,
      totalMinor: true,
      store: { select: { id: true, name: true } },
      items: {
        select: {
          commissionMinor: true,
          lineSubtotalMinor: true,
          product: { select: { category: { select: { name: true } } } },
        },
      },
    },
    orderBy: { paidAt: "asc" },
  });

  // day series (fills gaps with zero days)
  const seriesMap = new Map<string, { gmvMinor: number; orders: number; commissionMinor: number }>();
  for (let i = 0; i < days; i++) {
    const d = daysAgo(days - 1 - i);
    seriesMap.set(dayKey(d), { gmvMinor: 0, orders: 0, commissionMinor: 0 });
  }
  const byStore = new Map<string, { storeName: string; gmvMinor: number; orders: number; commissionMinor: number; itemsValue: number }>();
  const byCategory = new Map<string, number>();
  let totalGmv = 0;
  let totalCommission = 0;
  let totalItems = 0;

  for (const o of orders) {
    const key = o.paidAt ? dayKey(o.paidAt) : "";
    const commission = o.items.reduce((s, it) => s + it.commissionMinor, 0);
    totalGmv += o.totalMinor;
    totalCommission += commission;
    totalItems += o.items.length;

    if (key && seriesMap.has(key)) {
      const cell = seriesMap.get(key)!;
      cell.gmvMinor += o.totalMinor;
      cell.orders += 1;
      cell.commissionMinor += commission;
    }

    const sid = o.store.id;
    const storeCell = byStore.get(sid) ?? { storeName: o.store.name, gmvMinor: 0, orders: 0, commissionMinor: 0, itemsValue: 0 };
    storeCell.gmvMinor += o.totalMinor;
    storeCell.orders += 1;
    storeCell.commissionMinor += commission;
    storeCell.itemsValue += o.items.reduce((s, it) => s + it.lineSubtotalMinor, 0);
    byStore.set(sid, storeCell);

    for (const it of o.items) {
      const cat = it.product?.category?.name ?? "Uncategorised";
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + it.commissionMinor);
    }
  }

  if (type === "sales") {
    const series = [...seriesMap.entries()].map(([date, v]) => ({ date, ...v }));
    return ok({
      series,
      totals: {
        gmvMinor: totalGmv,
        orders: orders.length,
        commissionMinor: totalCommission,
        aovMinor: orders.length ? Math.round(totalGmv / orders.length) : 0,
      },
      days,
    });
  }

  if (type === "sellers") {
    const rows = [...byStore.values()]
      .map((r) => ({
        storeName: r.storeName,
        gmvMinor: r.gmvMinor,
        orders: r.orders,
        commissionMinor: r.commissionMinor,
        aovMinor: r.orders ? Math.round(r.gmvMinor / r.orders) : 0,
      }))
      .sort((a, b) => b.gmvMinor - a.gmvMinor);
    return ok({
      rows,
      totals: { gmvMinor: totalGmv, orders: orders.length, commissionMinor: totalCommission, stores: rows.length },
      days,
    });
  }

  // commission report
  const gmvBase = [...byStore.values()].reduce((s, r) => s + r.itemsValue, 0);
  return ok({
    series: [...seriesMap.entries()].map(([date, v]) => ({ date, commissionMinor: v.commissionMinor, gmvMinor: v.gmvMinor, orders: v.orders })),
    byCategory: [...byCategory.entries()]
      .map(([categoryName, commissionMinor]) => ({ categoryName, commissionMinor }))
      .sort((a, b) => b.commissionMinor - a.commissionMinor),
    effectiveRate: totalGmv > 0 ? Math.round((totalCommission / totalGmv) * 10000) / 100 : 0,
    totals: { commissionMinor: totalCommission, gmvMinor: totalGmv, items: totalItems, itemsValueMinor: gmvBase },
    days,
  });
});

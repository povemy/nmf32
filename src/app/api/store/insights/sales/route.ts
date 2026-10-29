import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  parseInsightsWindow,
  insightsCached,
  paidOrdersFor,
  aggregateSales,
  processedRefundsFor,
  salesTrend,
  fulfillmentInsights,
  funnelFor,
} from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// GET /api/store/insights/sales?window=...&granularity=day|week|month[&fresh=1]
// Sales & order performance from AUTHORITATIVE order/refund records only.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url);

  const granRaw = url.searchParams.get("granularity") ?? "day";
  if (!["day", "week", "month"].includes(granRaw)) {
    throw new ApiError(400, "VALIDATION", "granularity must be day|week|month");
  }
  const granularity = granRaw as "day" | "week" | "month";

  const cacheKey = `sales:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}:${granularity}`;
  const data = await insightsCached(cacheKey, url, async () => {
    const [paidOrders, paidPrev, refunds, refundsPrev, cancelled, cancelledPrev, trend, fulfillment, funnel] = await Promise.all([
      paidOrdersFor(store.id, win.from, win.to),
      paidOrdersFor(store.id, win.prevFrom, win.prevTo),
      processedRefundsFor(store.id, win.from, win.to),
      processedRefundsFor(store.id, win.prevFrom, win.prevTo),
      // cancelled in window = cancelledAt basis (pending/cancelled are never paid sales)
      db.order.count({ where: { storeId: store.id, cancelledAt: { gte: win.from, lt: win.to } } }),
      db.order.count({ where: { storeId: store.id, cancelledAt: { gte: win.prevFrom, lt: win.prevTo } } }),
      salesTrend(store.id, win, granularity),
      fulfillmentInsights(store.id),
      funnelFor(store.id, win),
    ]);

    const sales = aggregateSales(paidOrders);
    const salesPrev = aggregateSales(paidPrev);

    // Top products by net sales (paid orders in window)
    const perProduct = new Map<string, { title: string; units: number; net: number }>();
    const productsNeeded = new Set<string>();
    for (const o of paidOrders) {
      for (const it of o.items) {
        if (!it.productId) continue;
        productsNeeded.add(it.productId);
        const p = perProduct.get(it.productId) ?? { title: "", units: 0, net: 0 };
        p.units += it.qty;
        p.net += it.lineSubtotalMinor - it.discountMinor - it.refundedMinor;
        perProduct.set(it.productId, p);
      }
    }
    if (productsNeeded.size > 0) {
      const prods = await db.product.findMany({ where: { id: { in: [...productsNeeded] }, storeId: store.id }, select: { id: true, title: true } });
      for (const p of prods) {
        const entry = perProduct.get(p.id);
        if (entry) entry.title = p.title;
      }
    }
    const topProducts = [...perProduct.entries()]
      .map(([productId, p]) => ({ productId, title: p.title || "(deleted product)", units: p.units, netSalesMinor: p.net }))
      .filter((p) => p.title !== "(deleted product)")
      .sort((a, b) => b.netSalesMinor - a.netSalesMinor)
      .slice(0, 10);

    const storeVisits = funnel.stages.find((s) => s.key === "store_visit")?.count ?? 0;

    return {
      window: { key: win.key, from: win.from.toISOString(), to: win.to.toISOString(), prevFrom: win.prevFrom.toISOString(), prevTo: win.prevTo.toISOString(), days: win.days },
      generatedAt: new Date().toISOString(),
      cards: {
        paidOrders: sales.paidOrders,
        paidOrdersPrev: salesPrev.paidOrders,
        unitsSold: sales.unitsSold,
        unitsSoldPrev: salesPrev.unitsSold,
        grossSalesMinor: sales.grossSalesMinor,
        grossSalesMinorPrev: salesPrev.grossSalesMinor,
        grossProductSalesMinor: sales.grossProductSalesMinor,
        grossProductSalesMinorPrev: salesPrev.grossProductSalesMinor,
        discountsMinor: sales.discountsMinor,
        discountsMinorPrev: salesPrev.discountsMinor,
        shippingChargedMinor: sales.shippingChargedMinor,
        shippingChargedMinorPrev: salesPrev.shippingChargedMinor,
        sellerProceedsMinor: sales.sellerProceedsMinor,
        sellerProceedsMinorPrev: salesPrev.sellerProceedsMinor,
        refundedItemsMinor: sales.refundedItemsMinor,
        refundsMinor: refunds.amountMinor,
        refundsMinorPrev: refundsPrev.amountMinor,
        refundCount: refunds.count,
        refundCountPrev: refundsPrev.count,
        cancelledOrders: cancelled,
        cancelledOrdersPrev: cancelledPrev,
        aovMinor: sales.paidOrders > 0 ? Math.round(sales.grossSalesMinor / sales.paidOrders) : null,
        aovMinorPrev: salesPrev.paidOrders > 0 ? Math.round(salesPrev.grossSalesMinor / salesPrev.paidOrders) : null,
        netProductSalesMinor: sales.grossProductSalesMinor - sales.discountsMinor - refunds.amountMinor,
        visitToPurchaseRate: storeVisits > 0 ? Math.round((sales.paidOrders / storeVisits) * 1000) / 10 : null,
      },
      byDay: trend.trend,
      granularity: trend.granularity,
      topProducts,
      fulfillment,
      notes: [
        "Sales are counted by payment-success date (paidAt). Refunds are counted by their own processed date — a refund of an order paid in an earlier period appears here in the period it was processed (this is why sales and refund figures never silently restate each other).",
        "Gross sales (order GMV) includes shipping and is net of discounts. Gross product sales excludes shipping. Net product sales = gross product sales − discounts − refunds processed in the window (refund money is order-level; shipping-only refunds are not separable in the current data model).",
        "Seller proceeds = Σ item sellerNet (commission already deducted, payout holds applied via the ledger). Platform commission is NOT seller revenue. Pending/unpaid/cancelled orders are excluded from sales figures.",
        "Visit→purchase rate uses tracked store visits (post-release traffic data only) over paid orders — it is an estimate, not an exact conversion of all historical visitors.",
      ],
    };
  });

  return ok(data);
});

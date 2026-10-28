import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  parseInsightsWindow,
  insightsCached,
  trafficSummary,
  funnelFor,
  cartActivity,
  currentCartSnapshot,
  aggregateSales,
  paidOrdersFor,
  processedRefundsFor,
  freshnessFor,
  buildObservations,
} from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// GET /api/store/insights/overview?window=today|7d|30d|custom&from&to[&fresh=1]
// Store traffic + conversion funnel + summary cards + evidence-gated observations.
// Seller-scoped: the store is resolved from the SESSION (requireActiveSellerStore),
// never from query parameters.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url);
  const cacheKey = `overview:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}`;

  const data = await insightsCached(cacheKey, url, async () => {
    const [traffic, funnel, cart, snapshot, paidOrders, paidPrev, refunds, refundsPrev, freshness] = await Promise.all([
      trafficSummary(store.id, win),
      funnelFor(store.id, win),
      cartActivity(store.id, win),
      currentCartSnapshot(store.id),
      paidOrdersFor(store.id, win.from, win.to),
      paidOrdersFor(store.id, win.prevFrom, win.prevTo),
      processedRefundsFor(store.id, win.from, win.to),
      processedRefundsFor(store.id, win.prevFrom, win.prevTo),
      freshnessFor(store.id),
    ]);
    const sales = aggregateSales(paidOrders);
    const salesPrev = aggregateSales(paidPrev);

    const visitToPurchase = funnel.stages.find((s) => s.key === "store_visit");
    const purchase = funnel.stages.find((s) => s.key === "purchase");

    return {
      window: { key: win.key, from: win.from.toISOString(), to: win.to.toISOString(), prevFrom: win.prevFrom.toISOString(), prevTo: win.prevTo.toISOString(), days: win.days },
      generatedAt: new Date().toISOString(),
      freshness: {
        eventsUpTo: freshness.eventsUpTo,
        trackingSince: freshness.trackingSince,
        note: freshness.trackingSince ? null : "Traffic tracking starts from zero — no historical visitor data exists before this feature was released. Sales metrics use complete historical order records.",
      },
      traffic,
      funnel,
      summary: {
        orders: sales.paidOrders,
        ordersPrev: salesPrev.paidOrders,
        unitsSold: sales.unitsSold,
        unitsSoldPrev: salesPrev.unitsSold,
        grossSalesMinor: sales.grossSalesMinor,
        grossSalesMinorPrev: salesPrev.grossSalesMinor,
        grossProductSalesMinor: sales.grossProductSalesMinor,
        netProductSalesMinor: sales.grossProductSalesMinor - sales.discountsMinor - refunds.amountMinor,
        refundsMinor: refunds.amountMinor,
        refundsMinorPrev: refundsPrev.amountMinor,
        refundCount: refunds.count,
        aovMinor: sales.paidOrders > 0 ? Math.round(sales.grossSalesMinor / sales.paidOrders) : null,
        aovMinorPrev: salesPrev.paidOrders > 0 ? Math.round(salesPrev.grossSalesMinor / salesPrev.paidOrders) : null,
        cartAddUnits: cart.addUnits,
        cartAddUnitsPrev: cart.addUnitsPrev,
        activeCartsNow: snapshot.activeCarts,
        unitsInCartsNow: snapshot.totalUnits,
        visitToPurchaseRate:
          visitToPurchase && purchase && visitToPurchase.count > 0
            ? Math.round((purchase.count / visitToPurchase.count) * 1000) / 10
            : null,
      },
      observations: buildObservations({
        traffic,
        funnel,
        snapshot,
        sales: { paidOrders: sales.paidOrders, paidOrdersPrev: salesPrev.paidOrders, unitsSold: sales.unitsSold, grossSalesMinor: sales.grossSalesMinor },
        addUnits: cart.addUnits,
        addUnitsPrev: cart.addUnitsPrev,
      }),
    };
  });

  return ok(data);
});

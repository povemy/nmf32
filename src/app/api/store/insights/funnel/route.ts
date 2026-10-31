import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  parseInsightsWindow,
  insightsCached,
  funnelReportFor,
  productFunnelFor,
  freshnessFor,
} from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// GET /api/store/insights/funnel?window=today|7d|30d|1y[&productId=<id>][&fresh=1]
// Conversion funnel + per-day stage series for the interactive funnel diagram.
//
// Scope:
//   • no productId            → store-wide funnel (5 stages, unchanged contract)
//   • productId=<product id>  → PRODUCT-scoped funnel (4 stages: Viewed this
//     product → Added to cart → Checkout started → Paid orders) plus sales
//     context (units sold, gross product revenue, paid-order count). The
//     product is resolved against the CALLER'S OWN store (ownership-checked in
//     productFunnelFor — a valid id from another store is a 404, never
//     cross-store data).
//
// Every response also carries `products` — the products with tracked
// product_view / add_to_cart activity in the window (ranked by views, capped
// at 60 with an honest productsTruncated flag) — which powers the per-product
// selector in the funnel card.
//
// The ONLY insights route that accepts window=1y (rolling 365 d) — opt-in via
// parseInsightsWindow({ allowYearly: true }); the shared window contract
// (markets-api.md §2.3) is unchanged for every other route.
// Seller-scoped: the store is resolved from the SESSION (requireActiveSellerStore),
// never from query parameters. Stage numbers come from the same shared math as
// the overview route's funnel (buildFunnelStages / withDropOff) — never
// re-derived client-side.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url, { allowYearly: true });

  const rawProductId = url.searchParams.get("productId");
  if (rawProductId != null && (rawProductId.length < 10 || rawProductId.length > 64)) {
    throw new ApiError(400, "VALIDATION", "productId must be a product identifier");
  }

  const cacheKey = `funnel:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}:${rawProductId ?? "store"}`;

  const data = await insightsCached(cacheKey, url, async () => {
    const [report, freshness] = await Promise.all([
      rawProductId ? productFunnelFor(store.id, rawProductId, win) : funnelReportFor(store.id, win),
      freshnessFor(store.id),
    ]);
    const product = "product" in report ? report.product : null;
    const byDayNote =
      product == null
        ? "Daily series: visit → cart stages count DISTINCT sessions per calendar day (Kuala Lumpur) — a session spanning midnight counts on both days, so daily values can sum above the window total. Checkout and paid rows are exact per-day order counts."
        : "Daily series: view/cart stages count DISTINCT sessions per calendar day (Kuala Lumpur) for THIS product — a session spanning midnight counts on both days, so daily values can sum above the window total. Checkout and paid rows are exact per-day counts of orders containing this product.";
    return {
      scope: product == null ? "store" : "product",
      product,
      products: report.products,
      productsTruncated: report.productsTruncated,
      window: { key: win.key, from: win.from.toISOString(), to: win.to.toISOString(), prevFrom: win.prevFrom.toISOString(), prevTo: win.prevTo.toISOString(), days: win.days },
      generatedAt: new Date().toISOString(),
      freshness: {
        eventsUpTo: freshness.eventsUpTo,
        trackingSince: freshness.trackingSince,
        note: freshness.trackingSince ? null : "Traffic tracking starts from zero — no historical visitor data exists before this feature was released. Sales metrics use complete historical order records.",
      },
      stages: report.stages,
      byDay: report.byDay,
      truncated: report.truncated,
      paymentAttempts: report.paymentAttempts,
      paymentAttemptsPrev: report.paymentAttemptsPrev,
      basis: [...report.basis, byDayNote],
    };
  });

  return ok(data);
});

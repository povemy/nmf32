import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  parseInsightsWindow,
  insightsCached,
  productTrafficTop,
  productTrafficDetail,
} from "@/lib/analytics/queries";

export const dynamic = "force-dynamic"; // HMR ping 2

// GET /api/store/insights/product-traffic?window=today|7d|30d|1y[&productId=][&fresh=1]
// ---------------------------------------------------------------------------
// Per-product traffic for the Overview "Top viewed products" card:
//   • NO productId  → the top-8 most viewed products of the window, each with
//     view/cart-add/cart-remove/purchase movement (the card list + row stats).
//   • productId=…   → the drill-down detail for ONE product: view channels
//     (direct / search / social / internal / other), top referrer hosts,
//     views-by-day series and the same cart/purchase totals.
//
// The card carries its OWN Daily/Weekly/Monthly/Yearly filter (independent of
// the page window, like the conversion-funnel diagram), hence the yearly
// opt-in: parseInsightsWindow(allowYearly) accepts 1y here. Event pulls stay
// bounded by the shared 20k eventsFor guard; retention purges older events
// anyway — traffic honestly shows only what exists.
//
// Seller-scoped like every insights route: the store resolves from the SESSION
// (requireActiveSellerStore), never from query parameters; a productId that
// does not belong to this store answers 404.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url, { allowYearly: true });
  const productId = url.searchParams.get("productId");
  if (productId != null && !/^[a-zA-Z0-9_-]{1,64}$/.test(productId)) {
    throw new ApiError(400, "VALIDATION", "productId must be a product id");
  }

  const windowInfo = {
    key: win.key,
    from: win.from.toISOString(),
    to: win.to.toISOString(),
    prevFrom: win.prevFrom.toISOString(),
    prevTo: win.prevTo.toISOString(),
    days: win.days,
  };

  if (productId) {
    const cacheKey = `ptraffic:${store.id}:d:${productId}:${win.key}:${win.from.getTime()}:${win.to.getTime()}`;
    const data = await insightsCached(cacheKey, url, () => productTrafficDetail(store.id, productId, win));
    if (!data) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Unknown product for this store");
    return ok({
      window: windowInfo,
      generatedAt: new Date().toISOString(),
      ...data,
      notes: [
        "Views are first-party product-page views (deduplicated per session per product per hour); unique viewers count distinct browsing sessions.",
        "Channels classify the LAST tagged or referring visit: campaign links (UTM/nmcl) are the most reliable, then the referrer hostname; direct = typed URLs, bookmarks and referrer-stripping apps.",
        "Internal = navigation inside NOMOFEE — marketplace pages, storefront pages and in-app search all land there.",
        "Cart adds/removes are applied cart transitions (units actually added or removed); guest activity counts units but is not tied to a logged-in account.",
        "Purchases come from authoritative paid-order records (orders + units with paidAt in the window) — never from client beacons.",
      ],
    });
  }

  const cacheKey = `ptraffic:${store.id}:top:${win.key}:${win.from.getTime()}:${win.to.getTime()}`;
  const data = await insightsCached(cacheKey, url, () => productTrafficTop(store.id, win));
  return ok({
    window: windowInfo,
    generatedAt: new Date().toISOString(),
    ...data,
  });
});

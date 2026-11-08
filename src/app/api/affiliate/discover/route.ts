import { handle, ok } from "@/lib/api";
import { requireAffiliate, getAffiliateSettings } from "@/lib/affiliate";
import { discoverProducts } from "@/lib/affiliate-queries";
import type { DiscoverQuery, DiscoverActiveData, DiscoverPausedData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/affiliate/discover — participating products only (spec §3.B).
// Filters: category, q, store, min rate, max price, sort, pagination.
export const GET = handle(async (req: Request) => {
  await requireAffiliate();
  const settings = await getAffiliateSettings();
  if (!settings.enabled) {
    const payload: DiscoverPausedData = { rows: [], total: 0, paused: true };
    return ok(payload);
  }
  const url = new URL(req.url);
  const sortParam = url.searchParams.get("sort");
  const sort = (["rate", "price_asc", "price_desc", "sales", "newest", "featured"] as const).find((s) => s === sortParam);
  const query: DiscoverQuery = {
    category: url.searchParams.get("category") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    store: url.searchParams.get("store") ?? undefined,
    minRate: url.searchParams.get("minRate") ? Number(url.searchParams.get("minRate")) : undefined,
    maxPrice: url.searchParams.get("maxPrice") ? Number(url.searchParams.get("maxPrice")) : undefined,
    sort,
    page: Number(url.searchParams.get("page") ?? 1) || 1,
    size: Number(url.searchParams.get("size") ?? 24) || 24,
  };
  const { rows, total } = await discoverProducts({
    categorySlug: query.category,
    q: query.q,
    storeSlug: query.store,
    minRateBps: query.minRate,
    maxPriceMinor: query.maxPrice,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });
  const payload: DiscoverActiveData = { rows, total, maxRateBps: settings.maxRateBps };
  return ok(payload);
});

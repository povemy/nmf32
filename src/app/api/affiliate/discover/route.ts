import { handle, ok } from "@/lib/api";
import { requireAffiliate, getAffiliateSettings } from "@/lib/affiliate";
import { discoverProducts } from "@/lib/affiliate-queries";

export const dynamic = "force-dynamic";

// GET /api/affiliate/discover — participating products only (spec §3.B).
// Filters: category, q, store, min rate, max price, sort, pagination.
export const GET = handle(async (req: Request) => {
  await requireAffiliate();
  const settings = await getAffiliateSettings();
  if (!settings.enabled) return ok({ rows: [], total: 0, paused: true });
  const url = new URL(req.url);
  const sortParam = url.searchParams.get("sort");
  const sort = (["rate", "price_asc", "price_desc", "sales", "newest", "featured"] as const).find((s) => s === sortParam);
  const { rows, total } = await discoverProducts({
    categorySlug: url.searchParams.get("category") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    storeSlug: url.searchParams.get("store") ?? undefined,
    minRateBps: url.searchParams.get("minRate") ? Number(url.searchParams.get("minRate")) : undefined,
    maxPriceMinor: url.searchParams.get("maxPrice") ? Number(url.searchParams.get("maxPrice")) : undefined,
    sort,
    page: Number(url.searchParams.get("page") ?? 1) || 1,
    size: Number(url.searchParams.get("size") ?? 24) || 24,
  });
  return ok({ rows, total, maxRateBps: settings.maxRateBps });
});

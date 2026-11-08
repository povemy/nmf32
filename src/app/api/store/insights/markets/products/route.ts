import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { parseInsightsWindow, insightsCached, marketProducts } from "@/lib/analytics/queries";
import type { InsightsMarketProductsData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/insights/markets/products?window=...&dimension=country|state&code=MY|Johor[&fresh=1]
// Product performance inside one geographic market (S4).
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url);

  const dimRaw = url.searchParams.get("dimension") ?? "country";
  const code = url.searchParams.get("code") ?? "";
  if (!["country", "state"].includes(dimRaw)) {
    throw new ApiError(400, "VALIDATION", "dimension must be country|state");
  }
  if (!code || code.length > 64) {
    throw new ApiError(400, "VALIDATION", "code is required (a country code or state name)");
  }
  const dimension = dimRaw as "country" | "state";

  const cacheKey = `marketproducts:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}:${dimension}:${code}`;
  const data = await insightsCached(cacheKey, url, async (): Promise<InsightsMarketProductsData> => {
    const report = await marketProducts(store.id, win, dimension, code);
    return {
      window: { key: win.key, from: win.from.toISOString(), to: win.to.toISOString(), prevFrom: win.prevFrom.toISOString(), prevTo: win.prevTo.toISOString(), days: win.days },
      generatedAt: new Date().toISOString(),
      dimension,
      code,
      ...report,
    };
  });

  return ok(data);
});

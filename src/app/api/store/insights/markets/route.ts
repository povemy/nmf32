import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { parseInsightsWindow, insightsCached, marketReport } from "@/lib/analytics/queries";
import type { InsightsMarketsData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/insights/markets?window=...&dimension=country|state[&fresh=1]
// Sales by destination geography (country snapshot or recorded state).
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url);

  const dimRaw = url.searchParams.get("dimension") ?? "country";
  if (!["country", "state"].includes(dimRaw)) {
    throw new ApiError(400, "VALIDATION", "dimension must be country|state");
  }
  const dimension = dimRaw as "country" | "state";

  const cacheKey = `markets:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}:${dimension}`;
  const data = await insightsCached(cacheKey, url, async (): Promise<InsightsMarketsData> => {
    const report = await marketReport(store.id, win, dimension);
    return {
      window: { key: win.key, from: win.from.toISOString(), to: win.to.toISOString(), prevFrom: win.prevFrom.toISOString(), prevTo: win.prevTo.toISOString(), days: win.days },
      generatedAt: new Date().toISOString(),
      ...report,
    };
  });

  return ok(data);
});

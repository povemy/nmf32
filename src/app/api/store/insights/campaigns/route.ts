import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { parseInsightsWindow, insightsCached, campaignReport } from "@/lib/analytics/queries";
import type { InsightsCampaignsData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/insights/campaigns?window=today|7d|30d|custom&from&to[&fresh=1]
// Marketing Intelligence — first-party campaign attribution report:
// seller-generated campaign links + raw validated UTM traffic, each joined to
// the authoritative attributed-order records. Seller-scoped (session-resolved
// store), rate-limited, 45 s TTL cache with fresh=1 bypass — same conventions
// as every other insights route.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url);
  const cacheKey = `campaigns:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}`;

  const data = await insightsCached(cacheKey, url, async (): Promise<InsightsCampaignsData> => {
    const report = await campaignReport(store.id, win);
    return {
      window: { key: win.key, from: win.from.toISOString(), to: win.to.toISOString(), prevFrom: win.prevFrom.toISOString(), prevTo: win.prevTo.toISOString(), days: win.days },
      generatedAt: new Date().toISOString(),
      ...report,
    };
  });

  return ok(data);
});

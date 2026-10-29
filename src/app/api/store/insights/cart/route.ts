import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { parseInsightsWindow, insightsCached, cartActivity, currentCartSnapshot, freshnessFor } from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// GET /api/store/insights/cart?window=...[&fresh=1]
// Historical cart activity (events) + CURRENT live cart snapshot (separate, as
// required: adds-in-period ≠ units-still-in-carts).
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url);
  const cacheKey = `cart:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}`;

  const data = await insightsCached(cacheKey, url, async () => {
    const [activity, snapshot, freshness] = await Promise.all([
      cartActivity(store.id, win),
      currentCartSnapshot(store.id),
      freshnessFor(store.id),
    ]);
    return {
      window: { key: win.key, from: win.from.toISOString(), to: win.to.toISOString(), prevFrom: win.prevFrom.toISOString(), prevTo: win.prevTo.toISOString(), days: win.days },
      generatedAt: new Date().toISOString(),
      freshness: { eventsUpTo: freshness.eventsUpTo, trackingSince: freshness.trackingSince },
      period: activity,
      current: snapshot,
    };
  });

  return ok(data);
});

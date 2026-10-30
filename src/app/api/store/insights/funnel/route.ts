import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  parseInsightsWindow,
  insightsCached,
  funnelReportFor,
  freshnessFor,
} from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// GET /api/store/insights/funnel?window=today|7d|30d|1y[&fresh=1]
// Conversion funnel + per-day stage series for the interactive funnel diagram.
// The ONLY insights route that accepts window=1y (rolling 365 d) — opt-in via
// parseInsightsWindow({ allowYearly: true }); the shared window contract
// (markets-api.md §2.3) is unchanged for every other route.
// Seller-scoped: the store is resolved from the SESSION (requireActiveSellerStore),
// never from query parameters. Stage numbers come from the same shared math as
// the overview route's funnel (buildFunnelStages) — never re-derived client-side.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url, { allowYearly: true });
  const cacheKey = `funnel:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}`;

  const data = await insightsCached(cacheKey, url, async () => {
    const [report, freshness] = await Promise.all([funnelReportFor(store.id, win), freshnessFor(store.id)]);
    return {
      window: { key: win.key, from: win.from.toISOString(), to: win.to.toISOString(), prevFrom: win.prevFrom.toISOString(), prevTo: win.prevFrom.toISOString(), days: win.days },
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
      basis: [
        ...report.basis,
        "Daily series: visit → cart stages count DISTINCT sessions per calendar day (Kuala Lumpur) — a session spanning midnight counts on both days, so daily values can sum above the window total. Checkout and paid rows are exact per-day order counts.",
      ],
    };
  });

  return ok(data);
});

import { handle, okPaged, ApiError, getPagination } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { parseInsightsWindow, insightsCached, productPerformance, type ProductSort } from "@/lib/analytics/queries";
import type { InsightsProductPerformanceData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

const SORTS: ProductSort[] = ["views", "adds", "cartQty", "purchases", "revenue", "conversion"];

// GET /api/store/insights/products?window=...&sort=views|adds|cartQty|purchases|revenue|conversion&page=1&size=20[&fresh=1]
// Product performance table (paged, sortable) — views, cart activity, current
// cart quantity, purchases, revenue and conversion columns.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights", 60, 60_000);
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const win = parseInsightsWindow(url);
  const { page, size } = getPagination(url, 50);

  const sortRaw = url.searchParams.get("sort") ?? "views";
  if (!SORTS.includes(sortRaw as ProductSort)) {
    throw new ApiError(400, "VALIDATION", `sort must be one of ${SORTS.join("|")}`);
  }
  const sort = sortRaw as ProductSort;

  const cacheKey = `products:${store.id}:${win.key}:${win.from.getTime()}:${win.to.getTime()}:${sort}:${page}:${size}`;
  const data = await insightsCached(cacheKey, url, async (): Promise<InsightsProductPerformanceData> => {
    const perf = await productPerformance(store.id, win, sort, page, size);
    return {
      rows: perf.rows,
      meta: { page, size, total: perf.total },
      notes: [
        "Views/cart-adds are event-based (tracked since the analytics feature was released); purchases and revenue come from authoritative paid-order records and cover full history.",
        "View→cart rate = sessions that viewed AND then added this product ÷ sessions that viewed it (same window). Checkout→purchase = units in paid orders ÷ units in orders created.",
        "Current cart quantity is a live snapshot (not windowed); purchased/refunded metrics use the selected window.",
      ],
    };
  });

  return okPaged(data, data.meta);
});

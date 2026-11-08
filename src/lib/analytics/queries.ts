// Seller Insights — server-side query/aggregation engine.
//
// Design contract (agent-ctx/SI-PLAN.md + docs/seller-insights/metric-definitions.md):
//  • Money metrics derive ONLY from authoritative Order/OrderItem/Refund records
//    (paidAt basis for sales; processedAt basis for refunds — documented).
//  • Traffic metrics derive from the AnalyticsEvent log (post-release data only).
//  • All queries are store-scoped (storeId passed by the caller AFTER ownership
//    was resolved from the session — never from client input) and bounded
//    (window ≤ 92 days; series computed over ≤ 20k events with an honest
//    `truncated` flag; product tables paginated).
//  • Results are cached per (route, store, params) for 45s on globalThis
//    (house TTL-cache pattern; `fresh=1` bypasses).
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Timezone + window handling — Asia/Kuala_Lumpur (UTC+8, no DST): the platform's
// documented default (Store.timezone) and the seller audience. "Today" and all
// day buckets use KL day boundaries regardless of server clock.
// ---------------------------------------------------------------------------
const KL_OFFSET_MS = 8 * 3_600_000;
const MAX_WINDOW_DAYS = 92;

export type InsightsWindow = {
  key: "today" | "7d" | "30d" | "1y" | "custom";
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  days: number;
};

function klDayKey(d: Date): string {
  return new Date(d.getTime() + KL_OFFSET_MS).toISOString().slice(0, 10);
}
function klStartOfToday(): Date {
  const kl = new Date(new Date().getTime() + KL_OFFSET_MS);
  return new Date(Date.UTC(kl.getUTCFullYear(), kl.getUTCMonth(), kl.getUTCDate()) - KL_OFFSET_MS);
}
function klDayStart(ymd: string): Date {
  const kl = new Date(`${ymd}T00:00:00.000Z`); // interpreted as KL wall clock
  return new Date(kl.getTime() - KL_OFFSET_MS);
}

export function parseInsightsWindow(url: URL, opts: { allowYearly?: boolean } = {}): InsightsWindow {
  const raw = url.searchParams.get("window") ?? "30d";
  const now = new Date();
  let from: Date;
  let to: Date = now;
  if (raw === "today") {
    from = klStartOfToday();
  } else if (raw === "7d" || raw === "30d") {
    from = new Date(now.getTime() - (raw === "7d" ? 7 : 30) * 86_400_000);
  } else if (raw === "1y" && opts.allowYearly) {
    // Rolling 365-day window — OPT-IN (funnel route only). Not part of the
    // shared window contract documented in markets-api.md §2.3: the other
    // insight routes keep today|7d|30d|custom (≤ 92 d) so their order pulls
    // stay inside the documented bounded-window envelope. Event scans here
    // remain bounded by the 20 k `eventsFor` guard; retention purges older
    // events anyway (traffic honestly shows only what exists).
    from = new Date(now.getTime() - 365 * 86_400_000);
  } else if (raw === "custom") {
    const fromStr = url.searchParams.get("from") ?? "";
    const toStr = url.searchParams.get("to") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
      throw new ApiError(400, "VALIDATION", "custom window requires from=YYYY-MM-DD and to=YYYY-MM-DD");
    }
    from = klDayStart(fromStr);
    to = new Date(klDayStart(toStr).getTime() + 86_400_000); // inclusive end day
    if (from >= to) throw new ApiError(400, "VALIDATION", "custom window `from` must be before `to`");
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      throw new ApiError(400, "VALIDATION", `custom window cannot exceed ${MAX_WINDOW_DAYS} days`);
    }
    if (to > now) to = now;
  } else {
    throw new ApiError(400, "VALIDATION", `window must be one of today|7d|30d|custom${opts.allowYearly ? "|1y" : ""}`);
  }
  const len = to.getTime() - from.getTime();
  return {
    key: raw,
    from,
    to,
    prevFrom: new Date(from.getTime() - len),
    prevTo: from,
    days: Math.max(1, Math.round(len / 86_400_000)),
  };
}

// ---------------------------------------------------------------------------
// TTL cache (house pattern: globalThis + ?fresh=1 bypass, like /api/health).
// ---------------------------------------------------------------------------
type CacheEntry = { at: number; value: unknown };
const gCache = globalThis as typeof globalThis & { __siInsightsCache?: Map<string, CacheEntry> };
function cacheStore(): Map<string, CacheEntry> {
  if (!gCache.__siInsightsCache) gCache.__siInsightsCache = new Map();
  return gCache.__siInsightsCache;
}
export async function insightsCached<T>(key: string, url: URL, compute: () => Promise<T>, ttlMs = 45_000): Promise<T> {
  if (url.searchParams.get("fresh") === "1") return compute();
  const store = cacheStore();
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await compute();
  store.set(key, { at: Date.now(), value });
  if (store.size > 500) {
    // bounded: drop the 200 oldest entries
    const entries = [...store.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 200);
    for (const [k] of entries) store.delete(k);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Shared types + small helpers
// ---------------------------------------------------------------------------
export type PrevDelta<T> = { value: T; prev: T };

const COUNTRY_LABELS: Record<string, string> = { MY: "Malaysia", ZZ: "Unspecified" };
const MY_STATES = [
  "Johor", "Kedah", "Kelantan", "Kuala Lumpur", "Labuan", "Melaka", "Negeri Sembilan",
  "Pahang", "Penang", "Perak", "Perlis", "Putrajaya", "Sabah", "Sarawak", "Selangor", "Terengganu",
];

function pct(value: number, prev: number): { pct: number | null; isNew: boolean } {
  if (prev <= 0) return { pct: null, isNew: value > 0 };
  return { pct: Math.round(((value - prev) / prev) * 1000) / 10, isNew: false };
}
function rate(num: number, den: number): number | null {
  if (den <= 0) return null;
  return Math.round((num / den) * 1000) / 10;
}

type EventRow = { eventType: string; sessionId: string | null; visitorId: string | null; shopperId: string | null; productId: string | null; qty: number | null; channel: string | null; referrerHost: string | null; createdAt: Date };

/** Bounded event fetch for a store window (≤ 20k rows; sets `truncated` if hit). */
async function eventsFor(storeId: string, from: Date, to: Date): Promise<{ rows: EventRow[]; truncated: boolean }> {
  const rows = await db.analyticsEvent.findMany({
    where: { storeId, createdAt: { gte: from, lt: to } },
    select: { eventType: true, sessionId: true, visitorId: true, shopperId: true, productId: true, qty: true, channel: true, referrerHost: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 20_001,
  });
  const truncated = rows.length > 20_000;
  return { rows: truncated ? rows.slice(0, 20_000) : rows, truncated };
}

function sessionKey(e: EventRow): string | null {
  if (e.sessionId) return e.sessionId;
  if (e.shopperId) return `u:${e.shopperId}`;
  return null;
}

// ---------------------------------------------------------------------------
// Orders: paid-order item aggregation (authoritative money source)
// ---------------------------------------------------------------------------
export type PaidOrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  paidAt: Date | null;
  createdAt: Date;
  cancelledAt: Date | null;
  shippedAt: Date | null;
  totalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  discountMinor: number;
  shippingCountryCode: string;
  shippingCountrySource: string;
  shippingAddressJson: string;
  items: Array<{
    productId: string | null;
    qty: number;
    lineSubtotalMinor: number;
    discountMinor: number;
    shippingMinor: number;
    sellerNetMinor: number;
    refundedMinor: number;
  }>;
};

export async function paidOrdersFor(storeId: string, from: Date, to: Date): Promise<PaidOrderRow[]> {
  return db.order.findMany({
    where: { storeId, paidAt: { gte: from, lt: to } },
    select: {
      id: true, orderNumber: true, status: true, paidAt: true, createdAt: true, cancelledAt: true,
      shippedAt: true, totalMinor: true, shippingMinor: true, taxMinor: true, discountMinor: true,
      shippingCountryCode: true, shippingCountrySource: true, shippingAddressJson: true,
      items: { select: { productId: true, qty: true, lineSubtotalMinor: true, discountMinor: true, shippingMinor: true, sellerNetMinor: true, refundedMinor: true } },
    },
  });
}

export type SalesAgg = {
  paidOrders: number;
  unitsSold: number;
  grossProductSalesMinor: number;
  discountsMinor: number;
  shippingChargedMinor: number;
  grossSalesMinor: number; // order GMV: products + shipping − discounts (+ tax)
  sellerProceedsMinor: number;
  refundedItemsMinor: number; // cumulative refundedMinor on items of these orders
};

export function aggregateSales(orders: PaidOrderRow[]): SalesAgg {
  const agg: SalesAgg = {
    paidOrders: orders.length, unitsSold: 0, grossProductSalesMinor: 0, discountsMinor: 0,
    shippingChargedMinor: 0, grossSalesMinor: 0, sellerProceedsMinor: 0, refundedItemsMinor: 0,
  };
  for (const o of orders) {
    agg.grossSalesMinor += o.totalMinor;
    for (const it of o.items) {
      agg.unitsSold += it.qty;
      agg.grossProductSalesMinor += it.lineSubtotalMinor;
      agg.discountsMinor += it.discountMinor;
      agg.shippingChargedMinor += it.shippingMinor;
      agg.sellerProceedsMinor += it.sellerNetMinor;
      agg.refundedItemsMinor += it.refundedMinor;
    }
  }
  return agg;
}

/** Refunds PROCESSED in a window (order-level money; refund-date basis). */
export async function processedRefundsFor(storeId: string, from: Date, to: Date): Promise<{ count: number; amountMinor: number }> {
  const rows = await db.refund.findMany({
    where: { status: "processed", processedAt: { gte: from, lt: to }, order: { storeId } },
    select: { amountMinor: true },
  });
  return { count: rows.length, amountMinor: rows.reduce((s, r) => s + r.amountMinor, 0) };
}

// ---------------------------------------------------------------------------
// Traffic + funnel
// ---------------------------------------------------------------------------
export type TrafficSummary = {
  storeViews: number; storeViewsPrev: number;
  sessions: number; sessionsPrev: number;
  uniqueVisitors: number; uniqueVisitorsPrev: number;
  productViews: number; productViewsPrev: number;
  byDay: Array<{ day: string; storeViews: number; productViews: number }>;
  channels: Array<{ channel: string; views: number; sessions: number }>;
  topViewedProducts: Array<{ productId: string; title: string; slug: string; imageUrl: string | null; views: number }>;
  truncated: boolean;
};

export async function trafficSummary(storeId: string, win: InsightsWindow): Promise<TrafficSummary> {
  const [cur, prev] = await Promise.all([eventsFor(storeId, win.from, win.to), eventsFor(storeId, win.prevFrom, win.prevTo)]);

  const views = cur.rows.filter((e) => e.eventType === "store_view");
  const pviews = cur.rows.filter((e) => e.eventType === "product_view");
  const sessions = new Set(views.map(sessionKey).filter((x): x is string => Boolean(x)));
  const visitors = new Set(cur.rows.map((e) => e.visitorId).filter((x): x is string => Boolean(x)));
  const prevViews = prev.rows.filter((e) => e.eventType === "store_view");
  const prevSessions = new Set(prevViews.map(sessionKey).filter((x): x is string => Boolean(x)));
  const prevVisitors = new Set(prev.rows.map((e) => e.visitorId).filter((x): x is string => Boolean(x)));

  // Daily series (KL day buckets)
  const dayMap = new Map<string, { storeViews: number; productViews: number }>();
  for (let d = new Date(win.from); d < win.to; d = new Date(d.getTime() + 86_400_000)) {
    dayMap.set(klDayKey(d), { storeViews: 0, productViews: 0 });
  }
  for (const e of [...views, ...pviews]) {
    const k = klDayKey(e.createdAt);
    const slot = dayMap.get(k) ?? { storeViews: 0, productViews: 0 };
    if (e.eventType === "store_view") slot.storeViews += 1;
    else slot.productViews += 1;
    dayMap.set(k, slot);
  }

  // Channels (store_view events only; sessions = distinct session per channel)
  const chanMap = new Map<string, { views: number; sessions: Set<string> }>();
  for (const e of views) {
    const ch = e.channel ?? "direct";
    const slot = chanMap.get(ch) ?? { views: 0, sessions: new Set<string>() };
    slot.views += 1;
    const sk = sessionKey(e);
    if (sk) slot.sessions.add(sk);
    chanMap.set(ch, slot);
  }

  // Top viewed products (join titles/images from the store's own products only)
  const viewCounts = new Map<string, number>();
  for (const e of pviews) {
    if (e.productId) viewCounts.set(e.productId, (viewCounts.get(e.productId) ?? 0) + 1);
  }
  const topIds = [...viewCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
  const products = topIds.length
    ? await db.product.findMany({ where: { id: { in: topIds }, storeId }, select: { id: true, title: true, slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  return {
    storeViews: views.length,
    storeViewsPrev: prevViews.length,
    sessions: sessions.size,
    sessionsPrev: prevSessions.size,
    uniqueVisitors: visitors.size,
    uniqueVisitorsPrev: prevVisitors.size,
    productViews: pviews.length,
    productViewsPrev: prev.rows.filter((e) => e.eventType === "product_view").length,
    byDay: [...dayMap.entries()].map(([d, v]) => ({ day: d, ...v })),
    channels: [...chanMap.entries()].map(([channel, v]) => ({ channel, views: v.views, sessions: v.sessions.size })).sort((a, b) => b.views - a.views),
    topViewedProducts: topIds
      .map((id) => {
        const p = byId.get(id);
        return p ? { productId: id, title: p.title, slug: p.slug, imageUrl: p.images[0]?.url ?? null, views: viewCounts.get(id) ?? 0 } : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x)),
    truncated: cur.truncated || prev.truncated,
  };
}

// ---------------------------------------------------------------------------
// Product traffic — per-product view sources + cart/purchase movement.
// Powers the Overview "Top viewed products" card (own D/W/M/Y window) and its
// drill-down modal (channels, referrer hosts, by-day views, cart movement).
// Same honesty rules as the rest of Seller Insights: views/cart come from the (HMR ping)
// bounded event pull; purchases come from authoritative paid-order items.
// ---------------------------------------------------------------------------

export type ProductTrafficTotals = {
  views: number;
  uniqueViewers: number;
  cartAddTimes: number;
  cartAddUnits: number;
  cartRemoveTimes: number;
  cartRemoveUnits: number;
  purchaseOrders: number;
  purchaseUnits: number;
};

export type ProductTrafficRow = ProductTrafficTotals & {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
};

export type ProductTrafficDetail = {
  product: { id: string; title: string; slug: string; imageUrl: string | null };
  totals: ProductTrafficTotals;
  channels: Array<{ channel: string; views: number; sessions: number }>;
  referrers: Array<{ host: string; views: number }>;
  byDay: Array<{ day: string; views: number }>;
  truncated: boolean;
};

/** Cart add/remove movement per productId from an event pull. */
function cartMovementMap(rows: EventRow[]): Map<string, { times: number; units: number }[]> {
  const out = new Map<string, { times: number; units: number }[]>();
  for (const e of rows) {
    if (!e.productId) continue;
    if (e.eventType !== "add_to_cart" && e.eventType !== "remove_from_cart") continue;
    const slot = out.get(e.productId) ?? [ { times: 0, units: 0 }, { times: 0, units: 0 } ];
    const idx = e.eventType === "add_to_cart" ? 0 : 1;
    slot[idx]!.times += 1;
    slot[idx]!.units += e.qty ?? 1;
    out.set(e.productId, slot);
  }
  return out;
}

/** Purchased orders + units per productId from a paid-order pull (authoritative). */
function purchaseMap(paid: PaidOrderRow[]): Map<string, { orders: Set<string>; units: number }> {
  const out = new Map<string, { orders: Set<string>; units: number }>();
  for (const o of paid) {
    for (const it of o.items) {
      if (!it.productId) continue;
      const slot = out.get(it.productId) ?? { orders: new Set<string>(), units: 0 };
      slot.orders.add(o.id);
      slot.units += it.qty;
      out.set(it.productId, slot);
    }
  }
  return out;
}

export async function productTrafficTop(storeId: string, win: InsightsWindow): Promise<{ topViewedProducts: ProductTrafficRow[]; truncated: boolean }> {
  const [cur, paid] = await Promise.all([eventsFor(storeId, win.from, win.to), paidOrdersFor(storeId, win.from, win.to)]);

  const views = new Map<string, number>();
  const viewers = new Map<string, Set<string>>();
  for (const e of cur.rows) {
    if (e.eventType !== "product_view" || !e.productId) continue;
    views.set(e.productId, (views.get(e.productId) ?? 0) + 1);
    const sk = sessionKey(e);
    if (sk) {
      const set = viewers.get(e.productId) ?? new Set<string>();
      set.add(sk);
      viewers.set(e.productId, set);
    }
  }
  const carts = cartMovementMap(cur.rows);
  const purchases = purchaseMap(paid);

  const topIds = [...views.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
  const products = topIds.length
    ? await db.product.findMany({ where: { id: { in: topIds }, storeId }, select: { id: true, title: true, slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  // Explicit intermediate type: without it TS cannot prove the filter
  // predicate narrows the `| null` branch away (TS2677), leaving nulls in
  // the array type. Contextual typing also checks each row against
  // ProductTrafficRow directly.
  const rows: Array<ProductTrafficRow | null> = topIds.map((id) => {
    const p = byId.get(id);
    if (!p) return null;
    const cart = carts.get(id) ?? [ { times: 0, units: 0 }, { times: 0, units: 0 } ];
    const pur = purchases.get(id);
    return {
      productId: id,
      title: p.title,
      slug: p.slug,
      imageUrl: p.images[0]?.url ?? null,
      views: views.get(id) ?? 0,
      uniqueViewers: viewers.get(id)?.size ?? 0,
      cartAddTimes: cart[0]!.times,
      cartAddUnits: cart[0]!.units,
      cartRemoveTimes: cart[1]!.times,
      cartRemoveUnits: cart[1]!.units,
      purchaseOrders: pur?.orders.size ?? 0,
      purchaseUnits: pur?.units ?? 0,
    } satisfies ProductTrafficRow;
  });

  return {
    topViewedProducts: rows.filter((x): x is ProductTrafficRow => x !== null),
    truncated: cur.truncated,
  };
}

export async function productTrafficDetail(storeId: string, productId: string, win: InsightsWindow): Promise<ProductTrafficDetail | null> {
  // Ownership check: the product must belong to the SESSION's store — a foreign
  // id answers 404, never a data leak.
  const product = await db.product.findFirst({
    where: { id: productId, storeId },
    select: { id: true, title: true, slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } },
  });
  if (!product) return null;

  const [cur, paid] = await Promise.all([eventsFor(storeId, win.from, win.to), paidOrdersFor(storeId, win.from, win.to)]);

  // Day buckets seeded across the whole window (same convention as byDay in
  // trafficSummary — KL wall-clock days, zero-filled).
  const dayMap = new Map<string, number>();
  for (let d = new Date(win.from); d < win.to; d = new Date(d.getTime() + 86_400_000)) dayMap.set(klDayKey(d), 0);

  const pviews = cur.rows.filter((e) => e.eventType === "product_view" && e.productId === productId);
  const viewers = new Set<string>();
  const chanMap = new Map<string, { views: number; sessions: Set<string> }>();
  const refMap = new Map<string, number>();
  for (const e of pviews) {
    dayMap.set(klDayKey(e.createdAt), (dayMap.get(klDayKey(e.createdAt)) ?? 0) + 1);
    const sk = sessionKey(e);
    if (sk) viewers.add(sk);
    const ch = e.channel ?? "direct";
    const slot = chanMap.get(ch) ?? { views: 0, sessions: new Set<string>() };
    slot.views += 1;
    if (sk) slot.sessions.add(sk);
    chanMap.set(ch, slot);
    if (e.referrerHost) refMap.set(e.referrerHost, (refMap.get(e.referrerHost) ?? 0) + 1);
  }

  const carts = cartMovementMap(cur.rows).get(productId) ?? [ { times: 0, units: 0 }, { times: 0, units: 0 } ];
  const pur = purchaseMap(paid).get(productId);

  return {
    product: { id: product.id, title: product.title, slug: product.slug, imageUrl: product.images[0]?.url ?? null },
    totals: {
      views: pviews.length,
      uniqueViewers: viewers.size,
      cartAddTimes: carts[0]!.times,
      cartAddUnits: carts[0]!.units,
      cartRemoveTimes: carts[1]!.times,
      cartRemoveUnits: carts[1]!.units,
      purchaseOrders: pur?.orders.size ?? 0,
      purchaseUnits: pur?.units ?? 0,
    },
    channels: [...chanMap.entries()].map(([channel, v]) => ({ channel, views: v.views, sessions: v.sessions.size })).sort((a, b) => b.views - a.views),
    referrers: [...refMap.entries()].map(([host, views]) => ({ host, views })).sort((a, b) => b.views - a.views).slice(0, 6),
    byDay: [...dayMap.entries()].map(([day, views]) => ({ day, views })),
    truncated: cur.truncated,
  };
}

export type FunnelStage = {
  key: string;
  label: string;
  count: number;
  prev: number;
  /** Stage ÷ previous stage, same window (1-dp %). null when the previous
   *  stage is 0 (never a division by zero). */
  stepRate: number | null;
  /** ABSOLUTE drop-off vs the previous stage (previous count − count; can be
   *  NEGATIVE on mixed-basis steps — rendered as "gained", never clamped). */
  dropOff: number | null;
  /** Drop-off as % of the previous stage (1-dp; null when previous = 0). */
  dropOffPct: number | null;
};
export type Funnel = {
  stages: FunnelStage[];
  basis: string[];
  /** Authoritative payment sessions (PaymentGroup rows created in the window
   *  covering this store's orders) — the platform's payment-attempt object.
 *  A retry of a failed session re-opens the same group (not counted again);
 *  legacy single-order PaymentIntent rows predate the group flow. Shown as an
   *  annotated figure, NOT a funnel stage. */
  paymentAttempts: number;
  paymentAttemptsPrev: number;
};

/** Per-KL-day funnel series (funnel route only). Session stages count DISTINCT
 *  sessions per day — a session spanning midnight counts on both days, so the
 *  daily values can sum ABOVE the window total (which counts each session
 *  once). Checkouts/paid are exact per-day order counts (createdAt / paidAt).
 *  `visits` is store-scope only (a store visit is not product-scoped). */
export type FunnelDayPoint = {
  day: string;
  visits?: number;
  productViews: number;
  cartAdds: number;
  checkouts: number;
  paidOrders: number;
};
export type FunnelReport = Funnel & {
  byDay: FunnelDayPoint[];
  truncated: boolean;
  /** Products with tracked product_view/add_to_cart activity in the window
   *  (ranked by views, capped) — powers the per-product funnel selector. */
  products: FunnelProductRow[];
  productsTruncated: boolean;
};

/** Distinct-session sets per funnel stage over an event pull (shared math —
 *  funnelFor and funnelReportFor always produce identical stage numbers). */
function sessionSets(rows: EventRow[]) {
  const store = new Set<string>();
  const product = new Set<string>();
  const cart = new Set<string>();
  for (const e of rows) {
    const sk = sessionKey(e);
    if (!sk) continue;
    if (e.eventType === "store_view") store.add(sk);
    if (e.eventType === "product_view") product.add(sk);
    if (e.eventType === "add_to_cart") cart.add(sk);
  }
  return { store, product, cart };
}

/** Attach ABSOLUTE drop-off + drop-off % to a raw stage list — shared math for
 *  the store funnel AND the product funnel (identical semantics in both);
 *  every consumer gets the same numbers, never re-derived client-side. */
function withDropOff(
  raw: Array<Omit<FunnelStage, "dropOff" | "dropOffPct">>
): FunnelStage[] {
  return raw.map((st, i) => {
    if (i === 0) return { ...st, dropOff: null, dropOffPct: null };
    const prevCount = raw[i - 1]!.count;
    const dropOff = prevCount - st.count;
    return {
      ...st,
      dropOff,
      dropOffPct: prevCount > 0 ? Math.round((dropOff / prevCount) * 1000) / 10 : null,
    };
  });
}

function buildFunnelStages(
  s: ReturnType<typeof sessionSets>,
  sp: ReturnType<typeof sessionSets>,
  ordersCur: number,
  ordersPrev: number,
  paidCur: number,
  paidPrev: number
): FunnelStage[] {
  return withDropOff([
    { key: "store_visit", label: "Store visit (sessions)", count: s.store.size, prev: sp.store.size, stepRate: null },
    { key: "product_view", label: "Viewed a product", count: s.product.size, prev: sp.product.size, stepRate: rate(s.product.size, s.store.size) },
    { key: "add_to_cart", label: "Added to cart", count: s.cart.size, prev: sp.cart.size, stepRate: rate(s.cart.size, s.product.size) },
    { key: "begin_checkout", label: "Checkout started (orders)", count: ordersCur, prev: ordersPrev, stepRate: rate(ordersCur, s.cart.size) },
    { key: "purchase", label: "Paid orders", count: paidCur, prev: paidPrev, stepRate: rate(paidCur, ordersCur) },
  ]);
}

function funnelBasis(attemptsCur: number): string[] {
  return [
    "Visit → cart stages count DISTINCT pseudonymous sessions that performed each stage inside the window (estimates from first-party cookies; login not required).",
    "Checkout started = orders created in the window (authoritative Order.createdAt, any status). Paid orders = orders with paidAt in the window.",
    "The cart → checkout step mixes bases (sessions vs orders) — read it as an indication, not an exact visitor conversion. Drop-off on that step (and the checkout → purchase step) can be negative when the bases disagree.",
    `Payment attempts = authoritative payment sessions (PaymentGroup records created in the window for this store's checkouts — ${attemptsCur} now). A failed-session retry re-opens the same record and is not counted twice.`,
  ];
}

export async function funnelFor(storeId: string, win: InsightsWindow): Promise<Funnel> {
  const [cur, prev, ordersCur, ordersPrev] = await Promise.all([
    eventsFor(storeId, win.from, win.to),
    eventsFor(storeId, win.prevFrom, win.prevTo),
    db.order.count({ where: { storeId, createdAt: { gte: win.from, lt: win.to } } }),
    db.order.count({ where: { storeId, createdAt: { gte: win.prevFrom, lt: win.prevTo } } }),
  ]);
  const [paidCur, paidPrev, attemptsCur, attemptsPrev] = await Promise.all([
    db.order.count({ where: { storeId, paidAt: { gte: win.from, lt: win.to } } }),
    db.order.count({ where: { storeId, paidAt: { gte: win.prevFrom, lt: win.prevTo } } }),
    db.paymentGroup.count({ where: { createdAt: { gte: win.from, lt: win.to }, orders: { some: { storeId } } } }),
    db.paymentGroup.count({ where: { createdAt: { gte: win.prevFrom, lt: win.prevTo }, orders: { some: { storeId } } } }),
  ]);
  const s = sessionSets(cur.rows);
  const sp = sessionSets(prev.rows);
  return {
    stages: buildFunnelStages(s, sp, ordersCur, ordersPrev, paidCur, paidPrev),
    paymentAttempts: attemptsCur,
    paymentAttemptsPrev: attemptsPrev,
    basis: funnelBasis(attemptsCur),
  };
}

/** Funnel + per-day series for the dedicated funnel route. One bounded event
 *  pull per window side (same 20 k guard as funnelFor); order dates come from
 *  bounded date pulls (take 20 001 → `truncated`) that double as exact counts
 *  (with an honest exact re-count fallback when the cap is hit). */
export async function funnelReportFor(storeId: string, win: InsightsWindow): Promise<FunnelReport> {
  const DATE_CAP = 20_000;
  const [cur, prev, orderDates, paidDates, ordersPrev, paidPrev, attemptsCur, attemptsPrev] = await Promise.all([
    eventsFor(storeId, win.from, win.to),
    eventsFor(storeId, win.prevFrom, win.prevTo),
    db.order.findMany({
      where: { storeId, createdAt: { gte: win.from, lt: win.to } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
      take: DATE_CAP + 1,
    }),
    db.order.findMany({
      where: { storeId, paidAt: { gte: win.from, lt: win.to } },
      select: { paidAt: true },
      orderBy: { paidAt: "asc" },
      take: DATE_CAP + 1,
    }),
    db.order.count({ where: { storeId, createdAt: { gte: win.prevFrom, lt: win.prevTo } } }),
    db.order.count({ where: { storeId, paidAt: { gte: win.prevFrom, lt: win.prevTo } } }),
    db.paymentGroup.count({ where: { createdAt: { gte: win.from, lt: win.to }, orders: { some: { storeId } } } }),
    db.paymentGroup.count({ where: { createdAt: { gte: win.prevFrom, lt: win.prevTo }, orders: { some: { storeId } } } }),
  ]);

  let ordersCur = orderDates.length;
  let paidCur = paidDates.length;
  let truncated = cur.truncated || prev.truncated;
  if (orderDates.length > DATE_CAP) {
    ordersCur = await db.order.count({ where: { storeId, createdAt: { gte: win.from, lt: win.to } } });
    truncated = true;
  }
  if (paidDates.length > DATE_CAP) {
    paidCur = await db.order.count({ where: { storeId, paidAt: { gte: win.from, lt: win.to } } });
    truncated = true;
  }

  const s = sessionSets(cur.rows);
  const sp = sessionSets(prev.rows);

  // Per-day series — every KL day of the window is present (zeros included).
  const dayMap = new Map<string, { store: Set<string>; product: Set<string>; cart: Set<string>; checkouts: number; paidOrders: number }>();
  const emptyDay = () => ({ store: new Set<string>(), product: new Set<string>(), cart: new Set<string>(), checkouts: 0, paidOrders: 0 });
  for (let d = new Date(win.from); d < win.to; d = new Date(d.getTime() + 86_400_000)) {
    dayMap.set(klDayKey(d), emptyDay());
  }
  // Rolling windows (7d/30d/1y) have to − from as an EXACT day multiple, so
  // the stepping loop's last iteration lands on `to` and would skip the final
  // partial day — this guarantee closes that gap (today's orders must land in
  // the series, or byDay would disagree with the stage counts).
  const endKey = klDayKey(new Date(win.to.getTime() - 1));
  if (!dayMap.has(endKey)) dayMap.set(endKey, emptyDay());
  for (const e of cur.rows) {
    if (e.eventType !== "store_view" && e.eventType !== "product_view" && e.eventType !== "add_to_cart") continue;
    const slot = dayMap.get(klDayKey(e.createdAt));
    if (!slot) continue;
    const sk = sessionKey(e);
    if (!sk) continue;
    if (e.eventType === "store_view") slot.store.add(sk);
    if (e.eventType === "product_view") slot.product.add(sk);
    if (e.eventType === "add_to_cart") slot.cart.add(sk);
  }
  for (const o of orderDates) {
    const slot = dayMap.get(klDayKey(o.createdAt));
    if (slot) slot.checkouts += 1;
  }
  for (const o of paidDates) {
    const slot = dayMap.get(klDayKey(o.paidAt as Date));
    if (slot) slot.paidOrders += 1;
  }
  const byDay: FunnelDayPoint[] = [...dayMap.entries()].map(([day, v]) => ({
    day,
    visits: v.store.size,
    productViews: v.product.size,
    cartAdds: v.cart.size,
    checkouts: v.checkouts,
    paidOrders: v.paidOrders,
  }));

  // Per-product selector list — derived from the SAME event pull (no extra
  // scan; one bounded title/image join on the store's own products).
  const products = await funnelProductsFromRows(storeId, cur.rows);

  return {
    stages: buildFunnelStages(s, sp, ordersCur, ordersPrev, paidCur, paidPrev),
    paymentAttempts: attemptsCur,
    paymentAttemptsPrev: attemptsPrev,
    basis: funnelBasis(attemptsCur),
    byDay,
    truncated,
    products: products.rows,
    productsTruncated: products.truncated,
  };
}

// ---------------------------------------------------------------------------
// Per-product conversion funnel (product-scoped stages + selector list)
// ---------------------------------------------------------------------------

export type FunnelProductRow = {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  /** product_view events in the window (deduped per session/product/hour). */
  views: number;
  /** DISTINCT sessions that added this product to a cart in the window. */
  cartAdds: number;
};

const FUNNEL_PRODUCTS_CAP = 60;

/** Products with tracked product_view / add_to_cart activity in the window,
 *  ranked by views (capped at 60 — honest `truncated` flag). Derived from an
 *  event pull the caller already made, so it costs no extra scan. */
async function funnelProductsFromRows(
  storeId: string,
  events: EventRow[]
): Promise<{ rows: FunnelProductRow[]; truncated: boolean }> {
  const map = new Map<string, { views: number; carts: Set<string> }>();
  for (const e of events) {
    if (!e.productId) continue;
    if (e.eventType !== "product_view" && e.eventType !== "add_to_cart") continue;
    const slot = map.get(e.productId) ?? { views: 0, carts: new Set<string>() };
    if (e.eventType === "product_view") slot.views += 1;
    else {
      const sk = sessionKey(e);
      if (sk) slot.carts.add(sk);
    }
    map.set(e.productId, slot);
  }
  const ranked = [...map.entries()].sort((a, b) => b[1].views - a[1].views);
  const truncated = ranked.length > FUNNEL_PRODUCTS_CAP;
  const topIds = ranked.slice(0, FUNNEL_PRODUCTS_CAP).map(([id]) => id);
  const products = topIds.length
    ? await db.product.findMany({
        where: { id: { in: topIds }, storeId },
        select: { id: true, title: true, slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } },
      })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const rows = topIds
    .map((id): FunnelProductRow | null => {
      const p = byId.get(id);
      const slot = map.get(id)!;
      return p
        ? { productId: id, title: p.title, slug: p.slug, imageUrl: p.images[0]?.url ?? null, views: slot.views, cartAdds: slot.carts.size }
        : null;
    })
    .filter((x): x is FunnelProductRow => x != null);
  return {
    rows,
    truncated,
  };
}

export type ProductFunnel = {
  stages: FunnelStage[];
  byDay: FunnelDayPoint[];
  truncated: boolean;
  basis: string[];
  /** Selector list (same derivation as the store report — same window). */
  products: FunnelProductRow[];
  productsTruncated: boolean;
  /** Authoritative payment sessions for checkouts CONTAINING this product
   *  (same semantics as the store funnel's paymentAttempts, product-scoped). */
  paymentAttempts: number;
  paymentAttemptsPrev: number;
  product: {
    id: string;
    title: string;
    slug: string;
    imageUrl: string | null;
    /** Units of THIS product in orders paid in the window (paidAt basis). */
    unitsSold: number;
    /** Gross line subtotal of this product's items in those paid orders
     *  (before refunds — money context, not a funnel stage). */
    revenueMinor: number;
    ordersPaid: number;
  };
};

/** Product-scoped conversion funnel. Stages:
 *    Viewed this product (distinct sessions) → Added this product to cart
 *    (distinct sessions) → Checkout started (orders CONTAINING the product,
 *    createdAt basis) → Paid orders (paidAt basis).
 *  The store-visit stage is deliberately absent — a store visit is not
 *  product-scoped, so the funnel starts where the product enters the story.
 *  Ownership is checked HERE (store-scoped lookup, never trusting the client).
 *  Throws ApiError 404 when the product does not belong to the caller's store. */
export async function productFunnelFor(
  storeId: string,
  productId: string,
  win: InsightsWindow
): Promise<ProductFunnel> {
  const DATE_CAP = 20_000;
  const product = await db.product.findFirst({
    where: { id: productId, storeId },
    select: { id: true, title: true, slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } },
  });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Unknown product for this store");

  const [cur, prev, orderDates, paidRows, ordersPrev, paidPrev, attemptsCur, attemptsPrev] = await Promise.all([
    eventsFor(storeId, win.from, win.to),
    eventsFor(storeId, win.prevFrom, win.prevTo),
    db.order.findMany({
      where: { storeId, createdAt: { gte: win.from, lt: win.to }, items: { some: { productId } } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
      take: DATE_CAP + 1,
    }),
    db.order.findMany({
      where: { storeId, paidAt: { gte: win.from, lt: win.to }, items: { some: { productId } } },
      select: { paidAt: true, items: { where: { productId }, select: { qty: true, lineSubtotalMinor: true } } },
      orderBy: { paidAt: "asc" },
      take: DATE_CAP + 1,
    }),
    db.order.count({ where: { storeId, createdAt: { gte: win.prevFrom, lt: win.prevTo }, items: { some: { productId } } } }),
    db.order.count({ where: { storeId, paidAt: { gte: win.prevFrom, lt: win.prevTo }, items: { some: { productId } } } }),
    db.paymentGroup.count({ where: { createdAt: { gte: win.from, lt: win.to }, orders: { some: { storeId, items: { some: { productId } } } } } }),
    db.paymentGroup.count({ where: { createdAt: { gte: win.prevFrom, lt: win.prevTo }, orders: { some: { storeId, items: { some: { productId } } } } } }),
  ]);

  let ordersCur = orderDates.length;
  let paidCur = paidRows.length;
  let truncated = cur.truncated || prev.truncated;
  if (orderDates.length > DATE_CAP) {
    ordersCur = await db.order.count({ where: { storeId, createdAt: { gte: win.from, lt: win.to }, items: { some: { productId } } } });
    truncated = true;
  }

  // Money context from the paid pull (exact re-aggregation when the cap hit).
  let unitsSold = 0;
  let revenueMinor = 0;
  if (paidRows.length > DATE_CAP) {
    paidCur = await db.order.count({ where: { storeId, paidAt: { gte: win.from, lt: win.to }, items: { some: { productId } } } });
    truncated = true;
    const agg = await db.orderItem.aggregate({
      where: { productId, order: { storeId, paidAt: { gte: win.from, lt: win.to } } },
      _sum: { qty: true, lineSubtotalMinor: true },
    });
    unitsSold = agg._sum.qty ?? 0;
    revenueMinor = agg._sum.lineSubtotalMinor ?? 0;
  } else {
    for (const o of paidRows) {
      for (const it of o.items) {
        unitsSold += it.qty;
        revenueMinor += it.lineSubtotalMinor;
      }
    }
  }

  // Product-scoped session sets (this product only).
  const stageSets = (rows: EventRow[]) => {
    const views = new Set<string>();
    const carts = new Set<string>();
    for (const e of rows) {
      if (e.productId !== productId) continue;
      const sk = sessionKey(e);
      if (!sk) continue;
      if (e.eventType === "product_view") views.add(sk);
      if (e.eventType === "add_to_cart") carts.add(sk);
    }
    return { views, carts };
  };
  const s = stageSets(cur.rows);
  const sp = stageSets(prev.rows);

  // Per-day series (KL day buckets; same midnight double-count caveat).
  const dayMap = new Map<string, { views: Set<string>; carts: Set<string>; checkouts: number; paidOrders: number }>();
  const emptyDay = () => ({ views: new Set<string>(), carts: new Set<string>(), checkouts: 0, paidOrders: 0 });
  for (let d = new Date(win.from); d < win.to; d = new Date(d.getTime() + 86_400_000)) {
    dayMap.set(klDayKey(d), emptyDay());
  }
  const endKey = klDayKey(new Date(win.to.getTime() - 1));
  if (!dayMap.has(endKey)) dayMap.set(endKey, emptyDay());
  for (const e of cur.rows) {
    if (e.productId !== productId) continue;
    if (e.eventType !== "product_view" && e.eventType !== "add_to_cart") continue;
    const slot = dayMap.get(klDayKey(e.createdAt));
    if (!slot) continue;
    const sk = sessionKey(e);
    if (!sk) continue;
    if (e.eventType === "product_view") slot.views.add(sk);
    if (e.eventType === "add_to_cart") slot.carts.add(sk);
  }
  for (const o of orderDates) {
    const slot = dayMap.get(klDayKey(o.createdAt));
    if (slot) slot.checkouts += 1;
  }
  for (const o of paidRows) {
    const slot = dayMap.get(klDayKey(o.paidAt as Date));
    if (slot) slot.paidOrders += 1;
  }
  const byDay: FunnelDayPoint[] = [...dayMap.entries()].map(([day, v]) => ({
    day,
    productViews: v.views.size,
    cartAdds: v.carts.size,
    checkouts: v.checkouts,
    paidOrders: v.paidOrders,
  }));

  const products = await funnelProductsFromRows(storeId, cur.rows);

  return {
    stages: withDropOff([
      { key: "product_view", label: "Viewed this product", count: s.views.size, prev: sp.views.size, stepRate: null },
      { key: "add_to_cart", label: "Added to cart", count: s.carts.size, prev: sp.carts.size, stepRate: rate(s.carts.size, s.views.size) },
      { key: "begin_checkout", label: "Checkout started", count: ordersCur, prev: ordersPrev, stepRate: rate(ordersCur, s.carts.size) },
      { key: "purchase", label: "Paid orders", count: paidCur, prev: paidPrev, stepRate: rate(paidCur, ordersCur) },
    ]),
    byDay,
    truncated,
    basis: [
      `View and cart stages count DISTINCT pseudonymous sessions that viewed or added THIS product inside the window (a session counts here even when it also viewed other products; first-party cookies, login not required).`,
      `Checkout started = orders created in the window that CONTAIN this product (authoritative Order.createdAt, any status). Paid orders = orders containing this product with paidAt in the window — an order created before the window but paid inside it counts as paid only, so this step can be negative (gained).`,
      "View/cart stages are session-based while checkout/paid are order-based — mixed bases, so read step rates as indications, not exact visitor conversion.",
      `Units sold (${unitsSold.toLocaleString("en-MY")}) and gross product revenue (before refunds) cover this product's line items in those paid orders — sales context, not a funnel stage.`,
      `Payment sessions = authoritative payment sessions for checkouts CONTAINING this product (${attemptsCur} in this window). A failed-session retry re-opens the same record and is not counted twice.`,
    ],
    products: products.rows,
    productsTruncated: products.truncated,
    paymentAttempts: attemptsCur,
    paymentAttemptsPrev: attemptsPrev,
    product: {
      id: product.id,
      title: product.title,
      slug: product.slug,
      imageUrl: product.images[0]?.url ?? null,
      unitsSold,
      revenueMinor,
      ordersPaid: paidCur,
    },
  };
}

// ---------------------------------------------------------------------------
// Cart activity (historical events) + current-cart snapshot (live DB state)
// ---------------------------------------------------------------------------
export type CartActivity = {
  addEvents: number; addEventsPrev: number;
  addUnits: number; addUnitsPrev: number;
  removeEvents: number; removeEventsPrev: number;
  removeUnits: number; removeUnitsPrev: number;
  byDay: Array<{ day: string; addUnits: number; removeUnits: number }>;
  topAdded: Array<{ productId: string; title: string; imageUrl: string | null; addUnits: number; addEvents: number }>;
};

export async function cartActivity(storeId: string, win: InsightsWindow): Promise<CartActivity> {
  const [cur, prev] = await Promise.all([eventsFor(storeId, win.from, win.to), eventsFor(storeId, win.prevFrom, win.prevTo)]);
  const adds = cur.rows.filter((e) => e.eventType === "add_to_cart");
  const removes = cur.rows.filter((e) => e.eventType === "remove_from_cart");
  const prevAdds = prev.rows.filter((e) => e.eventType === "add_to_cart");
  const prevRemoves = prev.rows.filter((e) => e.eventType === "remove_from_cart");

  const dayMap = new Map<string, { addUnits: number; removeUnits: number }>();
  for (let d = new Date(win.from); d < win.to; d = new Date(d.getTime() + 86_400_000)) {
    dayMap.set(klDayKey(d), { addUnits: 0, removeUnits: 0 });
  }
  for (const e of [...adds, ...removes]) {
    const k = klDayKey(e.createdAt);
    const slot = dayMap.get(k) ?? { addUnits: 0, removeUnits: 0 };
    if (e.eventType === "add_to_cart") slot.addUnits += e.qty ?? 0;
    else slot.removeUnits += e.qty ?? 0;
    dayMap.set(k, slot);
  }

  const addMap = new Map<string, { units: number; events: number }>();
  for (const e of adds) {
    if (!e.productId) continue;
    const slot = addMap.get(e.productId) ?? { units: 0, events: 0 };
    slot.units += e.qty ?? 0;
    slot.events += 1;
    addMap.set(e.productId, slot);
  }
  const topIds = [...addMap.entries()].sort((a, b) => b[1].units - a[1].units).slice(0, 8).map(([id]) => id);
  const products = topIds.length
    ? await db.product.findMany({ where: { id: { in: topIds }, storeId }, select: { id: true, title: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  return {
    addEvents: adds.length, addEventsPrev: prevAdds.length,
    addUnits: adds.reduce((s, e) => s + (e.qty ?? 0), 0),
    addUnitsPrev: prevAdds.reduce((s, e) => s + (e.qty ?? 0), 0),
    removeEvents: removes.length, removeEventsPrev: prevRemoves.length,
    removeUnits: removes.reduce((s, e) => s + (e.qty ?? 0), 0),
    removeUnitsPrev: prevRemoves.reduce((s, e) => s + (e.qty ?? 0), 0),
    byDay: [...dayMap.entries()].map(([day, v]) => ({ day, ...v })),
    topAdded: topIds
      .map((id) => {
        const p = byId.get(id);
        return p ? { productId: id, title: p.title, imageUrl: p.images[0]?.url ?? null, addUnits: addMap.get(id)?.units ?? 0, addEvents: addMap.get(id)?.events ?? 0 } : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x)),
  };
}

export type CartSnapshot = {
  sampledAt: string;
  activeCarts: number;
  totalUnits: number;
  totalLines: number;
  ineligibleUnits: number; // units parked on non-purchasable products (archived/inactive/non-live)
  byProduct: Array<{ productId: string; title: string; slug: string; imageUrl: string | null; units: number; carts: number }>;
  eligibilityNote: string;
};

/**
 * CURRENT-CART snapshot — live CartItem state (NOT a sum of historical events).
 * Eligibility (documented rule, mirrors the shopper cart's purchasable check):
 * variant.isActive AND product.status = active AND store.status = live.
 * Removed/purchased lines are physically deleted by those operations, so they
 * are excluded by construction. A cart with 5 units of one product counts
 * 5 units but 1 distinct cart. Mixed-vendor carts attribute each line to the
 * line's own product store.
 */
export async function currentCartSnapshot(storeId: string): Promise<CartSnapshot> {
  const [eligible, ineligible] = await Promise.all([
    db.cartItem.findMany({
      where: {
        variant: { isActive: true, product: { storeId, status: "active", store: { status: "live" } } },
      },
      select: { cartId: true, qty: true, variant: { select: { productId: true } } },
    }),
    db.cartItem.count({
      where: {
        variant: { product: { storeId }, OR: [{ isActive: false }, { product: { status: { not: "active" } } }, { product: { store: { status: { not: "live" } } } }] },
      },
    }),
  ]);

  const carts = new Set<string>();
  const perProduct = new Map<string, { units: number; carts: Set<string> }>();
  let totalUnits = 0;
  for (const it of eligible) {
    carts.add(it.cartId);
    totalUnits += it.qty;
    const p = perProduct.get(it.variant.productId) ?? { units: 0, carts: new Set<string>() };
    p.units += it.qty;
    p.carts.add(it.cartId);
    perProduct.set(it.variant.productId, p);
  }

  const topIds = [...perProduct.entries()].sort((a, b) => b[1].units - a[1].units).slice(0, 50).map(([id]) => id);
  const products = topIds.length
    ? await db.product.findMany({ where: { id: { in: topIds }, storeId }, select: { id: true, title: true, slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  return {
    sampledAt: new Date().toISOString(),
    activeCarts: carts.size,
    totalUnits,
    totalLines: eligible.length,
    ineligibleUnits: ineligible,
    byProduct: topIds
      .map((id) => {
        const p = byId.get(id);
        return p ? { productId: id, title: p.title, slug: p.slug, imageUrl: p.images[0]?.url ?? null, units: perProduct.get(id)?.units ?? 0, carts: perProduct.get(id)?.carts.size ?? 0 } : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x)),
    eligibilityNote:
      "Live cart state in the database right now. Only purchasable lines count (variant active, product active, store live); units parked on unavailable items are reported separately as unavailable. Purchased/removed lines are deleted by those operations and therefore excluded. Historical add/remove activity is a separate metric.",
  };
}

// ---------------------------------------------------------------------------
// Product performance table (paged, sortable)
// ---------------------------------------------------------------------------
export type ProductPerfRow = {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  status: string;
  views: number;
  viewSessions: number;
  addUnits: number;
  addEvents: number;
  currentCartUnits: number;
  currentCarts: number;
  orderedUnits: number; // units in orders CREATED in window (any status)
  purchasedUnits: number; // units in orders PAID in window
  grossSalesMinor: number;
  netSalesMinor: number; // lineSubtotal − discount − refunded (cumulative on those items)
  refundedMinor: number;
  viewToCartRate: number | null; // sessions that viewed AND added / sessions that viewed
  checkoutToPurchaseRate: number | null; // purchasedUnits / orderedUnits
};

export type ProductSort = "views" | "adds" | "cartQty" | "purchases" | "revenue" | "conversion";

export async function productPerformance(
  storeId: string,
  win: InsightsWindow,
  sort: ProductSort,
  page: number,
  size: number
): Promise<{ rows: ProductPerfRow[]; total: number }> {
  const products = await db.product.findMany({
    where: { storeId },
    select: {
      id: true, title: true, slug: true, status: true,
      images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
    },
  });

  const [events, createdOrders, paidOrders] = await Promise.all([
    eventsFor(storeId, win.from, win.to),
    db.order.findMany({
      where: { storeId, createdAt: { gte: win.from, lt: win.to } },
      select: { items: { select: { productId: true, qty: true } } },
    }),
    paidOrdersFor(storeId, win.from, win.to),
  ]);

  const snap = await currentCartSnapshot(storeId);

  // Per-product accumulators
  type Acc = {
    views: number; viewSessions: Set<string>; addSessions: Set<string>;
    addUnits: number; addEvents: number;
    orderedUnits: number; purchasedUnits: number; gross: number; net: number; refunded: number;
  };
  const acc = new Map<string, Acc>();
  const accFor = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = { views: 0, viewSessions: new Set(), addSessions: new Set(), addUnits: 0, addEvents: 0, orderedUnits: 0, purchasedUnits: 0, gross: 0, net: 0, refunded: 0 };
      acc.set(id, a);
    }
    return a;
  };

  for (const e of events.rows) {
    if (!e.productId) continue;
    const a = accFor(e.productId);
    const sk = sessionKey(e);
    if (e.eventType === "product_view") {
      a.views += 1;
      if (sk) a.viewSessions.add(sk);
    } else if (e.eventType === "add_to_cart") {
      a.addUnits += e.qty ?? 0;
      a.addEvents += 1;
      if (sk) a.addSessions.add(sk);
    }
  }
  for (const o of createdOrders) {
    for (const it of o.items) {
      if (!it.productId) continue;
      accFor(it.productId).orderedUnits += it.qty;
    }
  }
  for (const o of paidOrders) {
    for (const it of o.items) {
      if (!it.productId) continue;
      const a = accFor(it.productId);
      a.purchasedUnits += it.qty;
      a.gross += it.lineSubtotalMinor;
      a.net += it.lineSubtotalMinor - it.discountMinor - it.refundedMinor;
      a.refunded += it.refundedMinor;
    }
  }
  const cartUnits = new Map(snap.byProduct.map((p) => [p.productId, p.units]));
  const cartCarts = new Map(snap.byProduct.map((p) => [p.productId, p.carts]));

  const rows: ProductPerfRow[] = products.map((p) => {
    const a = acc.get(p.id);
    const cart = { units: cartUnits.get(p.id) ?? 0, carts: cartCarts.get(p.id) ?? 0 };
    return {
      productId: p.id,
      title: p.title,
      slug: p.slug,
      imageUrl: p.images[0]?.url ?? null,
      status: p.status,
      views: a?.views ?? 0,
      viewSessions: a?.viewSessions.size ?? 0,
      addUnits: a?.addUnits ?? 0,
      addEvents: a?.addEvents ?? 0,
      currentCartUnits: cart.units,
      currentCarts: cart.carts,
      orderedUnits: a?.orderedUnits ?? 0,
      purchasedUnits: a?.purchasedUnits ?? 0,
      grossSalesMinor: a?.gross ?? 0,
      netSalesMinor: a?.net ?? 0,
      refundedMinor: a?.refunded ?? 0,
      viewToCartRate: a && a.viewSessions.size > 0 ? rate(a.addSessions.size, a.viewSessions.size) : null,
      checkoutToPurchaseRate: a && a.orderedUnits > 0 ? rate(a.purchasedUnits, a.orderedUnits) : null,
    };
  });

  const sorters: Record<ProductSort, (a: ProductPerfRow, b: ProductPerfRow) => number> = {
    views: (a, b) => b.views - a.views,
    adds: (a, b) => b.addUnits - a.addUnits,
    cartQty: (a, b) => b.currentCartUnits - a.currentCartUnits,
    purchases: (a, b) => b.purchasedUnits - a.purchasedUnits,
    revenue: (a, b) => b.grossSalesMinor - a.grossSalesMinor,
    conversion: (a, b) => (b.viewToCartRate ?? -1) - (a.viewToCartRate ?? -1),
  };
  rows.sort(sorters[sort] ?? sorters.views);

  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length };
}

// ---------------------------------------------------------------------------
// Sales trends + fulfillment
// ---------------------------------------------------------------------------
export type SalesTrend = {
  bucket: string;
  grossSalesMinor: number;
  netProductSalesMinor: number;
  orders: number;
  units: number;
  refundsMinor: number;
};

export async function salesTrend(
  storeId: string,
  win: InsightsWindow,
  granularity: "day" | "week" | "month"
): Promise<{ trend: SalesTrend[]; granularity: string }> {
  const [orders, refundRows] = await Promise.all([
    paidOrdersFor(storeId, win.from, win.to),
    db.refund.findMany({
      where: { status: "processed", processedAt: { gte: win.from, lt: win.to }, order: { storeId } },
      select: { amountMinor: true, processedAt: true },
    }),
  ]);

  const bucketKey = (d: Date): string => {
    const kl = new Date(d.getTime() + KL_OFFSET_MS);
    const ymd = kl.toISOString().slice(0, 10);
    if (granularity === "month") return ymd.slice(0, 7);
    if (granularity === "week") {
      const dayIdx = (kl.getUTCDay() + 6) % 7; // Monday = 0
      const monday = new Date(kl.getTime() - dayIdx * 86_400_000);
      return monday.toISOString().slice(0, 10);
    }
    return ymd;
  };

  const buckets = new Map<string, SalesTrend>();
  for (const o of orders) {
    if (!o.paidAt) continue;
    const k = bucketKey(o.paidAt);
    const slot = buckets.get(k) ?? { bucket: k, grossSalesMinor: 0, netProductSalesMinor: 0, orders: 0, units: 0, refundsMinor: 0 };
    slot.orders += 1;
    slot.grossSalesMinor += o.totalMinor;
    for (const it of o.items) {
      slot.units += it.qty;
      slot.netProductSalesMinor += it.lineSubtotalMinor - it.discountMinor;
    }
    buckets.set(k, slot);
  }
  for (const r of refundRows) {
    const k = bucketKey(r.processedAt ?? new Date());
    const slot = buckets.get(k) ?? { bucket: k, grossSalesMinor: 0, netProductSalesMinor: 0, orders: 0, units: 0, refundsMinor: 0 };
    slot.refundsMinor += r.amountMinor;
    slot.netProductSalesMinor -= r.amountMinor;
    buckets.set(k, slot);
  }
  return {
    trend: [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v),
    granularity,
  };
}

export type FulfillmentInsights = {
  unfulfilledPaidOrders: number;
  avgPaidToShippedHours: number | null;
  shippedSample: number;
  note: string;
};

export async function fulfillmentInsights(storeId: string): Promise<FulfillmentInsights> {
  const [unfulfilled, shipped] = await Promise.all([
    db.order.count({ where: { storeId, status: "paid", paidAt: { not: null } } }),
    db.order.findMany({
      where: { storeId, paidAt: { not: null }, shippedAt: { not: null } },
      select: { paidAt: true, shippedAt: true },
      take: 200,
      orderBy: { paidAt: "desc" },
    }),
  ]);
  const durations = shipped
    .filter((o) => o.paidAt && o.shippedAt)
    .map((o) => (o.shippedAt!.getTime() - o.paidAt!.getTime()) / 3_600_000)
    .filter((h) => h >= 0);
  return {
    unfulfilledPaidOrders: unfulfilled,
    avgPaidToShippedHours: durations.length > 0 ? Math.round((durations.reduce((s, h) => s + h, 0) / durations.length) * 10) / 10 : null,
    shippedSample: durations.length,
    note: "Average hours from payment confirmation to seller shipping (most recent 200 shipped orders). Delivery-time metrics are not shown: trustworthy carrier delivery timestamps are not recorded.",
  };
}

// ---------------------------------------------------------------------------
// Markets (Sales by Country / State)
// ---------------------------------------------------------------------------
export type MarketRow = {
  code: string;
  label: string;
  paidOrders: number;
  paidOrdersPrev: number;
  unitsSold: number;
  grossProductSalesMinor: number;
  discountsMinor: number;
  refundsMinor: number;
  netProductSalesMinor: number;
  shippingChargedMinor: number;
  aovMinor: number | null;
  shareNetPct: number | null;
  shareOrdersPct: number | null;
  growthPct: number | null;
  isNew: boolean;
  source: string;
};

export type MarketReport = {
  dimension: "country" | "state";
  rows: MarketRow[];
  totals: { paidOrders: number; netProductSalesMinor: number };
  notes: string[];
  movers: { risers: Array<{ code: string; label: string; growthPct: number }>; fallers: Array<{ code: string; label: string; growthPct: number }> };
};

function geoKey(dimension: "country" | "state", o: PaidOrderRow): string {
  if (dimension === "country") return o.shippingCountryCode || "ZZ";
  try {
    const addr = JSON.parse(o.shippingAddressJson || "{}") as { state?: unknown };
    return typeof addr.state === "string" && addr.state.trim() ? addr.state.trim() : "Unspecified";
  } catch {
    return "Unspecified";
  }
}

export async function marketReport(storeId: string, win: InsightsWindow, dimension: "country" | "state"): Promise<MarketReport> {
  const [cur, prev, refundsCur, refundsPrev] = await Promise.all([
    paidOrdersFor(storeId, win.from, win.to),
    paidOrdersFor(storeId, win.prevFrom, win.prevTo),
    processedRefundsFor(storeId, win.from, win.to),
    processedRefundsFor(storeId, win.prevFrom, win.prevTo),
  ]);

  type M = { orders: number; units: number; gross: number; discounts: number; shipping: number };
  const agg = new Map<string, M>();
  const aggFor = (k: string): M => {
    let m = agg.get(k);
    if (!m) {
      m = { orders: 0, units: 0, gross: 0, discounts: 0, shipping: 0 };
      agg.set(k, m);
    }
    return m;
  };
  for (const o of cur) {
    const m = aggFor(geoKey(dimension, o));
    m.orders += 1;
    for (const it of o.items) {
      m.units += it.qty;
      m.gross += it.lineSubtotalMinor;
      m.discounts += it.discountMinor;
      m.shipping += it.shippingMinor;
    }
  }
  const prevAgg = new Map<string, number>(); // prev paid orders per key
  for (const o of prev) {
    const k = geoKey(dimension, o);
    prevAgg.set(k, (prevAgg.get(k) ?? 0) + 1);
  }

  // Refunds are order-level (no per-geo split in the authoritative model) —
  // attributed to the order's own geography via a second pass.
  const refundRowsCur = await db.refund.findMany({
    where: { status: "processed", processedAt: { gte: win.from, lt: win.to }, order: { storeId } },
    select: { amountMinor: true, order: { select: { shippingCountryCode: true, shippingAddressJson: true } } },
  });
  const refundsByGeo = new Map<string, number>();
  for (const r of refundRowsCur) {
    const k = dimension === "country" ? r.order.shippingCountryCode || "ZZ" : (() => {
      try {
        const addr = JSON.parse(r.order.shippingAddressJson || "{}") as { state?: unknown };
        return typeof addr.state === "string" && addr.state.trim() ? addr.state.trim() : "Unspecified";
      } catch { return "Unspecified"; }
    })();
    refundsByGeo.set(k, (refundsByGeo.get(k) ?? 0) + r.amountMinor);
  }

  const totalNet = [...agg.values()].reduce((s, m) => s + m.gross - m.discounts, 0) - refundsCur.amountMinor;
  const totalOrders = cur.length;

  const sourceByCode = new Map<string, Set<string>>();
  for (const o of cur) {
    const k = geoKey(dimension, o);
    const set = sourceByCode.get(k) ?? new Set<string>();
    if (dimension === "country") set.add(o.shippingCountrySource || "");
    sourceByCode.set(k, set);
  }

  const rows: MarketRow[] = [...agg.entries()].map(([code, m]) => {
    const net = m.gross - m.discounts - (refundsByGeo.get(code) ?? 0);
    const growth = pct(m.orders, prevAgg.get(code) ?? 0);
    const sources = [...(sourceByCode.get(code) ?? new Set())].filter(Boolean);
    return {
      code,
      label: dimension === "country" ? COUNTRY_LABELS[code] ?? code : code,
      paidOrders: m.orders,
      paidOrdersPrev: prevAgg.get(code) ?? 0,
      unitsSold: m.units,
      grossProductSalesMinor: m.gross,
      discountsMinor: m.discounts,
      refundsMinor: refundsByGeo.get(code) ?? 0,
      netProductSalesMinor: net,
      shippingChargedMinor: m.shipping,
      aovMinor: m.orders > 0 ? Math.round((m.gross + m.shipping - m.discounts) / m.orders) : null,
      shareNetPct: totalNet > 0 ? Math.round((net / totalNet) * 1000) / 10 : null,
      shareOrdersPct: totalOrders > 0 ? Math.round((m.orders / totalOrders) * 1000) / 10 : null,
      growthPct: growth.pct,
      isNew: growth.isNew,
      source: sources.length === 1 ? sources[0] : sources.length > 1 ? "mixed" : "",
    };
  });
  rows.sort((a, b) => b.netProductSalesMinor - a.netProductSalesMinor);

  const movers = { risers: [] as Array<{ code: string; label: string; growthPct: number }>, fallers: [] as Array<{ code: string; label: string; growthPct: number }> };
  const MIN_SAMPLE = 5; // insufficient-sample guard: no market claims on tiny data
  for (const r of rows) {
    if (r.growthPct == null || r.paidOrders < MIN_SAMPLE) continue;
    if (r.growthPct >= 20) movers.risers.push({ code: r.code, label: r.label, growthPct: r.growthPct });
    if (r.growthPct <= -20) movers.fallers.push({ code: r.code, label: r.label, growthPct: r.growthPct });
  }

  const notes = [
    dimension === "country"
      ? "Geographic dimension = destination country recorded at checkout (shipping snapshot). Historical orders before this feature are labelled 'backfill' (derived from the frozen Malaysian postcode + state) — see metric definitions."
      : "Geographic dimension = destination state recorded in the order's frozen shipping address snapshot at checkout time.",
    "Billing country is not recorded anywhere in the current data model — that dimension is unavailable (not silently substituted).",
    "Growth compares paid-order counts against the equivalent previous period. Markets with fewer than 5 paid orders are excluded from mover highlights (insufficient sample) and growth shows as 'new' when the previous period had none.",
    refundsPrev.count > 0 || refundsCur.count > 0
      ? "Refunds are reported on their own processed date (order-level) and attributed to the order's recorded geography; they can relate to orders paid in an earlier period."
      : "No processed refunds in this window.",
    "All amounts are in MYR minor units (sen). The platform is single-currency — no conversion is applied anywhere.",
  ];

  return {
    dimension,
    rows,
    totals: { paidOrders: totalOrders, netProductSalesMinor: totalNet },
    notes,
    movers,
  };
}

export type MarketProductRow = {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  unitsSold: number;
  grossProductSalesMinor: number;
  discountsMinor: number;
  refundedMinor: number; // cumulative on items of these orders
  netProductSalesMinor: number;
  paidOrders: number;
  avgSellingPriceMinor: number | null;
  views: number; // store-wide (NOT geo-attributed)
  addUnits: number; // store-wide (NOT geo-attributed)
};

export async function marketProducts(
  storeId: string,
  win: InsightsWindow,
  dimension: "country" | "state",
  code: string
): Promise<{ rows: MarketProductRow[]; label: string; notes: string[] }> {
  const orders = await paidOrdersFor(storeId, win.from, win.to);
  const filtered = orders.filter((o) => geoKey(dimension, o) === code);

  const events = await eventsFor(storeId, win.from, win.to);
  const viewsByProduct = new Map<string, number>();
  const addsByProduct = new Map<string, number>();
  for (const e of events.rows) {
    if (!e.productId) continue;
    if (e.eventType === "product_view") viewsByProduct.set(e.productId, (viewsByProduct.get(e.productId) ?? 0) + 1);
    if (e.eventType === "add_to_cart") addsByProduct.set(e.productId, (addsByProduct.get(e.productId) ?? 0) + (e.qty ?? 0));
  }

  type P = { units: number; gross: number; discounts: number; refunded: number; orders: Set<string> };
  const perProduct = new Map<string, P>();
  for (const o of filtered) {
    for (const it of o.items) {
      if (!it.productId) continue;
      const p = perProduct.get(it.productId) ?? { units: 0, gross: 0, discounts: 0, refunded: 0, orders: new Set<string>() };
      p.units += it.qty;
      p.gross += it.lineSubtotalMinor;
      p.discounts += it.discountMinor;
      p.refunded += it.refundedMinor;
      p.orders.add(o.id);
      perProduct.set(it.productId, p);
    }
  }

  const ids = [...perProduct.keys()];
  const products = ids.length
    ? await db.product.findMany({ where: { id: { in: ids }, storeId }, select: { id: true, title: true, slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const rows: MarketProductRow[] = ids
    .map((id) => {
      const p = perProduct.get(id)!;
      const prod = byId.get(id);
      return {
        productId: id,
        title: prod?.title ?? "(deleted product)",
        slug: prod?.slug ?? "",
        imageUrl: prod?.images[0]?.url ?? null,
        unitsSold: p.units,
        grossProductSalesMinor: p.gross,
        discountsMinor: p.discounts,
        refundedMinor: p.refunded,
        netProductSalesMinor: p.gross - p.discounts - p.refunded,
        paidOrders: p.orders.size,
        avgSellingPriceMinor: p.units > 0 ? Math.round(p.gross / p.units) : null,
        views: viewsByProduct.get(id) ?? 0,
        addUnits: addsByProduct.get(id) ?? 0,
      };
    })
    .filter((r) => r.title !== "(deleted product)")
    .sort((a, b) => b.netProductSalesMinor - a.netProductSalesMinor || b.unitsSold - a.unitsSold);

  return {
    rows,
    label: dimension === "country" ? COUNTRY_LABELS[code] ?? code : code,
    notes: [
      "Product views and cart-add units are STORE-WIDE for the selected window — visitor geography is not tracked, so per-country view/cart attribution does not exist and is never invented (no per-country conversion rates are shown for this reason).",
      "Sales columns are attributed strictly by the order's recorded destination geography.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Campaign report (Marketing Intelligence — first-party attribution only)
// ---------------------------------------------------------------------------
export type CampaignRow = {
  campaignId: string;
  name: string;
  slug: string;
  code: string;
  status: string;
  defaultSource: string | null;
  defaultMedium: string | null;
  createdAt: string;
  // Event-side metrics (window; attributed = campaignId on the event row)
  visits: number; // attributed store_view events
  visitSessions: number; // DISTINCT sessions over attributed store_views
  productViews: number;
  addUnits: number;
  // Order-side metrics (authoritative money)
  attributedOrders: number; // orders CREATED in window with attrCampaignId (createdAt basis)
  paidOrders: number; // orders PAID in window with attrCampaignId (paidAt basis)
  paidOrdersPrev: number;
  grossSalesMinor: number; // Σ totalMinor over paid orders (paidAt basis)
  grossProductSalesMinor: number;
  aovMinor: number | null;
  /** paidOrders ÷ visitSessions — MIXED bases (orders vs sessions), disclosed. */
  conversionPct: number | null;
  firstEventAt: string | null;
};

export type UtmSourceRow = {
  source: string;
  medium: string | null;
  campaign: string | null;
  visits: number;
  visitSessions: number;
  productViews: number;
  addUnits: number;
  attributedOrders: number;
  paidOrders: number;
  grossSalesMinor: number;
};

export type CampaignReport = {
  rows: CampaignRow[];
  utmRows: UtmSourceRow[];
  totals: {
    campaigns: number;
    attributedVisits: number;
    attributedPaidOrders: number;
    attributedGrossSalesMinor: number;
    unclaimedPaidOrders: number;
    unclaimedGrossSalesMinor: number;
  };
  notes: string[];
};

const CAMPAIGN_EVENT_SCAN_CAP = 20_000;

export async function campaignReport(storeId: string, win: InsightsWindow): Promise<CampaignReport> {
  // (1) The seller's own campaigns (any status — archived ones keep reporting).
  const campaigns = await db.sellerCampaign.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, slug: true, code: true, status: true, defaultSource: true, defaultMedium: true, createdAt: true },
  });

  // (2) Attributed events in the window (campaign-tagged OR raw-UTM-tagged),
  // bounded like every other event scan.
  const eventRows = await db.analyticsEvent.findMany({
    where: {
      storeId,
      createdAt: { gte: win.from, lt: win.to },
      OR: [{ campaignId: { not: null } }, { utmSource: { not: null } }],
    },
    select: {
      eventType: true, sessionId: true, shopperId: true, qty: true,
      campaignId: true, utmSource: true, utmMedium: true, utmCampaign: true, createdAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: CAMPAIGN_EVENT_SCAN_CAP + 1,
  });
  const truncatedEvents = eventRows.length > CAMPAIGN_EVENT_SCAN_CAP;
  const events = truncatedEvents ? eventRows.slice(0, CAMPAIGN_EVENT_SCAN_CAP) : eventRows;

  // (3) Authoritative attributed orders — created-in-window (attribution count)
  // and paid-in-window (money), plus the previous period for paid deltas.
  const [ordersCreated, ordersPaid, ordersPaidPrev] = await Promise.all([
    db.order.findMany({
      where: { storeId, createdAt: { gte: win.from, lt: win.to }, attrCampaignId: { not: null } },
      select: { attrCampaignId: true, attrSource: true, attrMedium: true, attrCampaign: true },
    }),
    db.order.findMany({
      where: { storeId, paidAt: { gte: win.from, lt: win.to }, attrCampaignId: { not: null } },
      select: { attrCampaignId: true, totalMinor: true, items: { select: { lineSubtotalMinor: true } } },
    }),
    db.order.findMany({
      where: { storeId, paidAt: { gte: win.prevFrom, lt: win.prevTo }, attrCampaignId: { not: null } },
      select: { attrCampaignId: true },
    }),
  ]);

  // Unclaimed tagged traffic (raw UTM, no campaign token): order side.
  const [unclaimedCreated, unclaimedPaid] = await Promise.all([
    db.order.findMany({
      where: { storeId, createdAt: { gte: win.from, lt: win.to }, attrCampaignId: null, attrSource: { not: null } },
      select: { attrSource: true, attrMedium: true, attrCampaign: true },
    }),
    db.order.findMany({
      where: { storeId, paidAt: { gte: win.from, lt: win.to }, attrCampaignId: null, attrSource: { not: null } },
      select: { attrSource: true, attrMedium: true, attrCampaign: true, totalMinor: true },
    }),
  ]);

  // ---- per-campaign aggregation -------------------------------------------
  type CampAgg = {
    visits: number; visitSessions: Set<string>; productViews: number; addUnits: number;
    attributedOrders: number; paidOrders: number; grossSalesMinor: number; grossProductSalesMinor: number;
    firstEventAt: Date | null;
  };
  const campAgg = new Map<string, CampAgg>();
  const camp = (id: string): CampAgg => {
    let a = campAgg.get(id);
    if (!a) {
      a = { visits: 0, visitSessions: new Set(), productViews: 0, addUnits: 0, attributedOrders: 0, paidOrders: 0, grossSalesMinor: 0, grossProductSalesMinor: 0, firstEventAt: null };
      campAgg.set(id, a);
    }
    return a;
  };
  for (const e of events) {
    if (!e.campaignId) continue;
    const a = camp(e.campaignId);
    if (e.eventType === "store_view") {
      a.visits += 1;
      const sk = e.sessionId ?? (e.shopperId ? `u:${e.shopperId}` : null);
      if (sk) a.visitSessions.add(sk);
    }
    if (e.eventType === "product_view") a.productViews += 1;
    if (e.eventType === "add_to_cart") a.addUnits += e.qty ?? 0;
    if (!a.firstEventAt || e.createdAt < a.firstEventAt) a.firstEventAt = e.createdAt;
  }
  for (const o of ordersCreated) if (o.attrCampaignId) camp(o.attrCampaignId).attributedOrders += 1;
  for (const o of ordersPaid) {
    const a = camp(o.attrCampaignId!);
    a.paidOrders += 1;
    a.grossSalesMinor += o.totalMinor;
    for (const it of o.items) a.grossProductSalesMinor += it.lineSubtotalMinor;
  }
  const paidPrevMap = new Map<string, number>();
  for (const o of ordersPaidPrev) paidPrevMap.set(o.attrCampaignId!, (paidPrevMap.get(o.attrCampaignId!) ?? 0) + 1);

  const rows: CampaignRow[] = campaigns.map((c) => {
    const a = campAgg.get(c.id) ?? {
      visits: 0, visitSessions: new Set<string>(), productViews: 0, addUnits: 0,
      attributedOrders: 0, paidOrders: 0, grossSalesMinor: 0, grossProductSalesMinor: 0, firstEventAt: null,
    };
    return {
      campaignId: c.id,
      name: c.name,
      slug: c.slug,
      code: c.code,
      status: c.status,
      defaultSource: c.defaultSource,
      defaultMedium: c.defaultMedium,
      createdAt: c.createdAt.toISOString(),
      visits: a.visits,
      visitSessions: a.visitSessions.size,
      productViews: a.productViews,
      addUnits: a.addUnits,
      attributedOrders: a.attributedOrders,
      paidOrders: a.paidOrders,
      paidOrdersPrev: paidPrevMap.get(c.id) ?? 0,
      grossSalesMinor: a.grossSalesMinor,
      grossProductSalesMinor: a.grossProductSalesMinor,
      aovMinor: a.paidOrders > 0 ? Math.round(a.grossSalesMinor / a.paidOrders) : null,
      conversionPct: rate(a.paidOrders, a.visitSessions.size),
      firstEventAt: a.firstEventAt ? a.firstEventAt.toISOString() : null,
    };
  });

  // ---- unclaimed UTM-source aggregation -----------------------------------
  type UtmAgg = { visits: number; visitSessions: Set<string>; productViews: number; addUnits: number; attributedOrders: number; paidOrders: number; grossSalesMinor: number };
  const utmAgg = new Map<string, UtmAgg>();
  const utmKey = (source: string, medium: string | null, campaign: string | null) =>
    `${source}\u0000${medium ?? ""}\u0000${campaign ?? ""}`;
  const utm = (source: string, medium: string | null, campaign: string | null): UtmAgg => {
    const k = utmKey(source, medium, campaign);
    let a = utmAgg.get(k);
    if (!a) {
      a = { visits: 0, visitSessions: new Set(), productViews: 0, addUnits: 0, attributedOrders: 0, paidOrders: 0, grossSalesMinor: 0 };
      utmAgg.set(k, a);
    }
    return a;
  };
  for (const e of events) {
    if (e.campaignId || !e.utmSource) continue; // campaign rows handled above; skip untagged
    const a = utm(e.utmSource, e.utmMedium, e.utmCampaign);
    if (e.eventType === "store_view") {
      a.visits += 1;
      const sk = e.sessionId ?? (e.shopperId ? `u:${e.shopperId}` : null);
      if (sk) a.visitSessions.add(sk);
    }
    if (e.eventType === "product_view") a.productViews += 1;
    if (e.eventType === "add_to_cart") a.addUnits += e.qty ?? 0;
  }
  for (const o of unclaimedCreated) utm(o.attrSource!, o.attrMedium, o.attrCampaign).attributedOrders += 1;
  for (const o of unclaimedPaid) {
    const a = utm(o.attrSource!, o.attrMedium, o.attrCampaign);
    a.paidOrders += 1;
    a.grossSalesMinor += o.totalMinor;
  }
  const utmRows: UtmSourceRow[] = [...utmAgg.entries()]
    .map(([k, a]) => {
      const [source, medium, campaign] = k.split("\u0000");
      return {
        source,
        medium: medium || null,
        campaign: campaign || null,
        visits: a.visits,
        visitSessions: a.visitSessions.size,
        productViews: a.productViews,
        addUnits: a.addUnits,
        attributedOrders: a.attributedOrders,
        paidOrders: a.paidOrders,
        grossSalesMinor: a.grossSalesMinor,
      };
    })
    .sort((x, y) => y.visits - x.visits || y.paidOrders - x.paidOrders)
    .slice(0, 50);

  const notes = [
    "Attribution model: LAST-TOUCH first-party association — the most recent validated tagged landing within 30 days before the event/order. A tagged visit is ASSOCIATED with a campaign, never claimed to CAUSE a sale.",
    "Attribution tracking started with this feature — orders and traffic before that date have no attribution and are never backfilled or guessed.",
    "Attributed orders use Order.createdAt; paid orders and sales use paidAt (an order created just before the window can pay inside it — the two counts legitimately differ).",
    "Conversion = attributed paid orders ÷ attributed visit sessions — mixed bases (orders vs cookie sessions), read as an indication.",
    "No advertising spend exists in first-party data, so no ROAS / CPC / CPA is computed. Ad-platform-reported conversions are a DIFFERENT measurement and are not shown here.",
    "Campaign-link tokens (nmcl) resolve only against your own storefront — a token from another store is ignored.",
  ];
  if (truncatedEvents) {
    notes.push(`Attributed-event scan capped at ${CAMPAIGN_EVENT_SCAN_CAP.toLocaleString()} rows for this window — counts are partial for the window.`);
  }

  return {
    rows,
    utmRows,
    totals: {
      campaigns: rows.length,
      attributedVisits: rows.reduce((s, r) => s + r.visits, 0),
      attributedPaidOrders: rows.reduce((s, r) => s + r.paidOrders, 0),
      attributedGrossSalesMinor: rows.reduce((s, r) => s + r.grossSalesMinor, 0),
      unclaimedPaidOrders: utmRows.reduce((s, r) => s + r.paidOrders, 0),
      unclaimedGrossSalesMinor: utmRows.reduce((s, r) => s + r.grossSalesMinor, 0),
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Freshness + observations
// ---------------------------------------------------------------------------
export async function freshnessFor(storeId: string): Promise<{ eventsUpTo: string | null; trackingSince: string | null }> {
  const [latest, earliest] = await Promise.all([
    db.analyticsEvent.findFirst({ where: { storeId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.analyticsEvent.findFirst({ where: { storeId }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  return {
    eventsUpTo: latest?.createdAt.toISOString() ?? null,
    trackingSince: earliest?.createdAt.toISOString() ?? null,
  };
}

export type Observation = { kind: string; text: string };

/** Evidence-gated observations — only emitted when the measurements support them. */
export function buildObservations(input: {
  traffic: TrafficSummary;
  funnel: Funnel;
  snapshot: CartSnapshot;
  sales: { paidOrders: number; paidOrdersPrev: number; unitsSold: number; grossSalesMinor: number };
  addUnits: number;
  addUnitsPrev: number;
}): Observation[] {
  const out: Observation[] = [];
  const { traffic, funnel, snapshot, sales } = input;

  // Store-level view→cart signal (per-product rates live in productPerformance)
  const storeViews = traffic.storeViews;
  const addSessions = funnel.stages.find((s) => s.key === "add_to_cart")?.count ?? 0;
  const viewSessions = funnel.stages.find((s) => s.key === "product_view")?.count ?? 0;
  if (storeViews >= 30 && viewSessions > 0 && addSessions / viewSessions < 0.05) {
    out.push({
      kind: "low_cart_interest",
      text: `Your products were viewed in ${viewSessions} session${viewSessions === 1 ? "" : "s"} this period, but very few of those sessions added anything to the cart. Product price, photos or description may be worth reviewing.`,
    });
  }

  // Cart interest not converting
  if (snapshot.totalUnits >= 5 && sales.paidOrders === 0) {
    out.push({
      kind: "cart_not_converting",
      text: `${snapshot.totalUnits} unit${snapshot.totalUnits === 1 ? "" : "s"} of your products are currently sitting in ${snapshot.activeCarts} active shopper cart${snapshot.activeCarts === 1 ? "" : "s"}, with no paid orders in this period.`,
    });
  }

  // Cart adds trend vs previous period
  if (input.addUnits >= 10 && input.addUnitsPrev > 0) {
    const delta = (input.addUnits - input.addUnitsPrev) / input.addUnitsPrev;
    if (delta >= 0.2) {
      out.push({ kind: "adds_up", text: `Cart additions increased ${Math.round(delta * 100)}% compared with the previous period (${input.addUnitsPrev} → ${input.addUnits} units added).` });
    } else if (delta <= -0.2) {
      out.push({ kind: "adds_down", text: `Cart additions decreased ${Math.round(-delta * 100)}% compared with the previous period (${input.addUnitsPrev} → ${input.addUnits} units added).` });
    }
  }

  // Top cart quantity
  const top = snapshot.byProduct[0];
  if (top && top.units >= 3) {
    out.push({ kind: "top_in_carts", text: `"${top.title}" currently has the largest quantity sitting in shopper carts (${top.units} unit${top.units === 1 ? "" : "s"} across ${top.carts} cart${top.carts === 1 ? "" : "s"}).` });
  }

  // Sales trend
  if (sales.paidOrders >= 3 && sales.paidOrdersPrev > 0) {
    const delta = (sales.paidOrders - sales.paidOrdersPrev) / sales.paidOrdersPrev;
    if (delta >= 0.2) out.push({ kind: "sales_up", text: `Paid orders increased ${Math.round(delta * 100)}% versus the previous period (${sales.paidOrdersPrev} → ${sales.paidOrders}).` });
    if (delta <= -0.2) out.push({ kind: "sales_down", text: `Paid orders decreased ${Math.round(-delta * 100)}% versus the previous period (${sales.paidOrdersPrev} → ${sales.paidOrders}).` });
  }
  return out;
}

export { COUNTRY_LABELS, MY_STATES, pct, rate, klDayKey };

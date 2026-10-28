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
  key: "today" | "7d" | "30d" | "custom";
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

export function parseInsightsWindow(url: URL): InsightsWindow {
  const raw = url.searchParams.get("window") ?? "30d";
  const now = new Date();
  let from: Date;
  let to: Date = now;
  if (raw === "today") {
    from = klStartOfToday();
  } else if (raw === "7d" || raw === "30d") {
    from = new Date(now.getTime() - (raw === "7d" ? 7 : 30) * 86_400_000);
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
    throw new ApiError(400, "VALIDATION", "window must be one of today|7d|30d|custom");
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

type EventRow = { eventType: string; sessionId: string | null; visitorId: string | null; shopperId: string | null; productId: string | null; qty: number | null; channel: string | null; createdAt: Date };

/** Bounded event fetch for a store window (≤ 20k rows; sets `truncated` if hit). */
async function eventsFor(storeId: string, from: Date, to: Date): Promise<{ rows: EventRow[]; truncated: boolean }> {
  const rows = await db.analyticsEvent.findMany({
    where: { storeId, createdAt: { gte: from, lt: to } },
    select: { eventType: true, sessionId: true, visitorId: true, shopperId: true, productId: true, qty: true, channel: true, createdAt: true },
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

export type FunnelStage = { key: string; label: string; count: number; prev: number; stepRate: number | null };
export type Funnel = { stages: FunnelStage[]; basis: string[] };

export async function funnelFor(storeId: string, win: InsightsWindow): Promise<Funnel> {
  const [cur, prev, ordersCur, ordersPrev] = await Promise.all([
    eventsFor(storeId, win.from, win.to),
    eventsFor(storeId, win.prevFrom, win.prevTo),
    db.order.count({ where: { storeId, createdAt: { gte: win.from, lt: win.to } } }),
    db.order.count({ where: { storeId, createdAt: { gte: win.prevFrom, lt: win.prevTo } } }),
  ]);
  const paidCur = await db.order.count({ where: { storeId, paidAt: { gte: win.from, lt: win.to } } });
  const paidPrev = await db.order.count({ where: { storeId, paidAt: { gte: win.prevFrom, lt: win.prevTo } } });

  const sessionSets = (rows: EventRow[]) => {
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
  };
  const s = sessionSets(cur.rows);
  const sp = sessionSets(prev.rows);

  const stages: FunnelStage[] = [
    { key: "store_visit", label: "Store visit (sessions)", count: s.store.size, prev: sp.store.size, stepRate: null },
    { key: "product_view", label: "Viewed a product", count: s.product.size, prev: sp.product.size, stepRate: rate(s.product.size, s.store.size) },
    { key: "add_to_cart", label: "Added to cart", count: s.cart.size, prev: sp.cart.size, stepRate: rate(s.cart.size, s.product.size) },
    { key: "begin_checkout", label: "Checkout started (orders)", count: ordersCur, prev: ordersPrev, stepRate: rate(ordersCur, s.cart.size) },
    { key: "purchase", label: "Paid orders", count: paidCur, prev: paidPrev, stepRate: rate(paidCur, ordersCur) },
  ];
  return {
    stages,
    basis: [
      "Visit → cart stages count DISTINCT pseudonymous sessions that performed each stage inside the window (estimates from first-party cookies; login not required).",
      "Checkout started = orders created in the window (authoritative Order.createdAt, any status). Paid orders = orders with paidAt in the window.",
      "The cart → checkout step mixes bases (sessions vs orders) — read it as an indication, not an exact visitor conversion.",
    ],
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

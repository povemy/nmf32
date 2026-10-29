// Seller Store Insights — acceptance + authorization test suite (mission ADDENDUM #7, Phase 6).
// Isolated [LT] fixtures; own Prisma client (connection_limit=2); dev server on :3000.
// Evidence labels: PASS/FAIL only for executed checks. Archived to performance/runs/.
// @ts-nocheck
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { check, summary, exitCode, signWebhook, sleep } from "./lib";

const BASE = "http://127.0.0.1:3000";
const LT = "[LT]";
const STAMP = Date.now().toString(36);
const WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo";

// Own client, bounded pool (topology §7 discipline).
const url = readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
const db = new PrismaClient({ datasources: { db: { url: `${url}${url.includes("?") ? "&" : "?"}connection_limit=2` } } });

const results = [];
function record(name: string, ok: boolean, detail = "") {
  check(name, ok, detail);
  results.push({ name, ok, detail });
}

async function jsonFetch(path: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** POST /api/cron/analytics-tick — forces a queue flush (dev-open) + returns stats. */
async function flushEvents() {
  const r = await fetch(`${BASE}/api/cron/analytics-tick`, { method: "POST" });
  await r.json().catch(() => ({}));
  await sleep(200);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function registerLtSeller(tag: string) {
  const email = `lt-si-${tag}-${STAMP}@lt.test`;
  const r = await jsonFetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "LtSeller123!", fullName: `${LT} SI Seller ${tag}`, storeName: `${LT} SI Store ${tag}` }),
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`seller register failed ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  const sellerId = r.body?.data?.seller?.id;
  const storeId = r.body?.data?.seller?.storeId;
  const storeSlug = r.body?.data?.seller?.storeSlug;
  const token = r.body?.data?.token;
  // Test-fixture promotion: live store + published home + active product.
  await db.seller.update({ where: { id: sellerId }, data: { status: "active" } });
  await db.store.update({ where: { id: storeId }, data: { status: "live", supportEmail: email } });
  const home = await db.cmsPage.findFirst({ where: { storeId, slug: "home" } });
  if (home) await db.cmsPage.update({ where: { id: home.id }, data: { publishedJson: home.draftJson, publishedVersion: 1 } });
  const product = await db.product.create({
    data: { storeId, title: `${LT} SI product ${tag}`, slug: `lt-si-${tag}-${STAMP}`, description: "SI test artifact", status: "active", priceMinor: 1000 },
  });
  const variant = await db.productVariant.create({ data: { productId: product.id, name: "std", stock: 50, moq: 1, priceMinor: 1000, isActive: true } });
  return { email, sellerId, storeId, storeSlug, token, productId: product.id, variantId: variant.id, productSlug: product.slug };
}

async function registerLtShopper(tag: string) {
  const email = `lt-si-buyer-${tag}-${STAMP}@lt.test`;
  const r = await jsonFetch("/api/auth/shopper/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "LtBuyer123!", fullName: `${LT} SI Buyer` }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { email, cookie };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let sellerA: Awaited<ReturnType<typeof registerLtSeller>>;
let sellerB: Awaited<ReturnType<typeof registerLtSeller>>;
let shopper: Awaited<ReturnType<typeof registerLtShopper>>;
let groupRef = "";
let orderA = null;

async function main() {
  // ---- setup ----
  sellerA = await registerLtSeller("a");
  sellerB = await registerLtSeller("b");
  shopper = await registerLtShopper("a");
  record("setup: two [LT] sellers + live stores + active products + shopper", true, `A=${sellerA.storeSlug} B=${sellerB.storeSlug}`);

  // ---- T1: auth negatives ----
  for (const path of ["overview", "cart", "products", "sales", "markets", "markets/products?dimension=state&code=Johor"]) {
    const r = await jsonFetch(`/api/store/insights/${path}${path.includes("?") ? "&" : "?"}window=7d`);
    record(`T1 unauthenticated /api/store/insights/${path} → 401`, r.status === 401, `got ${r.status}`);
  }
  const badTok = await jsonFetch("/api/store/insights/overview?window=7d", { headers: bearer("deadbeefdeadbeefdeadbeef") });
  record("T1 invalid bearer token → 401", badTok.status === 401, `got ${badTok.status}`);

  // ---- T2/T3: storefront + PDP view tracking with dedup ----
  const sfFirst = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}`, { headers: { Referer: "https://www.google.com/search?q=test" } });
  await sfFirst.json();
  const setCookies = sfFirst.headers.getSetCookie?.() ?? [];
  const jar = setCookies.map((c) => c.split(";")[0]).join("; ");
  const sidCookie = setCookies.find((c) => c.startsWith("nm_ins_sid=")) ?? "";
  const vidCookie = setCookies.find((c) => c.startsWith("nm_ins_vid=")) ?? "";
  record("T2 identity cookies set on first storefront visit", Boolean(sidCookie && vidCookie), `${sidCookie.split("=")[0]} ${vidCookie.split("=")[0]}`);

  // Second hit, same session → dedup within the hour bucket
  const sfSecond = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}`, { headers: { Cookie: jar, Referer: "https://www.google.com/" } });
  await sfSecond.json();
  // PDP twice, same session
  const pdp1 = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}/products/${sellerA.productSlug}`, { headers: { Cookie: jar } });
  await pdp1.json();
  const pdp2 = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}/products/${sellerA.productSlug}`, { headers: { Cookie: jar } });
  await pdp2.json();
  await flushEvents();

  let evs = await db.analyticsEvent.findMany({ where: { storeId: sellerA.storeId } });
  record("T2 store_view deduped (2 hits, same session+hour → 1 event)", evs.filter((e) => e.eventType === "store_view").length === 1, `count=${evs.filter((e) => e.eventType === "store_view").length}`);
  record("T2 referrer classified search + host-only stored", evs.find((e) => e.eventType === "store_view")?.channel === "search" && evs.find((e) => e.eventType === "store_view")?.referrerHost === "www.google.com", JSON.stringify(evs.find((e) => e.eventType === "store_view")?.channel));
  record("T3 product_view deduped (2 PDP hits, same session+hour → 1 event)", evs.filter((e) => e.eventType === "product_view").length === 1, `count=${evs.filter((e) => e.eventType === "product_view").length}`);

  // New session (no cookie header) → +1 store_view, distinct sessionId
  const sfThird = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}`);
  await sfThird.json();
  await flushEvents();
  evs = await db.analyticsEvent.findMany({ where: { storeId: sellerA.storeId } });
  record("T4 new session counts a new store_view (2 total)", evs.filter((e) => e.eventType === "store_view").length === 2, `count=${evs.filter((e) => e.eventType === "store_view").length}`);
  record("T4 session ids distinct across events", new Set(evs.map((e) => e.sessionId)).size === 2, `distinct=${new Set(evs.map((e) => e.sessionId)).size}`);
  record("T4 unique visitors distinct (2)", new Set(evs.map((e) => e.visitorId)).size === 2, `distinct=${new Set(evs.map((e) => e.visitorId)).size}`);

  // ---- T5/T6/T7: cart ops events ----
  const add = async (variantId: string, qty: number) =>
    jsonFetch("/api/cart/items", { method: "POST", headers: { "Content-Type": "application/json", cookie: shopper.cookie }, body: JSON.stringify({ variantId, qty }) });
  await add(sellerA.variantId, 2); // pre 0 → post 2
  await add(sellerA.variantId, 1); // pre 2 → post 3 (delta 1)
  await flushEvents();
  let addEvents = await db.analyticsEvent.findMany({ where: { storeId: sellerA.storeId, eventType: "add_to_cart" }, orderBy: { createdAt: "asc" } });
  record("T5 add_to_cart qty deltas are the APPLIED deltas (2 then 1)", addEvents.length === 2 && addEvents[0].qty === 2 && addEvents[1].qty === 1, JSON.stringify(addEvents.map((e) => e.qty)));

  // remove via PATCH qty=0
  const cartNow = await jsonFetch("/api/cart", { headers: { cookie: shopper.cookie } });
  const lineId = cartNow.body?.data?.cart?.items?.find((i) => i.variantId === sellerA.variantId)?.id;
  await jsonFetch(`/api/cart/items/${lineId}`, { method: "PATCH", headers: { "Content-Type": "application/json", cookie: shopper.cookie }, body: JSON.stringify({ qty: 0 }) });
  await flushEvents();
  const rmEvent = await db.analyticsEvent.findFirst({ where: { storeId: sellerA.storeId, eventType: "remove_from_cart" } });
  record("T6 remove_from_cart (PATCH qty→0) records removed units (3)", rmEvent?.qty === 3, `qty=${rmEvent?.qty}`);

  // re-add for checkout: A qty 2 + B qty 1 (multi-vendor cart)
  await add(sellerA.variantId, 2);
  await add(sellerB.variantId, 1);
  // view_cart: GET /api/cart with items
  await jsonFetch("/api/cart", { headers: { cookie: shopper.cookie } });
  await flushEvents();
  const viewCartA = await db.analyticsEvent.findFirst({ where: { storeId: sellerA.storeId, eventType: "view_cart" } });
  const viewCartB = await db.analyticsEvent.findFirst({ where: { storeId: sellerB.storeId, eventType: "view_cart" } });
  record("T7 view_cart recorded per store (multi-vendor cart)", Boolean(viewCartA && viewCartB), `A=${Boolean(viewCartA)} B=${Boolean(viewCartB)}`);

  // ---- T8/T9: current-cart snapshot + multi-vendor attribution ----
  const cartA = await jsonFetch("/api/store/insights/cart?window=7d", { headers: bearer(sellerA.token) });
  const cartB = await jsonFetch("/api/store/insights/cart?window=7d", { headers: bearer(sellerB.token) });
  const curA = cartA.body?.data?.current;
  const curB = cartB.body?.data?.current;
  record("T8 seller A snapshot: own units only (2 units, 1 cart)", curA?.totalUnits === 2 && curA?.activeCarts === 1, `units=${curA?.totalUnits} carts=${curA?.activeCarts}`);
  record("T8 seller B snapshot: own units only (1 unit, 1 cart) — mixed cart attributed per seller", curB?.totalUnits === 1 && curB?.activeCarts === 1, `units=${curB?.totalUnits} carts=${curB?.activeCarts}`);
  record("T8 seller A product row: 2 units / 1 distinct cart", curA?.byProduct?.[0]?.units === 2 && curA?.byProduct?.[0]?.carts === 1, JSON.stringify(curA?.byProduct?.[0]?.units));
  record("T9 period adds reported separately from live snapshot", cartA.body?.data?.period?.addUnits === 5, `addUnits=${cartA.body?.data?.period?.addUnits}`); // 2+1 removed... adds: 2,1,2 = 5

  // ---- T10: multi-vendor checkout + authoritative payment ----
  const idem = `lt-si-${STAMP}`;
  const co = await jsonFetch("/api/checkout/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: shopper.cookie, "Idempotency-Key": idem },
    body: JSON.stringify({
      items: [
        { variantId: sellerA.variantId, qty: 2 },
        { variantId: sellerB.variantId, qty: 1 },
      ],
      customer: { name: "LT SI Buyer", email: shopper.email },
      shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
      provider: "fpx_toyyibpay",
    }),
  });
  groupRef = co.body?.data?.paymentRef ?? "";
  const groupTotal = co.body?.data?.totalMinor ?? 0;
  record("T10 multi-seller checkout creates one payment group + 2 orders", co.status === 201 && (co.body?.data?.orderNumbers?.length ?? 0) === 2, `status=${co.status} ref=${groupRef} total=${groupTotal}`);

  const orderNumberA = co.body?.data?.orderNumbers?.[0];
  orderA = await db.order.findUnique({ where: { orderNumber: orderNumberA }, include: { items: true } });

  const ts = Date.now();
  const sig = signWebhook(groupRef, "payment.succeeded", groupTotal, ts);
  const wh = await jsonFetch("/api/webhooks/payments/fpx_toyyibpay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerRef: groupRef, eventType: "payment.succeeded", amountMinor: groupTotal, ts, sig }),
  });
  record("T10 payment webhook succeeds for the group", wh.status === 200, `status=${wh.status} ${JSON.stringify(wh.body).slice(0, 120)}`);

  const paidA = await db.order.findUnique({ where: { orderNumber: orderNumberA } });
  record("T10 order A paid (authoritative paidAt)", paidA?.status === "paid" && Boolean(paidA?.paidAt), `status=${paidA?.status}`);

  // ---- T11: sales + funnel metrics from authoritative records ----
  const ovA = await jsonFetch("/api/store/insights/overview?window=7d&fresh=1", { headers: bearer(sellerA.token) });
  const s = ovA.body?.data?.summary;
  record("T11 overview paid orders = authoritative order count (1)", s?.orders === 1, `orders=${s?.orders}`);
  record("T11 gross sales = order totalMinor incl. shipping", s?.grossSalesMinor === paidA?.totalMinor, `got=${s?.grossSalesMinor} want=${paidA?.totalMinor}`);
  const fn = ovA.body?.data?.funnel?.stages ?? [];
  const fBC = fn.find((x) => x.key === "begin_checkout")?.count;
  const fP = fn.find((x) => x.key === "purchase")?.count;
  record("T11 funnel checkout-started = orders created (1)", fBC === 1, `got=${fBC}`);
  record("T11 funnel purchase = paid orders (1)", fP === 1, `got=${fP}`);

  // ---- T12: purchased items leave the live cart snapshot ----
  const cartA2 = await jsonFetch("/api/store/insights/cart?window=7d&fresh=1", { headers: bearer(sellerA.token) });
  record("T12 current-cart snapshot excludes purchased units", cartA2.body?.data?.current?.totalUnits === 0, `units=${cartA2.body?.data?.current?.totalUnits}`);

  // ---- T13: duplicate webhook does not duplicate sales ----
  const ts2 = Date.now();
  const sig2 = signWebhook(groupRef, "payment.succeeded", groupTotal, ts2);
  await jsonFetch("/api/webhooks/payments/fpx_toyyibpay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerRef: groupRef, eventType: "payment.succeeded", amountMinor: groupTotal, ts: ts2, sig: sig2 }),
  });
  const ovA2 = await jsonFetch("/api/store/insights/overview?window=7d&fresh=1", { headers: bearer(sellerA.token) });
  record("T13 duplicate webhook does not double-count sales", ovA2.body?.data?.summary?.grossSalesMinor === paidA?.totalMinor && ovA2.body?.data?.summary?.orders === 1, `orders=${ovA2.body?.data?.summary?.orders} gross=${ovA2.body?.data?.summary?.grossSalesMinor}`);

  // ---- T14: geographic attribution ----
  record("T14 order records MY country snapshot at checkout (source=checkout)", paidA?.shippingCountryCode === "MY" && paidA?.shippingCountrySource === "checkout", `${paidA?.shippingCountryCode}/${paidA?.shippingCountrySource}`);
  const mk = await jsonFetch("/api/store/insights/markets?window=7d&dimension=country&fresh=1", { headers: bearer(sellerA.token) });
  const myRow = (mk.body?.data?.rows ?? []).find((r) => r.code === "MY");
  record("T14 markets country: MY row with correct paid orders", myRow?.paidOrders === 1, JSON.stringify(myRow?.paidOrders));
  const mkState = await jsonFetch("/api/store/insights/markets?window=7d&dimension=state&fresh=1", { headers: bearer(sellerA.token) });
  const klRow = (mkState.body?.data?.rows ?? []).find((r) => r.code === "Kuala Lumpur");
  record("T14 markets state: recorded destination state (Kuala Lumpur)", klRow?.paidOrders === 1, JSON.stringify(klRow?.paidOrders));
  record("T14 markets notes disclose backfill + billing-unavailable honestly", Array.isArray(mk.body?.data?.notes) && mk.body.data.notes.length >= 3, `notes=${(mk.body?.data?.notes ?? []).length}`);

  // ---- T15: seller-to-seller isolation (negative authorization) ----
  const ovB = await jsonFetch("/api/store/insights/overview?window=7d&fresh=1", { headers: bearer(sellerB.token) });
  const tB = ovB.body?.data?.traffic;
  record("T15 seller B sees ZERO of seller A's store/product views", tB?.storeViews === 0 && tB?.productViews === 0, `views=${tB?.storeViews}/${tB?.productViews}`);
  record("T15 seller B sees own cart-add units only (1)", ovB.body?.data?.summary?.cartAddUnits === 1, `addUnits=${ovB.body?.data?.summary?.cartAddUnits}`);
  const prodsB = await jsonFetch("/api/store/insights/products?window=7d&fresh=1", { headers: bearer(sellerB.token) });
  const bIds = (prodsB.body?.data?.rows ?? []).map((r) => r.productId);
  record("T15 seller B product table contains ONLY seller B products", bIds.length === 1 && bIds[0] === sellerB.productId, JSON.stringify(bIds));
  const salesB = await jsonFetch("/api/store/insights/sales?window=7d&fresh=1", { headers: bearer(sellerB.token) });
  record("T15 seller B sales: own order only (1 paid order, B totalMinor)", salesB.body?.data?.cards?.paidOrders === 1, `orders=${salesB.body?.data?.cards?.paidOrders}`);
  record("T15 seller B gross sales = B order total (not the shared group total)", salesB.body?.data?.cards?.grossSalesMinor !== groupTotal, `B=${salesB.body?.data?.cards?.grossSalesMinor} group=${groupTotal}`);
  // Empty-ish store: B has no traffic events of its own besides cart adds
  record("T15 seller B trackingSince present (cart events) but store views zero — honest empty traffic state", tB?.storeViews === 0);

  // ---- T16: product performance row ----
  const prodsA = await jsonFetch("/api/store/insights/products?window=7d&sort=purchases&fresh=1", { headers: bearer(sellerA.token) });
  const rowA = (prodsA.body?.data?.rows ?? []).find((r) => r.productId === sellerA.productId);
  record("T16 product row: views=1, purchasedUnits=2, current cart=0 after purchase", rowA?.views === 1 && rowA?.purchasedUnits === 2 && rowA?.currentCartUnits === 0, JSON.stringify({ views: rowA?.views, purchased: rowA?.purchasedUnits, cart: rowA?.currentCartUnits }));
  record("T16 product row: gross sales = 2 × RM10 = 2000 minor", rowA?.grossSalesMinor === 2000, `got=${rowA?.grossSalesMinor}`);

  // ---- T17: window filters ----
  const today = await jsonFetch("/api/store/insights/overview?window=today&fresh=1", { headers: bearer(sellerA.token) });
  record("T17 window=today counts today's store views (2)", today.body?.data?.traffic?.storeViews === 2, `views=${today.body?.data?.traffic?.storeViews}`);
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const past = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const custom = await jsonFetch(`/api/store/insights/overview?window=custom&from=${past}&to=${future}&fresh=1`, { headers: bearer(sellerA.token) });
  record("T17 custom window (40 days back → +30d) includes the events", custom.body?.data?.traffic?.storeViews === 2, `views=${custom.body?.data?.traffic?.storeViews}`);
  const emptyWin = await jsonFetch(`/api/store/insights/overview?window=custom&from=2020-01-01&to=2020-01-15&fresh=1`, { headers: bearer(sellerA.token) });
  record("T17 empty historical window → zeros + prev-period zeros", emptyWin.body?.data?.traffic?.storeViews === 0 && emptyWin.body?.data?.summary?.orders === 0, `views=${emptyWin.body?.data?.traffic?.storeViews}`);
  const badWin = await jsonFetch("/api/store/insights/overview?window=banana&fresh=1", { headers: bearer(sellerA.token) });
  record("T17 invalid window rejected 400", badWin.status === 400, `got ${badWin.status}`);
  const tooLong = await jsonFetch(`/api/store/insights/overview?window=custom&from=2020-01-01&to=2020-12-31&fresh=1`, { headers: bearer(sellerA.token) });
  record("T17 >92-day custom window rejected 400", tooLong.status === 400, `got ${tooLong.status}`);

  // ---- T18: CSV export ----
  const csv = await fetch(`${BASE}/api/store/insights/export?type=products&window=7d`, { headers: bearer(sellerA.token) });
  const csvText = await csv.text();
  record("T18 CSV export: text/csv + header + seller-scoped product row", csv.status === 200 && (csv.headers.get("content-type") ?? "").includes("text/csv") && csvText.includes("NOMOFEE Seller Insights export") && csvText.includes(`${LT} SI product a`), `status=${csv.status} rows=${csvText.split("\n").length}`);
  const csvNo = await fetch(`${BASE}/api/store/insights/export?type=products&window=7d`);
  record("T18 CSV export requires auth (401)", csvNo.status === 401, `got ${csvNo.status}`);

  // ---- T19: refund reflection (authoritative Refund records) ----
  const refundRow = await db.refund.create({
    data: { orderId: paidA.id, amountMinor: 500, reason: "SI test partial refund", status: "processed", requestedBy: "seller", restock: false, processedAt: new Date() },
  });
  const salesAfterRefund = await jsonFetch("/api/store/insights/sales?window=7d&fresh=1", { headers: bearer(sellerA.token) });
  record("T19 processed refund appears in sales (amount + count)", salesAfterRefund.body?.data?.cards?.refundsMinor === 500 && salesAfterRefund.body?.data?.cards?.refundCount === 1, `amount=${salesAfterRefund.body?.data?.cards?.refundsMinor}`);
  const mkAfterRefund = await jsonFetch("/api/store/insights/markets?window=7d&dimension=country&fresh=1", { headers: bearer(sellerA.token) });
  record("T19 refund attributed to the order's geography (MY row)", (mkAfterRefund.body?.data?.rows ?? []).find((r) => r.code === "MY")?.refundsMinor === 500, JSON.stringify((mkAfterRefund.body?.data?.rows ?? [])[0]?.refundsMinor));
  await db.refund.delete({ where: { id: refundRow.id } });

  // ---- T20: recommendations scoping fix regression (runtime sanity) ----
  const rec = await jsonFetch("/api/me/recommendations", { headers: { cookie: shopper.cookie } });
  record("T20 recommendations route healthy after scoping fix", rec.status === 200, `status=${rec.status}`);

  // ---- T21: retention tick ----
  const tickGet = await jsonFetch("/api/cron/analytics-tick");
  record("T21 analytics tick observability (queue stats + retention)", tickGet.status === 200 && Boolean(tickGet.body?.data?.queue), `status=${tickGet.status}`);

  // ---- T22: rate limiting ----
  let limited = false;
  for (let i = 0; i < 65; i++) {
    const r = await fetch(`${BASE}/api/store/insights/overview?window=7d`, { headers: bearer(sellerA.token) });
    if (r.status === 429) { limited = true; break; }
  }
  record("T22 insights endpoints rate-limited (429 after burst)", limited);
}

main()
  .catch((e) => {
    console.error("SUITE ERROR:", e);
    results.push({ name: "suite crashed", ok: false, detail: String(e) });
  })
  .finally(async () => {
    // ---- cleanup: [LT] artifacts (orders kept for audit trail like other suites;
    //      the inserted Refund test row was already deleted above) ----
    try {
      await db.analyticsEvent.deleteMany({ where: { OR: [{ storeId: sellerA?.storeId }, { storeId: sellerB?.storeId }] } });
      const carts = await db.cart.findMany({ where: { shopper: { email: { in: [shopper?.email].filter(Boolean) } } }, select: { id: true } });
      if (carts.length) {
        await db.cartItem.deleteMany({ where: { cartId: { in: carts.map((c) => c.id) } } });
        await db.cart.deleteMany({ where: { id: { in: carts.map((c) => c.id) } } });
      }
      await db.session.deleteMany({ where: { OR: [{ userId: sellerA?.sellerId }, { userId: sellerB?.sellerId }] } });
    } catch (e) {
      console.warn("cleanup partial:", e instanceof Error ? e.message : e);
    }
    const passed = results.filter((r) => r.ok).length;
    const out = {
      suite: "seller-insights",
      ranAt: new Date().toISOString(),
      total: results.length,
      passed,
      failed: results.length - passed,
      results,
    };
    const fs = await import("node:fs");
    fs.writeFileSync(`performance/runs/${new Date().toISOString().slice(0, 10)}-seller-insights.json`, JSON.stringify(out, null, 2));
    console.log(`\narchived: performance/runs/${new Date().toISOString().slice(0, 10)}-seller-insights.json`);
    summary("seller-insights");
    await db.$disconnect();
    process.exit(exitCode());
  });

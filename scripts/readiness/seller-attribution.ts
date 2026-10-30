// Seller Insights & Marketing Intelligence — attribution acceptance suite
// (mission: campaign attribution + F-20 minimal remediation verification).
// Isolated [LT] fixtures; own Prisma client (connection_limit=2); dev server :3000.
// Covers: landing beacon + UTM validation + CSRF, campaign link CRUD + isolation,
// attributed visit/event flow, checkout attribution freeze, campaigns report
// correctness + isolation, funnel drop-off/payment-attempts, session sliding
// fix, and F-20 fail-closed scoping (global marketplace-connection rows).
// @ts-nocheck
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { check, summary, exitCode, signWebhook, sleep } from "./lib";

const BASE = "http://127.0.0.1:3000";
const LT = "[LT]";
const STAMP = Date.now().toString(36);
const WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo";

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

/** Registration with 429-aware retry. Back-to-back suite runs share the 5/min
 *  "auth-register" bucket (F-12), so a suite started right after another can
 *  get throttled. Wait the advertised retryAfterSeconds (+1s) and retry (max 2
 *  waits) instead of silently cascading empty-cookie failures downstream. */
async function registerFetch(path: string, body: unknown) {
  for (let attempt = 0; ; attempt++) {
    const r = await jsonFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status !== 429 || attempt >= 2) return r;
    const waitS = (r.body?.error?.details?.retryAfterSeconds ?? 12) + 1;
    console.log(`  [register throttle] ${path} 429 — waiting ${waitS}s (attempt ${attempt + 1}/2)`);
    await sleep(waitS * 1000);
  }
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function flushEvents() {
  const r = await fetch(`${BASE}/api/cron/analytics-tick`, { method: "POST" });
  await r.json().catch(() => ({}));
  await sleep(250);
}

// ---------------------------------------------------------------------------
// Fixtures (same pattern as seller-insights.ts)
// ---------------------------------------------------------------------------
async function registerLtSeller(tag: string) {
  const email = `lt-mi-${tag}-${STAMP}@lt.test`;
  const r = await registerFetch("/api/auth/register", { email, password: "LtSeller123!", fullName: `${LT} MI Seller ${tag}`, storeName: `${LT} MI Store ${tag}` });
  if (r.status !== 200 && r.status !== 201) throw new Error(`seller register failed ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  const sellerId = r.body?.data?.seller?.id;
  const storeId = r.body?.data?.seller?.storeId;
  const storeSlug = r.body?.data?.seller?.storeSlug;
  const token = r.body?.data?.token;
  await db.seller.update({ where: { id: sellerId }, data: { status: "active" } });
  await db.store.update({ where: { id: storeId }, data: { status: "live", supportEmail: email } });
  const home = await db.cmsPage.findFirst({ where: { storeId, slug: "home" } });
  if (home) await db.cmsPage.update({ where: { id: home.id }, data: { publishedJson: home.draftJson, publishedVersion: 1 } });
  const product = await db.product.create({
    data: { storeId, title: `${LT} MI product ${tag}`, slug: `lt-mi-${tag}-${STAMP}`, description: "MI test artifact", status: "active", priceMinor: 1000 },
  });
  const variant = await db.productVariant.create({ data: { productId: product.id, name: "std", stock: 50, moq: 1, priceMinor: 1000, isActive: true } });
  return { email, sellerId, storeId, storeSlug, token, productId: product.id, variantId: variant.id, productSlug: product.slug };
}

async function registerLtShopper(tag: string) {
  const email = `lt-mi-buyer-${tag}-${STAMP}@lt.test`;
  const r = await registerFetch("/api/auth/shopper/register", { email, password: "LtBuyer123!", fullName: `${LT} MI Buyer` });
  if (r.status !== 200 && r.status !== 201) throw new Error(`shopper register failed ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { email, cookie };
}

/** Merge Set-Cookie values from a response into a cookie-jar string. */
function absorbCookie(jar: string, res: Response): string {
  const map = new Map(jar.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c]));
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq), pair);
  }
  return [...map.values()].join("; ");
}

// seller fixture ids captured for cleanup (module scope, set during main)
let _sellerA: any = null;
let _sellerB: any = null;

async function main() {
  const sellerA = await registerLtSeller("a");
  const sellerB = await registerLtSeller("b");
  _sellerA = sellerA;
  _sellerB = sellerB;
  const shopper = await registerLtShopper("a");
  record("setup: two [LT] sellers + live stores + products + shopper", true, `A=${sellerA.storeSlug} B=${sellerB.storeSlug}`);

  // =========================================================================
  // A. Campaign link management + isolation
  // =========================================================================
  const unauth = await jsonFetch("/api/store/campaigns", { headers: bearer("deadbeefdeadbeefdeadbeef") });
  record("A1 campaigns list requires auth (401 on bad token)", unauth.status === 401, `got ${unauth.status}`);

  const mkCampaign = (name: string, extra = {}) =>
    jsonFetch("/api/store/campaigns", { method: "POST", headers: bearer(sellerA.token), body: JSON.stringify({ name, ...extra }) });
  const c1 = await mkCampaign("Raya Blast", { source: "whatsapp", medium: "social" });
  const c1d = c1.body?.data;
  record("A2 campaign created (201) with code + slug + linkPath", c1.status === 201 && Boolean(c1d?.code) && Boolean(c1d?.slug) && String(c1d?.linkPath ?? "").includes("nmcl="), String(c1d?.linkPath ?? "none").slice(0, 120));
  record("A2 linkPath targets the seller's storefront with utm_campaign", String(c1d?.linkPath ?? "").startsWith(`/?sf=${sellerA.storeSlug}&utm_campaign=`), String(c1d?.linkPath).slice(0, 80));
  record("A2 default source/medium stamped into the link", String(c1d?.linkPath ?? "").includes("utm_source=whatsapp") && String(c1d?.linkPath ?? "").includes("utm_medium=social"), "");

  const c2 = await mkCampaign("Raya Blast");
  record("A3 duplicate name → unique slug suffix (-2)", c2.status === 201 && c2.body?.data?.slug === `${c1d.slug}-2`, `slug=${c2.body?.data?.slug}`);

  const noName = await jsonFetch("/api/store/campaigns", { method: "POST", headers: bearer(sellerA.token), body: JSON.stringify({ source: "x" }) });
  record("A3 missing name rejected 400", noName.status === 400, `got ${noName.status}`);

  // Isolation: seller B's list must NOT contain A's campaigns; PATCH on A's id → 404.
  const listB = await jsonFetch("/api/store/campaigns", { headers: bearer(sellerB.token) });
  const bIds = (listB.body?.data ?? []).map((c) => c.id);
  record("A4 seller B campaign list excludes A's campaigns (isolation)", !bIds.includes(c1d.id) && bIds.length === 0, `B has ${bIds.length}`);
  const patchB = await jsonFetch(`/api/store/campaigns/${c1d.id}`, { method: "PATCH", headers: bearer(sellerB.token), body: JSON.stringify({ status: "archived" }) });
  record("A4 seller B cannot PATCH A's campaign (404)", patchB.status === 404, `got ${patchB.status}`);

  const badStatus = await jsonFetch(`/api/store/campaigns/${c1d.id}`, { method: "PATCH", headers: bearer(sellerA.token), body: JSON.stringify({ status: "hacked" }) });
  record("A5 invalid status rejected 400", badStatus.status === 400, `got ${badStatus.status}`);

  const arch = await jsonFetch(`/api/store/campaigns/${c2.body?.data?.id}`, { method: "PATCH", headers: bearer(sellerA.token), body: JSON.stringify({ status: "archived" }) });
  record("A5 archive works, slug/code immutable", arch.status === 200 && arch.body?.data?.status === "archived" && arch.body?.data?.slug === c2.body?.data?.slug, `status=${arch.body?.data?.status}`);
  const react = await jsonFetch(`/api/store/campaigns/${c2.body?.data?.id}`, { method: "PATCH", headers: bearer(sellerA.token), body: JSON.stringify({ status: "active" }) });
  record("A5 reactivation works", react.status === 200 && react.body?.data?.status === "active", `status=${react.body?.data?.status}`);

  // =========================================================================
  // B. Landing beacon — validation, cookie, CSRF, rate limit
  // =========================================================================
  const noop = await jsonFetch("/api/analytics/landing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  record("B1 beacon with no params → 200 captured:false (idempotent no-op)", noop.status === 200 && noop.body?.data?.captured === false, JSON.stringify(noop.body?.data));

  const csrf = await fetch(`${BASE}/api/analytics/landing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ utm_source: "evil", sf: sellerA.storeSlug }),
  });
  record("B2 cross-site POST beacon rejected by CSRF gate (403)", csrf.status === 403, `got ${csrf.status}`);

  const getMethod = await fetch(`${BASE}/api/analytics/landing`);
  record("B3 GET beacon not allowed (405)", getMethod.status === 405, `got ${getMethod.status}`);

  // Valid tagged landing for seller A's campaign (shopper jar)
  let jar = shopper.cookie;
  const land = await fetch(`${BASE}/api/analytics/landing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({ sf: sellerA.storeSlug, nmcl: c1d.code, utm_source: "facebook", utm_medium: "paid_social" }),
  });
  const landBody = await land.json().catch(() => ({}));
  jar = absorbCookie(jar, land);
  const attrCookie = land.headers.getSetCookie?.().find((c) => c.startsWith("nm_ins_attr=")) ?? "";
  record("B4 valid beacon → captured:true + nm_ins_attr cookie set (httpOnly, 30d)", land.status === 200 && landBody?.data?.captured === true && attrCookie.includes("HttpOnly") && attrCookie.includes("Max-Age=2592000"), attrCookie.slice(0, 60));
  record("B4 cookie carries the resolved campaign + validated UTMs", decodeURIComponent(attrCookie).includes(`"campaignId":"${c1d.id}"`) && decodeURIComponent(attrCookie).includes('"utmSource":"facebook"'), "");

  // Cross-store token: A's campaign code + B's storefront → fail-closed (no campaign).
  const landCross = await fetch(`${BASE}/api/analytics/landing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({ sf: sellerB.storeSlug, nmcl: c1d.code }),
  });
  const crossBody = await landCross.json().catch(() => ({}));
  record("B5 cross-store nmcl token ignored (captured:false — campaign does not resolve)", landCross.status === 200 && crossBody?.data?.captured === false, JSON.stringify(crossBody?.data));

  // Garbage UTM values sanitized: control chars + oversized → dropped/clamped.
  const landBad = await fetch(`${BASE}/api/analytics/landing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({ sf: sellerA.storeSlug, utm_source: "a\u0000b\u0007c", utm_medium: "x".repeat(300) }),
  });
  jar = absorbCookie(jar, landBad);
  await landBad.json().catch(() => ({}));
  const badCookieRaw = decodeURIComponent(landBad.headers.getSetCookie?.().find((c) => c.startsWith("nm_ins_attr=")) ?? "");
  record("B6 control chars stripped + oversized values clamped on capture", badCookieRaw.includes('"utmSource":"a b c"') && !badCookieRaw.includes("x".repeat(60)), badCookieRaw.slice(0, 140));

  // Rate limit: 30/min on the beacon bucket — verified at the END so the
  // burst cannot starve the attribution beacons below (single shared IP).
  // (See B8 at the end of main().)

  // =========================================================================
  // C. Attributed visit → events carry attribution; channel from utm_source
  // =========================================================================
  // Restore the clean campaign attribution (last-touch — B6 overwrote it).
  const land2 = await fetch(`${BASE}/api/analytics/landing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({ sf: sellerA.storeSlug, nmcl: c1d.code, utm_source: "facebook", utm_medium: "paid_social" }),
  });
  jar = absorbCookie(jar, land2);
  await land2.json().catch(() => ({}));

  const sf = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}`, { headers: { Cookie: jar } });
  jar = absorbCookie(jar, sf);
  await sf.json();
  const pdp = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}/products/${sellerA.productSlug}`, { headers: { Cookie: jar } });
  jar = absorbCookie(jar, pdp);
  await pdp.json();
  await flushEvents();

  let evs = await db.analyticsEvent.findMany({ where: { storeId: sellerA.storeId } });
  const sv = evs.find((e) => e.eventType === "store_view");
  const pv = evs.find((e) => e.eventType === "product_view");
  record("C1 store_view event carries the campaign attribution", sv?.campaignId === c1d.id && sv?.utmSource === "facebook" && sv?.utmMedium === "paid_social", JSON.stringify({ campaignId: sv?.campaignId, utmSource: sv?.utmSource }));
  record("C1 store_view utmCampaign falls back to the campaign slug", sv?.utmCampaign === c1d.slug, `utmCampaign=${sv?.utmCampaign}`);
  record("C1 product_view event carries the same attribution", pv?.campaignId === c1d.id && pv?.utmSource === "facebook", "");
  record("C2 channel derived from utm_source (facebook → social)", sv?.channel === "social", `channel=${sv?.channel}`);

  // Untagged visit (fresh jar, no attribution cookie) → channel falls back to referrer classification.
  const sfPlain = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}`, { headers: { Referer: "https://www.bing.com/search?q=x" } });
  await sfPlain.json();
  await flushEvents();
  evs = await db.analyticsEvent.findMany({ where: { storeId: sellerA.storeId } });
  const plain = evs.filter((e) => e.eventType === "store_view").find((e) => e.utmSource == null && e.campaignId == null);
  record("C3 untagged visit stays unattributed + legacy referrer classification intact", plain?.campaignId == null && plain?.channel === "search" && plain?.utmSource == null, `channel=${plain?.channel}`);

  // =========================================================================
  // D. Session sliding-window fix (identity.ts)
  // =========================================================================
  const knownToken = "abcdef0123456789abcdef0123456789";
  const mkSid = (mintedAgoMs: number) => `${knownToken}.${Date.now() - mintedAgoMs}`;
  const sfSlide = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}`, { headers: { Cookie: `nm_ins_vid=${knownToken}; nm_ins_sid=${mkSid(25 * 60_000)}` } });
  const slideCookie = sfSlide.headers.getSetCookie?.().find((c) => c.startsWith("nm_ins_sid=")) ?? "";
  await sfSlide.json();
  record("D1 active session within window: SAME token, mintedAt refreshed (sliding fix)", slideCookie.startsWith(`nm_ins_sid=${knownToken}.`) && Number(slideCookie.split(".")[1]?.split(";")[0]) > Date.now() - 5_000, slideCookie.slice(0, 60));
  const sfRot = await fetch(`${BASE}/api/sf/${sellerA.storeSlug}`, { headers: { Cookie: `nm_ins_vid=${knownToken}; nm_ins_sid=${mkSid(31 * 60_000)}` } });
  const rotCookie = sfRot.headers.getSetCookie?.().find((c) => c.startsWith("nm_ins_sid=")) ?? "";
  await sfRot.json();
  record("D2 session past the 30-min window rotates to a NEW token", !rotCookie.startsWith(`nm_ins_sid=${knownToken}.`) && rotCookie.startsWith("nm_ins_sid="), rotCookie.slice(0, 60));
  await flushEvents();

  // =========================================================================
  // E. Cart event attribution + checkout freeze (golden path)
  // =========================================================================
  const add = await jsonFetch("/api/cart/items", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar },
    body: JSON.stringify({ variantId: sellerA.variantId, qty: 2 }),
  });
  await flushEvents();
  const addEv = await db.analyticsEvent.findFirst({ where: { storeId: sellerA.storeId, eventType: "add_to_cart" }, orderBy: { createdAt: "desc" } });
  record("E1 add_to_cart event carries attribution (fire-and-forget context intact)", addEv?.campaignId === c1d.id && addEv?.utmSource === "facebook", JSON.stringify({ campaignId: addEv?.campaignId, utmSource: addEv?.utmSource }));

  const idem = `lt-mi-${STAMP}`;
  const co = await jsonFetch("/api/checkout/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar, "Idempotency-Key": idem },
    body: JSON.stringify({
      items: [{ variantId: sellerA.variantId, qty: 2 }],
      customer: { name: "LT MI Buyer", email: shopper.email },
      shippingAddress: { line1: "1 MI Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
      provider: "fpx_toyyibpay",
    }),
  });
  const groupRef = co.body?.data?.paymentRef ?? "";
  const total = co.body?.data?.totalMinor ?? 0;
  record("E2 checkout created (single-seller)", co.status === 201, `status=${co.status} ref=${groupRef} total=${total}`);

  const orderNumber = co.body?.data?.orderNumbers?.[0];
  const orderRow = await db.order.findUnique({ where: { orderNumber } });
  record("E3 order froze the attribution snapshot at creation", orderRow?.attrCampaignId === c1d.id && orderRow?.attrSource === "facebook" && orderRow?.attrMedium === "paid_social" && orderRow?.attrCampaign === c1d.slug, JSON.stringify({ c: orderRow?.attrCampaignId, s: orderRow?.attrSource, m: orderRow?.attrMedium }));

  const ts = Date.now();
  const sig = signWebhook(groupRef, "payment.succeeded", total, ts);
  const wh = await jsonFetch("/api/webhooks/payments/fpx_toyyibpay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerRef: groupRef, eventType: "payment.succeeded", amountMinor: total, ts, sig }),
  });
  const paidOrder = await db.order.findUnique({ where: { orderNumber } });
  record("E4 payment webhook → order paid, attribution retained", wh.status === 200 && paidOrder?.status === "paid" && paidOrder?.attrCampaignId === c1d.id, `status=${paidOrder?.status} attr=${paidOrder?.attrCampaignId}`);

  // =========================================================================
  // F. Campaigns report — correctness + isolation + honesty
  // =========================================================================
  const repNo = await jsonFetch("/api/store/insights/campaigns?window=7d", { headers: bearer("nope") });
  record("F1 campaigns report requires auth (401)", repNo.status === 401, `got ${repNo.status}`);

  const repA = await jsonFetch("/api/store/insights/campaigns?window=7d&fresh=1", { headers: bearer(sellerA.token) });
  const rep = repA.body?.data;
  const campRow = (rep?.rows ?? []).find((r) => r.campaignId === c1d.id);
  record("F2 campaign row: attributed visits ≥1 (store_view with campaignId)", (campRow?.visits ?? 0) >= 1, `visits=${campRow?.visits}`);
  record("F2 campaign row: attributed paid orders = 1 (authoritative)", campRow?.paidOrders === 1, `paidOrders=${campRow?.paidOrders}`);
  record("F2 campaign row: gross sales = order totalMinor (authoritative money)", campRow?.grossSalesMinor === total, `got=${campRow?.grossSalesMinor} want=${total}`);
  record("F2 campaign row: AOV = total / 1 order", campRow?.aovMinor === total, `aov=${campRow?.aovMinor}`);
  record("F2 campaign row: conversion computed (mixed-basis, present not null)", typeof campRow?.conversionPct === "number", `conv=${campRow?.conversionPct}`);
  record("F2 campaign row: attributed orders (createdAt basis) = 1", campRow?.attributedOrders === 1, `orders=${campRow?.attributedOrders}`);
  record("F2 campaign row: product views attributed", (campRow?.productViews ?? 0) >= 1, `views=${campRow?.productViews}`);

  const repB = await jsonFetch("/api/store/insights/campaigns?window=7d&fresh=1", { headers: bearer(sellerB.token) });
  const repBd = repB.body?.data;
  record("F3 seller B campaigns report: zero attributed everything (isolation)", repBd?.totals?.attributedVisits === 0 && repBd?.totals?.attributedPaidOrders === 0 && repBd?.totals?.attributedGrossSalesMinor === 0, JSON.stringify(repBd?.totals));
  record("F3 seller B report lists only B's campaigns", (repBd?.rows ?? []).every((r) => r.campaignId !== c1d.id), `rows=${(repBd?.rows ?? []).length}`);

  record("F4 honesty notes present (attribution model, no-ROAS, tracking start)", Array.isArray(rep?.notes) && rep.notes.length >= 5 && rep.notes.some((n) => n.includes("LAST-TOUCH")) && rep.notes.some((n) => n.includes("ROAS")), `notes=${(rep?.notes ?? []).length}`);

  // Unclaimed tagged traffic: the C3 plain visit had NO utm → not counted. Make one raw-UTM visit for B.
  let jarB = shopper.cookie;
  const landB = await fetch(`${BASE}/api/analytics/landing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jarB },
    body: JSON.stringify({ sf: sellerB.storeSlug, utm_source: "tiktok", utm_medium: "organic", utm_campaign: "bio-link" }),
  });
  jarB = absorbCookie(jarB, landB);
  await landB.json().catch(() => ({}));
  const sfB = await fetch(`${BASE}/api/sf/${sellerB.storeSlug}`, { headers: { Cookie: jarB } });
  await sfB.json();
  await flushEvents();
  const repB2 = await jsonFetch("/api/store/insights/campaigns?window=7d&fresh=1", { headers: bearer(sellerB.token) });
  const utmRow = (repB2.body?.data?.utmRows ?? []).find((r) => r.source === "tiktok");
  record("F5 raw-UTM visit (no campaign token) appears in unclaimed tagged traffic", utmRow?.visits === 1 && utmRow?.medium === "organic" && utmRow?.campaign === "bio-link", JSON.stringify(utmRow ?? null));
  record("F5 unclaimed row not in seller A's report (isolation)", !(rep?.utmRows ?? []).some((r) => r.source === "tiktok"), "");

  // =========================================================================
  // G. Funnel drop-off + payment attempts (authoritative)
  // =========================================================================
  const ovA = await jsonFetch("/api/store/insights/overview?window=7d&fresh=1", { headers: bearer(sellerA.token) });
  const stages = ovA.body?.data?.funnel?.stages ?? [];
  const purchaseStage = stages.find((x) => x.key === "purchase");
  const checkoutStage = stages.find((x) => x.key === "begin_checkout");
  record("G1 funnel stages carry drop-off (absolute + %) — purchase vs checkout", checkoutStage?.dropOff != null && typeof purchaseStage?.dropOffPct === "number", JSON.stringify({ co: checkoutStage?.dropOff, p: purchaseStage?.dropOff, pct: purchaseStage?.dropOffPct }));
  record("G1 first stage has null drop-off (nothing before it)", stages[0]?.dropOff == null && stages[0]?.dropOffPct == null, "");
  record("G2 payment attempts exposed (authoritative PaymentIntent count ≥1)", (ovA.body?.data?.funnel?.paymentAttempts ?? 0) >= 1, `attempts=${ovA.body?.data?.funnel?.paymentAttempts}`);

  // =========================================================================
  // H. F-20 minimal remediation — fail-closed scoping (runtime verification)
  // =========================================================================
  const globalConn = await db.marketplaceConnection.create({
    data: { storeId: null, platform: "shopee", status: "connected", shopId: `lt-f20-${STAMP}`, shopName: "LT global handshake row", envConfigured: false, scopesJson: "[]" },
  });
  const connA = await jsonFetch("/api/store/connections", { headers: bearer(sellerA.token) });
  const connIds = (connA.body?.data?.connections ?? []).map((c) => c.id);
  record("H1 global (storeId:null) connection row invisible to seller A", !connIds.includes(globalConn.id), `visible=${connIds.length}`);
  const discA = await jsonFetch("/api/store/connections/disconnect?platform=shopee", { method: "DELETE", headers: bearer(sellerA.token) });
  const globalAfter = await db.marketplaceConnection.findUnique({ where: { id: globalConn.id } });
  record("H2 seller disconnect does NOT mutate the global row", discA.status === 200 && globalAfter?.status === "connected", `status=${globalAfter?.status}`);
  const importsA = await jsonFetch("/api/store/imports", { headers: bearer(sellerA.token) });
  const impConns = importsA.body?.data?.connections ?? [];
  record("H3 import centre connection list also excludes global rows", !impConns.some((c) => c.shopId === globalConn.shopId), `conns=${impConns.length}`);
  await db.marketplaceConnection.delete({ where: { id: globalConn.id } });

  // =========================================================================
  // I. Money-path regression sanity (attribution must not disturb checkout)
  // =========================================================================
  record("I1 checkout total sane (2 × RM10 = 2000 minor + shipping)", total >= 2000, `total=${total}`);
  const walletA = await jsonFetch("/api/store/wallet", { headers: bearer(sellerA.token) });
  record("I2 seller A wallet healthy post-paid-order", walletA.status === 200, `status=${walletA.status}`);

  // =========================================================================
  // B8. Beacon rate limit — LAST (the burst exhausts the shared per-IP bucket)
  // =========================================================================
  let limited = false;
  for (let i = 0; i < 35; i++) {
    const r = await fetch(`${BASE}/api/analytics/landing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (r.status === 429) { limited = true; break; }
  }
  record("B8 beacon rate-limited (429 after burst)", limited);
}

main()
  .catch((e) => {
    console.error("SUITE ERROR:", e);
    results.push({ name: "suite crashed", ok: false, detail: String(e) });
  })
  .finally(async () => {
    try {
      await db.analyticsEvent.deleteMany({ where: { OR: [{ storeId: { in: [sellerAStoreId(), sellerBStoreId()] } }] } });
      await db.sellerCampaign.deleteMany({ where: { storeId: { in: [sellerAStoreId(), sellerBStoreId()] } } });
    } catch (e) {
      console.warn("cleanup partial:", e instanceof Error ? e.message : e);
    }
    const passed = results.filter((r) => r.ok).length;
    const out = {
      suite: "seller-attribution",
      ranAt: new Date().toISOString(),
      total: results.length,
      passed,
      failed: results.length - passed,
      results,
    };
    const fs = await import("node:fs");
    fs.writeFileSync(`performance/runs/${new Date().toISOString().slice(0, 10)}-seller-attribution.json`, JSON.stringify(out, null, 2));
    console.log(`\narchived: performance/runs/${new Date().toISOString().slice(0, 10)}-seller-attribution.json`);
    summary("seller-attribution");
    await db.$disconnect();
    process.exit(exitCode());
  });

function sellerAStoreId() { return _sellerA?.storeId ?? "__none__"; }
function sellerBStoreId() { return _sellerB?.storeId ?? "__none__"; }

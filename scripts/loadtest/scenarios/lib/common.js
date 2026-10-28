// ============================================================================
// LT-3 k6 scenarios — shared library (common.js)
//
// k6 v2.3.0 constraints honoured here:
//   - open() is ONLY legal in the init stage (module top-level) → config is
//     loaded once at import time.
//   - No __dirname / import.meta.url in the k6 JS runtime → the default config
//     path is RELATIVE TO THIS FILE (lib/../../config.json = loadtest/config.json).
//   - Module state is per-VU → session cache below is exec-scoped per VU.
//
// APP CONTRACTS (all verified by reading the referenced source, 2026-10-22):
//   POST /api/auth/shopper/login          {email,password} → data.token (hex, Bearer)
//                                         [src/app/api/auth/shopper/login/route.ts]
//   GET  /api/cart                        public; requiresAuth flag when guest
//   POST /api/cart/items                  {variantId, qty} Bearer → 201 cart
//                                         [src/app/api/cart/items/route.ts]
//   GET  /api/market/products?search=     {data:[ProductCard{id,slug,storeSlug,...}],meta.total}
//   GET  /api/market/home                 public landing payload
//   GET  /api/market/search/suggest?q=    ≤6 product cards + ≤3 stores
//   GET  /api/sf/{storeSlug}              storefront home (404 until published)
//   GET  /api/sf/{storeSlug}/products/{pSlug}   product.variants[{id,stock,moq,isActive}]
//                                         → variantId source for cart/checkout
//   POST /api/checkout/create             Bearer + Idempotency-Key header REQUIRED
//                                         body {items:[{variantId,qty}], customer,
//                                         shippingAddress{line1,city,state,postcode(5 digits)},
//                                         provider} → 201 {paymentRef,...} | 409 OUT_OF_STOCK/MOQ_NOT_MET
//                                         [src/app/api/checkout/create/route.ts]
//   POST /api/checkout/payments/{ref}/simulate  {result:"succeeded"|"failed"}
//                                         NOTE: the task brief said result:"success",
//                                         but the route validates ["succeeded","failed"]
//                                         (simulate/route.ts) — code is truth: "succeeded".
//                                         Rate limit 10/min per IP+route (FIN-2b).
//   GET  /api/checkout/payments/{ref}     {status: requires_payment|succeeded|failed|expired}
//
// RATE LIMITER (src/lib/ratelimit.ts): keys on the FIRST x-forwarded-for value.
// Direct-to-:3000 traffic is fully client-addressed → each request carries a
// unique XFF ("10.<vu>.<a>.<b>") to model thousands of distinct launch IPs.
// Through Caddy (:81) Caddy OVERWRITES XFF with {remote_host} (Caddyfile
// header_up) → all traffic collapses into ONE limiter bucket by design.
//
// Custom metrics (aggregated + per-code counters because k6 only exposes tagged
// sub-metrics in the end-of-test summary when a threshold references them —
// separate counters are deterministic and report-friendly).
// ============================================================================

import http from "k6/http";
import { sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

/* ── config loading (init scope ONLY — open() constraint) ────────────────── */
function readRawConfig() {
  const fromEnv = __ENV.LT_CONFIG;
  if (fromEnv && fromEnv.trim().startsWith("{")) return fromEnv; // inline JSON
  if (fromEnv) return open(fromEnv); // path (relative paths resolve from THIS file)
  return open(__ENV.LT_CONFIG_PATH || "../../config.json");
}
export const CONFIG = JSON.parse(readRawConfig());

export const PROFILE_NAME = __ENV.LT_PROFILE || "smoke";
export const PROFILE = (CONFIG.profiles && CONFIG.profiles[PROFILE_NAME]) || {};

export function baseUrl() {
  if (__ENV.LT_BASE_URL) return __ENV.LT_BASE_URL;
  if (CONFIG.viaCaddy || __ENV.LT_VIA_CADDY === "1") return CONFIG.caddyUrl || "http://localhost:81";
  return CONFIG.baseUrl || "http://localhost:3000";
}

const EP = CONFIG.endpoints || {};
const CHECKOUT = EP.checkout || {};

/* ── custom metrics ──────────────────────────────────────────────────────── */
export const checkoutAttempts = new Counter("checkout_attempts");
export const checkoutCreated = new Counter("checkout_created");
export const ordersPaid = new Counter("orders_paid");
export const orderCreate409Stock = new Counter("order_create_409_out_of_stock");
export const orderCreate409Moq = new Counter("order_create_409_moq_not_met");
export const orderCreate409Other = new Counter("order_create_409_other");
export const orderCreate4xx = new Counter("order_create_4xx"); // non-409 4xx (code in tag)
export const orderCreate5xx = new Counter("order_create_5xx");
export const paymentFailed = new Counter("payment_failed");
export const paymentSimulateErrors = new Counter("payment_simulate_errors");
export const paymentPollTimeout = new Counter("payment_poll_timeout");
export const orderE2eMs = new Trend("order_e2e_ms", true);
export const integrityFailures = new Rate("integrity_failures");
export const authFailures = new Counter("auth_failures");
export const cartAddFailures = new Counter("cart_add_failures");
export const purchaseSkipped = new Counter("purchase_skipped");

/* ── think time ──────────────────────────────────────────────────────────── */
export function thinkTime() {
  const min = Number(CONFIG.thinkTimeMinS ?? 0.5);
  const max = Number(CONFIG.thinkTimeMaxS ?? 2.5);
  sleep(min + Math.random() * Math.max(0, max - min));
}

/* ── XFF spread (rate-limiter models thousands of launch IPs) ────────────── */
export function xffFor(vu, iter) {
  const prefix = CONFIG.xffPrefix || "10.";
  const d = (Math.floor(iter / 255) % 255);
  const h = (iter % 255) + 1;
  return `${prefix}${vu}.${d}.${h}`;
}

/* ── per-VU shopper session (module state = per-VU in k6) ────────────────── */
const sessions = {}; // key: "vu<N>" → {token,email,failAt?}
export function shopperEmailFor(vu) {
  const tpl = EP.shopperEmailTemplate || "lt-shopper-{{i}}@lt.nomofee.test";
  const count = Math.max(1, Number(CONFIG.shopperCount || 120));
  return tpl.replace("{{i}}", String((vu - 1) % count));
}

const RETRY_AUTH_AFTER_MS = 30000;

/** Login ONCE per VU (cached); negative results retryable after 30s. */
export function loginShopper(vu, iter) {
  const key = `vu${vu}`;
  const cached = sessions[key];
  if (cached && cached.token) return cached;
  if (cached && cached.failAt && Date.now() - cached.failAt < RETRY_AUTH_AFTER_MS) return cached;

  const email = shopperEmailFor(vu);
  const res = http.post(
    `${baseUrl()}/api/auth/shopper/login`,
    JSON.stringify({ email, password: EP.shopperPassword || "LT-Pass-2026!" }),
    { headers: baseHeaders(xffFor(vu, iter)), tags: { leg: "auth-login" }, timeout: "15s" }
  );
  let token = null;
  try {
    const body = res.json();
    if (res.status === 200 && body && body.data && body.data.token) token = body.data.token;
  } catch (_e) { /* non-JSON body → treated as failure below */ }
  if (token) {
    sessions[key] = { token, email };
    return sessions[key];
  }
  authFailures.add(1, { status: String(res.status) });
  sessions[key] = { token: null, email, failAt: Date.now() };
  return sessions[key];
}

/* ── request wrappers ────────────────────────────────────────────────────── */
export function baseHeaders(xff, token) {
  const h = {
    "X-Forwarded-For": xff,
    "User-Agent": "k6-nomofee-lt/1.0",
    "Content-Type": "application/json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function call(method, path, body, opts) {
  const o = opts || {};
  const params = {
    headers: baseHeaders(o.xff || xffFor(__VU, 0), o.token),
    tags: Object.assign({ leg: o.leg || "api" }, o.tags || {}),
    timeout: o.timeout || "20s",
  };
  if (o.idemKey) params.headers["Idempotency-Key"] = o.idemKey;
  if (method === "post" || method === "put" || method === "patch") {
    return http[method](`${baseUrl()}${path}`, body == null ? "null" : JSON.stringify(body), params);
  }
  return http[method](`${baseUrl()}${path}`, params);
}

export const apiGet = (path, opts) => call("get", path, null, opts);
export const apiPost = (path, body, opts) => call("post", path, body, opts);

/* ── endpoint helpers (each documents the contract it relies on) ─────────── */
export function getMarketHome(opts) { return apiGet("/api/market/home", Object.assign({ leg: "home" }, opts)); }
export function getStorefront(sfSlug, opts) {
  return apiGet(`/api/sf/${encodeURIComponent(sfSlug || EP.storeSlug || "lt-main-store")}`, Object.assign({ leg: "storefront" }, opts));
}
export function getSuggest(q, opts) {
  return apiGet(`/api/market/search/suggest?q=${encodeURIComponent(q)}`, Object.assign({ leg: "suggest" }, opts));
}
export function searchProducts(term, opts) {
  return apiGet(`/api/market/products?search=${encodeURIComponent(term)}`, Object.assign({ leg: "search" }, opts));
}
export function getProductDetail(storeSlug, productSlug, opts) {
  return apiGet(`/api/sf/${encodeURIComponent(storeSlug)}/products/${encodeURIComponent(productSlug)}`,
    Object.assign({ leg: "pdp" }, opts));
}
export function cartAdd(token, variantId, qty, opts) {
  return apiPost("/api/cart/items", { variantId, qty }, Object.assign({ token, leg: "cart-add" }, opts));
}
export function cartGet(token, opts) {
  return apiGet("/api/cart", Object.assign({ token, leg: "cart-get" }, opts));
}
export function checkoutCreate(token, items, idemKey, opts) {
  const addr = CHECKOUT.shippingAddress || { line1: "LT Load Test Jalan 1", city: "Shah Alam", state: "Selangor", postcode: "40000" };
  const body = {
    items,
    customer: CHECKOUT.customer || null, // null → server prefills from the account
    shippingAddress: addr,
    provider: CHECKOUT.provider || "fpx_toyyibpay",
  };
  return apiPost("/api/checkout/create", body, Object.assign({ token, leg: "checkout-create", idemKey }, opts));
}
export function paymentSimulate(ref, opts) {
  return apiPost(`/api/checkout/payments/${encodeURIComponent(ref)}/simulate`, { result: "succeeded" },
    Object.assign({ leg: "payment-simulate" }, opts));
}
export function paymentStatus(ref, opts) {
  return apiGet(`/api/checkout/payments/${encodeURIComponent(ref)}`, Object.assign({ leg: "payment-status" }, opts));
}

/* ── storefront resolution (setup-time; resilient) ───────────────────────── */
/** Storefront slug resolution: the LT store is live but may have no PUBLISHED
 *  home CMS page (GET /api/sf/[slug] → 404 STORE_NOT_PUBLISHED — a real app
 *  contract, see src/app/api/sf/[slug]/route.ts). Rather than injecting 404
 *  noise into http_req_failed, the storefront leg probes the configured slug
 *  first, then the fallback list, and uses the first slug that returns 200.
 *  Returns null when nothing responds 200 (leg then folds into search). */
export function resolveStorefrontSlug(iter) {
  const candidates = [EP.storeSlug || "lt-main-store"];
  for (const s of EP.storefrontFallbackSlugs || ["glow-theory", "bytebazaar", "lumina-living"]) {
    if (!candidates.includes(s)) candidates.push(s);
  }
  const xff = xffFor(0, (iter || 0) + 7);
  for (const slug of candidates) {
    try {
      const res = getStorefront(slug, { xff, timeout: "10s" });
      if (res.status === 200) return slug;
    } catch (_e) { /* try next */ }
  }
  return null;
}

/** Resolve a product slug → {productId, slug, storeSlug, variantId, stock, moq}.
 *  Returns null (never throws) so runs against a not-yet-seeded server degrade
 *  gracefully: PDP/cart legs are skipped and purchase legs count purchase_skipped.
 *
 *  Resolution order (Measured 2026-10-22): (1) market search — works when every
 *  slug token appears in title/description/category/store (e.g. perf item);
 *  (2) DIRECT PDP fallback on the configured LT store — needed because search
 *  cannot match slugs whose tokens aren't in the title (correctness item:
 *  slug "lt-flash-correct-item" tokens include "flash" but title is
 *  "[LT] Correctness Item" → search total:0 while the PDP 200s). */
export function resolveProduct(productSlug, iter) {
  const xff = xffFor(0, iter || 0);
  try {
    let card = null;
    try {
      const res = searchProducts(productSlug, { xff, timeout: "15s" });
      if (res.status === 200) {
        const body = res.json();
        const cards = (body && body.data) || [];
        card = cards.find((c) => c.slug === productSlug) || null;
      }
    } catch (_e) { /* fall through to direct PDP */ }
    const storeSlug = (card && card.storeSlug) || EP.storeSlug || "lt-main-store";
    const det = getProductDetail(storeSlug, productSlug, { xff, timeout: "15s" });
    if (det.status !== 200) return null;
    const dbody = det.json();
    const product = dbody && dbody.data && dbody.data.product;
    if (!product) return null;
    const variants = product.variants || [];
    const variant = variants.find((v) => v.isActive !== false && v.stock > 0) || variants[0];
    if (!variant) return null;
    return {
      productId: product.id,
      slug: product.slug,
      storeSlug,
      variantId: variant.id,
      stock: variant.stock,
      moq: Math.max(1, variant.moq || 1),
      priceMinor: variant.priceMinor,
    };
  } catch (_e) {
    return null;
  }
}

/* ── browse mix (shared by browse.js / browse-arrival.js / stress.js and the
 *    non-purchaser share of purchase.js) ──────────────────────────────────── */
const SEARCH_TERMS = EP.searchTerms || ["lt", "candle", "serum", "vase", "keyboard", "[LT] Catalog Item 12"];
const SUGGEST_TERMS = EP.suggestTerms || ["lt", "candle", "serum", "vase", "keyboard", "byte"];

/** One browsing iteration. `product`/`sfSlug` may be null (LT data not seeded)
 *  → the PDP/storefront/cart legs fold into search/suggest; the run completes
 *  with reduced coverage instead of failing. Returns the leg executed. */
export function browseLeg(vu, iter, sess, product, sfSlug) {
  const r = Math.random() * 100;
  const xff = xffFor(vu, iter);
  const searchOpts = { xff };
  if (r < 30) {
    getMarketHome({ xff });
    return "home";
  }
  if (r < 55) {
    searchProducts(SEARCH_TERMS[iter % SEARCH_TERMS.length], searchOpts);
    return "search";
  }
  if (r < 75) {
    if (product && product.storeSlug) {
      getProductDetail(product.storeSlug, product.slug, { xff });
      return "pdp";
    }
    searchProducts(SEARCH_TERMS[iter % SEARCH_TERMS.length], searchOpts);
    return "search[pdp-unavailable]";
  }
  if (r < 85) {
    if (sfSlug) {
      getStorefront(sfSlug, { xff });
      return "storefront";
    }
    searchProducts(SEARCH_TERMS[iter % SEARCH_TERMS.length], searchOpts);
    return "search[storefront-unavailable]";
  }
  if (r < 95) {
    getSuggest(SUGGEST_TERMS[iter % SUGGEST_TERMS.length], { xff });
    return "suggest";
  }
  // 5% cart add+get — requires a shopper session
  if (sess && sess.token && product && product.variantId) {
    const add = cartAdd(sess.token, product.variantId, 1, { xff });
    if (add.status >= 400) cartAddFailures.add(1, { status: String(add.status) });
    cartGet(sess.token, { xff });
    return "cart";
  }
  getSuggest(SUGGEST_TERMS[iter % SUGGEST_TERMS.length], { xff });
  return "suggest[cart-unavailable]";
}

/* ── purchase journey (shared by purchase.js / spike-launch.js) ──────────── */
/** Full purchase leg: cart add → checkout create (unique idem key) → simulate
 *  success → poll status until terminal → verify paid. Every 409/4xx is
 *  counted BY CODE — never retried, never silent. Returns an outcome object. */
export function checkoutJourney(vu, iter, sess, variant) {
  const t0 = Date.now();
  const xff = xffFor(vu, iter);
  if (!sess || !sess.token) {
    purchaseSkipped.add(1, { reason: "no-session" });
    return { created: false, paid: false, reason: "no-session" };
  }
  if (!variant || !variant.variantId) {
    purchaseSkipped.add(1, { reason: "no-lt-product" });
    return { created: false, paid: false, reason: "no-lt-product" };
  }

  // 1) cart add (journey fidelity — create does not read the cart, but a real
  //    buyer always goes through it; qty 1 of the LT perf item)
  const add = cartAdd(sess.token, variant.variantId, 1, { xff });
  if (add.status >= 400) {
    cartAddFailures.add(1, { status: String(add.status) });
  }

  // 2) checkout create — unique Idempotency-Key per attempt
  checkoutAttempts.add(1);
  const idem = `${vu}-${iter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = checkoutCreate(sess.token, [{ variantId: variant.variantId, qty: 1 }], idem, { xff });
  if (res.status === 201) {
    checkoutCreated.add(1);
  } else if (res.status === 409) {
    let code = "UNKNOWN";
    try { code = (res.json().error && res.json().error.code) || "UNKNOWN"; } catch (_e) { /* body not JSON */ }
    if (code === "OUT_OF_STOCK") orderCreate409Stock.add(1);
    else if (code === "MOQ_NOT_MET") orderCreate409Moq.add(1);
    else orderCreate409Other.add(1, { code });
    return { created: false, paid: false, status: 409, code };
  } else if (res.status >= 400 && res.status < 500) {
    let code = "UNKNOWN";
    try { code = (res.json().error && res.json().error.code) || "UNKNOWN"; } catch (_e) { /* body not JSON */ }
    orderCreate4xx.add(1, { code, status: String(res.status) });
    return { created: false, paid: false, status: res.status, code };
  } else if (res.status >= 500) {
    orderCreate5xx.add(1);
    return { created: false, paid: false, status: res.status };
  }

  let paymentRef = null;
  let orderNumber = null;
  try {
    const body = res.json().data || {};
    paymentRef = body.paymentRef || body.orderPaymentRef || null;
    orderNumber = body.orderNumber || null;
  } catch (_e) { /* handled below via !paymentRef */ }
  if (!paymentRef) {
    paymentPollTimeout.add(1);
    return { created: false, paid: false, status: res.status, reason: "no-payment-ref" };
  }

  // 3) simulate success (mock PSP stand-in; result must be "succeeded")
  const sim = paymentSimulate(paymentRef, { xff });
  if (sim.status >= 400) {
    paymentSimulateErrors.add(1, { status: String(sim.status) });
    return { created: true, paid: false, status: sim.status, paymentRef, reason: "simulate-failed" };
  }

  // 4) poll status until terminal (max tries per config)
  const maxTries = Number(EP.paymentPollMaxTries || 10);
  const intervalS = Number(EP.paymentPollIntervalS || 0.5);
  let finalStatus = null;
  let lastBody = null;
  for (let i = 0; i < maxTries; i++) {
    sleep(intervalS);
    const st = paymentStatus(paymentRef, { xff });
    if (st.status === 200) {
      try {
        lastBody = st.json().data || {};
        finalStatus = lastBody.status;
        if (finalStatus !== "requires_payment") break;
      } catch (_e) { /* keep polling */ }
    }
  }

  // 5) verify + record
  if (finalStatus === "succeeded") {
    ordersPaid.add(1);
    orderE2eMs.add(Date.now() - t0);
    const okVerify = Boolean(lastBody && Array.isArray(lastBody.orderNumbers) && lastBody.orderNumbers.length >= 1);
    integrityFailures.add(okVerify ? 0 : 1);
    return { created: true, paid: true, status: finalStatus, paymentRef, orderNumber };
  }
  if (finalStatus === "failed" || finalStatus === "expired") {
    paymentFailed.add(1);
    return { created: true, paid: false, status: finalStatus, paymentRef };
  }
  // never confirmed within the poll budget → a paid-order verify mismatch
  paymentPollTimeout.add(1);
  integrityFailures.add(1);
  return { created: true, paid: false, status: finalStatus || "timeout", paymentRef };
}

/* ── executors ───────────────────────────────────────────────────────────── */
export function parseStages(arr) {
  return (arr || []).map((s) => {
    const m = /^(\d+)vus:([0-9.]+[smh])$/.exec(String(s).trim());
    if (!m) throw new Error(`Bad stage "${s}" — expected "Nvus:D" (e.g. "25vus:2m")`);
    return { target: parseInt(m[1], 10), duration: m[2] };
  });
}

/** CLOSED model executor from a profile (stages → ramping-vus, else constant-vus). */
export function closedExecutor(profile) {
  const p = profile || {};
  if (p.stages && p.stages.length) {
    const stages = parseStages(p.stages);
    return { executor: "ramping-vus", startVUs: 1, stages, gracefulStop: "10s" };
  }
  return { executor: "constant-vus", vus: Number(p.vus || 1), duration: p.duration || "30s", gracefulStop: "10s" };
}

/** OPEN model executor (constant-arrival-rate). VU pre-allocation derived from
 *  the arrival rate × journey duration (documented, configurable multipliers). */
export function arrivalExecutor(ratePerSec, duration) {
  const om = CONFIG.openModel || {};
  const per = Number(om.preAllocatedVusPerArrival ?? 3);
  const factor = Number(om.maxVusFactor ?? 10);
  const cap = Number(om.hardVuCap ?? 600);
  const pre = Math.max(20, Math.ceil(ratePerSec * per));
  const max = Math.max(pre, Math.min(cap, Math.ceil(ratePerSec * factor)));
  return {
    executor: "constant-arrival-rate",
    rate: Math.max(1, ratePerSec),
    timeUnit: "1s",
    duration,
    preAllocatedVUs: pre,
    maxVUs: max,
    gracefulStop: "10s",
  };
}

/** Spike (open ramping-arrival-rate): start → ramp to peak → plateau → tail down. */
export function spikeExecutor(p) {
  const om = CONFIG.openModel || {};
  const factor = Number(om.maxVusFactor ?? 10);
  const cap = Number(om.hardVuCap ?? 600);
  const peak = Number(p.arrivalPeak || 120);
  const pre = Math.max(20, Math.ceil(peak * Number(om.preAllocatedVusPerArrival ?? 3)));
  const max = Math.max(pre, Math.min(cap, Math.ceil(peak * factor)));
  return {
    executor: "ramping-arrival-rate",
    startRate: Number(p.arrivalStart ?? 0),
    timeUnit: "1s",
    preAllocatedVUs: pre,
    maxVUs: max,
    stages: [
      { duration: p.rampToPeak || "10s", target: peak },
      { duration: p.plateau || "3m", target: peak },
      { duration: p.tail || "1m", target: 0 },
    ],
    gracefulStop: "10s",
  };
}

/* ── guardrail thresholds (rule #9 — k6 layer; coordinator watcher is layer 2) */
export function abortThresholds() {
  const a = (CONFIG.profiles && CONFIG.profiles.stress && CONFIG.profiles.stress.abort) || null;
  if (!a) return {};
  const t = {
    "http_req_duration": [{ threshold: `p(95)<${a.httpP95Ms}`, abortOnFail: true }],
    "http_req_failed": [{ threshold: `rate<${(a.errorRatePct ?? 10) / 100}`, abortOnFail: true }],
  };
  if (a.delayAbortEvalS) {
    for (const k of Object.keys(t)) t[k][0].delayAbortEval = `${a.delayAbortEvalS}s`;
  }
  return t;
}

/* ── dry-run overrides (smoke verification) ──────────────────────────────── */
export function applyRunOverrides(scenario) {
  const dur = __ENV.LT_DURATION_OVERRIDE;
  const vus = __ENV.LT_VUS_OVERRIDE;
  const s = Object.assign({}, scenario);
  if (dur) {
    if (s.stages) s.stages = [{ duration: dur, target: s.stages[0].target }];
    if (s.duration) s.duration = dur;
  }
  if (vus) {
    if (s.vus != null) s.vus = Number(vus);
    if (s.startVUs != null) s.startVUs = Number(vus);
  }
  return s;
}

export function baseOptions(extra) {
  return Object.assign(
    {
      summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(90)", "p(95)", "p(99)"],
      noConnectionReuse: false,
      userAgent: "k6-nomofee-lt/1.0",
    },
    extra || {}
  );
}

/* ── handleSummary factory ───────────────────────────────────────────────── */
function fmt(v, suffix) { return v == null ? "n/a" : `${v}${suffix || ""}`; }

function compactText(profile, data) {
  const m = data.metrics || {};
  const dur = data.state ? data.state.testRunDurationMs / 1000 : null;
  const durVals = m.http_req_duration ? m.http_req_duration.values : {};
  const line = (k) => (m[k] && m[k].values ? `${m[k].values.count ?? m[k].values.rate ?? ""}` : "n/a");
  const tFail = Object.keys(m)
    .filter((k) => m[k].thresholds && m[k].thresholds.some((t) => !t.ok))
    .join(", ");
  return [
    "",
    `==== LT-3 k6 summary [profile=${profile}] ====`,
    `duration: ${dur != null ? dur.toFixed(1) + "s" : "n/a"} [Measured]  max VUs: ${m.vus_max ? m.vus_max.values.max : "n/a"}`,
    `http_reqs: ${line("http_reqs")} | achieved RPS: ${m.http_reqs ? m.http_reqs.values.rate.toFixed(2) : "n/a"}`,
    `latency p50/p90/p95/p99 ms: ${fmt(round1(durVals["p(50)"]))} / ${fmt(round1(durVals["p(90)"]))} / ${fmt(round1(durVals["p(95)"]))} / ${fmt(round1(durVals["p(99)"]))}`,
    `http_req_failed rate: ${m.http_req_failed ? (m.http_req_failed.values.rate * 100).toFixed(2) + "%" : "n/a"}`,
    `checkout_attempts: ${line("checkout_attempts")} | checkout_created: ${line("checkout_created")} | orders_paid: ${line("orders_paid")}`,
    `409s: stock=${line("order_create_409_out_of_stock")} moq=${line("order_create_409_moq_not_met")} other=${line("order_create_409_other")} | other-4xx: ${line("order_create_4xx")} | 5xx: ${line("order_create_5xx")}`,
    `order_e2e_ms avg: ${m.order_e2e_ms ? round1(m.order_e2e_ms.values.avg) : "n/a"} | integrity_failures: ${m.integrity_failures ? m.integrity_failures.values.rate : "n/a"}`,
    tFail ? `THRESHOLDS FAILED: ${tFail}` : "thresholds: all ok",
    "NOTE: VUs are simulated API clients, NOT concurrent human visitors.",
    "",
  ].join("\n");
}
function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }

/** Every scenario exports handleSummary = makeSummaryHandler("<name>") — writes
 *  the raw k6 JSON to LT_SUMMARY_PATH + a compact stdout block. */
export function makeSummaryHandler(profile) {
  return function handleSummary(data) {
    const files = {};
    const path = __ENV.LT_SUMMARY_PATH;
    const payload = JSON.stringify(
      {
        lt: { profile, baseUrl: baseUrl(), viaCaddy: Boolean(CONFIG.viaCaddy || __ENV.LT_VIA_CADDY === "1"), generatedAt: new Date().toISOString() },
        data,
      },
      null,
      2
    );
    if (path) files[path] = payload;
    files["stdout"] = compactText(profile, data) + (path ? "" : "\n(LT_SUMMARY_PATH not set — raw JSON not written)\n");
    return files;
  };
}

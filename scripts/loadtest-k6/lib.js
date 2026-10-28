// ============================================================================
// K6 SHARED LIB — NOMOFEE external load-test profiles (mission Phase 6).
// ----------------------------------------------------------------------------
// Runs on an EXTERNAL load generator (NOT the app/DB host). Mirrors the
// in-sandbox harness (`scripts/readiness/load-scenarios.ts`) data formats:
// [LT]-tagged shoppers, lt-* idempotency keys, same checkout/webhook shapes —
// one system, two drivers, compatible evidence JSON.
//
// FAIL-CLOSED TARGET GUARD (mirrors scripts/readiness/target-guard.ts for a
// generator WITHOUT DB access):
//   TARGET_CONFIRM  = staging | dev-sandbox-local        (required, else abort)
//   BASE            = https://staging.example.com        (default http://127.0.0.1:3000)
//   DB_FINGERPRINT  = 16-hex from the target's /api/health deployment.dbFingerprint
//                     (REQUIRED for staging; optional extra pin for dev-sandbox-local)
//   WEBHOOK_SECRET  = the TARGET environment's PSP webhook secret (staging value
//                     only — never a production secret). Needed for payment-path
//                     profiles; browse-only profiles run without it.
// The guard aborts the whole test (setup throws) when: confirm missing/invalid,
// health unreachable/missing deployment block, nodeEnv=production, or the
// reported fingerprint does not match DB_FINGERPRINT.
// ============================================================================
import http from "k6/http";
import crypto from "k6/crypto";
import { Trend, Counter, Rate } from "k6/metrics";

export const BASE = (__ENV.BASE ?? "http://127.0.0.1:3000").replace(/\/$/, "");
export const RUN_ID = (__ENV.RUN_ID ?? `k6-${Date.now().toString(36)}`);

// ── metrics (shared across profiles; tags carry the categories) ─────────────
export const browseLatency = new Trend("browse_latency_ms", true);
export const checkoutLatency = new Trend("checkout_latency_ms", true);
export const paymentLatency = new Trend("payment_latency_ms", true);
export const checkouts = new Counter("checkouts_total"); // tagged outcome=success|rejected|overload|error
export const paidOrders = new Counter("paid_orders_total");
export const journeys = new Counter("journeys_total"); // tagged outcome=completed|busy|rejected|aborted
export const duplicateWebhooks = new Counter("duplicate_webhooks_total"); // tagged outcome=converged|other
export const authOk = new Rate("auth_ok_rate");

// ── fail-closed target guard (k6 mirror of the bun target-guard) ────────────
export function guardSetup() {
  // http_req_failed must count ONLY raw infrastructure failures: 409 (semantic
  // rejection) and 503 (controlled CHECKOUT_BUSY) are EXPECTED responses under
  // overload — the mission's "zero raw 5xx" criterion maps to this set.
  http.setResponseCallback(http.expectedStatuses(200, 201, 409, 503));
  const confirm = (__ENV.TARGET_CONFIRM ?? "").toLowerCase();
  if (confirm !== "staging" && confirm !== "dev-sandbox-local") {
    throw new Error(`[target-guard] REFUSED — TARGET_CONFIRM must be staging|dev-sandbox-local (got "${__ENV.TARGET_CONFIRM ?? ""}")`);
  }
  if (confirm === "staging" && !__ENV.DB_FINGERPRINT) {
    throw new Error("[target-guard] REFUSED — staging runs require DB_FINGERPRINT (from the staging app's /api/health deployment.dbFingerprint)");
  }
  const h = http.get(`${BASE}/api/health`, { tags: { name: "health_guard" } });
  if (h.status !== 200) throw new Error(`[target-guard] REFUSED — /api/health answered ${h.status}`);
  const dep = h.json("data.deployment");
  if (!dep || !dep.dbFingerprint) throw new Error("[target-guard] REFUSED — deployment block missing (old app version)");
  if (dep.nodeEnv === "production") throw new Error("[target-guard] REFUSED — target reports NODE_ENV=production; heavy tests against production are forbidden");
  if (__ENV.DB_FINGERPRINT && __ENV.DB_FINGERPRINT !== dep.dbFingerprint) {
    throw new Error(`[target-guard] REFUSED — pinned DB_FINGERPRINT ${__ENV.DB_FINGERPRINT} ≠ target ${dep.dbFingerprint}`);
  }
  if (__ENV.WEBHOOK_SECRET === "sm_webhook_secret_demo" && confirm === "staging") {
    // Staging must set a real (staging) secret — the public fallback is refused
    // so a misconfigured staging run cannot silently pass.
    throw new Error("[target-guard] REFUSED — WEBHOOK_SECRET is the public demo fallback; set the staging webhook secret");
  }
  console.log(`[target-guard] CONFIRMED target=${confirm} base=${BASE} nodeEnv=${dep.nodeEnv} dbFingerprint=${dep.dbFingerprint}`);
  return { confirmed: confirm, base: BASE, fingerprint: dep.dbFingerprint, runId: RUN_ID };
}

// ── fixtures (created by `bun scripts/loadtest-k6/fixtures-setup.ts`) ────────
export function loadFixtures() {
  // fixtures.json is produced by fixtures-setup.ts (DB-side) and copied next
  // to the profiles on the generator.
  return JSON.parse(open(__ENV.FIXTURES ?? "./fixtures.json"));
}

// ── shopper identity (register idempotent → login) ─────────────────────────
export function newShopper(tag) {
  const email = `lt-${RUN_ID}-${tag}@lt.test`;
  const reg = http.post(
    `${BASE}/api/auth/shopper/register`,
    JSON.stringify({ email, password: "LtBuyer123!", fullName: "LT K6 Buyer" }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "shopper_register" } },
  );
  let cookie = (reg.headers["Set-Cookie"] ?? "").split(";")[0];
  if (!cookie || reg.status >= 400) {
    const login = http.post(
      `${BASE}/api/auth/shopper/login`,
      JSON.stringify({ email, password: "LtBuyer123!" }),
      { headers: { "Content-Type": "application/json" }, tags: { name: "shopper_login" } },
    );
    cookie = (login.headers["Set-Cookie"] ?? "").split(";")[0];
    authOk.add(login.status === 200);
    if (!cookie || login.status !== 200) return { email, cookie: null };
  } else {
    authOk.add(true);
  }
  return { email, cookie };
}

// ── journeys ────────────────────────────────────────────────────────────────
export function browse(latencies) {
  const home = http.get(`${BASE}/api/market/home`, { tags: { name: "market_home" } });
  latencies.push(home.timings.duration);
  const products = http.get(`${BASE}/api/market/products?size=24`, { tags: { name: "market_products" } });
  latencies.push(products.timings.duration);
  return home.status === 200 && products.status === 200;
}

export function signWebhook(secret, ref, eventType, amountMinor, ts) {
  return crypto.hmac("sha256", secret, `${ref}.${eventType}.${amountMinor}.${ts}`, "hex");
}

/** One purchase attempt. Returns {outcome, ref, amountMinor, ms}. */
export function purchase(fx, cookie, idemKey, opts = {}) {
  const t0 = Date.now();
  const body = JSON.stringify({
    items: [{ variantId: fx.variantId, qty: opts.qty ?? 1 }],
    customer: { name: "LT K6 Buyer", email: opts.email ?? "lt-k6@lt.test" },
    shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
    provider: "fpx_toyyibpay",
  });
  const r = http.post(`${BASE}/api/checkout/create`, body, {
    headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": idemKey },
    tags: { name: "checkout_create" },
  });
  const ms = Date.now() - t0;
  checkoutLatency.add(ms);
  const data = r.json("data") ?? {};
  const ref = (data.redirectUrl ?? "").split("/").pop() || data.paymentGroupRef;
  let outcome = "error";
  if (r.status === 201 || r.status === 200) outcome = "success";
  else if (r.status === 409) outcome = "rejected"; // OUT_OF_STOCK / MOQ etc. — semantic
  else if (r.status === 503) outcome = "overload"; // CHECKOUT_BUSY — semantic
  checkouts.add(1, { outcome });
  return { outcome, ref, amountMinor: data.totalMinor, ms, status: r.status };
}

/** Pay a created checkout through the SIGNED webhook (the real pipeline). */
export function payViaWebhook(secret, ref, amountMinor) {
  const ts = Date.now();
  const sig = signWebhook(secret, ref, "payment.succeeded", amountMinor, ts);
  const t0 = Date.now();
  const r = http.post(
    `${BASE}/api/webhooks/payments/fpx_toyyibpay`,
    JSON.stringify({ providerRef: ref, eventType: "payment.succeeded", amountMinor, ts, sig }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "payment_webhook" } },
  );
  paymentLatency.add(Date.now() - t0);
  const duplicate = r.status === 200 && r.json("data")?.duplicate === true;
  if (r.status === 200) {
    paidOrders.add(1);
    duplicateWebhooks.add(1, { outcome: duplicate ? "converged" : "first" });
  }
  return { status: r.status, duplicate };
}

/** Pay via the mock-PSP simulate endpoint (staging mock rails). */
export function payViaSimulate(ref) {
  const t0 = Date.now();
  const r = http.post(
    `${BASE}/api/checkout/payments/${ref}/simulate`,
    JSON.stringify({ result: "succeeded" }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "payment_simulate" } },
  );
  paymentLatency.add(Date.now() - t0);
  if (r.status === 200) paidOrders.add(1);
  return { status: r.status };
}

// ── full shopper journey (browse → auth → checkout → pay) ──────────────────
// shopperCache: per-VU closure object { email, cookie } — register once per VU.
// opts: { pay: "webhook"|"simulate"|false, duplicate: bool, fixture: "flash"|"contended" }
export function journeyOnce(fx, shopperCache, vuTag, iter, opts = {}) {
  const latencies = [];
  const browsed = browse(latencies);
  for (const l of latencies) browseLatency.add(l);
  if (!shopperCache.cookie) {
    const s = newShopper(vuTag);
    shopperCache.email = s.email;
    shopperCache.cookie = s.cookie;
  }
  if (!shopperCache.cookie) {
    journeys.add(1, { outcome: "aborted" });
    return { outcome: "aborted", reason: "auth" };
  }
  const fixture = opts.fixture === "contended" ? fx.contended : fx.flash;
  const idem = `lt-k6-${fx.runId}-${vuTag}-${iter}`;
  const p = purchase(fixture, shopperCache.cookie, idem, { email: shopperCache.email });
  if (p.outcome !== "success" || !p.ref) {
    journeys.add(1, { outcome: p.outcome });
    return { outcome: p.outcome };
  }
  if (opts.pay === "webhook") {
    const pay = payViaWebhook(__ENV.WEBHOOK_SECRET, p.ref, p.amountMinor);
    if (pay.status !== 200) {
      journeys.add(1, { outcome: "aborted" });
      return { outcome: "aborted", reason: `pay:${pay.status}` };
    }
    if (opts.duplicate) payViaWebhook(__ENV.WEBHOOK_SECRET, p.ref, p.amountMinor); // redelivery must converge
  } else if (opts.pay === "simulate") {
    const pay = payViaSimulate(p.ref);
    if (pay.status !== 200) {
      journeys.add(1, { outcome: "aborted" });
      return { outcome: "aborted", reason: `pay:${pay.status}` };
    }
  }
  journeys.add(1, { outcome: "completed" });
  return { outcome: "completed", browsed };
}

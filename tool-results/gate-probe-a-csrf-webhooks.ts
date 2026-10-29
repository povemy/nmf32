/**
 * Post-Remediation Verification Gate — Probe A (NO LOGINS).
 *
 * F-01  CSRF proxy matrix (cross-site Origin / null origin / Sec-Fetch-Site /
 *       form-encoded / Bearer / same-origin / exemption for HMAC routes).
 * F-04  Payments-webhook signature matrix on the LIVE dev server
 *       (valid sig + unknown ref → INTENT_NOT_FOUND; wrong sig → BAD_SIGNATURE;
 *       stale-but-signed → STALE_EVENT; missing sig → BAD_SIGNATURE;
 *       cross-site Origin + valid HMAC → exempted, reaches route).
 * F-05  Shipping-webhook signature matrix (same shape).
 * F-06  Gateway port allowlist LIVE on :81 (XTransformPort=3103/3005 fall
 *       through to the webapp; 3003 reaches the chat hub).
 *       Public fail-closed surfaces: /api/metrics, health, platform terms.
 *
 * No sessions are created; every request is unauthenticated and read-only or
 * rejected-before-state-change (unknown refs / bogus signatures).
 */
const BASE = "http://127.0.0.1:3000";
const GW = "http://127.0.0.1:81";

let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function post(path: string, headers: Record<string, string>, body?: string) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, ct: res.headers.get("content-type") ?? "" };
}

const JSONH = { "Content-Type": "application/json" };
const LOGIN_BODY = JSON.stringify({ email: "nobody@probe.local", password: "wrong-password", portal: "admin" });

// HMAC helpers (dev fallback secrets are documented public knowledge in dev)
import { createHmac } from "crypto";
const hmac = (secret: string, msg: string) => createHmac("sha256", secret).update(msg).digest("hex");
const PSP_SECRET = "sm_webhook_secret_demo";
const SHIP_SECRET = "sm_shipping_webhook_demo";

console.log("=== Probe A — CSRF + webhook signatures + gateway (no logins) ===\n");

// ---------------------------------------------------------------- F-01 CSRF
console.log("-- F-01: CSRF proxy matrix (POST /api/auth/login) --");
{
  const r = await post("/api/auth/login", { ...JSONH, Origin: "https://evil.example" }, LOGIN_BODY);
  check("cross-site Origin → 403 CSRF_REJECTED", r.status === 403 && r.json?.error?.code === "CSRF_REJECTED", `got ${r.status} ${r.json?.error?.code}`);

  const r2 = await post("/api/auth/login", { ...JSONH, Origin: BASE }, LOGIN_BODY);
  check("same-origin Origin → passes gate (route-level 401)", r2.status === 401 && r2.json?.error?.code === "INVALID_CREDENTIALS", `got ${r2.status} ${r2.json?.error?.code}`);

  const r3 = await post("/api/auth/login", { ...JSONH }, LOGIN_BODY);
  check("no-Origin non-browser POST → passes gate (401)", r3.status === 401 && r3.json?.error?.code === "INVALID_CREDENTIALS", `got ${r3.status} ${r3.json?.error?.code}`);

  const r4 = await post("/api/auth/login", { ...JSONH, "Sec-Fetch-Site": "cross-site" }, LOGIN_BODY);
  check("Sec-Fetch-Site: cross-site → 403 CSRF_REJECTED", r4.status === 403 && r4.json?.error?.code === "CSRF_REJECTED", `got ${r4.status} ${r4.json?.error?.code}`);

  const r5 = await post("/api/auth/login", { "Content-Type": "application/x-www-form-urlencoded" }, "email=nobody&password=wrong");
  check("urlencoded form POST (no Origin) → 415 UNSUPPORTED_MEDIA_TYPE", r5.status === 415 && r5.json?.error?.code === "UNSUPPORTED_MEDIA_TYPE", `got ${r5.status} ${r5.json?.error?.code}`);

  const r6 = await post("/api/auth/login", { ...JSONH, Origin: "https://evil.example", Authorization: "Bearer deadbeefdeadbeef" }, LOGIN_BODY);
  check("Bearer + cross-site Origin → passes gate (route 401)", r6.status === 401 && r6.json?.error?.code === "INVALID_CREDENTIALS", `got ${r6.status} ${r6.json?.error?.code}`);

  const r7 = await post("/api/auth/login", { ...JSONH, Origin: "null" }, LOGIN_BODY);
  check("Origin: null → 403 CSRF_REJECTED", r7.status === 403 && r7.json?.error?.code === "CSRF_REJECTED", `got ${r7.status} ${r7.json?.error?.code}`);

  const r8 = await fetch(`${BASE}/api/platform/terms`, { method: "GET" });
  check("GET request unaffected by gate (terms 200)", r8.status === 200, `got ${r8.status}`);
}

// ------------------------------------------------- F-04 payments webhook
console.log("\n-- F-04: payments-webhook signature matrix (POST /api/webhooks/payments/mock) --");
{
  const ref = `ref_probe_unknown_${Date.now()}`;
  const ev = "payment.succeeded";
  const amount = 1000;
  const ts = Date.now();
  const goodSig = hmac(PSP_SECRET, `${ref}.${ev}.${amount}.${ts}`);

  const r1 = await post("/api/webhooks/payments/mock", { ...JSONH, "X-SM-Signature": goodSig }, JSON.stringify({ providerRef: ref, eventType: ev, amountMinor: amount, ts }));
  check("valid signature + unknown ref → 404 INTENT_NOT_FOUND (sig passed)", r1.status === 404 && r1.json?.error?.code === "INTENT_NOT_FOUND", `got ${r1.status} ${r1.json?.error?.code}`);

  const r2 = await post("/api/webhooks/payments/mock", { ...JSONH, "X-SM-Signature": "0".repeat(64) }, JSON.stringify({ providerRef: ref, eventType: ev, amountMinor: amount, ts }));
  check("wrong signature → 400 BAD_SIGNATURE", r2.status === 400 && r2.json?.error?.code === "BAD_SIGNATURE", `got ${r2.status} ${r2.json?.error?.code}`);

  const staleTs = Date.now() - 30 * 60_000;
  const staleSig = hmac(PSP_SECRET, `${ref}.${ev}.${amount}.${staleTs}`);
  const r3 = await post("/api/webhooks/payments/mock", { ...JSONH, "X-SM-Signature": staleSig }, JSON.stringify({ providerRef: ref, eventType: ev, amountMinor: amount, ts: staleTs }));
  check("correctly-signed STALE event (30 min old) → 400 STALE_EVENT (replay guard)", r3.status === 400 && r3.json?.error?.code === "STALE_EVENT", `got ${r3.status} ${r3.json?.error?.code}`);

  const r4 = await post("/api/webhooks/payments/mock", { ...JSONH }, JSON.stringify({ providerRef: ref, eventType: ev, amountMinor: amount, ts }));
  check("missing signature → 400 BAD_SIGNATURE", r4.status === 400 && r4.json?.error?.code === "BAD_SIGNATURE", `got ${r4.status} ${r4.json?.error?.code}`);

  const r5 = await post("/api/webhooks/payments/mock", { ...JSONH, "X-SM-Signature": goodSig, Origin: "https://evil.example" }, JSON.stringify({ providerRef: ref, eventType: ev, amountMinor: amount, ts }));
  check("cross-site Origin + valid HMAC → CSRF-exempt, reaches route (404 INTENT_NOT_FOUND)", r5.status === 404 && r5.json?.error?.code === "INTENT_NOT_FOUND", `got ${r5.status} ${r5.json?.error?.code}`);

  const r6 = await post("/api/webhooks/payments/mock", { ...JSONH }, JSON.stringify({ providerRef: "", eventType: ev, amountMinor: amount, ts }));
  check("empty providerRef → 400 BAD_REQUEST (input validation)", r6.status === 400 && r6.json?.error?.code === "BAD_REQUEST", `got ${r6.status} ${r6.json?.error?.code}`);
}

// ------------------------------------------------- F-05 shipping webhook
console.log("\n-- F-05: shipping-webhook signature matrix (POST /api/shipping/webhook/easyparcel) --");
{
  const awb = `PROBE${Date.now().toString(36).toUpperCase()}`;
  const status = "DELIVERED";
  const ts = Date.now();
  const goodSig = hmac(SHIP_SECRET, `${awb}.${status}.${ts}`);

  const r1 = await post("/api/shipping/webhook/easyparcel", { ...JSONH }, JSON.stringify({ awb, status, ts }));
  check("no signature → 400 BAD_SIGNATURE", r1.status === 400 && r1.json?.error?.code === "BAD_SIGNATURE", `got ${r1.status} ${r1.json?.error?.code}`);

  const r2 = await post("/api/shipping/webhook/easyparcel", { ...JSONH, "x-shipping-signature": "0".repeat(64) }, JSON.stringify({ awb, status, ts }));
  check("wrong signature → 400 BAD_SIGNATURE", r2.status === 400 && r2.json?.error?.code === "BAD_SIGNATURE", `got ${r2.status} ${r2.json?.error?.code}`);

  const r3 = await post("/api/shipping/webhook/easyparcel", { ...JSONH, "x-shipping-signature": goodSig }, JSON.stringify({ awb, status, ts }));
  check("valid signature + unknown AWB → 404 NOT_FOUND (sig passed, no state change)", r3.status === 404 && r3.json?.error?.code === "NOT_FOUND", `got ${r3.status} ${r3.json?.error?.code}`);

  const staleTs = Date.now() - 30 * 60_000;
  const staleSig = hmac(SHIP_SECRET, `${awb}.${status}.${staleTs}`);
  const r4 = await post("/api/shipping/webhook/easyparcel", { ...JSONH, "x-shipping-signature": staleSig }, JSON.stringify({ awb, status, ts: staleTs }));
  check("correctly-signed STALE event → 400 STALE_EVENT (replay guard)", r4.status === 400 && r4.json?.error?.code === "STALE_EVENT", `got ${r4.status} ${r4.json?.error?.code}`);

  const badStatus = "TELEPORTED";
  const badSig = hmac(SHIP_SECRET, `${awb}.${badStatus}.${ts}`);
  const r5 = await post("/api/shipping/webhook/easyparcel", { ...JSONH, "x-shipping-signature": badSig }, JSON.stringify({ awb, status: badStatus, ts }));
  check("forged status value → 400 VALIDATION (status whitelist)", r5.status === 400 && r5.json?.error?.code === "VALIDATION", `got ${r5.status} ${r5.json?.error?.code}`);
}

// ------------------------------------------------- F-06 gateway allowlist
console.log("\n-- F-06: gateway XTransformPort allowlist (live on :81) --");
{
  // 3103 (internal relay) must NOT be proxied: the request falls through to the
  // webapp — distinguishable from the relay's JSON 401.
  const r1 = await fetch(`${GW}/broadcast?XTransformPort=3103`, { method: "POST", headers: JSONH, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
  const t1 = await r1.text();
  check("XTransformPort=3103 NOT proxied to relay (falls to webapp)", !(t1.includes("unauthorized relay")), `status=${r1.status} body=${t1.slice(0, 80)}`);

  // 3003 (chat hub) IS proxied: socket.io answers with its engine error, not a webapp 404.
  const r2 = await fetch(`${GW}/?XTransformPort=3003`, { method: "POST", headers: JSONH, body: "{}" });
  const t2 = await r2.text();
  check("XTransformPort=3003 reaches chat hub (socket.io engine response)", r2.status !== 404 && (t2.includes("Transport unknown") || t2.includes("transport") || t2.length < 200), `status=${r2.status} body=${t2.slice(0, 80)}`);

  // 3005 (scheduler) must NOT be proxied either.
  const r3 = await fetch(`${GW}/?XTransformPort=3005`);
  const t3 = await r3.text();
  check("XTransformPort=3005 falls through to webapp", r3.status === 200 || r3.status === 404, `status=${r3.status}`);
}

// ------------------------------------------------- public fail-closed + health
console.log("\n-- public surfaces: metrics fail-closed, health, live terms --");
{
  const m = await fetch(`${BASE}/api/metrics`);
  check("/api/metrics unauthenticated → fail-closed (401/503)", m.status === 401 || m.status === 503, `got ${m.status}`);

  const h = await fetch(`${BASE}/api/health/live`);
  check("/api/health/live → 200", h.status === 200, `got ${h.status}`);
  const hr = await fetch(`${BASE}/api/health/ready`);
  check("/api/health/ready → 200", hr.status === 200, `got ${hr.status}`);

  const t = await fetch(`${BASE}/api/platform/terms`);
  const tj = (await t.json()) as any;
  check("/api/platform/terms → live configured values", t.status === 200 && typeof tj?.data?.commissionPercent === "number", JSON.stringify(tj?.data)?.slice(0, 120));
}

console.log(`\n=== Probe A result: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(failCount > 0 ? 1 : 0);

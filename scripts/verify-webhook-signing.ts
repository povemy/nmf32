// ============================================================================
// C2.8 VERIFICATION — webhook signing + delivery guard logic (PURE, no DB).
// Run:  bun scripts/verify-webhook-signing.ts
// Exit 0 = all sections pass, exit 1 = any failure. No database access and no
// network access: safeRequestJson is exercised through its injected fetch /
// lookup seams, and the signer/verifier are pure functions.
// ============================================================================
import {
  buildWebhookHeaders,
  verifyWebhookSignature,
  signWebhookBody,
  webhookBackoffMs,
  webhookNextRetryAt,
  isPermanentDeliveryError,
  WEBHOOK_BACKOFF_SCHEDULE_MS,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_TIMESTAMP_TOLERANCE_MS,
} from "../src/lib/webhook-delivery";
import { safeRequestJson, type DnsLookupFn, type MinimalFetch, type MinimalResponse } from "../src/lib/safe-fetch";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
}
function section(title: string) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------- A: signer

section("A. signer / verifier round-trip");
{
  const secret = "whsec_test_secret_1234";
  const rawBody = JSON.stringify({ orderNumber: "NM-100001", totalMinor: 4200 });
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const sig = signWebhookBody(secret, rawBody, ts);

  check("signature is 64-char lowercase hex", /^[0-9a-f]{64}$/.test(sig), sig.slice(0, 16) + "…");
  check("verifier accepts a freshly signed payload", verifyWebhookSignature({ secret, rawBody, timestamp: ts, signature: sig, nowMs: now }).valid === true);
  check("verifier rejects a tampered body", verifyWebhookSignature({ secret, rawBody: rawBody.replace("4200", "9900"), timestamp: ts, signature: sig, nowMs: now }).reason === "BAD_SIGNATURE");
  check("verifier rejects a wrong secret", verifyWebhookSignature({ secret: "whsec_other", rawBody, timestamp: ts, signature: sig, nowMs: now }).reason === "BAD_SIGNATURE");

  // The timestamp is INSIDE the signed material: refreshing an old captured
  // request's timestamp header must invalidate the signature (replay guard).
  const oldTs = String(Math.floor((now - 3600_000) / 1000));
  const oldSig = signWebhookBody(secret, rawBody, oldTs);
  const refreshed = String(Math.floor(now / 1000));
  check("verifier rejects a refreshed timestamp on an old capture (timestamp is signed)", verifyWebhookSignature({ secret, rawBody, timestamp: refreshed, signature: oldSig, nowMs: now }).reason === "BAD_SIGNATURE");

  check("verifier rejects a stale (>10 min) but correctly signed payload", verifyWebhookSignature({ secret, rawBody, timestamp: oldTs, signature: oldSig, nowMs: now }).reason === "STALE_TIMESTAMP");
  const edgeTs = String(Math.floor((now - WEBHOOK_TIMESTAMP_TOLERANCE_MS + 5_000) / 1000));
  const edgeSig = signWebhookBody(secret, rawBody, edgeTs);
  check("verifier accepts at the edge of the ±10 min window", verifyWebhookSignature({ secret, rawBody, timestamp: edgeTs, signature: edgeSig, nowMs: now }).valid === true);
  check("verifier rejects a malformed signature", verifyWebhookSignature({ secret, rawBody, timestamp: ts, signature: "deadbeef", nowMs: now }).reason === "BAD_SIGNATURE");
  check("verifier rejects a non-hex signature", verifyWebhookSignature({ secret, rawBody, timestamp: ts, signature: "z".repeat(64), nowMs: now }).reason === "BAD_SIGNATURE");
  check("verifier rejects a non-numeric timestamp", verifyWebhookSignature({ secret, rawBody, timestamp: "now", signature: sig, nowMs: now }).reason === "BAD_TIMESTAMP");

  const headers = buildWebhookHeaders("order.paid", rawBody, secret, now);
  check("buildWebhookHeaders signs with the same formula", verifyWebhookSignature({ secret, rawBody, timestamp: headers["x-nomofee-timestamp"], signature: headers["x-nomofee-signature"], nowMs: now }).valid === true);
  check("buildWebhookHeaders sets event + timestamp + content-type", headers["x-nomofee-event"] === "order.paid" && headers["x-nomofee-timestamp"] === ts && headers["content-type"] === "application/json");
  const unsigned = buildWebhookHeaders("order.paid", rawBody, null, now);
  check("buildWebhookHeaders omits the signature when there is no secret (unsigned contract)", !("x-nomofee-signature" in unsigned) && "x-nomofee-timestamp" in unsigned);
}

// ---------------------------------------------------------------- B: schedule

section("B. derived retry schedule");
{
  check("schedule is 1m, 5m, 15m, 1h, 4h, 12h, 24h after the immediate first attempt", JSON.stringify(WEBHOOK_BACKOFF_SCHEDULE_MS) === JSON.stringify([0, 60_000, 300_000, 900_000, 3_600_000, 14_400_000, 43_200_000, 86_400_000]));
  check("8 attempts total", MAX_WEBHOOK_ATTEMPTS === 8);
  const now = new Date("2026-11-08T12:00:00Z");
  check("never-attempted rows are due immediately", webhookNextRetryAt(0, null, now)?.getTime() === now.getTime());
  check("failed attempt 1 retries after 1m", webhookNextRetryAt(1, now, now)?.getTime() === now.getTime() + 60_000);
  check("failed attempt 2 retries after 5m", webhookNextRetryAt(2, now, now)?.getTime() === now.getTime() + 300_000);
  check("failed attempt 7 retries after 24h cap", webhookNextRetryAt(7, now, now)?.getTime() === now.getTime() + 86_400_000);
  check("exhausted rows have no next retry (terminal)", webhookNextRetryAt(8, now, now) === null);
  check("backoff index clamps out-of-range inputs", webhookBackoffMs(99) === 86_400_000 && webhookBackoffMs(-5) === 0);
  const total = WEBHOOK_BACKOFF_SCHEDULE_MS.slice(1).reduce((a, b) => a + b, 0);
  check("full retry horizon ≈ 41.4 h (2481 min)", Math.round(total / 3_600_000) === 41, `${(total / 3_600_000).toFixed(1)} h`);
}

// ---------------------------------------------------------------- C: error class

section("C. permanent-vs-retryable error classification");
{
  check("SSRF hop refusals are permanent", isPermanentDeliveryError("PRIVATE_HOST") && isPermanentDeliveryError("SCHEME") && isPermanentDeliveryError("CREDENTIALS") && isPermanentDeliveryError("INVALID_URL"));
  check("DNS private-resolution refusals (inside NETWORK messages) are permanent", isPermanentDeliveryError("NETWORK: Blocked resolution of internal.corp to a private/restricted address (SSRF guard)") && isPermanentDeliveryError("NETWORK: getaddrinfo EPRIVATEADDRESS example.com"));
  check("timeouts / plain network errors stay retryable", !isPermanentDeliveryError("NETWORK: The operation was aborted due to timeout") && !isPermanentDeliveryError("HTTP_500"));
}

// ---------------------------------------------------------------- D: guarded POST

section("D. safeRequestJson — SSRF guards + real status capture (injected fetch)");
{
  // stub DNS: any hostname "resolves" to a public IP unless overridden
  const publicLookup: DnsLookupFn = (hostname, _opts, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]);
  const mkRes = (status: number, headers: Record<string, string> = {}, body = ""): MinimalResponse => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    body: null,
  });

  const stubFetch = (impl: (url: string) => Promise<MinimalResponse>): MinimalFetch => {
    return (async (url: string) => impl(url)) as MinimalFetch;
  };

  // 1) metadata IP literal is refused before any HTTP happens
  const fetchCalls: string[] = [];
  const never: MinimalFetch = (async (url: string) => {
    fetchCalls.push(String(url));
    return mkRes(200);
  }) as MinimalFetch;
  const meta = await safeRequestJson("http://169.254.169.254/latest/meta-data", { fetchImpl: never, lookup: publicLookup });
  check("cloud-metadata IP literal is refused (PRIVATE_HOST)", meta.ok === false && meta.reason === "PRIVATE_HOST" && fetchCalls.length === 0);

  // 2) redirect into a private range is re-validated and refused
  const redirectFetch: MinimalFetch = (async (url: string) => {
    fetchCalls.push(String(url));
    if (String(url).includes("hooks.example.com")) return mkRes(302, { location: "http://10.0.0.5/steal" });
    return mkRes(200);
  }) as MinimalFetch;
  const viaRedirect = await safeRequestJson("https://hooks.example.com/deliver", { fetchImpl: redirectFetch, lookup: publicLookup });
  check("302 redirect to a private IP is refused on the hop (PRIVATE_HOST)", viaRedirect.ok === false && viaRedirect.reason === "PRIVATE_HOST");

  // 3) non-http schemes + userinfo are refused
  const fileScheme = await safeRequestJson("file:///etc/passwd", { fetchImpl: never, lookup: publicLookup });
  check("file:// scheme is refused (SCHEME)", fileScheme.ok === false && fileScheme.reason === "SCHEME");
  const creds = await safeRequestJson("http://user:pass@hooks.example.com/deliver", { fetchImpl: never, lookup: publicLookup });
  check("embedded userinfo is refused (CREDENTIALS)", creds.ok === false && creds.reason === "CREDENTIALS");

  // 4) hostname resolving to a private address is refused (DNS guard)
  const privateLookup: DnsLookupFn = (hostname, _opts, cb) => cb(null, [{ address: "192.168.1.10", family: 4 }]);
  const dnsAttack = await safeRequestJson("https://evil.example.com/deliver", { fetchImpl: never, lookup: privateLookup });
  check("hostname resolving to a private IP is refused (PRIVATE_HOST)", dnsAttack.ok === false && dnsAttack.reason === "PRIVATE_HOST");

  // 5) a real non-2xx response is reported as ok:true with the REAL status
  const err500 = await safeRequestJson("https://hooks.example.com/deliver", {
    fetchImpl: stubFetch(() => Promise.resolve(mkRes(500, { "content-type": "application/json", "content-length": "26" }, '{"error":"boom"}'))),
    lookup: publicLookup,
  });
  check("non-2xx HTTP response is captured as the real status", err500.ok === true && err500.status === 500 && err500.body === '{"error":"boom"}');

  // 6) 2xx with an undeclared (chunked) body: status kept, body not read
  const chunked = await safeRequestJson("https://hooks.example.com/deliver", {
    fetchImpl: stubFetch(() => Promise.resolve(mkRes(202, { "content-type": "application/json" }))),
    lookup: publicLookup,
  });
  check("chunked 202 captured, body not read (bounded capture)", chunked.ok === true && chunked.status === 202 && chunked.body === null);

  // 7) network failure is a refusal with a NETWORK reason (no status invented)
  const netFail = await safeRequestJson("https://hooks.example.com/deliver", {
    fetchImpl: (async () => {
      throw new Error("The operation was aborted due to timeout");
    }) as MinimalFetch,
    lookup: publicLookup,
  });
  check("timeout surfaces as NETWORK refusal (status never invented)", netFail.ok === false && netFail.reason.startsWith("NETWORK:"));

  // 8) 307 redirect to a PUBLIC host is followed (re-POST) and the final
  //    status is the one recorded
  const hopFetch: MinimalFetch = (async (url: string) => {
    fetchCalls.push(String(url));
    if (String(url).includes("hooks.example.com")) return mkRes(307, { location: "https://backup.example.com/deliver" });
    return mkRes(201, { "content-type": "application/json", "content-length": "2" }, "{}");
  }) as MinimalFetch;
  const via307 = await safeRequestJson("https://hooks.example.com/deliver", { fetchImpl: hopFetch, lookup: publicLookup });
  check("307 redirect to a public host is followed; final real status recorded", via307.ok === true && via307.status === 201);
}

// ---------------------------------------------------------------- summary

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

// ============================================================================
// Phase 1 (A3) — CSRF gate regression tests for src/proxy.ts.
// Verifies the layered origin-evidence gate AFTER the Next.js 16.1.3 → 16.4.3
// upgrade: cross-origin mutations rejected, legitimate request shapes pass,
// and every self-authenticated exemption keeps passing through to its own
// downstream authentication (HMAC / cron secret / capability URL).
// Pure unit tests — no database, no server, no network.
// ============================================================================
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import proxy from "@/proxy";

const HOST = "shopmesh.test";

function make(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  const url = `http://${HOST}${path}`;
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers: { host: HOST, ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

function statusOf(res: Response): number {
  return res.status;
}

describe("proxy CSRF gate — safe traffic passes", () => {
  test("GET on any API route passes (safe method)", () => {
    expect(statusOf(proxy(make("/api/market/products")))).toBe(200);
  });
  test("non-API page request passes untouched", () => {
    const res = proxy(make("/pay/ref_x", { method: "POST" }));
    expect(statusOf(res)).toBe(200);
  });
  test("same-origin Sec-Fetch-Site POST passes", () => {
    expect(statusOf(proxy(make("/api/cart/items", { method: "POST", headers: { "sec-fetch-site": "same-origin" } })))).toBe(200);
  });
  test("same-site Sec-Fetch-Site POST passes", () => {
    expect(statusOf(proxy(make("/api/cart/items", { method: "POST", headers: { "sec-fetch-site": "same-site" } })))).toBe(200);
  });
  test("matching Origin (port-insensitive) passes", () => {
    expect(
      statusOf(proxy(make("/api/cart/items", { method: "POST", headers: { origin: `http://${HOST}:81` } })))
    ).toBe(200);
  });
  test("app client marker (X-SM-Client: web) passes pre-auth routes", () => {
    expect(
      statusOf(proxy(make("/api/auth/unified-login", { method: "POST", headers: { "x-sm-client": "web" } })))
    ).toBe(200);
  });
  test("Bearer bridge passes (preflight-gated custom header)", () => {
    expect(
      statusOf(proxy(make("/api/me/profile", { method: "PATCH", headers: { authorization: "Bearer abcd1234" } })))
    ).toBe(200);
  });
  test("headerless non-browser client without content-type passes (route guards apply downstream)", () => {
    expect(statusOf(proxy(make("/api/orders/lookup", { method: "POST", headers: { "content-length": "0" } })))).toBe(200);
  });
  test("application/json body from headerless client passes", () => {
    expect(
      statusOf(proxy(make("/api/orders/lookup", { method: "POST", headers: { "content-type": "application/json", "content-length": "32" } })))
    ).toBe(200);
  });
});

describe("proxy CSRF gate — cross-site attacks rejected", () => {
  test("Sec-Fetch-Site: cross-site mutation → 403 CSRF_REJECTED", () => {
    const res = proxy(make("/api/cart/items", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    expect(statusOf(res)).toBe(403);
  });
  test("Origin: null (sandboxed form post) → 403", () => {
    const res = proxy(make("/api/cart/items", { method: "POST", headers: { origin: "null" } }));
    expect(statusOf(res)).toBe(403);
  });
  test("foreign Origin → 403", () => {
    const res = proxy(make("/api/cart/items", { method: "POST", headers: { origin: "http://evil.example" } }));
    expect(statusOf(res)).toBe(403);
  });
  test("form-encoded body with no origin metadata → 415 (classic form CSRF vector)", () => {
    const res = proxy(
      make("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "40" },
      })
    );
    expect(statusOf(res)).toBe(415);
  });
  test("multipart body with no origin metadata → 415", () => {
    const res = proxy(
      make("/api/store/products", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "100" },
      })
    );
    expect(statusOf(res)).toBe(415);
  });
  test("DELETE with cross-site metadata → 403", () => {
    const res = proxy(make("/api/cart/items/c1", { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } }));
    expect(statusOf(res)).toBe(403);
  });
});

describe("proxy CSRF gate — self-authenticated exemptions still pass to their own auth", () => {
  // These carry HMAC signatures / cron secrets / capability refs downstream —
  // the CSRF layer must NEVER block them, and never accepts them WITHOUT
  // those credentials (the downstream guards own that).
  test("payments webhook POST is exempt (HMAC verified downstream)", () => {
    expect(statusOf(proxy(make("/api/webhooks/payments/mock", { method: "POST", headers: { "content-type": "text/plain" } })))).toBe(200);
  });
  test("shipping webhook POST is exempt (HMAC verified downstream)", () => {
    expect(statusOf(proxy(make("/api/shipping/webhook/some-provider", { method: "POST" })))).toBe(200);
  });
  test("cron expiry-sweep POST is exempt (x-cron-secret verified downstream)", () => {
    expect(statusOf(proxy(make("/api/cron/expiry-sweep", { method: "POST" })))).toBe(200);
  });
  test("cron session-purge POST is exempt (Phase 1 C3)", () => {
    expect(statusOf(proxy(make("/api/cron/session-purge", { method: "POST" })))).toBe(200);
  });
  test("checkout payments retry capability URL POST is exempt", () => {
    expect(statusOf(proxy(make("/api/checkout/payments/ref_abc/retry", { method: "POST" })))).toBe(200);
  });
  test("claim bind POST is exempt (single-use token verified downstream)", () => {
    expect(statusOf(proxy(make("/api/claim/bind", { method: "POST" })))).toBe(200);
  });
  test("orders expiry tick POST is exempt (idempotent CAS sweep)", () => {
    expect(statusOf(proxy(make("/api/orders/expiry/tick", { method: "POST" })))).toBe(200);
  });
  test("NEAR-miss paths are NOT exempt (prefix must match segment-wise)", () => {
    // /api/webhooks-payments is not /api/webhooks/payments — must go through
    // the full gate (and be rejected without origin evidence + JSON body).
    const res = proxy(
      make("/api/webhook-payments-fake", {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": "10" },
      })
    );
    expect(statusOf(res)).toBe(415);
  });
});

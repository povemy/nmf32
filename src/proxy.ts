// ============================================================================
// src/proxy.ts — F-01 (CRITICAL) CSRF remediation.
// ============================================================================
// Next.js 16 proxy convention (middleware renamed to proxy in 16.x — verified
// against next@16.1.3 PROXY_FILENAME). Runs for /api/* requests only.
//
// WHAT THIS GATE DOES — every NON-safe (POST/PATCH/PUT/DELETE) request to the
// API must prove it originates from THIS application, unless the route
// authenticates itself by another mechanism (HMAC signature / shared secret /
// single-use token — the exemption list below).
//
// Rules, in order:
//   1. Bearer Authorization header present → ALLOW. A custom header cannot be
//      attached by a cross-site page without a CORS preflight, and this app
//      grants no cross-origin CORS — so a Bearer-bearing request is never an
//      ambient-cookie forgery. (This is the iframe/preview-panel path.)
//   2. Origin header present → the origin's host must match the request's own
//      host (Host header, honouring x-forwarded-host behind the gateway).
//      "null" origin (sandboxed frame / data: URL) → REJECT.
//   3. No Origin but Sec-Fetch-Site present → REJECT "cross-site".
//   4. Neither header → ALLOW (non-browser client: curl, scripts, PSP
//      delivery, scheduler — no ambient cookie authority in practice).
//   5. Content-type gate: requests that declare a body must be JSON (the app
//      has no form-encoded or multipart endpoints — verified). A classic
//      cross-site <form> POST (urlencoded/text/plain) is rejected with 415
//      even on browsers that lack Sec-Fetch-Site.
//
// WHAT IT DOES NOT DO — it does not weaken or replace session authentication
// (lib/auth.ts still validates every request), and it deliberately does NOT
// block all cross-origin traffic: the legitimate architecture (portal iframes
// carrying the Bearer bridge) keeps working, and HMAC-authenticated webhook
// endpoints are exempt because they never rely on cookies.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";

/** Routes that authenticate themselves WITHOUT cookies (HMAC signature over
 * the body, shared cron secret, single-use claim token, or system ticks with
 * their own throttle). The origin gate does not apply to them. */
const SELF_AUTHENTICATED_PREFIXES = [
  "/api/webhooks/payments/", // HMAC-SHA256 (X-SM-Signature) + replay window
  "/api/shipping/webhook/", // HMAC-SHA256 (x-shipping-signature) + replay window
  "/api/cron/", // x-cron-secret shared secret (fail-closed in production)
  "/api/checkout/payments/", // /simulate = HMAC-signed mock rail; [ref]/retry = capability URL
  "/api/claim/bind", // 192-bit hashed single-use token
  "/api/shipping/tick", // system tick (in-process throttle, documented design)
  "/api/orders/expiry/tick", // system tick (in-process throttle, documented design)
] as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Hostname of an Origin/URL value, lowercased, port-insensitive. */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The host this request was addressed to: x-forwarded-host (first value,
 * gateway chains) wins, then the Host header. Lowercased hostname only. */
function requestHost(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-host");
  const raw = (fwd ? fwd.split(",")[0].trim() : null) ?? req.headers.get("host");
  if (!raw) return null;
  // strip port (v4/v6) — Origin comparison stays port-insensitive so the
  // gateway's public port vs the internal app port can never cause a
  // false rejection; a cross-site attacker differs at the hostname level.
  const hostPart = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  return hostPart.toLowerCase();
}

function reject(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export default function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Only the API surface is gated; page requests are GET-navigations.
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (SAFE_METHODS.has(req.method)) return NextResponse.next();

  // Self-authenticated routes (HMAC / shared secret / token / tick).
  const isExempt = SELF_AUTHENTICATED_PREFIXES.some((p) => {
    const base = p.endsWith("/") ? p.slice(0, -1) : p;
    return pathname === base || pathname.startsWith(`${base}/`);
  });
  if (isExempt) {
    return NextResponse.next();
  }

  // (1) Bearer bridge — never an ambient-cookie forgery (custom header ⇒
  // preflight-gated cross-origin; no CORS is granted to other origins).
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return NextResponse.next();

  // (2) Origin evidence (browsers send Origin on every non-GET).
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin.toLowerCase() === "null") {
      return reject(403, "CSRF_REJECTED", "Request origin is opaque (null) — cross-site form submissions are not accepted on authenticated endpoints.");
    }
    const originHost = hostnameOf(origin);
    const ownHost = requestHost(req);
    if (!originHost || !ownHost || originHost !== ownHost) {
      return reject(403, "CSRF_REJECTED", "Cross-site request detected — the API only accepts same-origin mutations.");
    }
    return NextResponse.next();
  }

  // (3) Sec-Fetch-Site (modern browsers; also covers no-Origin legacy paths).
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite.toLowerCase() === "cross-site") {
    return reject(403, "CSRF_REJECTED", "Cross-site request detected — the API only accepts same-origin mutations.");
  }

  // (4) Content-type gate: bodies must be JSON (this app defines no form or
  // multipart endpoints — all clients send application/json, verified).
  // Applies even to non-browser clients: cheap, uniform, and kills the
  // classic HTML-form CSRF vector regardless of header support.
  const hasBody =
    (req.headers.get("content-length") ?? "") !== "0" &&
    (Boolean(req.headers.get("content-length")) || Boolean(req.headers.get("transfer-encoding")));
  const contentType = req.headers.get("content-type");
  if (hasBody && contentType && !/^application\/json\b/i.test(contentType.trim())) {
    return reject(415, "UNSUPPORTED_MEDIA_TYPE", "This API accepts JSON bodies only (cross-site form posts are not valid requests).");
  }

  // (5) No Origin and no Sec-Fetch-Site → non-browser client (scripts, PSP
  // deliveries, monitoring). It carries no ambient cookie authority that a
  // forged page could leverage; route guards still apply.
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};

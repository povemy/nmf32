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
//   2. App client marker header (X-SM-Client: web) present → ALLOW. Identical
//      trust class as (1): every fetch() the app's own JS makes attaches this
//      custom header, and cross-site pages CANNOT set custom headers without a
//      CORS preflight (which this app never grants — verified: no
//      Access-Control-Allow-* is emitted anywhere). Critically this covers
//      PRE-AUTH requests (login/register): the Bearer bridge only exists after
//      a session exists, but the marker proves "our own JavaScript" even when
//      the user has no token yet — including inside sandboxed iframes with
//      opaque (null) origins.
//   3. Sec-Fetch-Site evidence (Fetch Metadata): same-origin / same-site / none
//      → ALLOW; cross-site → REJECT. The browser computes this value against
//      the URL it is actually fetching (the app's real public origin), so it is
//      IMMUNE to proxy chains that rewrite the Host header between the browser
//      and this process. This is what fixes preview-panel logins for good:
//      the browser truthfully says "same-origin" while the Origin↔Host string
//      comparison fails purely because a gateway rewrote Host.
//   4. Origin header present → the origin's host must match the request's own
//      host (Host header, honouring x-forwarded-host behind the gateway).
//      "null" origin (sandboxed frame / data: URL) → REJECT. (Legacy browsers
//      without Fetch Metadata support.)
//   5. Content-type gate: requests that declare a body must be JSON (the app
//      has no form-encoded or multipart endpoints — verified). A classic
//      cross-site <form> POST (urlencoded/text/plain) is rejected with 415
//      even on browsers that lack Sec-Fetch-Site.
//   6. Neither Origin nor Sec-Fetch-Site → ALLOW (non-browser client: curl,
//      scripts, PSP delivery, scheduler — no ambient cookie authority in
//      practice).
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
  "/api/webhooks/email/", // Svix HMAC-SHA256 (svix-signature) + replay window (Phase 2.3)
  "/api/shipping/webhook/", // HMAC-SHA256 (x-shipping-signature) + replay window
  "/api/cron/", // x-cron-secret shared secret (fail-closed in production)
  "/api/checkout/payments/", // /simulate = HMAC-signed mock rail; [ref]/retry = capability URL
  "/api/claim/bind", // 192-bit hashed single-use token
  "/api/shipping/tick", // system tick (in-process throttle, documented design)
  "/api/orders/expiry/tick", // system tick (assertCronAuth since Phase 2.2)
] as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Header value that marks a request as made by THIS app's own JavaScript.
 * Every client fetch helper (lib/session-client.ts authHeaders/deviceHeaders)
 * attaches it to every request — including GETs (harmless) — so any mutation
 * made by the app itself carries it. Cross-site pages cannot forge it: custom
 * headers require a CORS preflight, and this app never grants CORS. */
const CLIENT_MARKER_HEADER = "x-sm-client";
const CLIENT_MARKER_VALUE = "web";

/** Fetch-Metadata values the browser computes for requests initiated from
 * the site being fetched (or with no initiating site at all). "none" covers
 * address-bar/extension-initiated requests; "cross-site" is the only value
 * that indicates a foreign page. */
const SAMESITE_FETCH_VALUES = new Set(["same-origin", "same-site", "none"]);

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

  // (2) App client marker — same preflight-gated trust class as the Bearer
  // bridge, but available PRE-AUTHENTICATION (login / register / landing
  // beacons). Fixes preview-panel logins even inside sandboxed iframes where
  // the origin is opaque and Fetch Metadata would read "cross-site".
  const marker = req.headers.get(CLIENT_MARKER_HEADER);
  if (marker && marker.trim().toLowerCase() === CLIENT_MARKER_VALUE) {
    return NextResponse.next();
  }

  // (3) Fetch Metadata — the browser's own site classification of this
  // request, computed against the URL it fetches (our real public origin).
  // Proxy chains may rewrite Host, but they cannot rewrite what the browser
  // asserted about the initiator, so this is the authoritative signal.
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite) {
    const site = fetchSite.trim().toLowerCase();
    if (SAMESITE_FETCH_VALUES.has(site)) return NextResponse.next();
    if (site === "cross-site") {
      return reject(403, "CSRF_REJECTED", "Cross-site request detected — the API only accepts same-origin mutations.");
    }
    // Unknown value → fall through to the Origin evidence below.
  }

  // (4) Origin evidence (browsers send Origin on every non-GET).
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

  // (5) Content-type gate: bodies must be JSON. The ONE sanctioned multipart
  // endpoint is /api/admin/campaign-media (work order 14 banner uploads) —
  // it is unreachable through this gate for cookie-only flows by design: the
  // app's own upload helper always carries the Bearer bridge / client marker
  // (steps 1-2), while a cross-site HTML form post (the classic CSRF vector
  // for file uploads) is 415'd right here before it can touch the route. The
  // route itself then re-checks RBAC (campaigns.manage) + magic bytes.
  const hasBody =
    (req.headers.get("content-length") ?? "") !== "0" &&
    (Boolean(req.headers.get("content-length")) || Boolean(req.headers.get("transfer-encoding")));
  const contentType = req.headers.get("content-type");
  if (hasBody && contentType && !/^application\/json\b/i.test(contentType.trim())) {
    return reject(415, "UNSUPPORTED_MEDIA_TYPE", "This API accepts JSON bodies only (cross-site form posts are not valid requests).");
  }

  // (6) No Origin and no Sec-Fetch-Site → non-browser client (scripts, PSP
  // deliveries, monitoring). It carries no ambient cookie authority that a
  // forged page could leverage; route guards still apply.
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};

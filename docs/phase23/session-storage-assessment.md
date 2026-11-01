# Phase 2.3 (P2.3-6) — Browser Session Storage Assessment

**Status: ASSESSMENT ONLY — no transport change made.** Decision and evidence below.

## Current model (verified in code)

- **Transport:** session token (256-bit hex) is returned by `/api/auth/login` (JSON `token`)
  and stored in `localStorage["sm_session_token"]`; every portal request sends it as
  `Authorization: Bearer <token>` **plus** the `X-SM-Client: web` origin-gate marker
  (`src/lib/session-client.ts` → `authHeaders()`).
- **Parallel cookie:** `createSession()` (src/lib/auth.ts) ALSO sets `sm_session`
  (`HttpOnly; Secure; SameSite=None; Path=/`) and `getSession()` accepts cookie fallback —
  top-level browsing already runs on an HttpOnly cookie today.
- **Server side:** sessions are DB rows with `token = sha256(raw)` (C2 — no replay from a
  DB/backup read), 7-day TTL, `destroySession()` (Bearer + cookie both retired),
  `revokeUserSessions()` (admin suspend/terminate), `rotateSession()` (delete-first).
- **CSRF:** F-01 gate in `src/proxy.ts` — every non-safe `/api/*` request must show
  Bearer, the `X-SM-Client` marker, same-origin/same-site `Sec-Fetch-Site`, a matching
  `Origin`, or a JSON body (HTML-form posts rejected 415). No CORS is granted anywhere,
  so custom headers are preflight-gated ⇒ cross-site pages cannot forge mutations.
- **Chat:** socket.io handshake carries `{ token }` in the auth payload (NOT a cookie);
  the hub validates it against the app (F-06).
- **Guest identity:** `X-Cart-Token` / `X-Shopper-Token` header bridges + `sm_cart`
  cookie — separate from session auth, untouched by any cookie migration.

## XSS exposure profile

If XSS executes on the app origin, the attacker can read `sm_session_token` and
**exfiltrate a durable bearer token** (works from any origin, survives page close).
With an HttpOnly-only model the same XSS could not read the credential but could still
**ride the session in-context** (same-origin `fetch` attaches cookies automatically).
So HttpOnly's real delta is *exfiltration resistance*, not XSS immunity.

## What a full HttpOnly migration would require

1. Cookie-primary auth on all routes (API side is ~ready — the cookie fallback exists).
2. Hard CSRF obligations for cookie-authenticated mutations: today's gate already blocks
   cross-site mutations (marker/`Sec-Fetch-Site` + no-CORS), but cookie authority makes
   a per-request CSRF token (or at minimum the permanent marker requirement) mandatory
   defense-in-depth on EVERY route — a large audit surface.
3. **Chat service:** forward cookies through the Caddy ws path (`/?XTransformPort=3003`)
   and authenticate the handshake from them — or keep the token handshake (then the
   token is JS-readable anyway and HttpOnly adds nothing for chat).
4. **Preview-panel iframe Bearer bridge must be preserved regardless:** the platform
   preview embeds the app cross-site; browsers block/partition third-party cookies
   there (that is precisely why the localStorage bridge exists — see comments in
   session-client.ts, lib/auth.ts, api/cart/cart.ts). A cookie-only model breaks
   preview logins; keeping the bridge means the token stays JS-visible anyway.
5. Mobile/script API clients use Bearer headers — Bearer must remain supported.

## Risks of migrating

Auth regression in exactly the contexts the architecture targets (sandboxed/cross-site
iframes, partitioned storage), doubled transport logic in login/logout/rotate, expanded
CSRF surface, and chat-handshake rework — against a benefit (exfil resistance) that
largely evaporates because the iframe bridge and chat handshake keep a JS-held token.

## Recommendation — keep the current model

The layered defenses (F-01 origin gate + zero CORS + sha256-at-rest sessions +
revocation/rotation + login rate limits + admin MFA) already cover the realistic
threats. Top-level browsing already enjoys the HttpOnly cookie; the localStorage
bridge is only load-bearing where cookies are unavailable, and there it is the only
thing that works. Migrating would add ~one narrow property (token exfiltration
resistance under XSS) at the cost of breaking the documented embed architecture.

**Cheap hardening (done):** verified `sm_session_token` is read/written ONLY via
`src/lib/session-client.ts` (repo-wide grep: zero direct accesses outside the module;
`sm_cart_note` / `sm_surface` are non-credential UI prefs). No strays to centralize.

**Future options if the threat model changes:** short-lived JS access token +
HttpOnly rotating refresh token (keeps the iframe bridge on the access token),
CSP nonce hardening (see next.config.ts comment), Trusted Types.

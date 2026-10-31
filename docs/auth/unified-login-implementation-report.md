# Unified Login — Implementation Report

**Date:** 2026-10-31 · **Scope:** Phase 11 + 12 of the post-implementation mission — ONE login entry point for every NOMOFEE account type (buyer / seller / affiliate / administrator) with a development-only credential reference. **No new authentication system was created** — every existing secure mechanism is reused verbatim.

---

## 1. What existed before (audit summary)

- Three separate login UIs: shopper dialog (shopper-shell), seller auth screen (seller-shell), admin login card (admin-shell) — each hardwired to its own endpoint.
- Two login endpoints: `POST /api/auth/login` (admin+seller, portal body field) and `POST /api/auth/shopper/login`.
- DB-backed opaque sessions (`Session` table, `sm_session` httpOnly/secure/sameSite=none cookie + Bearer bridge, 7-day TTL, revocation by row delete).
- Scrypt password verification (timing-safe), shared `auth-login` rate limit 10/min/IP, CSRF proxy gate (`X-SM-Client: web` / Fetch Metadata), uniform 401s (no account oracles), no MFA (documented posture), no forgot-password flow (none existed — none invented).
- Emails can legitimately exist in more than one account table (seller↔shopper; shopper registration cross-checks, seller registration does not).
- Affiliates are shoppers (`AffiliateProfile` on `ShopperUser`) — no separate identity.

## 2. What was built

### 2.1 Canonical endpoint — `POST /api/auth/unified-login` (src/app/api/auth/unified-login/route.ts)

- Body `{ email, password }` — **no portal choice required**. The server probes the three account tables in parallel, verifies the password against each, and mints the session for the (single) verified identity.
- **Ambiguity handling:** same credentials valid in >1 table ⇒ **409 `ACCOUNT_TYPE_AMBIGUOUS`** with `details.types` (server-verified only); NO session minted. The client shows a portal picker limited to those types; a pick resubmits with `portal`, which the server honours ONLY if that type is among the verified candidates (else uniform 401).
- Response: the exact legacy login shape (`userType`, `admin|seller|shopper` payload, `token`, `claimed`) + `isAffiliate` (shopper only — informs routing, never authorization).
- **Security posture — identical to legacy, nothing weakened:** same shared `auth-login` 10/min/IP bucket; same scrypt verify; same `createSession`/cookie flags/Bearer bridge; same status gates (admin `isActive`, seller terminated/suspended 403s, shopper non-active 403); uniform `INVALID_CREDENTIALS`; every login writes the same ActivityLog rows (`admin.login`/`seller.login`/`shopper.login`, `meta.via:"unified"`).
- Privileges are NEVER inferred from body/URL/client — identity is established server-side; downstream `requireAdmin`/`requireCap`/`requireSeller`/`requireShopper`/`requireAffiliate` are untouched and remain the sole authorization enforcers. A buyer cannot become an admin by editing any request field — the admin session only exists if the password verified against the `AdminUser` row.
- Legacy routes remain fully functional (deep links, scripts, E2E harnesses unchanged).

### 2.2 Shared UI — `src/components/auth/unified-auth-panel.tsx`

- One login form (email + password with show/hide, autocomplete hints, 44px targets, loading/error states) embedded in ALL THREE portal login UIs; the user never chooses a portal first.
- 409 ⇒ inline ambiguity picker ("Continue as Seller/Buyer/Admin" with destination labels) — resubmits with the disambiguation hint; editing credentials dismisses it.
- On success: `setSessionToken` (existing localStorage bridge) then hands routing to the host via `onAuthed(userType, res)`.

### 2.3 Portal integrations (surgical)

| Surface | File | Post-login routing |
|---|---|---|
| Shopper dialog | shopper-shell.tsx (`ShopperAuthDialog`) | shopper → existing flow (refreshMe + intent resume `afterShopperAuth`); seller/admin → `setSurface(userType)` + toast "opening the Seller Centre/Admin Console". Register tab untouched. |
| Seller screen | seller-shell.tsx (`AuthScreen`) | seller → existing post-login flow (status gates: onboarding/rejected/pending_review/active); shopper → marketplace toast+route; admin → Admin Console route. |
| Admin card | admin-shell.tsx (`LoginCard`) | admin → existing `onLogin()` (refreshMe → console gate); non-admin → toast "This account is not an administrator" + route to their own portal. **The console itself stays fully server-protected** — the old client-side userType rejection was redundant with `requireAdmin`, which still guards every admin API. |

Legacy URL compatibility: the app is a single-route SPA — there are no `/login`-style URLs to break; `?sf=` deep links and PortalFab switching behave exactly as before (verified in-browser). No open-redirect surface exists (surface switching is an internal store enum, not a URL).

### 2.4 Dev-only credential reference — Phase 12

- **API** `GET /api/auth/dev-accounts` (src/app/api/auth/dev-accounts/route.ts): dual server-side gate — `NODE_ENV === "development"` **AND** `NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS === "true"`; otherwise **404 indistinguishable from a missing route**. Every listed account is re-verified against its documented password at request time; drifted accounts are omitted (never guessed). No production endpoint returns credentials under any condition.
- **UI** `src/components/auth/dev-accounts-panel.tsx`: collapsible "Development Test Accounts — Sandbox Only" section rendered BELOW the login form inside the shared panel (therefore present in all three portals, never on register tabs). Per-account: type badge, label, email + password with individual copy buttons (clipboard API + textarea fallback, copied-state feedback, sr-only labels). **Renders absolutely nothing unless the API returns 200 with accounts** — no bundled/cached credential data exists client-side, so a production build cannot show even an empty shell.
- **Source of credentials** (seeded/demo, never invented): `prisma/seed.ts` admin/seller fallbacks + documented demo shoppers + the E2E affiliate demo. `scripts/ensure-demo-accounts.ts` (NEW, idempotent) guarantees the shopper-side demo passwords verify (resetting ONLY explicitly-identified sandbox demo accounts; aisyah@nomofee.test had drifted → reset) and ensures the demo affiliate profile exists. Seed-managed admin/seller accounts are verified, never mutated.
- **Demo-account safety:** all listed identities are sandbox demo rows; the demo admin's powers are the dev sandbox's own (mock PSP rails — `fpx_toyyibpay` simulate endpoint, manual-bank payouts only, no live provider keys are set; `.env.example` documents every production secret as unset/fail-closed).
- **Flag propagation:** `.env` (sandbox) + `upload/.env.vault` (durable) + `.env.example` (documentation + cleanup pointer).

### 2.5 Account-table hygiene note

Seller↔shopper email collision remains possible (seller registration lacks the cross-portal check shoppers have). The unified endpoint handles the collision safely via the ambiguity flow; closing the registration gap itself is a small future hardening item (not required for this mission and deliberately not changed to avoid altering signup behaviour).

## 3. Verification

**Runtime (curl):** admin/seller/affiliate logins 200 with correct payloads + tokens; wrong password → uniform 401; dev-accounts 200 with the flag / 404-classified otherwise. See `docs/affiliate/post-implementation-verification.md` §2.6.

**Browser (agent-browser):** unified dialog renders on all three surfaces; dev panel lists 12 accounts with working copy buttons; buyer login ✔; buyer-on-admin-card routed to marketplace with the explanatory toast and NO console access ✔; admin login → Admin Console ✔; mobile 390 px layout ✔; zero console/page errors. (§2.3/§3 of the verification doc.)

**Security invariants re-checked:** every admin API still 401/403 for non-admin sessions (unchanged code paths); rate limit shared bucket active (429 observed during rapid E2E register bursts); session cookie flags and Bearer bridge unchanged; `logout`/`revokeUserSessions`/`rotateSession` untouched and still consumed by the same store.

**Not tested:** production build of the panel (forbidden build in sandbox; the 404 gate + zero bundled data make the panel structurally absent without the flag), staging.

## 4. Files

- NEW: `src/app/api/auth/unified-login/route.ts`, `src/app/api/auth/dev-accounts/route.ts`, `src/components/auth/unified-auth-panel.tsx`, `src/components/auth/dev-accounts-panel.tsx`, `scripts/ensure-demo-accounts.ts`
- MODIFIED: `src/components/shopper/shopper-shell.tsx`, `src/components/seller/seller-shell.tsx`, `src/components/admin/admin-shell.tsx`, `.env.example`, `.env` (sandbox flag), `upload/.env.vault` (durable copy)
- UNTOUCHED: all auth libraries (`lib/auth.ts`, `lib/password.ts`, `lib/api.ts`, `src/proxy.ts`), legacy login routes, session model, RBAC.

## 5. Cleanup when development finishes

1. Remove `NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS` (panel + API vanish — 404).
2. Optionally delete the panel component + API route.
3. Rotate demo passwords via `scripts/ensure-demo-accounts.ts` (edit documented values) / `SEED_*_PASSWORD` overrides.
4. Verify no credentials appear in a production build (`grep` of build output — data is DB-side only).
5. Genuine accounts untouched throughout.

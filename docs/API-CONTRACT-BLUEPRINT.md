# Nomofee — API Contract & Blueprint Document

**Single source of truth for the frontend ⇄ backend separation.**

| | |
|---|---|
| **Generated** | 2026-11-08 (dev sandbox snapshot) |
| **Scope** | Every API route under `src/app/api/` |
| **Coverage** | **290 route files → 369 HTTP endpoints** (100% of routes; every exported handler) |
| **Method** | Read-only static audit of handler source — **no project files were modified** |

---

## 0. How to read this document

Routes are grouped **by feature domain** (Auth, Commerce, Affiliates, Commissions, Admin, …), matching the four product surfaces: **Shopper storefront**, **Seller backend**, **Admin backend**, and **Platform/Operations**.

Each endpoint block looks like this:

```
### `METHOD /api/path` — short-name
**File**: src/app/api/.../route.ts · **Auth**: <tier> · **Rate limit**: <name (n/window) or none>
**Purpose**: one line.
**Request**: path params; query params (with defaults); body interface (if any).
**Response 200**: strict TypeScript interface of the actual JSON.
**Errors**: notable non-2xx statuses (HTTP `code` reason).
```

All TypeScript interfaces are **derived from the actual serialization code** (return statements, `ok()`/`okPaged()`/`fail()` calls, Prisma `select` shapes) — not aspirational. Dates are ISO strings, money is integer **minor units** (MYR sen, suffix `Minor`), nullable fields are marked `| null`.

---

## 1. Global Conventions

### 1.1 Response envelope (`src/lib/api.ts`)

| Kind | Shape | Helper |
|---|---|---|
| Single object | `{ "data": T }` | `ok(data)` |
| List / paged | `{ "data": T[], "meta": { page, size, total } }` | `okPaged(data, meta)` |
| Error | `{ "error": { code, message, details? } }` | `fail(...)` / thrown `ApiError` |

- Composite payloads (`{ bucketCounts, orders }`) may ride in `data` with `meta` alongside.
- Production 500s add `error.meta.refId` (correlation id); raw messages stay server-side.
- **Non-envelope responses** (binary/CSV/redirect/webhook-ack) are flagged per-route below.

### 1.2 Pagination

Query params via `getPagination()`: `page` (default **1**), `size` (default **20**, max **100** unless a route clamps lower). Some routes deviate (inline `total/page` inside `data`, cursor pagination, unpaginated lists) — each deviation is flagged.

### 1.3 Authentication tiers (`src/lib/auth.ts`)

One session store; token transported EITHER as httpOnly cookie (`sm_session`) OR `Authorization: Bearer <token>` header. Token is stored sha256-hashed; rotation on refresh.

| Tier | Meaning | Failure codes |
|---|---|---|
| **Public** | No auth | — |
| **Shopper** | `requireShopper()` — buyer account | `401 UNAUTHORIZED` |
| **Seller** | `requireSeller()` — identity tier | `401 UNAUTHORIZED` |
| **Active seller + store** | `requireActiveSellerStore()` — store ops tier | `401` · `403 ACCOUNT_SUSPENDED` / `ACCOUNT_TERMINATED` · `400 NO_STORE` |
| **Admin** | `requireAdmin()` — any admin role | `401 UNAUTHORIZED` · `403 MFA_ENROLLMENT_REQUIRED` (money-capable roles must enroll) |
| **Admin + cap** | `requireCap(...)` / `requireAnyCap(...)` — RBAC (superadmin / ops / finance / moderator) | `403 FORBIDDEN` |
| **Admin (MFA bootstrap)** | `requireAdminUngated()` — MFA routes only | `401` |
| **HMAC / secret** | Webhooks & cron: signed headers (see each route) | `400 BAD_SIGNATURE` · `403 CRON_FORBIDDEN` |

A handful of routes do manual `getSession()` checks with `401 UNAUTHENTICATED` — flagged as deviations.

### 1.4 Rate limiting (`src/lib/rate-limit.ts`)

Fixed-window in-memory limiter (optional Redis store via `RATE_LIMIT_REDIS_URL`). Violations return **429 `RATE_LIMITED`** with retry info in `details`. Limits are noted per route (e.g. `auth-login (10/min/IP + 20/h/email)`).

### 1.5 Money, dates, IDs

- Money: integer **minor units** (`priceMinor`, `totalMinor`, …) = MYR sen. Admin exports convert to RM decimals in CSV only.
- Dates/timestamps: ISO-8601 strings.
- Affiliate rates: integer basis points (`rateBps`, 10000 = 100%).
- Order numbers: `NM-100001`-style via `nextOrderNumber()` counter.

### 1.6 Status-code semantics (house style)

`400 VALIDATION` (bad input) · `401 UNAUTHORIZED/INVALID_CREDENTIALS` · `403 FORBIDDEN` (RBAC) · `404 NOT_FOUND` (or domain codes like `STORE_NOT_FOUND`) · `409 CONFLICT` (state machine / duplicate) · `410 SESSION_EXPIRED` · `429 RATE_LIMITED` · `503` (fail-closed infrastructure: email provider, secrets unset, `CHECKOUT_BUSY` with `Retry-After`).

---

## Table of Contents

- **§2 Authentication & Identity** — login, MFA, registration, email verification, password recovery, OAuth callback (17 endpoints)
- **§3 Platform & Operations** — health, metrics, cron ticks, inbound webhooks (payments/email/shipping), platform terms (27 endpoints)
- **§4 Public Marketplace & Storefront** — market home/search, storefront pages, products, reviews, follows, campaigns, analytics beacons, placeholder images (21 endpoints)
- **§5 Cart & Checkout** — cart CRUD, quotes, address book, order creation, payment status/retry/simulate, guest OTP (17 endpoints)
- **§6 Orders, Receipts & Guest Access** — order lookup, receipts, order OTP (4 endpoints)
- **§7 Shopper Account Hub** — profile, wallet, orders, reviews, vouchers, coins, notifications, activity, recommendations (26 endpoints)
- **§8 Shopper ⇄ Seller Messaging (Chat)** — threads, messages, read state, hub socket auth (14 endpoints)
- **§9 Affiliate Program — Shopper Side** — activation, links, collections, earnings, payouts, network, public showcase (20 endpoints)
- **§10 Seller Backend — Catalog, Content & Imports** — products, variants, categories, collections, coupons, vouchers, campaigns, CMS pages, marketplace imports, inventory (43 endpoints)
- **§11 Seller Backend — Orders & Fulfillment** — order list/detail, fulfill, ship, deliver, AWB labels, refund requests (7 endpoints)
- **§12 Seller Backend — Insights & Analytics** — sales, funnel, products, traffic, markets, cart, campaigns, overview, CSV export (10 endpoints)
- **§13 Seller Backend — Monetization** — wallet, payouts, bank accounts, affiliate program, vouchers panel (11 endpoints)
- **§14 Seller Backend — Store Configuration & Operations** — settings, theme, SEO, card style, domains, webhooks, connections, integrations, dashboard, onboarding, publish (30 endpoints)
- **§15 Admin — Sellers, KYC & Marketplace Moderation** — seller lifecycle, KYC queue, stores, orders, disputes, refunds, product & review moderation (27 endpoints)
- **§16 Admin — Finance** — payouts, batches, commission settings/overrides/holidays/analytics/exports, ledger, wallets, banks, reconciliation (35 endpoints)
- **§17 Admin — Affiliate Program Management** — accounts, commissions, payouts, reconciliation, overview (10 endpoints)
- **§18 Admin — Security (MFA) & Support** — MFA enroll/confirm/disable/status, tickets, announcements (11 endpoints)
- **§19 Admin — Content, Config & Reporting** — banners, categories, coupons, campaigns, featured, home layout, reports, exports, audit/activity logs, webhook deliveries, feature flags, settings, system health, dashboard (39 endpoints)
- **§20 Coverage Census & Maintenance Notes** — endpoint census, contract deviations watch-list, maintenance rule

---

## §2 Authentication & Identity

Multi-portal: admin / seller / shopper accounts live in separate tables; one session store keyed by `userType`.

### `POST /api/auth/login` — legacy portal login
**File**: `src/app/api/auth/login/route.ts` · **Auth**: Public · **Rate limit**: auth-login (10/min/IP) + auth-login-email (20/h/email)
**Purpose**: Credential login for one chosen portal; admin MFA challenge; seller status gates.
**Request**: body:
```ts
interface LoginBody { email?: string; password?: string; portal?: "admin" | "seller" }
```
**Response 200**:
```ts
interface LoginMfaResponse { data: { mfaRequired: true; challenge: string; email: string } }
interface LoginAdminResponse { data: { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; token: string } }
interface LoginSellerResponse { data: { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string | null; storeSlug: string | null; storeName: string | null }; token: string } }
```
**Errors**: `400 VALIDATION` missing email/password · `401 INVALID_CREDENTIALS` bad creds · `403 ACCOUNT_TERMINATED`/`ACCOUNT_SUSPENDED` seller status · `429 RATE_LIMITED` throttle · `429 MFA_ACCOUNT_COOLDOWN` admin MFA lockout

### `POST /api/auth/unified-login` — cross-portal login
**File**: `src/app/api/auth/unified-login/route.ts` · **Auth**: Public · **Rate limit**: auth-login (10/min/IP) + auth-login-email (20/h/email)
**Purpose**: Server resolves account type across admin/seller/shopper tables; ambiguous emails need portal disambiguation.
**Request**: body:
```ts
interface UnifiedLoginBody { email?: string; password?: string; portal?: "admin" | "seller" | "shopper" }
```
**Response 200**:
```ts
interface UnifiedMfaResponse { data: { mfaRequired: true; challenge: string; email: string } }
interface UnifiedAdminResponse { data: { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; token: string } }
interface UnifiedSellerResponse { data: { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string | null; storeSlug: string | null; storeName: string | null }; token: string } }
interface UnifiedShopperResponse { data: { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null }; isAffiliate: boolean; token: string; claimed: { addressesClaimed: number; ordersClaimed: number; skipped?: "email-unverified" }; emailVerified: boolean; guestCartMerged: number } }
```
**Errors**: `400 VALIDATION` missing fields · `401 INVALID_CREDENTIALS` bad creds/portal mismatch · `403 ACCOUNT_TERMINATED`/`ACCOUNT_SUSPENDED` seller status · `409 ACCOUNT_TYPE_AMBIGUOUS` multi-table email (details: `{ types: ("admin"|"seller"|"shopper")[] }`) · `429 RATE_LIMITED` throttle

### `POST /api/auth/logout` — logout
**File**: `src/app/api/auth/logout/route.ts` · **Auth**: Public (revokes presented cookie and/or Bearer session) · **Rate limit**: none
**Purpose**: Destroys presented session(s) and clears session cookie.
**Request**: none.
**Response 200**:
```ts
interface LogoutResponse { data: { loggedOut: true } }
```
**Errors**: none notable

### `GET /api/auth/me` — current identity
**File**: `src/app/api/auth/me/route.ts` · **Auth**: Session (optional; anonymous → `userType: null`) · **Rate limit**: none
**Purpose**: Returns signed-in principal (admin/seller/shopper); admin includes MFA-enrollment gate flag.
**Request**: none.
**Response 200**:
```ts
interface MeAnonymousResponse { data: { userType: null } }
interface MeAdminResponse { data: { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; mfaEnrollmentRequired: boolean } }
interface MeSellerResponse { data: { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string | null; storeSlug: string | null; storeName: string | null } } }
interface MeShopperResponse { data: { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null } } }
```
**Errors**: `401 UNAUTHORIZED` session exists but account missing/inactive

### `POST /api/auth/register` — seller signup
**File**: `src/app/api/auth/register/route.ts` · **Auth**: Public · **Rate limit**: auth-register (5/min/IP)
**Purpose**: Creates seller (status "onboarding"), draft store with default CMS pages, wallet; sends verification code best-effort.
**Request**: body:
```ts
interface RegisterBody { email?: string; password?: string; fullName?: string; displayName?: string; countryCode?: string; storeName?: string; storeSlug?: string; phone?: string }
```
**Response 201**:
```ts
interface RegisterResponse { data: { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string; storeSlug: string; storeName: string }; emailVerified: boolean; emailVerificationSent: boolean; token: string } }
```
**Errors**: `400 VALIDATION` email/password/fullName rules · `409 EMAIL_TAKEN` existing seller · `429 RATE_LIMITED` throttle

### `POST /api/auth/reset-password` — complete password reset
**File**: `src/app/api/auth/reset-password/route.ts` · **Auth**: Public (HMAC "prg:v1:" grant token) · **Rate limit**: auth-password-reset (10/min/IP) + auth-password-reset-email (10/h per grant email)
**Purpose**: Consumes reset grant, sets new shopper password, revokes all sessions.
**Request**: body:
```ts
interface ResetPasswordBody { token?: string; newPassword?: string }
```
**Response 200**:
```ts
interface ResetPasswordResponse { data: { reset: true; message: string } }
```
**Errors**: `400 VALIDATION` password length (8–200) · `401 INVALID_GRANT` bad/expired/replayed/missing account · `429 RATE_LIMITED` throttle

### `POST /api/auth/forgot-password` — request recovery code
**File**: `src/app/api/auth/forgot-password/route.ts` · **Auth**: Public · **Rate limit**: auth-forgot-password (5/min/IP) + auth-forgot-password-email (3/h/email)
**Purpose**: Issues 6-digit password-reset OTP to registered active shopper; uniform response hides account existence.
**Request**: body:
```ts
interface ForgotPasswordBody { email?: string }
```
**Response 200**:
```ts
interface ForgotPasswordResponse { data: { sent: true; message: string } }
```
**Errors**: `400 VALIDATION` invalid email · `503 EMAIL_PROVIDER_NOT_CONFIGURED`/`EMAIL_OTP_UNAVAILABLE` fail-closed pre-flights · `429 RATE_LIMITED` throttle

### `POST /api/auth/verify-recovery` — verify recovery code
**File**: `src/app/api/auth/verify-recovery/route.ts` · **Auth**: Public · **Rate limit**: auth-recovery-verify (10/min/IP) + auth-recovery-verify-email (10/h/email)
**Purpose**: CAS-consumes password-reset OTP; mints 15-minute HMAC reset grant.
**Request**: body:
```ts
interface VerifyRecoveryBody { email?: string; code?: string }
```
**Response 200**:
```ts
interface VerifyRecoveryResponse { data: { token: string; email: string; expiresAt: string } }
```
**Errors**: `401 INVALID` any failure mode (uniform) · `503 EMAIL_OTP_UNAVAILABLE` storage missing · `429 RATE_LIMITED` throttle

### `GET /api/auth/dev-accounts` — dev credentials panel
**File**: `src/app/api/auth/dev-accounts/route.ts` · **Auth**: Public, dev-only dual gate (NODE_ENV=development + NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS=true) · **Rate limit**: none
**Purpose**: Lists seeded sandbox test accounts whose documented passwords still verify.
**Request**: none.
**Response 200**:
```ts
interface DevAccountsResponse { data: { title: string; accounts: { type: "admin" | "seller" | "buyer" | "affiliate"; label: string; email: string; password: string; role: string | null; status: string | null }[] } }
```
**Errors**: `404 NOT_FOUND` outside dev or flag off (indistinguishable from missing route)

### `POST /api/auth/mfa/verify` — admin MFA completion
**File**: `src/app/api/auth/mfa/verify/route.ts` · **Auth**: Public (256-bit challenge token from login) · **Rate limit**: auth-login (10/min/IP)
**Purpose**: Verifies TOTP/recovery code against login challenge; only session-minting path for MFA admins.
**Request**: body:
```ts
interface MfaVerifyBody { challenge?: string; code?: string }
```
**Response 200**:
```ts
interface MfaVerifyResponse { data: { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; token: string } }
```
**Errors**: `400 VALIDATION` missing/invalid shape · `401 MFA_EXPIRED` challenge expired · `401 MFA_INVALID` wrong code (details: `{ attemptsRemaining: number | null }`) · `401 UNAUTHORIZED` admin gone/inactive · `429 MFA_LOCKED` progressive lockout (details: `{ retryAfterSeconds: number }`) · `429 RATE_LIMITED` throttle

### `POST /api/auth/seller/email-verification/request` — seller OTP request
**File**: `src/app/api/auth/seller/email-verification/request/route.ts` · **Auth**: requireSeller() [401] · **Rate limit**: email-verification-request (5/min/IP) + email-verification-account (3/h/account)
**Purpose**: Sends 6-digit code to session seller's own email; idempotent if already verified.
**Request**: none.
**Response 200**:
```ts
interface SellerEvDoneResponse { data: { alreadyVerified: true; sent: false } }
interface SellerEvSentResponse { data: { sent: true; message: string } }
```
**Errors**: `401 UNAUTHORIZED` no seller session · `429 VERIFICATION_CODE_UNAVAILABLE` code not issued · `429 RATE_LIMITED` throttle · `503 EMAIL_PROVIDER_NOT_CONFIGURED`/`EMAIL_OTP_UNAVAILABLE` fail-closed

### `POST /api/auth/seller/email-verification/verify` — seller OTP verify
**File**: `src/app/api/auth/seller/email-verification/verify/route.ts` · **Auth**: requireSeller() [401] · **Rate limit**: email-verification-verify (10/min/IP; 20/h/account)
**Purpose**: CAS-consumes code; sole writer of Seller.emailVerifiedAt (transactional with consume).
**Request**: body:
```ts
interface SellerEvVerifyBody { code?: string }
```
**Response 200**:
```ts
interface SellerEvVerifyResponse { data: { verified: true; alreadyVerified: boolean; emailVerifiedAt: string } }
```
**Errors**: `401 UNAUTHORIZED` no session · `401 INVALID` any code failure (uniform) · `429 RATE_LIMITED` throttle · `503 EMAIL_OTP_UNAVAILABLE`/`SELLER_EMAIL_VERIFICATION_UNAVAILABLE` fail-closed

### `POST /api/auth/shopper/login` — buyer login
**File**: `src/app/api/auth/shopper/login/route.ts` · **Auth**: Public · **Rate limit**: auth-login (10/min/IP) + auth-login-email (20/h/email)
**Purpose**: Shopper credential login; email-ownership-gated guest-order claim plus guest-cart merge.
**Request**: body:
```ts
interface ShopperLoginBody { email?: string; password?: string }
```
**Response 200**:
```ts
interface ShopperLoginResponse { data: { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null }; token: string; claimed: { addressesClaimed: number; ordersClaimed: number; skipped?: "email-unverified" }; emailVerified: boolean; guestCartMerged: number } }
```
**Errors**: `400 VALIDATION` missing fields · `401 INVALID_CREDENTIALS` bad creds · `403 ACCOUNT_SUSPENDED` inactive status · `429 RATE_LIMITED` throttle

### `POST /api/auth/shopper/register` — buyer signup
**File**: `src/app/api/auth/shopper/register/route.ts` · **Auth**: Public · **Rate limit**: auth-register (5/min/IP)
**Purpose**: Creates shopper account; folds guest cart; sends email verification best-effort, never claims orders.
**Request**: body:
```ts
interface ShopperRegisterBody { email?: string; password?: string; fullName?: string; phone?: string }
```
**Response 200**:
```ts
interface ShopperRegisterResponse { data: { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null }; token: string; claimed: { addressesClaimed: number; ordersClaimed: number }; emailVerified: boolean; emailVerificationSent: boolean; guestCartMerged: number } }
```
**Errors**: `400 VALIDATION` email/password/fullName rules · `409 EMAIL_TAKEN` shopper/seller/admin clash · `429 RATE_LIMITED` throttle

### `POST /api/auth/shopper/email-verification/request` — shopper OTP request
**File**: `src/app/api/auth/shopper/email-verification/request/route.ts` · **Auth**: requireShopper() [401] · **Rate limit**: email-verification-request (5/min/IP) + email-verification-account (3/h/account)
**Purpose**: Sends 6-digit code to session shopper's own email; idempotent if already verified.
**Request**: none.
**Response 200**:
```ts
interface ShopperEvDoneResponse { data: { alreadyVerified: true; sent: false } }
interface ShopperEvSentResponse { data: { sent: true; message: string } }
```
**Errors**: `401 UNAUTHORIZED` no shopper session · `429 VERIFICATION_CODE_UNAVAILABLE` code not issued · `429 RATE_LIMITED` throttle · `503 EMAIL_PROVIDER_NOT_CONFIGURED`/`EMAIL_OTP_UNAVAILABLE` fail-closed

### `POST /api/auth/shopper/email-verification/verify` — shopper OTP verify
**File**: `src/app/api/auth/shopper/email-verification/verify/route.ts` · **Auth**: requireShopper() [401] · **Rate limit**: email-verification-verify (10/min/IP; 20/h/account)
**Purpose**: CAS-consumes code; winner claims legacy guest orders exactly once.
**Request**: body:
```ts
interface ShopperEvVerifyBody { code?: string }
```
**Response 200**:
```ts
interface ShopperEvVerifyResponse { data: { verified: true; alreadyVerified: boolean; ordersClaimed: number } }
```
**Errors**: `401 UNAUTHORIZED` no session · `401 INVALID` any code failure (uniform) · `429 RATE_LIMITED` throttle · `503 EMAIL_OTP_UNAVAILABLE` storage missing

### `GET /api/auth/callback/[platform]` — OAuth redirect target
**File**: `src/app/api/auth/callback/[platform]/route.ts` · **Auth**: Public (single-use state nonce; optional seller-session CSRF match) · **Rate limit**: none
**Purpose**: Exchanges Shopee/TikTok Shop OAuth code after fail-closed state validation; redirects with outcome flag.
**Request**: path: `platform: "shopee" | "tiktok"`; query: `code?: string`, `error?: string`, `state?: string`, `shop_id?: string`
**Response 307** **(redirect-only, non-envelope)**:
```ts
type OauthFlag = "invalid_platform" | "denied" | "invalid_state" | "state_platform_mismatch" | "expired_state" | "state_seller_mismatch" | "connected" | "failed";
type CallbackResponse = { status: 307; location: `${string}/?oauth=${OauthFlag}${string}` };
```
**Errors**: no JSON errors — failures surface as `?oauth=failed&reason=` redirect (sanitized + ref id in production)

---

## §3 Platform & Operations

Health/metrics probes, scheduled cron ticks (all cron routes: `x-cron-secret` header, sha256 + timingSafeEqual; production without `CRON_SECRET` → 503 fail-closed; dev-open), and inbound provider webhooks (HMAC-signed).

### `GET /api/metrics` — load-test telemetry
**File**: `src/app/api/metrics/route.ts` · **Auth**: `X-Metrics-Token` header = METRICS_TOKEN (constant-time compare) · **Rate limit**: none
**Purpose**: Bounded process/route/DB performance snapshot; excludes its own traffic.
**Request**: none.
**Response 200** (manual `Response.json({data})`, `Cache-Control: no-store` — envelope-conformant):
```ts
interface MetricsRouteEntry { label: string; count: number; avgMs: number; minMs: number; maxMs: number; p50: number; p90: number; p95: number; p99: number; errors: number; lastErrorAt: string | null; maxInFlight: number; inFlight: number; dbMsTotal: number; dbCountTotal: number; dbAvgMsPerReq: number; byStatus: Record<string, number> }
interface MetricsResponse { data: { ts: string; uptimeSec: number; process: { pid: number; nodeVersion: string; rssMb: number; heapUsedMb: number; heapTotalMb: number; fdCount: number; fdLimit: number }; eventLoopLag: { lastMs: number; p95Ms: number; maxMs: number; samples: number }; memoryTrend: { rssDeltaMb60s: number; samples: number } | null; inFlight: { now: number; max: number }; totals: { requests: number; errors: number; errorRate: number; startedAt: string }; events: { key: string; count: number; lastAt: string }[]; routes: MetricsRouteEntry[]; db: { note: string; aggregates: { key: string; count: number; avgMs: number; maxMs: number; errors: number }[]; slowRing: { model: string; op: string; ms: number; route: string | null; ts: string }[] }; prismaMetrics: { available: true; pool: Record<string, number>; waitP95Ms: number | null; waitMaxMs: number | null } | { available: false; reason: string } } }
```
**Errors**: `401 UNAUTHORIZED` missing/wrong token · `503 METRICS_UNCONFIGURED` METRICS_TOKEN unset · `503 METRICS_UNAVAILABLE` client lacks $metrics

### `GET /api/health` — system heartbeat
**File**: `src/app/api/health/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: DB counts, deployment fingerprint, TTL-cached ledger invariants, checkout-gate gauges.
**Request**: query: `fresh: "1" | null (default null — bypasses 60s invariant cache)`
**Response 200**:
```ts
interface HealthResponse { data: { status: "healthy" | "unhealthy"; db: string; deployment: { nodeEnv: string; dbFingerprint: string }; counts: { stores: number; products: number; orders: number }; ledgerInvariants: { ok: boolean; txnCount: number; walletCount: number; hardProblems: string[]; hardDriftCount: number; timeMaturityStaleness: { count: number; magnitudeMinor: number; note: string } }; checkoutGate: { inflight: number; waiting: number; maxInflight: number; maxWaiting: number; waitMs: number }; invariantCachedAt: string | null; time: string } }
```
**Errors**: none deliberate — ledger problems flip `status` field, not HTTP code

### `GET /api/health/live` — liveness probe
**File**: `src/app/api/health/live/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Process-only liveness (uptime, event-loop lag, memory, FDs); no DB access.
**Request**: none.
**Response 200** (manual `Response.json({data})`, `Cache-Control: no-store`):
```ts
interface HealthLiveResponse { data: { status: "live"; uptimeSec: number; eventLoopLagP95Ms: number; rssMb: number; heapUsedMb: number; fdCount: number; dbQueried: false; time: string } }
```
**Errors**: none

### `GET /api/health/ready` — readiness probe
**File**: `src/app/api/health/ready/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: One `SELECT 1` raced against 1.2s timeout.
**Request**: none.
**Response 200** (manual `Response.json({data})`, `Cache-Control: no-store`):
```ts
interface HealthReadyResponse { data: { status: "ready"; db: "up"; dbProbeMs: number; time: string } }
```
**Errors**: `503 NOT_READY` DB probe failed/timeout — error object deviates: `{ code, message, dbProbeMs: number, meta?: { refId: string } }` (prod-sanitized) **(non-envelope error extras)**

### `GET /api/health/scheduler` — scheduler heartbeat
**File**: `src/app/api/health/scheduler/route.ts` · **Auth**: `x-cron-secret` header (assertCronAuth: secret-required / fail-closed / dev-open) · **Rate limit**: none
**Purpose**: Verdict from durable `cron.*` Setting rows; expiry-sweep age decides healthy vs stale.
**Request**: none.
**Response 200**:
```ts
interface SchedulerRail { key: string; ageSeconds: number | null; verdict: "fresh" | "stale" | "missing"; note: string; recordedAt: string | null; cadenceSec: number; outcome: Record<string, unknown> | null }
interface SchedulerResponse { data: { status: "healthy" | "stale"; expirySweep: { key: string; ageSeconds: number | null; healthyWithinSec: number; verdict: "fresh" | "stale" | "missing" }; staleRails: string[]; freshestAgeSeconds: number | null; evaluatedAt: string; cadenceBaseSec: number; staleFactor: number; auth: "secret-required" | "fail-closed" | "dev-open"; rails: SchedulerRail[]; schedulingNote: string; monitoringHint: string } }
```
**Errors**: `403 CRON_FORBIDDEN` wrong/missing secret · `503 CRON_NOT_CONFIGURED` prod without CRON_SECRET · `503 SCHEDULER_DB_UNREACHABLE` Setting read failed · `503 SCHEDULER_STALE` expiry sweep missing/old (details = full payload above)

### `GET /api/platform/terms` — public platform terms
**File**: `src/app/api/platform/terms/route.ts` · **Auth**: Public · **Rate limit**: platform-terms (120/min/IP)
**Purpose**: Global business-policy terms for pre-auth seller portal (60s TTL cache).
**Request**: none.
**Response 200**:
```ts
interface PlatformTermsResponse { data: { commissionPercent: number; commissionSource: "global_default"; fixedFeeMinor: number; hasFixedFee: boolean; minCommissionMinor: number; hasMinCommission: boolean; holdDays: number; holdSource: "global_default"; payoutMinMinor: number; moderationFirstN: number } }
```
**Errors**: `429 RATE_LIMITED` throttle

### `GET /api/settings/site` — site appearance settings
**File**: `src/app/api/settings/site/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Public chrome setting: footer visibility from Setting key `ui.footer_visible`.
**Request**: none.
**Response 200**:
```ts
interface SiteSettingsResponse { data: { footerVisible: boolean } }
```
**Errors**: none notable

### `POST /api/orders/expiry/tick` — expiry-sweep tick (manual trigger)
**File**: `src/app/api/orders/expiry/tick/route.ts` · **Auth**: Cron — `x-cron-secret` header, timing-safe compare; dev-open outside production · **Rate limit**: in-process 1.5s throttle (returns throttled payload, not 429)
**Purpose**: Sweeps expired unpaid reservations: expires groups/orders, restocks, restores redemptions.
**Request**: none.
**Response 200** (group-stat fields present only when `throttled:false`):
```ts
interface ExpiryTickResponse { data: { examined?: number; expired?: number; ordersExpired?: number; itemsRestocked?: number; skippedConcurrent?: number; anomalies?: number; failures?: number; vouchersRestored?: number; couponsRestored?: number; scanned: number; released: number; skipped: number; errors: { orderId: string; error: string }[]; throttled: boolean; auth: "secret-required" | "fail-closed" | "dev-open" } }
```
**Errors**: `403 CRON_FORBIDDEN` wrong/missing secret · `503 CRON_NOT_CONFIGURED` production without CRON_SECRET

### `POST /api/cron/session-purge` — expired-session purge tick
**File**: `src/app/api/cron/session-purge/route.ts` · **Auth**: cron-secret (`x-cron-secret`) · **Rate limit**: none (in-process throttle 10 min)
**Purpose**: Delete expired Sessions and unverified expired EmailOtpChallenges (guest-order); records outcome in Setting `cron.session_purge.last`.
**Request**: none.
**Response 200**:
```ts
interface SessionPurgeResponse { data: { purged: number; otpChallengesPurged: number; durationMs: number; at: string; auth: "secret-required" | "fail-closed" | "dev-open" } | { throttled: true; purged: 0; auth: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` prod w/o secret · `403 CRON_FORBIDDEN` bad secret

### `GET /api/cron/session-purge` — purge observability
**File**: `src/app/api/cron/session-purge/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Expired-session backlog and last recorded purge outcome without triggering a purge.
**Request**: none.
**Response 200**:
```ts
interface SessionPurgeStatusResponse { data: { expiredBacklog: number; lastRun: { purged: number; otpChallengesPurged: number; durationMs: number; at: string; auth: string } | null; auth: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `POST /api/cron/expiry-sweep` — payment-window expiry tick
**File**: `src/app/api/cron/expiry-sweep/route.ts` · **Auth**: cron-secret (`x-cron-secret`, timing-safe; fail-closed in prod) · **Rate limit**: none (in-process throttle 1.5 s)
**Purpose**: Expire unpaid PaymentGroups + legacy single-intent orders via shared `runExpirySweep`; restock, restore redemptions, bust cache; records Setting `cron.expiry_sweep.last`.
**Request**: none.
**Response 200**:
```ts
interface ExpirySweepOutcome { examined: number; expired: number; ordersExpired: number; itemsRestocked: number; skippedConcurrent: number; anomalies: number; failures: number; vouchersRestored: number; couponsRestored: number; scanned: number; released: number; skipped: number; errors: { orderId: string; error: string }[]; throttled: boolean; remainingBacklog: number; durationMs: number; at: string; auth: string }
interface ExpirySweepResponse { data: ExpirySweepOutcome | { throttled: true; expired: 0; auth: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `GET /api/cron/expiry-sweep` — expiry observability
**File**: `src/app/api/cron/expiry-sweep/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Backlog count, oldest expired group and last-run outcome without sweeping.
**Request**: none.
**Response 200**:
```ts
interface ExpirySweepStatusResponse { data: { backlog: number; oldestExpiredAt: string | null; lastRun: ExpirySweepOutcome | null; auth: string; schedulingNote: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `POST /api/cron/refund-reconcile` — late-payment refund tick
**File**: `src/app/api/cron/refund-reconcile/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Process PaymentReconciliation refund obligations (batch 25): idempotent provider refunds with durable attempt intents, bounded retries; records Setting `cron.refund_reconcile.last`.
**Request**: none.
**Response 200**:
```ts
interface RefundReconcileResponse { data: { examined: number; attempted: number; succeeded: number; failed: number; unknown: number; skippedNoAdapter: number; skippedSandboxDisabled: number; skippedBackoff: number; skippedExhausted: number; transientErrors: number; faultsApplied: number; at: string; durationMs: number; backoffMs: number; maxAttempts: number; batchLimit: number; auth: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `GET /api/cron/refund-reconcile` — reconcile observability
**File**: `src/app/api/cron/refund-reconcile/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Reconciliation case counts by status, oldest open case, operator-awaiting cases, last run.
**Request**: none.
**Response 200**:
```ts
interface RefundReconcileStatusResponse { data: { counts: Record<string, number>; oldestOpenCase: { createdAt: string; provider: string } | null; awaitingOperator: number; lastRun: { examined: number; attempted: number; succeeded: number; failed: number; unknown: number; skippedNoAdapter: number; skippedSandboxDisabled: number; skippedBackoff: number; skippedExhausted: number; transientErrors: number; faultsApplied: number; at: string; durationMs: number; backoffMs: number; maxAttempts: number; batchLimit: number; auth: string } | null; auth: string; statuses: string[] } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `POST /api/cron/order-maintenance` — order lifecycle tick
**File**: `src/app/api/cron/order-maintenance/route.ts` · **Auth**: cron-secret · **Rate limit**: none (in-process throttle 20 s)
**Purpose**: Auto-receipt (delivered+14d), auto-complete (received+30d), advance mock shipments (45 s idle guard); records Setting `cron.orders.last`.
**Request**: none.
**Response 200**:
```ts
interface OrderMaintenanceOutcome { ranAt: string; durationMs: number; autoReceipt: { candidates: number; received: number; cutoff: string }; autoComplete: { candidates: number; completed: number; cutoff: string }; tracking: { scanned: number; advanced: number }; errors: string[]; auth: string }
interface OrderMaintenanceResponse { data: OrderMaintenanceOutcome | { throttled: true; skippedForMs: number; auth: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `GET /api/cron/order-maintenance` — maintenance observability
**File**: `src/app/api/cron/order-maintenance/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Backlogs for auto-receipt/auto-complete and in-flight mock shipments plus last run.
**Request**: none.
**Response 200**:
```ts
interface OrderMaintenanceStatusResponse { data: { lastRun: OrderMaintenanceOutcome | null; autoReceiptBacklog: number; autoCompleteBacklog: number; inflightMockShipments: number } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `POST /api/cron/affiliate-tick` — commission lifecycle tick
**File**: `src/app/api/cron/affiliate-tick/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Approve pending commissions on delivered/received/completed orders; mature approved entries past review window; records Setting `cron.affiliate.last`.
**Request**: none.
**Response 200**:
```ts
interface AffiliateTickResponse { data: { approved: number; matured: number; remainingPending: number; durationMs: number; at: string; authMode: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `GET /api/cron/affiliate-tick` — affiliate tick observability
**File**: `src/app/api/cron/affiliate-tick/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Last recorded affiliate lifecycle tick outcome.
**Request**: none.
**Response 200**:
```ts
interface AffiliateTickStatusResponse { data: { last: { approved: number; matured: number; remainingPending: number; durationMs: number; at: string; authMode: string } | null } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `POST /api/cron/webhook-delivery` — webhook retry tick
**File**: `src/app/api/cron/webhook-delivery/route.ts` · **Auth**: cron-secret · **Rate limit**: none (in-process throttle 5 s)
**Purpose**: Retry pending seller webhook deliveries on backoff schedule until 2xx or attempt budget exhausted; records Setting `cron.webhook_delivery.last`.
**Request**: none.
**Response 200**:
```ts
interface WebhookSweepOutcome { scanned: number; attempted: number; succeeded: number; retried: number; failedFinal: number; skippedNotDue: number; skippedInactive: number; skippedOther: number; unsubscribedFailed: number; staleFailed: number; errors: number; remainingBacklog: number | null; durationMs: number; at: string; schedule: string }
interface WebhookDeliverySweepResponse { data: WebhookSweepOutcome | { throttled: true; attempted: 0; auth: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `GET /api/cron/webhook-delivery` — webhook observability
**File**: `src/app/api/cron/webhook-delivery/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Pending backlog, due-now approximation, oldest pending delivery, last run, receiver signing contract.
**Request**: none.
**Response 200**:
```ts
interface WebhookDeliveryStatusResponse { data: { backlog: number | null; dueNowApprox: number | null; oldestPending: { createdAt: string; event: string; attempts: number } | null; lastRun: WebhookSweepOutcome | null; auth: string; schedulingNote: string; receiverContract: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `POST /api/cron/analytics-tick` — analytics retention tick
**File**: `src/app/api/cron/analytics-tick/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Flush in-memory analytics queue then purge browsing/cart events older than retention (≤20k rows/tick); records Setting `cron.analytics.last`.
**Request**: none.
**Response 200**:
```ts
interface AnalyticsTickResponse { data: { ranAt: string; durationMs: number; retentionDays: number; cutoff: string; purged: number; flush: { flushed: number; pending: number }; remaining: number; oldestEventAt: string | null; auth: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `GET /api/cron/analytics-tick` — analytics observability
**File**: `src/app/api/cron/analytics-tick/route.ts` · **Auth**: cron-secret · **Rate limit**: none
**Purpose**: Event totals by type, oldest event, retention setting, queue stats, last run.
**Request**: none.
**Response 200**:
```ts
interface AnalyticsTickStatusResponse { data: { total: number; byType: Record<string, number>; oldestEventAt: string | null; retentionDays: number; queue: { pending: number; dropped: number; flushed: number; lastFlushAt: string | null; lastError: string | null; lastErrorAt: string | null }; lastRun: { ranAt: string; durationMs: number; retentionDays: number; cutoff: string; purged: number; flush: { flushed: number; pending: number }; remaining: number; oldestEventAt: string | null; auth: string } | null; auth: string } }
```
**Errors**: `503 CRON_NOT_CONFIGURED` · `403 CRON_FORBIDDEN`

### `POST /api/webhooks/payments/[provider]` — payment webhook
**File**: `src/app/api/webhooks/payments/[provider]/route.ts` · **Auth**: HMAC — `X-SM-Signature` header (or body `sig`) = HMAC-SHA256 hex of `"<providerRef>.<eventType>.<amountMinor>.<ts>"` keyed by PSP_WEBHOOK_SECRET; ±10-min freshness · **Rate limit**: per-IP+path (60/60s; env `WEBHOOK_RATE_LIMIT_PER_MIN`)
**Purpose**: Ingests provider payment/payout events; claim-first idempotent money movement.
**Request**: path: `provider: string`; body:
```ts
interface PaymentWebhookBody { providerRef: string; eventType: "payment.succeeded" | "payment.failed" | "payout.succeeded" | "payout.failed"; amountMinor: number; ts: number; sig?: string; reason?: string }
```
**Response 200**:
```ts
interface PaymentWebhookResponse { data: { ok: boolean; duplicate: boolean; orderNumber: string; orderStatus: string } }
```
**Errors**: `400 BAD_REQUEST`/`BAD_SIGNATURE`/`STALE_EVENT`/`UNKNOWN_EVENT` · `403 PROVIDER_SANDBOX_ONLY` · `404 INTENT_NOT_FOUND`/`PAYOUT_NOT_FOUND` · `409 AMOUNT_MISMATCH`/`GROUP_EXPIRED`/`ORDER_EXPIRED` · `429 RATE_LIMITED` · `503 WEBHOOK_SECRET_UNSET`

### `POST /api/webhooks/payments/payout-simulate` — payout simulate (sandbox)
**File**: `src/app/api/webhooks/payments/payout-simulate/route.ts` · **Auth**: Public sandbox mock (404 in production unless Setting `psp.mock.enabled=true`; server self-signs HMAC) · **Rate limit**: per-IP+path (10/60s)
**Purpose**: Emits the signed payout.succeeded/failed event through the webhook pipeline.
**Request**: body:
```ts
interface PayoutSimulateBody { referenceNo: string; result?: "succeeded" | "failed"; reason?: string }
```
**Response 200**:
```ts
interface PayoutSimulateResponse { data: { ok: boolean; duplicate: boolean; eventType: string; orderNumber: string; orderStatus: string; intentStatus: string; orderNumbers?: string[]; isGroup?: boolean; payoutConflict?: boolean; referenceNo: string; payoutStatus: string } }
```
**Errors**: `429 RATE_LIMITED` · `404 NOT_FOUND` prod gate / unknown payout · `400 VALIDATION` · processor: `409 AMOUNT_MISMATCH`, `404 PAYOUT_NOT_FOUND`/`NOT_FOUND`, `503 WEBHOOK_SECRET_UNSET`

### `POST /api/webhooks/email/resend` — Resend email webhook
**File**: `src/app/api/webhooks/email/resend/route.ts` · **Auth**: HMAC — Svix scheme: `svix-id`, `svix-timestamp`, `svix-signature` headers over RAW body, HMAC-SHA256 with RESEND_WEBHOOK_SECRET; ±5-min replay window · **Rate limit**: none
**Purpose**: Ingests Resend delivery events; suppresses bounces/complaints; exactly-once by svix-id.
**Request**: body:
```ts
interface ResendEventBody { type?: string; created_at?: string; data?: { email_id?: string; email?: string; to?: string[]; subject?: string; bounce?: { type?: string } } }
```
**Response 200**:
```ts
interface ResendWebhookResponse { data: { received: boolean; duplicate: boolean; eventType: string } }
```
**Errors**: `400 BAD_SIGNATURE` missing/invalid svix headers · `400 STALE_EVENT` · `400 BAD_PAYLOAD` · `503 EMAIL_WEBHOOK_SECRET_UNSET` production without secret

### `POST /api/shipping/tick` — shipping tick (sandbox)
**File**: `src/app/api/shipping/tick/route.ts` · **Auth**: Public (intentionally unauthenticated sandbox sweep) · **Rate limit**: in-process 1.5s throttle (throttled payload, not 429)
**Purpose**: Advances every active mock shipment one realistic step.
**Request**: none.
**Response 200**:
```ts
interface ShippingTickResponse { data: { advanced: number; throttled: boolean; results: { shipmentId: string; orderId: string; awbNumber: string | null; status: string }[] } }
```
**Errors**: none notable (`500 INTERNAL` on failure)

### `POST /api/shipping/webhook/[provider]` — courier tracking webhook
**File**: `src/app/api/shipping/webhook/[provider]/route.ts` · **Auth**: HMAC — `x-shipping-signature` header (or body `sig`) = HMAC-SHA256 hex of `"<awb>.<status>.<ts>"` keyed by SHIPPING_WEBHOOK_SECRET; ±10-min freshness · **Rate limit**: shipping-webhook (60/min/IP)
**Purpose**: Ingests courier tracking events; updates shipment, order, delivery side effects.
**Request**: path: `provider: string`; body (status: BOOKED|PICKED_UP|IN_TRANSIT|OUT_FOR_DELIVERY|DELIVERED|EXCEPTION|RETURNED):
```ts
interface ShippingWebhookBody { event?: string; awb?: string; trackingNumber?: string; orderNumber?: string; status: string; description?: string; location?: string; occurredAt?: string; ts: number; sig?: string }
```
**Response 200**:
```ts
interface ShippingWebhookResponse { data: { orderNumber: string; shipmentStatus: string; ignored?: boolean } }
```
**Errors**: `400 VALIDATION` · `400 BAD_SIGNATURE` · `400 STALE_EVENT` · `503 SHIPPING_SECRET_UNSET` production without secret · `404 NOT_FOUND` no matching shipment

---

## §4 Public Marketplace & Storefront

Public discovery surfaces: marketplace home/search, per-store storefront (`/sf/{slug}`), PDPs, reviews, follows, campaign placements, analytics beacons, and the seeded placeholder image service.

### `GET /api/sf/app-config` — platform chrome config
**File**: `src/app/api/sf/app-config/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Lightweight shopper-app chrome config; exposes global footer visibility setting.
**Request**: path: —; query: none
**Response 200**:
```ts
interface AppConfigResponse { data: { footerVisible: boolean } }
```
**Errors**: none (DB miss/failure degrades to default `true`)

### `GET /api/sf/[slug]` — storefront home
**File**: `src/app/api/sf/[slug]/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Published storefront home: store profile, theme, system-assembled sections, followers.
**Request**: path: `slug: string`; query: none
**Response 200**:
```ts
interface Section { id: string; type: string; props: Record<string, unknown> }
interface Theme { primaryColor: string; accentColor: string; fontHeading: string; fontBody: string; radius: string; buttonStyle: string }
interface CardStyle { nameFont: string; nameSize: string; nameAlign: string; priceFont: string; priceSize: string; priceAlign: string }
interface SfHomeResponse { data: {
  store: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; bannerUrl: string | null; description: string | null; theme: Theme; whatsapp: string | null; supportEmail: string | null; supportPhone: string | null; social: Record<string, string>; followers: number; cardStyle: CardStyle | null; display: { showStars: boolean; metric: string }; categories: { id: string; name: string; sortOrder: number }[] };
  page: { id: string; title: string; slug: string; sections: Section[]; publishedVersion: number };
} }
```
**Errors**: `404 STORE_NOT_FOUND` non-live store or inactive seller · `404 STORE_NOT_PUBLISHED` no published home page

### `GET /api/sf/[slug]/cart-settings` — cart drawer config
**File**: `src/app/api/sf/[slug]/cart-settings/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Store's cart drawer configuration plus resolved upsell and best-seller product cards.
**Request**: path: `slug: string`; query: none
**Response 200**:
```ts
interface Theme { primaryColor: string; accentColor: string; fontHeading: string; fontBody: string; radius: string; buttonStyle: string }
interface UpsellCard { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; viewCount: number; salesCount: number; categoryName: string | null; stock: number }
interface CartSettingsDTO { layout: string; showFreeShippingBar: boolean; freeShipThresholdMinor: number; upsellEnabled: boolean; upsellMode: string; upsellTitle: string; upsellLimit: number; urgencyStockEnabled: boolean; urgencyStockThreshold: number; urgencyViewersEnabled: boolean; urgencyViewersMin: number; urgencyViewersMax: number; urgencyCountdownEnabled: boolean; urgencyCountdownMinutes: number; showOrderNote: boolean; showDiscountHint: boolean; checkoutLabel: string; showContinueShopping: boolean; stickyCta: boolean; trustBadges: string[] }
interface CartSettingsResponse { data: { store: { id: string; name: string; slug: string; theme: Theme }; settings: CartSettingsDTO | null; upsell: UpsellCard[]; bestSellers: UpsellCard[] } }
```
**Errors**: `404 STORE_NOT_FOUND` non-live store or inactive seller

### `POST /api/sf/[slug]/newsletter` — newsletter subscribe
**File**: `src/app/api/sf/[slug]/newsletter/route.ts` · **Auth**: Public · **Rate limit**: sf-newsletter (5/min/IP) + sf-newsletter-email (3/1h/email)
**Purpose**: Store newsletter subscription with duplicate guard and notification/activity logging.
**Request**: path: `slug: string`; body:
```ts
interface NewsletterBody { email: string }
```
**Response 200**:
```ts
interface NewsletterResponse { data: { subscribed: boolean } }
```
**Errors**: `400 VALIDATION` missing/invalid/over-length email · `404 STORE_NOT_FOUND` non-live store or inactive seller · `429 RATE_LIMITED` burst or per-email throttle

### `GET /api/sf/[slug]/pages/[pageSlug]` — published CMS page
**File**: `src/app/api/sf/[slug]/pages/[pageSlug]/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Published CMS page (about/contact/policies) with store header info.
**Request**: path: `slug: string`, `pageSlug: string`; query: none
**Response 200**:
```ts
interface Section { id: string; type: string; props: Record<string, unknown> }
interface Theme { primaryColor: string; accentColor: string; fontHeading: string; fontBody: string; radius: string; buttonStyle: string }
interface SfPageResponse { data: {
  store: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; whatsapp: string | null; supportEmail: string | null; theme: Theme; cardStyle: { nameFont: string; nameSize: string; nameAlign: string; priceFont: string; priceSize: string; priceAlign: string } | null };
  page: { id: string; title: string; slug: string; pageType: string; publishedVersion: number };
  sections: Section[];
} }
```
**Errors**: `404 STORE_NOT_FOUND` non-live store or inactive seller · `404 PAGE_NOT_PUBLISHED` page missing or unpublished

### `GET /api/sf/[slug]/products` — storefront product listing
**File**: `src/app/api/sf/[slug]/products/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Storefront catalogue cards: tokenized search, collection/featured source, store-category filter.
**Request**: path: `slug: string`; query: `search: string ("", ≤80 chars)`, `collection: string ("")`, `source: "latest"|"featured" (latest)`, `category: string ("", StoreCategory id)`, `limit: number (8, 1–50)`
**Response 200**:
```ts
interface ProductCard { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; viewCount: number; salesCount: number; categoryName: string | null }
interface SfProductsResponse { data: ProductCard[] }
```
**Errors**: `404 STORE_NOT_FOUND` non-live store or inactive seller · note: list without `meta` (fixed-window, deviation from paged envelope)

### `GET /api/sf/[slug]/products/[pSlug]` — product detail (PDP)
**File**: `src/app/api/sf/[slug]/products/[pSlug]/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Full PDP payload: product, published reviews, related cards, store header; increments viewCount.
**Request**: path: `slug: string`, `pSlug: string`; query: none
**Response 200**:
```ts
interface ProductCard { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; viewCount: number; salesCount: number; categoryName: string | null }
interface PdpVariant { id: string; name: string; optionName: string | null; optionValue: string | null; priceMinor: number; compareAtPriceMinor: number | null; stock: number; moq: number; sku: string | null; isActive: boolean; imageUrl: string | null; lowStockThreshold: number }
interface PdpResponse { data: {
  product: { id: string; title: string; slug: string; description: string | null; priceMinor: number; compareAtPriceMinor: number | null; ratingAvg: number; ratingCount: number; salesCount: number; viewCount: number; categoryId: string | null; categoryName: string | null; images: string[]; ratingDist: number[]; variants: PdpVariant[] };
  reviews: { id: string; orderId: string | null; customerName: string; rating: number; title: string | null; body: string | null; reply: string | null; createdAt: string }[];
  related: ProductCard[];
  store: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; whatsapp: string | null; cardStyle: { nameFont: string; nameSize: string; nameAlign: string; priceFont: string; priceSize: string; priceAlign: string } | null };
} }
```
**Errors**: `404 STORE_NOT_FOUND` non-live store or inactive seller · `404 PRODUCT_NOT_FOUND` missing/inactive product

### `GET /api/sf/[slug]/products/[pSlug]/reviews` — reviews listing
**File**: `src/app/api/sf/[slug]/products/[pSlug]/reviews/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Published-only reviews with star filter, sorting, server-side pagination.
**Request**: path: `slug: string`, `pSlug: string`; query: `star: "1"|"2"|"3"|"4"|"5" (absent)`, `sort: "recent"|"highest"|"lowest" (recent)`, `page: number (1)`, `size: number (10, 1–50)` — size defaults deviate from global 20/100
**Response 200**:
```ts
interface ReviewsListResponse { data: { reviews: { id: string; orderId: string | null; customerName: string; rating: number; title: string | null; body: string | null; reply: string | null; createdAt: string }[] }; meta: { page: number; size: number; total: number } }
```
**Errors**: `400 VALIDATION` bad star/sort · `404 STORE_NOT_FOUND` non-live store or inactive seller · `404 PRODUCT_NOT_FOUND` unknown product

### `POST /api/sf/[slug]/products/[pSlug]/reviews` — review submission
**File**: `src/app/api/sf/[slug]/products/[pSlug]/reviews/route.ts` · **Auth**: requireShopper · **Rate limit**: sf-review-v2 (10/10s/IP) + sf-review-acct-v2 (3/5s/account) + sf-review-product-v2 (10/5s/product)
**Purpose**: Verified-purchase review submission with atomic membership-reward credit.
**Request**: path: `slug: string`, `pSlug: string`; body:
```ts
interface ReviewSubmitBody { rating: number; customerName?: string; title?: string | null; body?: string | null }
```
**Response 201**:
```ts
interface ReviewSubmitResponse { data: { id: string; status: string; orderCompleted: boolean; reward: { credited: boolean; points: number; minorEquivalent: number }; message: string } }
```
**Errors**: `401 UNAUTHORIZED` not signed in · `503 REVIEWS_NOT_MIGRATED` pre-migration · `404 STORE_NOT_FOUND`/`404 PRODUCT_NOT_FOUND` · `403 SELLER_SELF_REVIEW` · `403 VERIFIED_PURCHASE_REQUIRED` no eligible order · `409 REVIEW_ALREADY_EXISTS` · `400 VALIDATION`/`400 UNSAFE_CONTENT` · `429 RATE_LIMITED`

### `GET /api/sf/[slug]/products/[pSlug]/reviews/eligibility` — review eligibility probe
**File**: `src/app/api/sf/[slug]/products/[pSlug]/reviews/eligibility/route.ts` · **Auth**: requireShopper · **Rate limit**: none
**Purpose**: Signed-in shopper's review affordance state for one product (CTA driver).
**Request**: path: `slug: string`, `pSlug: string`; query: none
**Response 200**:
```ts
interface EligibilityResponse { data: { eligible: boolean; reason: "already_reviewed" | "own_product" | "ok" | "no_eligible_order"; review?: { id: string; status: string; rating: number } } }
```
**Errors**: `401 ANONYMOUS` not signed in · `503 REVIEWS_NOT_MIGRATED` pre-migration · `404 STORE_NOT_FOUND`/`404 PRODUCT_NOT_FOUND`

### `GET /api/market/home` — marketplace landing aggregate
**File**: `src/app/api/market/home/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Public marketplace landing payload: banners, categories, product shelves, campaign placements.
**Request**: path: —; query: none
**Response 200**:
```ts
interface ProductCard { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; viewCount: number; salesCount: number; categoryName: string | null }
interface Cta { kind: "search" | "category" | "store" | "deals" | "vouchers" | "external"; q?: string; slug?: string; url?: string }
interface Theme { accent: string; accentSoft: string; gradientFrom: string; gradientTo: string; greeting: string; greetingBm: string; tagline: string; taglineBm: string; ornament: string }
interface MarketHomeResponse { data: {
  banners: { id: string; title: string; imageUrl: string; linkUrl: string | null }[];
  categories: { id: string; name: string; slug: string; imageUrl: string | null; children: { id: string; name: string; slug: string }[] }[];
  featured: ProductCard[]; latest: ProductCard[]; trending: ProductCard[]; featuredStores: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; bannerUrl: string | null; productCount: number }[];
  sectionOrder: ("hero" | "quick_access" | "showcase" | "flash_deals" | "categories" | "trending" | "featured" | "stores" | "new_arrivals" | "inline")[];
  hero: { id: string; kind: "campaign" | "banner"; name: string; description: string | null; ctaLabel: string; cta: Cta | null; endsAt: string; title: string; subtext: string | null; imageUrl: string | null; mobileImageUrl: string | null; theme: Theme | null }[];
  heroSecondary: { id: string; name: string; description: string | null; ctaLabel: string; cta: Cta | null; endsAt: string; heading: string; subtext: string | null; imageUrl: string | null; mobileImageUrl: string | null; theme: Theme }[];
  promoTiles: { id: string; name: string; theme: Theme; cta: Cta | null }[]; showcase: { id: string; name: string; description: string | null; ctaLabel: string; cta: Cta | null; endsAt: string; thumbnailUrl: string | null; theme: Theme }[];
  inline: { id: string; name: string; description: string | null; ctaLabel: string; cta: Cta | null; endsAt: string; heading: string; subtext: string | null; bannerDesktopUrl: string | null; bannerMobileUrl: string | null; productQuery: string | null; products: ProductCard[]; theme: Theme }[];
  flashDeals: { products: ProductCard[]; campaign: { id: string; name: string; endAt: string } | null };
} }
```
**Errors**: none notable

### `GET /api/market/products` — marketplace product listing
**File**: `src/app/api/market/products/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Public market listing: tokenized search, category tree filter, deterministic sorts, pagination.
**Request**: path: —; query: `search: string ("", ≤80 chars)`, `category: string ("")`, `sort: "relevance"|"newest"|"price_asc"|"price_desc"|"popular" (newest)`, `page: number (1)`, `size: number (20, max 100)`, `onSale: "1"|"true" (false)`
**Response 200**:
```ts
interface ProductCard { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; viewCount: number; salesCount: number; categoryName: string | null }
interface MarketProductsResponse { data: ProductCard[]; meta: { page: number; size: number; total: number } }
```
**Errors**: none notable (unknown category slug yields empty list; relevance mode caps `total` at 200)

### `GET /api/market/stores` — store directory
**File**: `src/app/api/market/stores/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Public directory of live stores of admin-approved sellers with active product counts.
**Request**: path: —; query: none
**Response 200**:
```ts
interface MarketStoresResponse { data: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; bannerUrl: string | null; productCount: number }[] }
```
**Errors**: none notable · note: unpaginated full list without `meta` (deviation from paged envelope)

### `GET /api/market/search/suggest` — search autocomplete
**File**: `src/app/api/market/search/suggest/route.ts` · **Auth**: Public · **Rate limit**: market-suggest (30/min/IP)
**Purpose**: Header autocomplete: relevance-ranked product cards plus matching live stores.
**Request**: path: —; query: `q: string ("", ≤80 chars; empty short-circuits)`
**Response 200**:
```ts
interface ProductCard { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; viewCount: number; salesCount: number; categoryName: string | null }
interface SuggestResponse { data: { products: ProductCard[]; stores: { name: string; slug: string; logoUrl: string }[] } }
```
**Errors**: `429 RATE_LIMITED` over 30/min/IP

### `GET /api/market/search/related` — related products
**File**: `src/app/api/market/search/related/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Products similar to searched one; bestseller/newest fallback keeps rail non-empty.
**Request**: path: —; query: `q: string ("")`, `exclude: string (comma-separated product ids, "")`, `limit: number (8, 1–12)`
**Response 200**:
```ts
interface ProductCard { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; viewCount: number; salesCount: number; categoryName: string | null }
interface RelatedResponse { data: { products: ProductCard[] } }
```
**Errors**: none notable

### `GET /api/img/[seed]` — deterministic SVG placeholder
**File**: `src/app/api/img/[seed]/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Deterministic seeded SVG placeholder image; branded product-glyph tile variant.
**Request**: path: `seed: string`; query: `w: number (800, 40–2400)`, `h: number (600, 40–2400)`, `label: string (seed with -/_ → spaces)`, `icon: string ("product" → glyph tile)`
**Response 200** **(non-envelope)**: `Content-Type: image/svg+xml`; body is an SVG document (string): gradient tile with two initials + label, or neutral shopping-bag glyph when `icon=product`; `Cache-Control: public, max-age=31536000, immutable`
**Errors**: none (always 200; raw handler, not wrapped in `handle()`)

### `GET /api/campaigns/active` — active campaign
**File**: `src/app/api/campaigns/active/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Single highest-priority live published campaign, or null when none running.
**Request**: path: —; query: none
**Response 200**:
```ts
interface ActiveCampaignResponse { data: { id: string; name: string; presetId: string | null; isPublished: boolean; placement: "hero" | "hero_secondary" | "promo_tile" | "showcase" | "inline"; startAt: string; endAt: string; theme: { accent: string; accentSoft: string; gradientFrom: string; gradientTo: string; greeting: string; greetingBm: string; tagline: string; taglineBm: string; ornament: string }; daysLeft: number } | null }
```
**Errors**: none notable

### `POST /api/analytics/pdp-event` — PDP event beacon
**File**: `src/app/api/analytics/pdp-event/route.ts` · **Auth**: optional-shopper (session enriches shopperId) · **Rate limit**: pdp-event (120/min/IP)
**Purpose**: Guest-safe PDP conversion-funnel micro-event beacon; never errors on bad payloads.
**Request**: path: —; body:
```ts
interface PdpEventBody { eventType: string; storeId: string; productId?: string | null; variantId?: string | null; qty?: number | null }
```
**Response 200**:
```ts
interface PdpEventResponse { data: { recorded: boolean } }
```
**Errors**: `429 RATE_LIMITED` over 120/min/IP (unknown eventType/missing storeId → `recorded: false`)

### `POST /api/analytics/landing` — attribution beacon
**File**: `src/app/api/analytics/landing/route.ts` · **Auth**: Public · **Rate limit**: analytics-landing (30/min/IP)
**Purpose**: Same-origin landing attribution capture: validates UTMs/nmcl token, writes httpOnly cookie.
**Request**: path: —; body:
```ts
interface LandingBody { utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; utm_content?: string; nmcl?: string; sf?: string }
```
**Response 200**:
```ts
interface LandingResponse { data: { captured: boolean } }
```
**Errors**: `429 RATE_LIMITED` over 30/min/IP (no valid params → idempotent `captured: false`)

### `GET /api/stores/[slug]/follow` — follow state
**File**: `src/app/api/stores/[slug]/follow/route.ts` · **Auth**: requireShopper · **Rate limit**: none
**Purpose**: Signed-in shopper's following state and the store's total follower count.
**Request**: path: `slug: string`; query: none
**Response 200**:
```ts
interface FollowResponse { data: { following: boolean; followers: number } }
```
**Errors**: `401 UNAUTHORIZED` shopper login required · `404 STORE_NOT_FOUND` unknown slug

### `POST /api/stores/[slug]/follow` — follow toggle
**File**: `src/app/api/stores/[slug]/follow/route.ts` · **Auth**: requireShopper · **Rate limit**: none
**Purpose**: Toggle follow/unfollow for the store; updates shopper followingCount counter.
**Request**: path: `slug: string`; body: none
**Response 200**:
```ts
interface FollowToggleResponse { data: { following: boolean; followers: number } }
```
**Errors**: `401 UNAUTHORIZED` shopper login required · `404 STORE_NOT_FOUND` unknown slug · `409 FOLLOW_CONFLICT` lost follow race

---

## §5 Cart & Checkout

Guest-capable cart (session OR `sm_cart` cookie / `X-Cart-Token` header), server-recomputed quotes, address book, multi-seller order creation behind an admission gate, and the hosted-pay payment flow.

### `GET /api/cart` — get-caller-cart
**File**: `src/app/api/cart/route.ts` · **Auth**: Public (shopper session OR guest `sm_cart` cookie / `X-Cart-Token` header) · **Rate limit**: none
**Purpose**: Returns the caller's account cart or token-keyed guest cart, grouped per seller store.
**Request**: none
**Response 200**:
```ts
interface CartItem { id: string; variantId: string; productId: string; title: string; productSlug: string; variantLabel: string; unitPriceMinor: number; compareAtPriceMinor: number | null; qty: number; stock: number; moq: number; lineTotalMinor: number; imageUrl: string; storeId: string; storeSlug: string; storeName: string; selected: boolean }
interface CartStore { storeId: string; storeSlug: string; storeName: string; itemCount: number; subtotalMinor: number }
interface CartView { id: string | null; storeId: string | null; storeSlug: string | null; storeName: string | null; token: string | null; stores: CartStore[]; items: CartItem[] }
interface GetCartResponse { data: { cart: CartView; requiresAuth: boolean } }
```
**Errors**: `401 UNAUTHORIZED` invalid/suspended shopper session

### `POST /api/cart/items` — add-to-cart
**File**: `src/app/api/cart/items/route.ts` · **Auth**: Public (session or guest; guest cart created lazily, cookie minted) · **Rate limit**: none
**Purpose**: Adds a variant to the caller's cart, merging duplicates under stock/MOQ caps.
**Request**: body:
```ts
interface AddCartItemBody { variantId: string; qty?: number }
```
**Response 201**:
```ts
interface AddCartItemResponse { data: { cart: CartView; notice: string | null } }
```
**Errors**: `400 VALIDATION` variantId/qty · `400 VARIANT_UNAVAILABLE` unpurchasable · `409 OUT_OF_STOCK` · `409 MOQ_EXCEEDS_STOCK` · `401 UNAUTHORIZED`

### `PATCH /api/cart/items/[id]` — update-cart-item
**File**: `src/app/api/cart/items/[id]/route.ts` · **Auth**: Public (session or guest cart token) · **Rate limit**: none
**Purpose**: Updates quantity (0 removes) or checkout selection of one own-cart item.
**Request**: path: `id: string`; body:
```ts
interface UpdateCartItemBody { qty?: number; selected?: boolean }
```
**Response 200**:
```ts
interface UpdateCartItemResponse { data: { cart: CartView } }
```
**Errors**: `400 VALIDATION` · `404 NOT_FOUND` cart/item · `409 OUT_OF_STOCK` · `409 MOQ_NOT_MET` · `401 UNAUTHORIZED`

### `DELETE /api/cart/items/[id]` — remove-cart-item
**File**: `src/app/api/cart/items/[id]/route.ts` · **Auth**: Public (session or guest cart token) · **Rate limit**: none
**Purpose**: Removes one line from the caller's cart.
**Request**: path: `id: string`
**Response 200**:
```ts
interface DeleteCartItemResponse { data: { cart: CartView } }
```
**Errors**: `404 NOT_FOUND` cart/item · `401 UNAUTHORIZED`

### `PATCH /api/cart/selection` — bulk-selection
**File**: `src/app/api/cart/selection/route.ts` · **Auth**: Public (session or guest cart token) · **Rate limit**: none
**Purpose**: Bulk-toggles checkout selection of own-cart items (foreign ids silently ignored).
**Request**: body:
```ts
interface SelectionBody { itemIds: string[]; selected: boolean }
```
**Response 200**:
```ts
interface SelectionResponse { data: { cart: CartView } }
```
**Errors**: `400 VALIDATION` · `404 NOT_FOUND` empty cart · `401 UNAUTHORIZED`

### `GET /api/cart/stock` — stock-probe
**File**: `src/app/api/cart/stock/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Live stock/MOQ/purchasability probe for cart variant ids.
**Request**: query: `ids: string` (comma-separated variant ids, capped at 100)
**Response 200**:
```ts
interface StockProbeResponse { data: { stocks: Record<string, { stock: number; moq: number; purchasable: boolean }> } }
```
**Errors**: `400 VALIDATION` ids missing

### `POST /api/checkout/quote` — quote
**File**: `src/app/api/checkout/quote/route.ts` · **Auth**: Public (optional shopper session for wallet vouchers) · **Rate limit**: none
**Purpose**: Server-recomputes totals for legacy single-store or multi-seller carts, with voucher verdicts; nothing persisted.
**Request**: body:
```ts
interface QuoteBody { storeSlug?: string; items?: { variantId: string; qty: number }[]; couponCode?: string | null; shippingRateId?: string | null; state?: string | null; userVoucherId?: string; vouchers?: { storeId: string; userVoucherId: string }[] }
```
**Response 200** (legacy branch: +`voucher`, `commissionPreviewMinor`, no `groups`; multi branch: +`groups`, item store fields):
```ts
interface QuoteCoupon { code: string; valid: boolean; discountMinor?: number; freeShip?: boolean; reason?: string }
interface QuoteVoucher { storeId: string; userVoucherId: string; valid: boolean; reason: string | null; code: string | null; title: string | null; kind: string | null; discountMinor: number; freeShipping: boolean; fsPriceAdjustMinor: number | null }
interface QuoteItem { title: string; variantLabel: string | null; qty: number; unitPriceMinor: number; lineTotalMinor: number; stock: number; moq: number; storeId?: string; storeSlug?: string; storeName?: string }
interface QuoteGroup { storeId: string; storeSlug: string; storeName: string; subtotalMinor: number; discountMinor: number; shippingMinor: number; totalMinor: number; itemCount: number; couponApplied: boolean; voucher: QuoteVoucher | null }
interface ShippingOption { id: string; label: string; eta: string; amountMinor: number; freeShipping: boolean; available: boolean; reason: string | null }
interface QuoteResponse { data: { subtotalMinor: number; discountMinor: number; shippingMinor: number; totalMinor: number; shippingRateId: string; coupon: QuoteCoupon; voucher?: QuoteVoucher | null; items: QuoteItem[]; groups?: QuoteGroup[]; shippingOptions: ShippingOption[]; commissionPreviewMinor?: number } }
```
**Errors**: `404 STORE_NOT_FOUND` legacy slug · `400 EMPTY_CART` · `400 INVALID_QTY` · `400 VARIANT_INVALID` · `400 STORE_UNAVAILABLE`

### `POST /api/checkout/create` — create-checkout
**File**: `src/app/api/checkout/create/route.ts` · **Auth**: Shopper session OR verified guest (`guestVerification` "gcv:v1:" token bound to customer.email) · **Rate limit**: checkout-guest-create (10/min/IP, guests only) + admission gate (8 inflight / 32 queued / 5s wait)
**Purpose**: Creates one PaymentGroup plus N per-seller orders; decrements stock, redeems vouchers atomically.
**Request**: header `Idempotency-Key: string` (required); body:
```ts
interface CreateCheckoutBody { customer?: { name?: string; email?: string; phone?: string | null }; provider?: string; items?: { variantId: string; qty: number }[]; shippingAddress?: { line1?: string; city?: string; state?: string; postcode?: string }; couponCode?: string | null; shippingRateId?: string | null; vouchers?: { storeId: string; userVoucherId: string }[]; guestVerification?: string; customerNote?: string | null }
```
**Response 200/201**:
```ts
interface VoucherApplied { storeId: string; code: string | null; title: string | null; kind: string | null; discountMinor: number; freeShipping: boolean; fsPriceAdjustMinor: number | null }
interface CreateCheckoutResponse { data: { orderNumber: string; orderNumbers: string[]; orderPaymentRef: string | null; paymentRef: string | null; totalMinor: number; redirectUrl?: string; status: string; duplicate?: boolean; vouchersApplied?: VoucherApplied[] } }
```
(201 fresh: `redirectUrl`, `status:"payment_pending"`, `vouchersApplied`; 200 replay: `duplicate:true`, no `redirectUrl`/`vouchersApplied`, legacy single-order ref may be null)
**Errors**: `400 IDEMPOTENCY_KEY_REQUIRED` · `401 GUEST_VERIFICATION_REQUIRED` · `401 UNAUTHORIZED` · `403 FORBIDDEN` idem-key of another account · `400 VALIDATION`/`INVALID_PROVIDER`/`INVALID_SHIPPING`/`EMPTY_CART`/`INVALID_QTY`/`VARIANT_INVALID`/`STORE_UNAVAILABLE` · `409 SHIPPING_UNAVAILABLE`/`OUT_OF_STOCK`/`MOQ_NOT_MET`/`VOUCHER_INVALID`/`VOUCHER_ALREADY_USED`/`QUOTA_EXHAUSTED` · `429 RATE_LIMITED` guest IP · `503 CHECKOUT_BUSY` gate saturation (+`Retry-After`)

### `GET /api/checkout/addresses` — list-addresses
**File**: `src/app/api/checkout/addresses/route.ts` · **Auth**: requireShopper · **Rate limit**: none
**Purpose**: Lists the signed-in shopper's saved addresses (default first, then newest).
**Request**: none
**Response 200**:
```ts
interface Address { id: string; ownerToken: string; shopperId: string | null; label: string; name: string; phone: string | null; line1: string; city: string; state: string; postcode: string; isDefault: boolean; createdAt: string; updatedAt: string }
interface ListAddressesResponse { data: { addresses: Address[] } }
```
**Errors**: `401 UNAUTHORIZED`

### `POST /api/checkout/addresses` — create-address
**File**: `src/app/api/checkout/addresses/route.ts` · **Auth**: requireShopper · **Rate limit**: none
**Purpose**: Saves a new address; first one (or isDefault:true) becomes default.
**Request**: body:
```ts
interface CreateAddressBody { label?: string; name: string; phone?: string | null; line1: string; city: string; state: string; postcode: string; isDefault?: boolean }
```
**Response 201**:
```ts
interface CreateAddressResponse { data: { address: Address; addresses: Address[] } }
```
**Errors**: `401 UNAUTHORIZED` · `400 VALIDATION`

### `PATCH /api/checkout/addresses/[id]` — update-address
**File**: `src/app/api/checkout/addresses/[id]/route.ts` · **Auth**: requireShopper (account-scoped ownership) · **Rate limit**: none
**Purpose**: Edits address fields and/or sets it as the default.
**Request**: path: `id: string`; body:
```ts
interface UpdateAddressBody { label?: string; name?: string; phone?: string | null; line1?: string; city?: string; state?: string; postcode?: string; isDefault?: boolean }
```
**Response 200**:
```ts
interface UpdateAddressResponse { data: { address: Address; addresses: Address[] } }
```
**Errors**: `401 UNAUTHORIZED` · `400 VALIDATION` · `404 NOT_FOUND`

### `DELETE /api/checkout/addresses/[id]` — delete-address
**File**: `src/app/api/checkout/addresses/[id]/route.ts` · **Auth**: requireShopper (account-scoped ownership) · **Rate limit**: none
**Purpose**: Removes an address; promotes newest remaining if the default went away.
**Request**: path: `id: string`
**Response 200**:
```ts
interface DeleteAddressResponse { data: { addresses: Address[] } }
```
**Errors**: `401 UNAUTHORIZED` · `404 NOT_FOUND`

### `GET /api/checkout/payments/[ref]` — payment-status
**File**: `src/app/api/checkout/payments/[ref]/route.ts` · **Auth**: Public (unguessable ref acts as capability) · **Rate limit**: none
**Purpose**: Payment status for the hosted pay page; supports PaymentGroups and legacy intents.
**Request**: path: `ref: string`
**Response 200** (group: storeName/storeSlug null, no redirectUrl; intent: sets both):
```ts
interface PaymentStatusResponse { data: { status: string; isGroup: boolean; orderNumber: string; orderNumbers: string[]; orderCount: number; storeNames: string[]; storeName: string | null; storeSlug: string | null; amountMinor: number; orderStatus: string; provider: string; expiresAt: string; redirectUrl?: string } }
```
**Errors**: `404 NOT_FOUND`

### `POST /api/checkout/payments/[ref]/retry` — retry-payment
**File**: `src/app/api/checkout/payments/[ref]/retry/route.ts` · **Auth**: Public (ref capability) · **Rate limit**: none
**Purpose**: Conditionally re-opens a FAILED payment session (group or legacy intent).
**Request**: path: `ref: string`
**Response 200**:
```ts
interface RetryPaymentResponse { data: { status: string } }
```
**Errors**: `409 ALREADY_PAID` · `409 NOT_RETRYABLE` · `410 SESSION_EXPIRED` · `404 NOT_FOUND`

### `POST /api/checkout/payments/[ref]/simulate` — simulate-payment
**File**: `src/app/api/checkout/payments/[ref]/simulate/route.ts` · **Auth**: Public sandbox mock (server self-signs the webhook HMAC; 404 in production unless Setting `psp.mock.enabled=true`) · **Rate limit**: per-IP+path (10/60s; env `SIMULATE_RATE_LIMIT_PER_MIN`)
**Purpose**: Plays the licensed PSP: feeds a signed succeeded/failed event through the webhook pipeline.
**Request**: path: `ref: string`; body:
```ts
interface SimulatePaymentBody { result?: "succeeded" | "failed" }
```
**Response 200**:
```ts
interface SimulatePaymentResponse { data: { status: string; orderNumber: string; orderNumbers: string[]; isGroup: boolean } }
```
**Errors**: `429 RATE_LIMITED` · `404 NOT_FOUND` prod gate / unknown payment · `400 VALIDATION` · processor: `409 GROUP_EXPIRED`/`AMOUNT_MISMATCH`/`ORDER_EXPIRED`, `404 INTENT_NOT_FOUND`, `503 WEBHOOK_SECRET_UNSET`

### `POST /api/checkout/guest-verify/request` — request-guest-otp
**File**: `src/app/api/checkout/guest-verify/request/route.ts` · **Auth**: Public (unauthenticated buyers) · **Rate limit**: guest-verify-request (5/min/IP) + guest-verify-email (3/h/email)
**Purpose**: Emails a 6-digit code proving ownership of the guest checkout email.
**Request**: body:
```ts
interface GuestVerifyRequestBody { email: string }
```
**Response 200**:
```ts
interface GuestVerifyRequestResponse { data: { sent: boolean; message: string } }
```
**Errors**: `400 VALIDATION` · `429 RATE_LIMITED` · `429 VERIFICATION_CODE_UNAVAILABLE` locked challenge/delivery failure · `503 EMAIL_PROVIDER_NOT_CONFIGURED` / `EMAIL_OTP_UNAVAILABLE` / `EMAIL_OTP_SECRET_UNSET`

### `POST /api/checkout/guest-verify/verify` — verify-guest-otp
**File**: `src/app/api/checkout/guest-verify/verify/route.ts` · **Auth**: Public · **Rate limit**: guest-verify-verify (10/min/IP) + guest-verify-verify-email (10/h/email)
**Purpose**: Consumes the code and mints a 30-minute "gcv:v1:" verified-email token.
**Request**: body:
```ts
interface GuestVerifyBody { email: string; code: string }
```
**Response 200**:
```ts
interface GuestVerifyResponse { data: { token: string; email: string; expiresAt: string } }
```
**Errors**: `401 INVALID` uniform for every failure · `429 RATE_LIMITED` · `503 EMAIL_OTP_UNAVAILABLE` / `EMAIL_OTP_SECRET_UNSET`

---

## §6 Orders, Receipts & Guest Access

Guest order access via 15-minute order-OTP grants; account-holders see orders under §7.

### `GET /api/orders/lookup` — guest-order-lookup
**File**: `src/app/api/orders/lookup/route.ts` · **Auth**: `Authorization: Bearer v1.<orderId>.<expiry>.<hmac>` order-access grant (15-min TTL) OR owning shopper session · **Rate limit**: orders-lookup (10/min/IP) + orders-lookup-order (300/h/orderNumber)
**Purpose**: Releases order status/items/history only to grant holders or owners.
**Request**: query: `orderNumber: string` (≤32 chars)
**Response 200**:
```ts
interface OrderLookupResponse { data: { orderNumber: string; status: string; totalMinor: number; storeName: string; storeId: string; storeSlug: string; createdAt: string; items: { title: string; qty: number }[]; history: { toStatus: string; createdAt: string }[] } }
```
**Errors**: `400 VALIDATION` · `401 ORDER_VERIFICATION_REQUIRED` uniform (no oracle) · `429 RATE_LIMITED`

### `GET /api/orders/receipt` — order-receipt-pdf
**File**: `src/app/api/orders/receipt/route.ts` · **Auth**: order-access grant (Bearer, 15-min TTL) OR owning shopper session · **Rate limit**: orders-receipt (10/min/IP) + orders-receipt-order (300/h/orderNumber)
**Purpose**: Streams a structured PDF payment receipt (customer PII, provider name only).
**Request**: query: `orderNumber: string` (≤32 chars)
**Response 200** **(non-envelope)**:
```ts
interface ReceiptResponse { body: Uint8Array; headers: { "Content-Type": "application/pdf"; "Content-Disposition": string; "Cache-Control": "no-store" } }
```
**Errors**: `400 VALIDATION` · `401 ORDER_VERIFICATION_REQUIRED` · `409 NOT_PAID` while payment_pending · `429 RATE_LIMITED`

### `POST /api/orders/otp/request` — request-order-otp
**File**: `src/app/api/orders/otp/request/route.ts` · **Auth**: Public · **Rate limit**: orders-otp-request (5/min/IP) + orders-otp-email (3/h/email) + orders-otp-order (5/h/orderNumber) + orders-otp-pair (3/h/pair)
**Purpose**: Emails a 6-digit code for a (email, orderNumber) pair; response always uniform.
**Request**: body:
```ts
interface OrderOtpRequestBody { email: string; orderNumber: string }
```
**Response 200**:
```ts
interface OrderOtpRequestResponse { data: { sent: boolean; message: string } }
```
**Errors**: `429 RATE_LIMITED` · `503 EMAIL_PROVIDER_NOT_CONFIGURED` / `EMAIL_OTP_UNAVAILABLE` (uniform pre-flight)

### `POST /api/orders/otp/verify` — verify-order-otp
**File**: `src/app/api/orders/otp/verify/route.ts` · **Auth**: Public · **Rate limit**: orders-otp-verify (10/min/IP) + orders-otp-verify-email (10/h/email) + orders-otp-verify-order (30/h/orderNumber)
**Purpose**: Consumes the code and mints a 15-minute order-specific access grant.
**Request**: body:
```ts
interface OrderOtpVerifyBody { email: string; orderNumber: string; code: string }
```
**Response 200**:
```ts
interface OrderOtpVerifyResponse { data: { accessGrant: string; grantExpiresInMs: number } }
```
**Errors**: `401 INVALID` uniform for every failure · `429 RATE_LIMITED` · `503 EMAIL_OTP_UNAVAILABLE` / `EMAIL_OTP_SECRET_UNSET`

---

## §7 Shopper Account Hub

Buyer self-service: profile/membership, purchases, after-sales, reviews & rewards, vouchers, coins, wallet, notifications, activity, recommendations.

### `POST /api/me/activity` — track-like-or-view
**File**: `src/app/api/me/activity/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Record product LIKE/VIEWED; upserts one row per product+type, bumping recency.
**Request**: path: —; query: —; body:
```ts
interface ActivityBody { productId: string; activityType: "LIKE" | "VIEWED" }
```
**Response 201**:
```ts
interface TrackActivityResponse { data: { tracked: "LIKE" | "VIEWED"; productId: string } }
```
**Errors**: `400 VALIDATION` productId/activityType required · `404 NOT_FOUND` product not found

### `DELETE /api/me/activity` — untrack-activity
**File**: `src/app/api/me/activity/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Remove a LIKE/VIEWED activity row (PDP heart un-like).
**Request**: path: —; query: —; body:
```ts
interface ActivityBody { productId: string; activityType: "LIKE" | "VIEWED" }
```
**Response 200**:
```ts
interface RemoveActivityResponse { data: { removed: "LIKE" | "VIEWED"; productId: string } }
```
**Errors**: `400 VALIDATION` productId/activityType required

### `GET /api/me/activity` — likes-and-recently-viewed
**File**: `src/app/api/me/activity/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Product cards for My Likes/Recently Viewed, newest first; `?productId` yields liked-check.
**Request**: path: —; query: `type: "LIKE"|"VIEWED" (default VIEWED)`, `productId: string (optional → liked-check mode)`, `page: number (1)`, `size: number (20, max 50)`; body: none
**Response 200**:
```ts
interface ActivityListResponse {
  data: { activities: { activityId: string; trackedAt: string; product: { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; salesCount: number; viewCount: number; categoryName: string | null } }[] };
  meta: { page: number; size: number; total: number };
}
interface ActivityLikedResponse { data: { liked: boolean } }
```
**Errors**: `400 VALIDATION` type must be LIKE or VIEWED

### `GET /api/me/follows` — my-followed-stores
**File**: `src/app/api/me/follows/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Stores the shopper follows, newest first; non-live stores included but flagged.
**Request**: path: —; query: —; body: none
**Response 200**:
```ts
interface FollowsResponse {
  data: { stores: { id: string; name: string; slug: string; logoUrl: string | null; bannerUrl: string | null; tagline: string | null; status: string; isLive: boolean; productCount: number; followers: number; followedAt: string }[]; total: number };
}
```
**Errors**: none notable

### `POST /api/me/follows` — follow-store
**File**: `src/app/api/me/follows/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Follow a live store; idempotent — already-following returns 200 with already:true.
**Request**: path: —; query: —; body:
```ts
interface FollowBody { storeId: string }
```
**Response 201**:
```ts
interface FollowResponse { data: { following: true; followers: number; already?: true } }
```
**Errors**: `400 VALIDATION` storeId required · `404 NOT_FOUND` store not found · `409 STORE_NOT_LIVE` only live stores followable

### `DELETE /api/me/follows` — unfollow-store
**File**: `src/app/api/me/follows/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Unfollow a store; storeId accepted via query param or JSON body.
**Request**: path: —; query: `storeId: string (optional; falls back to body)`; body:
```ts
interface UnfollowBody { storeId?: string }
```
**Response 200**:
```ts
interface UnfollowResponse { data: { following: false; followers: number } }
```
**Errors**: `400 VALIDATION` storeId required · `404 NOT_FOUND` not following this store

### `GET /api/me/orders` — my-purchases
**File**: `src/app/api/me/orders/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Buyer purchase hub: bucket counts plus paginated orders (optionally one bucket).
**Request**: path: —; query: `bucket: "to_pay"|"to_ship"|"to_receive"|"to_rate"|"completed"|"cancelled" (optional)`, `page: number (1)`, `size: number (20, max 50)`; body: none
**Response 200**:
```ts
interface OrdersResponse {
  data: {
    bucketCounts: Record<"to_pay" | "to_ship" | "to_receive" | "to_rate" | "completed" | "cancelled", number>;
    orders: { id: string; orderNumber: string; status: string; totalMinor: number; createdAt: string; receivedAt: string | null; paymentProvider: string | null; trackingNumber: string | null; shipmentStatus: string | null; shippingCourierName: string | null; store: { id: string; name: string; slug: string }; items: { id: string; title: string; variantLabel: string | null; qty: number; unitPriceMinor: number; productId: string | null; imageUrl: string }[] }[];
  };
  meta: { page: number; size: number; total: number };
}
```
**Errors**: `400 VALIDATION` bucket must be one of the six keys

### `GET /api/me/orders/[orderNumber]` — order-detail
**File**: `src/app/api/me/orders/[orderNumber]/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Account-scoped order detail: money breakdown, customer/shipping block, items, history, shipment timeline, dispute.
**Request**: path: `orderNumber: string`; query: —; body: none
**Response 200**:
```ts
interface OrderDetailResponse {
  data: {
    orderNumber: string; status: string; currency: string; subtotalMinor: number; discountMinor: number; shippingMinor: number; taxMinor: number; totalMinor: number; createdAt: string;
    customerName: string; customerEmail: string; customerPhone: string | null; customerNote: string | null; shippingAddress: { line1?: string; city?: string; state?: string; postcode?: string } | null;
    paymentProvider: string | null; paidAt: string | null; shippedAt: string | null; deliveredAt: string | null; receivedAt: string | null; completedAt: string | null; trackingNumber: string | null; storeName: string; storeId: string; storeSlug: string;
    items: { id: string; title: string; variantLabel: string | null; qty: number; unitPriceMinor: number; lineTotalMinor: number; productId: string | null; variantId: string | null; imageUrl: string }[];
    history: { fromStatus: string | null; toStatus: string; actor: string; note: string | null; createdAt: string }[];
    shipment: { status: string; providerId: string; courierName: string | null; awbNumber: string | null; labelUrl: string | null; etaFrom: string | null; etaTo: string | null; bookedAt: string | null; deliveredAt: string | null; events: { id: string; status: string; description: string | null; location: string | null; occurredAt: string; proofImageUrl: string | null }[] } | null;
    shipmentStatus: string | null; shippingCourierName: string | null; dispute: { id: string; reason: string; status: string; resolution: string | null; createdAt: string } | null;
  }
}
```
**Errors**: `404 NOT_FOUND` no order with that number on your account

### `POST /api/me/orders/[orderNumber]/receive` — confirm-receipt
**File**: `src/app/api/me/orders/[orderNumber]/receive/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Buyer confirms receipt: shipped|delivered → received; idempotent, race-safe conditional flip.
**Request**: path: `orderNumber: string`; query: —; body: none
**Response 200**:
```ts
interface ReceiveOrderResponse { data: { id: string; orderNumber: string; status: string; receivedAt: string | null; completedAt: string | null; alreadyConfirmed?: true } }
```
**Errors**: `404 NOT_FOUND` no order on your account · `409 INVALID_STATUS` order not paid yet · `409 VALIDATION` cannot confirm from current status

### `POST /api/me/orders/[orderNumber]/reorder` — reorder-to-cart
**File**: `src/app/api/me/orders/[orderNumber]/reorder/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: One-tap re-order: tops up active cart per item with live availability re-checks.
**Request**: path: `orderNumber: string`; query: —; body: none
**Response 200**:
```ts
interface ReorderResponse { data: { added: { title: string; qty: number }[]; skipped: { title: string; reason: "Out of stock" | "Already at the maximum in your cart" | "No longer available" }[] } }
```
**Errors**: `404 NOT_FOUND` no order on your account · `500 INTERNAL` could not load your cart

### `POST /api/me/orders/[orderNumber]/return-request` — open-after-sales
**File**: `src/app/api/me/orders/[orderNumber]/return-request/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Open after-sales request (refund/return) stored as open Dispute; type carried in reason text.
**Request**: path: `orderNumber: string`; query: —; body:
```ts
interface ReturnRequestBody { reason: string; type?: "refund" | "return" }
```
**Response 200**:
```ts
interface ReturnRequestResponse { data: { id: string; orderId: string; orderNumber: string; orderStatus: string; type: "refund" | "return"; reason: string; status: string; createdAt: string } }
```
**Errors**: `400 VALIDATION` reason ≥10 chars / type must be refund|return · `404 NOT_FOUND` no order on account · `409 DISPUTE_EXISTS` open request already exists · `409 INVALID_STATUS` status not eligible

### `GET /api/me/orders/[orderNumber]/return-request` — after-sales-visibility
**File**: `src/app/api/me/orders/[orderNumber]/return-request/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Buyer-side list of after-sales requests (disputes) on the order, newest first.
**Request**: path: `orderNumber: string`; query: —; body: none
**Response 200**:
```ts
interface ReturnRequestsResponse { data: { orderNumber: string; orderStatus: string; disputes: { id: string; reason: string; status: string; resolution: string | null; createdAt: string; resolvedAt: string | null }[] } }
```
**Errors**: `404 NOT_FOUND` no order with that number on your account

### `POST /api/me/coins/claim` — daily-coin-checkin
**File**: `src/app/api/me/coins/claim/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Daily check-in crediting coins with streak bonus; dormant behind NOMO_FINANCE_ENABLED flag.
**Request**: path: —; query: —; body: none
**Response 200**:
```ts
interface CoinClaimResponse { data: { awarded: number; coinBalance: number; checkInStreak: number; nextClaimAt: string } }
```
**Errors**: `403 FEATURE_DORMANT` Nomo Coins paused · `429 ALREADY_CLAIMED` 24h cooldown (details: nextClaimAt)

### `GET /api/me/notifications` — notification-feed
**File**: `src/app/api/me/notifications/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Shopper's notification feed, newest first; optional unread-only filter.
**Request**: path: —; query: `unread: "1"|"true" (optional)`, `page: number (1)`, `size: number (20, max 50)`; body: none
**Response 200**:
```ts
interface NotificationsResponse {
  data: { id: string; type: string; title: string; body: string | null; data: Record<string, unknown>; read: boolean; readAt: string | null; createdAt: string }[];
  meta: { page: number; size: number; total: number };
}
```
**Errors**: none notable

### `POST /api/me/notifications` — mark-notifications-read
**File**: `src/app/api/me/notifications/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Mark notifications read by ids (≤200) or all unread at once.
**Request**: path: —; query: —; body:
```ts
interface MarkReadBody { ids?: string[]; all?: boolean }
```
**Response 200**:
```ts
interface MarkReadResponse { data: { updated: number; unread: number } }
```
**Errors**: `400 VALIDATION` provide ids[] or all:true

### `GET /api/me/notifications/unread` — unread-badge-count
**File**: `src/app/api/me/notifications/unread/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Cheap unread notification count for the header bell.
**Request**: path: —; query: —; body: none
**Response 200**:
```ts
interface UnreadCountResponse { data: { unread: number } }
```
**Errors**: none notable

### `POST /api/me/password` — change-password
**File**: `src/app/api/me/password/route.ts` · **Auth**: Any principal (admin|seller|shopper session via getSession — deviation from shopper-only) · **Rate limit**: auth (20/60s)
**Purpose**: Self-service credential change; session rotated, fresh token returned like login.
**Request**: path: —; query: —; body:
```ts
interface PasswordChangeBody { currentPassword: string; newPassword: string }
```
**Response 200**:
```ts
interface PasswordChangeResponse {
  data: { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; token: string } | { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string }; token: string } | { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null }; token: string };
}
```
**Errors**: `429 RATE_LIMITED` auth throttle · `401 UNAUTHORIZED` no session / principal gone · `400 VALIDATION` fields required / min 8 chars · `400 INVALID_CURRENT_PASSWORD` wrong current password · `403 ACCOUNT_TERMINATED` terminated seller

### `GET /api/me/profile` — profile-card
**File**: `src/app/api/me/profile/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Buyer profile card: identity, spend-computed membership tier (auto-upgrade), follow stats, addresses.
**Request**: path: —; query: —; body: none
**Response 200**:
```ts
interface ProfileResponse {
  data: {
    id: string; email: string; emailVerified: boolean; fullName: string; username: string | null; avatarUrl: string | null; phone: string | null;
    membershipLevel: "SILVER" | "GOLD" | "PLATINUM"; followingCount: number; followerCount: number; memberSince: string; addressCount: number; lifetimeSpendMinor: number;
    tierProgress: { nextTier: "GOLD" | "PLATINUM"; nextThresholdMinor: number; remainingMinor: number; percent: number } | null;
  };
}
```
**Errors**: `404 NOT_FOUND` shopper not found

### `PATCH /api/me/profile` — edit-profile
**File**: `src/app/api/me/profile/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Edit name, phone, username, avatar; avatar URL-guarded ("grad:" enums or safe URLs).
**Request**: path: —; query: —; body:
```ts
interface ProfilePatchBody { fullName?: string; phone?: string | null; username?: string | null; avatarUrl?: string | null }
```
**Response 200**:
```ts
interface ProfilePatchResponse { data: { profile: { id: string; fullName: string; username: string | null; avatarUrl: string | null; phone: string | null } } }
```
**Errors**: `400 VALIDATION` field rules / avatarUrl must be valid http(s) or site-relative URL · `409 USERNAME_TAKEN` handle already taken

### `GET /api/me/recommendations` — you-may-also-like
**File**: `src/app/api/me/recommendations/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Personalised product feed: recently-viewed categories boosted, popular live products fill.
**Request**: path: —; query: `sort: "popular"|"sales"|"new" (default popular)`, `page: number (1)`, `size: number (20, max 40)`; body: none
**Response 200**:
```ts
interface RecommendationsResponse {
  data: {
    products: { id: string; slug: string; title: string; priceMinor: number; compareAtPriceMinor: number | null; variantId: string | null; imageUrl: string; storeName: string; storeSlug: string; ratingAvg: number; ratingCount: number; salesCount: number; viewCount: number; categoryName: string | null; inStock: boolean; isFeatured: boolean; isSellingFast: boolean; payLaterEligible: boolean }[];
  };
  meta: { page: number; size: number; total: number };
}
```
**Errors**: none notable

### `GET /api/me/reviews` — review-management
**File**: `src/app/api/me/reviews/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Review surface: eligible unreviewed purchases, my reviews with moderation/reward state, rewards ledger.
**Request**: path: —; query: —; body: none
**Response 200**:
```ts
interface MyReviewsResponse {
  data: {
    toReview: { orderNumber: string; orderStatus: string; purchasedAt: string; store: { id: string; name: string; slug: string }; product: { id: string; title: string; slug: string; imageUrl: string } }[];
    submitted: { id: string; rating: number; title: string | null; body: string | null; titleRemoved: boolean; bodyRemoved: boolean; status: "pending" | "published" | "rejected"; createdAt: string; product: { id: string; title: string; slug: string; imageUrl: string; store: { name: string; slug: string } }; reward: { points: number; reversed: boolean; reversalReason: string | null } | null; editable: boolean; editCount: number }[];
    rewards: { activePoints: number; activeCount: number; reversedCount: number; reversedPoints: number; minorEquivalent: number; recent: { id: string; kind: string; points: number; note: string | null; createdAt: string; reversedAt: string | null; reversalReason: string | null }[] };
    policy: { pointsPerReview: number; minorPerPoint: number; maxEdits: number };
  };
}
```
**Errors**: `503 REVIEWS_NOT_MIGRATED` verified-reviews migration pending

### `PATCH /api/me/reviews/[id]` — edit-my-review
**File**: `src/app/api/me/reviews/[id]/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Edit own pending review exactly once; merge semantics; unsafe content rejected; race-safe.
**Request**: path: `id: string`; query: —; body:
```ts
interface ReviewEditBody { rating?: number; title?: string | null; body?: string | null; customerName?: string }
```
**Response 200**:
```ts
interface ReviewEditResponse { data: { id: string; status: "pending"; editsRemaining: number } }
```
**Errors**: `503 REVIEWS_NOT_MIGRATED` migration pending · `404 NOT_FOUND` review not found · `409 NOT_EDITABLE` already moderated / no longer editable · `409 EDIT_LIMIT` one edit max · `400 VALIDATION` sanitizer errors · `400 UNSAFE_CONTENT` scripts/HTML not allowed

### `GET /api/me/vouchers` — voucher-wallet-and-claim-center
**File**: `src/app/api/me/vouchers/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Held vouchers (lazy-expired on read), legacy flat list, plus claimable pool with quota state.
**Request**: path: —; query: —; body: none
**Response 200**:
```ts
interface VouchersResponse {
  data: {
    vouchers: { id: string; status: string; claimedAt: string; usedAt: string | null; voucher: { code: string; title: string; kind: string; discountMinor: number; percentOff: number | null; maxDiscountMinor: number | null; minSpendMinor: number; expiryAt: string } }[];
    mine: { id: string; status: string; claimedByMe: boolean; claimedAt: string; usedAt: string | null; usedOrderId: string | null; voucher: { id: string; code: string; title: string; kind: string; discountMinor: number; percentOff: number | null; maxDiscountMinor: number | null; minSpendMinor: number; expiryAt: string; scope: string; storeId: string | null; regionLimit: string | null; store: { name: string; slug: string; logoUrl: string | null } | null } }[];
    center: { id: string; code: string; title: string; kind: string; discountMinor: number; percentOff: number | null; maxDiscountMinor: number | null; minSpendMinor: number; expiryAt: string; startsAt: string | null; scope: string; regionLimit: string | null; store: { name: string; slug: string; logoUrl: string | null } | null; claimedByMe: boolean; quotaRemaining: number | null; claimable: boolean }[];
  };
}
```
**Errors**: none notable

### `POST /api/me/vouchers` — claim-by-code-legacy
**File**: `src/app/api/me/vouchers/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Claim a pool voucher by code (legacy contract; same engine as /vouchers/claim).
**Request**: path: —; query: —; body:
```ts
interface ClaimByCodeBody { code: string }
```
**Response 201**:
```ts
interface ClaimByCodeResponse { data: { voucher: { code: string; title: string; kind: string; scope: string }; status: string } }
```
**Errors**: `400 VALIDATION` code required (2-40 chars) · `404 NOT_FOUND` unknown/inactive/expired/not started · `409 ALREADY_HELD` already in wallet · `409 QUOTA_EXHAUSTED` pool redeemed out

### `POST /api/me/vouchers/claim` — claim-voucher
**File**: `src/app/api/me/vouchers/claim/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Claim a pool voucher by code or voucherId.
**Request**: path: —; query: —; body:
```ts
interface ClaimVoucherBody { code?: string; voucherId?: string }
```
**Response 201**:
```ts
interface ClaimVoucherResponse { data: { voucher: { id: string; code: string; title: string; kind: string; scope: string; expiryAt: string }; userVoucherId: string; status: string } }
```
**Errors**: `400 VALIDATION` code or voucherId required · `404 NOT_FOUND` unknown/inactive/expired/not started/dormant store · `409 ALREADY_HELD` already in wallet · `409 QUOTA_EXHAUSTED` pool redeemed out

### `GET /api/me/wallet` — financial-overview
**File**: `src/app/api/me/wallet/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: NomoPay/coins/PayLater overview plus voucher counts; disabled envelope while finance dormant.
**Request**: path: —; query: —; body: none
**Response 200**:
```ts
interface WalletResponse {
  data: { disabled: true; message: string; wallet: null; checkIn: null; vouchers: { available: number; used: number } } | { wallet: { balanceMinor: number; coinBalance: number; payLaterLimitMinor: number; payLaterUsedMinor: number; payLaterAvailableMinor: number; checkInStreak: number }; vouchers: { available: number; used: number }; checkIn: { canClaim: boolean; lastCheckInAt: string | null; nextClaimAt: string | null } };
}
```
**Errors**: none notable

---

## §8 Shopper ⇄ Seller Messaging (Chat)

REST persistence + a socket handshake check for the persistence-free chat hub mini-service (port 3003, reached via `/?XTransformPort=3003`).

### `GET /api/chat/unread` — unread badge count
**File**: `src/app/api/chat/unread/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Total unread seller messages across the shopper's threads (header badge).
**Request**: none
**Response 200**:
```ts
interface ChatUnreadResponse { data: { total: number } }
```
**Errors**: `401 UNAUTHORIZED`

### `POST /api/chat/hub-auth` — hub socket authorization
**File**: `src/app/api/chat/hub-auth/route.ts` · **Auth**: Public (validates session token in body — invoked by chat hub mini-service on :3003; no token is minted here) · **Rate limit**: chat-hub-auth (600/min/IP, shared loopback bucket) + chat-hub-auth:t (120/min per token hash)
**Purpose**: Authoritative socket-handshake check for the persistence-free chat hub: validates hashed session token (sha256 lookup) and `user:`/`thread:` room membership.
**Request**: body:
```ts
interface HubAuthBody { token: string; rooms: string[] }
```
**Response 200**:
```ts
interface HubAuthResponse { data: { ok: true; user: { userType: string; userId: string }; allowed: string[]; denied: number } }
```
**Errors**: `401 UNAUTHORIZED` malformed/expired token · `403 FORBIDDEN` suspended seller / non-active shopper / admin session · `429 RATE_LIMITED`

### `GET /api/chat/threads` — list conversations
**File**: `src/app/api/chat/threads/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Shopper's conversations, newest activity first; search spans store name/slug, subject, order number, message bodies.
**Request**: query: `q: string; filter: "all"|"active" (all); page: number (1); size: number (20, max 100)`
**Response 200**:
```ts
interface ChatThreadSummary { id: string; storeId: string; displayName: string; avatarUrl: string | null; storeSlug: string; orderNumber: string | null; contextType: string | null; subject: string | null; createdAt: string; lastMessageAt: string; unreadCount: number; lastMessage: { body: string; senderType: string; createdAt: string; readAt: string | null } | null }
interface ChatThreadsResponse { data: ChatThreadSummary[]; meta: { page: number; size: number; total: number } }
```
**Errors**: `401 UNAUTHORIZED` (search is case-sensitive `contains` — noted in source)

### `POST /api/chat/threads` — get-or-create thread
**File**: `src/app/api/chat/threads/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: chat-threads (20/min/IP)
**Purpose**: Get-or-create conversation with a store; stamps product/order context (order ownership enforced via Order.shopperId) and optional seed message.
**Request**: body:
```ts
interface CreateThreadBody { storeId?: string; storeSlug?: string; orderNumber?: string; productId?: string; message?: string; subject?: string }
```
**Response 200**:
```ts
interface ChatMessage { id: string; threadId: string; senderType: string; senderName: string; body: string; readAt: string | null; createdAt: string }
interface CreateThreadResponse { data: { thread: { id: string; storeId: string; storeName: string; storeSlug: string; orderNumber: string | null; contextType: string | null; subject: string | null; lastMessageAt: string }; message: ChatMessage | null } }
```
**Errors**: `404 NOT_FOUND` store / product-not-in-store / non-owned order (uniform, no existence oracle)

### `GET /api/chat/threads/[id]` — conversation page
**File**: `src/app/api/chat/threads/[id]/route.ts` · **Auth**: Session (thread's shopper owner or store's seller; admin denied) · **Rate limit**: none
**Purpose**: One keyset-paginated message page plus context card; opening clears reader-side unread and stamps readAt (broadcasts `chat:read`).
**Request**: path: `id: string`; query: `limit: number (50, max 200); before: string (message-id cursor)`
**Response 200**:
```ts
interface ThreadContextCard { kind: "product"; productId: string; title: string; slug: string; storeSlug: string; image: string | null; priceMinor: number; compareAtPriceMinor: number | null } | { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; itemCount: number; firstItemTitle: string | null; firstItemImage: string | null }
interface ThreadDetailResponse { data: { thread: { id: string; storeId: string; storeName: string; storeSlug: string; shopperName: string; orderNumber: string | null; contextType: string | null; subject: string | null; createdAt: string; lastMessageAt: string }; context: ThreadContextCard | null; hasMore: boolean; messages: ChatMessage[] } }
```
**Errors**: `401 UNAUTHORIZED` · `404 NOT_FOUND` · `403 FORBIDDEN` not participant · `400 VALIDATION` invalid `before` cursor

### `PATCH /api/chat/threads/[id]` — clear context card
**File**: `src/app/api/chat/threads/[id]/route.ts` · **Auth**: Session (thread shopper owner or store's seller) · **Rate limit**: none
**Purpose**: Close the quoted product/order context, turning the thread into a plain direct message; broadcasts `chat:context`.
**Request**: path: `id: string`; body:
```ts
interface ClearContextBody { action: "clearContext" }
```
**Response 200**:
```ts
interface ClearContextResponse { data: { threadId: string; contextType: null } }
```
**Errors**: `400 BAD_REQUEST` unsupported action · `401 UNAUTHORIZED` · `404 NOT_FOUND` · `403 FORBIDDEN`

### `POST /api/chat/threads/[id]/read` — mark thread read
**File**: `src/app/api/chat/threads/[id]/read/route.ts` · **Auth**: Shopper (owner only) · **Rate limit**: none
**Purpose**: Zero shopper unread and stamp readAt on seller messages; broadcasts `chat:read` to seller's panels/inbox.
**Request**: path: `id: string`
**Response 200**:
```ts
interface MarkReadResponse { data: { read: true; marked: { count: number } } }
```
**Errors**: `404 NOT_FOUND` · `403 FORBIDDEN` not own conversation

### `POST /api/chat/threads/[id]/messages` — send shopper message
**File**: `src/app/api/chat/threads/[id]/messages/route.ts` · **Auth**: Shopper (owner only) · **Rate limit**: chat-send-shopper (20/min/user, identity-keyed)
**Purpose**: Shopper sends a message; bumps seller unread, broadcasts `chat:message` + inbox push; dormant auto-reply scaffold may append a seller bot message.
**Request**: path: `id: string`; body:
```ts
interface SendMessageBody { body: string }
```
**Response 200**:
```ts
interface SendMessageResponse { data: { id: string; threadId: string; senderType: "shopper"; senderName: string; body: string; createdAt: string; readAt: null } }
```
**Errors**: `400 VALIDATION` empty message · `404 NOT_FOUND` thread · `403 FORBIDDEN` not own conversation · `429 RATE_LIMITED`

### `GET /api/store/chat/unread` — seller unread badge
**File**: `src/app/api/store/chat/unread/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Total unread shopper messages across the store's threads.
**Request**: path: `—`; query: none
**Response 200**:
```ts
interface ChatUnreadResponse { data: { total: number } }
```
**Errors**: — none route-specific

### `GET /api/store/chat/threads` — seller inbox
**File**: `src/app/api/store/chat/threads/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Paged chat threads, newest activity first, searchable, active filter.
**Request**: path: `—`; query: `q: string ("")`; `filter: "all"|"active" ("all")`; `page: number (1)`; `size: number (20, max 100)`
**Response 200**:
```ts
interface ChatThreadsResponse {
  data: Array<{ id: string; shopperId: string; displayName: string; avatarUrl: null; shopperEmail: string; orderNumber: string | null; contextType: string | null; subject: string | null; createdAt: string; lastMessageAt: string; unreadCount: number; lastMessage: { body: string; senderType: string; createdAt: string; readAt: string | null } | null }>;
  meta: { page: number; size: number; total: number };
}
```
**Errors**: — none route-specific

### `POST /api/store/chat/threads/[id]/read` — mark thread read (seller)
**File**: `src/app/api/store/chat/threads/[id]/read/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Marks whole thread read for seller; broadcasts chat:read event.
**Request**: path: `id: string (thread id)`; query: none; body: none
**Response 200**:
```ts
interface ThreadReadResponse { data: { read: boolean; marked: { count: number } } }
```
**Errors**: `404 NOT_FOUND` conversation not found / other store's thread

### `GET /api/store/chat/threads/[id]/messages` — thread messages page (seller)
**File**: `src/app/api/store/chat/threads/[id]/messages/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: One bounded keyset page of messages plus context card; clears unread.
**Request**: path: `id: string (thread id)`; query: `limit: number (50, max 200)`; `before: string (message id cursor for older page)`
**Response 200**:
```ts
interface ThreadMessagesResponse {
  data: {
    thread: { id: string; shopperName: string; shopperEmail: string; orderNumber: string | null; contextType: string | null; subject: string | null; lastMessageAt: string };
    context: { kind: "product"; productId: string; title: string; slug: string; storeSlug: string; image: string | null; priceMinor: number; compareAtPriceMinor: number | null } | { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; itemCount: number; firstItemTitle: string | null; firstItemImage: string | null } | null;
    hasMore: boolean;
    messages: Array<{ id: string; senderType: string; senderName: string; body: string; createdAt: string; readAt: string | null }>;
  };
}
```
**Errors**: `400 VALIDATION` invalid pagination cursor · `404 NOT_FOUND` conversation not found

### `POST /api/store/chat/threads/[id]/messages` — seller reply
**File**: `src/app/api/store/chat/threads/[id]/messages/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: chat-send-seller (20/60s)
**Purpose**: Seller sends reply; bumps shopper unread, broadcasts, notifies inbox.
**Request**: path: `id: string (thread id)`; query: none; body:
```ts
interface SellerReplyBody { body: string }
```
**Response 200**:
```ts
interface SellerReplyResponse { data: { id: string; threadId: string; senderType: "seller"; senderName: string; body: string; createdAt: string; readAt: null } }
```
**Errors**: `400 VALIDATION` empty message · `404 NOT_FOUND` conversation · `429 RATE_LIMITED` send throttle

### `PATCH /api/store/chat/threads/[id]/messages` — clear context (seller)
**File**: `src/app/api/store/chat/threads/[id]/messages/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Closes quoted product/order context; thread becomes plain DM.
**Request**: path: `id: string (thread id)`; query: none; body:
```ts
interface ClearContextBody { action: "clearContext" }
```
**Response 200**:
```ts
interface ClearContextResponse { data: { threadId: string; contextType: null } }
```
**Errors**: `400 BAD_REQUEST` unsupported action · `404 NOT_FOUND` conversation

---

## §9 Affiliate Program — Shopper Side

Shopper-affiliate surface: activation, promo links, curated collections, public showcase pages, earnings, payouts, network. Platform-side management lives in §17; seller-side enrollment in §13.

### `POST /api/affiliate/track` — resolve promo link
**File**: `src/app/api/affiliate/track/route.ts` · **Auth**: Public · **Rate limit**: affiliate-track (60/min/IP)
**Purpose**: Resolve `/?al={code}` promotional link server-side; records attribution touch, bumps clicks, sets `nm_aff_last` cookie. Returns JSON navigation target (no redirect/pixel).
**Request**: body:
```ts
interface TrackBody { code: string }
```
**Response 200**:
```ts
interface TrackResponse { data: { target: { kind: "product"; storeSlug: string; productSlug: string } | { kind: "store"; storeSlug: string } | { kind: "collection"; collectionSlug: string } | { kind: "showcase"; affiliateSlug: string }; sharedBy: string; linkType: string; channel: string } }
```
**Errors**: `400 VALIDATION` code required · `404 LINK_NOT_FOUND` invalid/inactive link, ineligible affiliate or unavailable target · `429 RATE_LIMITED`

### `POST /api/affiliate/track-referral` — record referral visit
**File**: `src/app/api/affiliate/track-referral/route.ts` · **Auth**: Public · **Rate limit**: affiliate-track-ref (30/min/IP)
**Purpose**: `/?ref={code}` first-touch referral visit; sets `nm_aff_ref` httpOnly cookie only when no valid unconsumed touch exists.
**Request**: body:
```ts
interface TrackReferralBody { code: string; channel?: string }
```
**Response 200**:
```ts
interface TrackReferralResponse { data: { invitedBy: string | null } }
```
**Errors**: `429 RATE_LIMITED` (missing/invalid code → 200 `invitedBy: null`, never an error)

### `GET /api/affiliate/pub/collection/[slug]` — public collection page
**File**: `src/app/api/affiliate/pub/collection/[slug]/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Published curated collection with active/live products; fails closed (`found:false`) while `affiliate.collections_enabled` is off.
**Request**: path: `slug: string`
**Response 200**:
```ts
interface PubCollectionResponse { data: { found: false } | { found: true; collection: { title: string; description: string | null; curatedBy: string; curatorSlug: string; curatorAvatar: string | null; pageType: "affiliate_collection"; products: { productId: string; title: string; slug: string; priceMinor: number; storeName: string; storeSlug: string; image: string | null }[] } } }
```
**Errors**: none (missing/unpublished → `found:false`)

### `GET /api/affiliate/pub/showcase/[slug]` — public affiliate showcase
**File**: `src/app/api/affiliate/pub/showcase/[slug]/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Public affiliate recommendation page (display name, bio, avatar, published collections only — no PII/earnings); fails closed while showcase gate off.
**Request**: path: `slug: string`
**Response 200**:
```ts
interface PubShowcaseResponse { data: { found: false } | { found: true; showcase: { displayName: string; bio: string | null; avatarUrl: string | null; slug: string; pageType: "affiliate_recommendations"; collections: { id: string; title: string; description: string | null; slug: string; products: { productId: string; title: string; slug: string; priceMinor: number; storeName: string; storeSlug: string; image: string | null }[] }[] } } }
```
**Errors**: none (missing/inactive profile → `found:false`)

### `GET /api/affiliate/links` — list my promo links
**File**: `src/app/api/affiliate/links/route.ts` · **Auth**: Affiliate (shopper session + profile; 401/403 NOT_AFFILIATE/AFFILIATE_SUSPENDED/AFFILIATE_TERMINATED) · **Rate limit**: none
**Purpose**: My promotional links with denormalized click stats and resolved target titles/thumbnails.
**Request**: none
**Response 200**:
```ts
interface LinksResponse { data: { links: { id: string; code: string; type: string; channel: string; label: string | null; status: string; clicks: number; lastClickAt: string | null; createdAt: string; target: { kind: "product"; title: string; slug: string | null; storeSlug: string | null; storeName: string | null; image: string | null } | { kind: "store"; title: string; slug: string | null } | { kind: "collection"; title: string; slug: string | null; status: string | null } | { kind: "showcase"; title: string; slug: string } }[] } }
```
**Errors**: `401 UNAUTHORIZED` · `403 NOT_AFFILIATE`/`AFFILIATE_SUSPENDED`/`AFFILIATE_TERMINATED`

### `POST /api/affiliate/links` — create promo link
**File**: `src/app/api/affiliate/links/route.ts` · **Auth**: Affiliate · **Rate limit**: affiliate-link-create (30/min/IP)
**Purpose**: Create product/store/collection/showcase link after ownership + affiliate-eligibility validation; collection/showcase fail closed while gated off.
**Request**: body:
```ts
interface CreateLinkBody { type: "product" | "store" | "collection" | "showcase"; channel?: string; label?: string; productId?: string; storeId?: string; collectionId?: string }
```
**Response 200** (201):
```ts
interface CreateLinkResponse { data: { link: { id: string; code: string; type: string; channel: string; label: string | null } } }
```
**Errors**: `400 VALIDATION`/`NOT_ENROLLED`/`NOT_PUBLISHED`/`LIMIT` (500 links) · `403 COLLECTIONS_DISABLED`/`SHOWCASE_DISABLED` · `404 PRODUCT_NOT_FOUND`/`STORE_NOT_FOUND`/`COLLECTION_NOT_FOUND`

### `PATCH /api/affiliate/links/[id]` — update promo link
**File**: `src/app/api/affiliate/links/[id]/route.ts` · **Auth**: Affiliate (ownership-scoped) · **Rate limit**: none
**Purpose**: Archive/reactivate/relabel/rechannel own link; reactivating gated-off collection/showcase links fails closed.
**Request**: path: `id: string`; body:
```ts
interface UpdateLinkBody { status?: "active" | "archived"; channel?: string; label?: string }
```
**Response 200**:
```ts
interface UpdateLinkResponse { data: { link: { id: string; status: string; channel: string; label: string | null } } }
```
**Errors**: `404 NOT_FOUND` not own link · `400 VALIDATION` bad status · `403 COLLECTIONS_DISABLED`/`SHOWCASE_DISABLED` reactivation while deferred

### `GET /api/affiliate/collections` — list my collections
**File**: `src/app/api/affiliate/collections/route.ts` · **Auth**: Affiliate · **Rate limit**: none
**Purpose**: My non-archived collections with items, eligibility flags and effective rates.
**Request**: none
**Response 200**:
```ts
interface CollectionsResponse { data: { collections: { id: string; title: string; description: string | null; slug: string; status: string; version: number; createdAt: string; updatedAt: string; publishedAt: string | null; items: { productId: string; position: number; title: string; slug: string; priceMinor: number; image: string | null; storeName: string; storeSlug: string; eligible: boolean; rateBps: number }[] }[] } }
```
**Errors**: `401 UNAUTHORIZED` · `403 NOT_AFFILIATE` et al.

### `POST /api/affiliate/collections` — create draft collection
**File**: `src/app/api/affiliate/collections/route.ts` · **Auth**: Affiliate · **Rate limit**: affiliate-collection-create (10/min/IP)
**Purpose**: Create draft collection; fails closed (403) while `affiliate.collections_enabled` is off.
**Request**: body:
```ts
interface CreateCollectionBody { title: string; description?: string }
```
**Response 200** (201):
```ts
interface CreateCollectionResponse { data: { collection: { id: string; slug: string; title: string; status: string } } }
```
**Errors**: `403 COLLECTIONS_DISABLED` · `400 VALIDATION` title 3–80 chars · `400 LIMIT` 100 collections

### `PATCH /api/affiliate/collections/[id]` — edit/publish collection
**File**: `src/app/api/affiliate/collections/[id]/route.ts` · **Auth**: Affiliate (ownership-scoped) · **Rate limit**: none
**Purpose**: Edit metadata, publish/unpublish/archive, add/remove/reorder products; membership changes bump `version`. While gated off only wind-down ops allowed.
**Request**: path: `id: string`; body:
```ts
interface UpdateCollectionBody { title?: string; description?: string; status?: "draft" | "published" | "archived"; addProductIds?: string[]; removeProductIds?: string[]; order?: string[] }
```
**Response 200**:
```ts
interface UpdateCollectionResponse { data: { collection: { id: string; title: string; slug: string; status: string; version: number } } }
```
**Errors**: `404 NOT_FOUND` collection/products · `403 COLLECTIONS_DISABLED` publish/add/reorder while gated · `400 VALIDATION`/`NOT_ENROLLED`/`LIMIT` (60 items)/`EMPTY` publish without items

### `DELETE /api/affiliate/collections/[id]` — archive collection
**File**: `src/app/api/affiliate/collections/[id]/route.ts` · **Auth**: Affiliate (ownership-scoped) · **Rate limit**: none
**Purpose**: Soft-archive collection (never hard-delete) and archive its active links; bumps version.
**Request**: path: `id: string`
**Response 200**:
```ts
interface ArchiveCollectionResponse { data: { archived: true } }
```
**Errors**: `404 NOT_FOUND` not own collection

### `GET /api/affiliate/me` — my affiliate context
**File**: `src/app/api/affiliate/me/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: none
**Purpose**: Signed-in shopper's affiliate profile (or null), programme settings, sponsor identity, live balances, pending referral inviter.
**Request**: none
**Response 200**:
```ts
interface AffiliateSettings { enabled: boolean; sponsorEnabled: boolean; maxRateBps: number; attrWindowDays: number; sponsorWindowDays: number; reviewDays: number; minPayoutMinor: number; collectionsEnabled: boolean; showcaseEnabled: boolean }
interface AffiliateBalances { pendingMinor: number; approvedMinor: number; availableMinor: number; payoutInFlightMinor: number; paidMinor: number; reversedMinor: number; heldMinor: number; recoveryMinor: number; requestableMinor: number }
interface MeResponse { data: { activated: boolean; settings: AffiliateSettings; invitedBy?: string | null; profile?: { id: string; code: string; slug: string; status: string; displayName: string; bio: string | null; avatarUrl: string | null; payoutRef: string | null; payoutVerified: boolean; sponsorId: string | null; sponsorName: string | null; sponsorSlug: string | null; termsVersion: number; termsAcceptedAt: string; activatedAt: string }; balances?: AffiliateBalances } }
```
**Errors**: `401 UNAUTHORIZED` (not activated → `activated:false` + `invitedBy`)

### `GET /api/affiliate/discover` — discover enrolled products
**File**: `src/app/api/affiliate/discover/route.ts` · **Auth**: Affiliate · **Rate limit**: none
**Purpose**: Participating products with commission estimates; returns paused payload when programme disabled.
**Request**: query: `category: string; q: string; store: string; minRate: number; maxPrice: number; sort: "rate"|"price_asc"|"price_desc"|"sales"|"newest"|"featured"; page: number (1); size: number (24, clamp 6–48)`
**Response 200**:
```ts
interface DiscoverProduct { productId: string; title: string; slug: string; storeSlug: string; storeName: string; image: string | null; priceMinor: number; rateBps: number; estimatedCommissionMinor: number; salesCount: number; viewCount: number; ratingAvg: number; isFeatured: boolean; addedAt: string | null }
interface DiscoverResponse { data: { rows: DiscoverProduct[]; total: number; maxRateBps: number } | { rows: never[]; total: 0; paused: true } }
```
**Errors**: `401 UNAUTHORIZED` · `403 NOT_AFFILIATE` et al. (deviation: list via single envelope, no meta)

### `GET /api/affiliate/earnings` — commission entries
**File**: `src/app/api/affiliate/earnings/route.ts` · **Auth**: Affiliate · **Rate limit**: none
**Purpose**: Personal direct vs sponsor earnings with balances; buyer PII excluded (order number + product/store data only).
**Request**: query: `role: "direct"|"sponsor"; status: string; page: number (1); size: number (20, clamp 5–50)`
**Response 200**:
```ts
interface EarningsResponse { data: { total: number; page: number; balances: AffiliateBalances; rows: { id: string; role: string; status: string; amountMinor: number; reversedMinor: number; holdReason: string | null; availableAt: string | null; paidAt: string | null; payoutId: string | null; createdAt: string; orderNumber: string; rateBps: number; baseMinor: number; poolMinor: number; channel: string; linkType: string }[] } }
```
**Errors**: `401 UNAUTHORIZED` · `403 NOT_AFFILIATE` et al. (deviation: inline page/total, no meta envelope)

### `GET /api/affiliate/activate` — pre-activation context
**File**: `src/app/api/affiliate/activate/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Programme status plus pending sponsor from first-touch referral cookie, for the confirmation UI.
**Request**: none
**Response 200**:
```ts
interface ActivateContextResponse { data: { enabled: boolean; sponsorEnabled: boolean; maxRateBps: number; invitedBy: string | null; invitedByCode: string | null } }
```
**Errors**: none

### `POST /api/affiliate/activate` — join programme
**File**: `src/app/api/affiliate/activate/route.ts` · **Auth**: Shopper (requireShopper) · **Rate limit**: affiliate-activate (5/min/IP)
**Purpose**: Activate affiliate account; sponsor assigned server-side only (first-touch cookie precedence, one-time code entry, explicit confirmation); locks permanently.
**Request**: body:
```ts
interface ActivateBody { termsAccepted: boolean; displayName?: string; bio?: string; slug?: string; sponsorCode?: string; sponsorConfirmed?: boolean }
```
**Response 200** (201):
```ts
interface ActivateResponse { data: { profile: { id: string; code: string; slug: string; displayName: string; status: string; sponsorId: string | null }; sponsor: { id: string; displayName: string } | null; sponsorSource: "referral_touch" | "code_entry" | null } }
```
**Errors**: `400 TERMS_REQUIRED`/`INVALID_SPONSOR_CODE`/`SELF_REFERRAL`/`SPONSOR_INACTIVE`/`SPONSOR_CONFIRMATION_REQUIRED` · `403 AFFILIATE_DISABLED` · `409 ALREADY_AFFILIATE`

### `GET /api/affiliate/overview` — hub overview
**File**: `src/app/api/affiliate/overview/route.ts` · **Auth**: Affiliate · **Rate limit**: none
**Purpose**: Hub overview; estimated analytics and authoritative financial figures kept separate, plus daily series.
**Request**: query: `days: number (30, clamp 1–365)`
**Response 200**:
```ts
interface OverviewResponse {
  data: {
    estimated: { clicks: number; uniqueVisitors: number; productViews: number; addToCart: number };
    commerce: { attributedOrders: number; paidOrders: number; eligibleSalesMinor: number; reversedMinor: number };
    earnings: { personalDirectMinor: number; sponsorMinor: number; pendingMinor: number; approvedMinor: number; availableMinor: number; paidMinor: number; reversedMinor: number; heldMinor: number; recoveryMinor: number; requestableMinor: number; payoutInFlightMinor: number };
    network: { directReferrals: number; activatedAffiliates: number; affiliatesWithSales: number };
    series: { date: string; clicks: number; orders: number; commissionMinor: number }[];
    days: number;
  };
}
```
**Errors**: `401 UNAUTHORIZED` · `403 NOT_AFFILIATE` et al.

### `GET /api/affiliate/payouts` — payout history
**File**: `src/app/api/affiliate/payouts/route.ts` · **Auth**: Affiliate · **Rate limit**: none
**Purpose**: My payout history (latest 50) plus requestable balance and minimum payout threshold.
**Request**: none
**Response 200**:
```ts
interface PayoutsResponse { data: { balances: AffiliateBalances; minPayoutMinor: number; payouts: { id: string; amountMinor: number; status: string; method: string; reference: string | null; note: string | null; failReason: string | null; requestedAt: string; processedAt: string | null }[] } }
```
**Errors**: `401 UNAUTHORIZED` · `403 NOT_AFFILIATE` et al.

### `POST /api/affiliate/payouts` — request withdrawal
**File**: `src/app/api/affiliate/payouts/route.ts` · **Auth**: Affiliate · **Rate limit**: affiliate-payout-request (3/min/IP)
**Purpose**: Request withdrawal of requestable balance (manual finance workflow; Serializable claim of matured entries).
**Request**: none (body ignored)
**Response 200** (201):
```ts
interface PayoutRequestResponse { data: { payoutId: string; amountMinor: number } }
```
**Errors**: `403 AFFILIATE_DISABLED` · `400 BELOW_MIN_PAYOUT` · `409 PAYOUT_OPEN`/`PAYOUT_CLAIM_CONFLICT`

### `GET /api/affiliate/network` — direct referrals
**File**: `src/app/api/affiliate/network/route.ts` · **Auth**: Affiliate · **Rate limit**: none
**Purpose**: Direct referrals only (display names, one level); includes generated-sales flags and total sponsor earnings.
**Request**: query: `page: number (1); size: number (20, clamp 5–50)`
**Response 200**:
```ts
interface NetworkResponse { data: { total: number; page: number; referrals: { displayName: string; slug: string; status: string; activatedAt: string; generatedSales: boolean }[]; sponsorEarningsMinor: number } }
```
**Errors**: `401 UNAUTHORIZED` · `403 NOT_AFFILIATE` et al. (deviation: inline page/total, no meta envelope)

---

## §10 Seller Backend — Catalog, Content & Imports

Product/variant/category/collection/coupon/voucher/campaign/CMS-page management plus the marketplace import pipeline (URL → job → claim → bind).

### `GET /api/store/products` — list seller products
**File**: `src/app/api/store/products/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Paginated catalog of the seller's own products with images, variants, category.
**Request**: path: —; query: `search: string (none, title contains)`, `status: string (all)`, `page: number (1)`, `size: number (20, max 100)`
**Response 200**:
```ts
interface ProductImage { id: string; productId: string; url: string; sortOrder: number; alt: string | null }
interface ProductVariant { id: string; productId: string; name: string; optionName: string | null; optionValue: string | null; priceMinor: number; compareAtPriceMinor: number | null; stock: number; moq: number; lowStockThreshold: number; sku: string | null; isActive: boolean; imageUrl: string | null; sourceModelId: string | null; createdAt: string; updatedAt: string }
interface ProductFull { id: string; storeId: string; categoryId: string | null; title: string; slug: string; description: string | null; status: string; rejectReason: string | null;
  priceMinor: number; commissionPercentOverride: number | null; flagsJson: string; reportsCount: number; salesCount: number; viewCount: number; ratingAvg: number; ratingCount: number;
  isFeatured: boolean; publishedAt: string | null; storeCategoryId: string | null; isFixture: boolean; sourcePlatform: string | null; sourceShopId: string | null; sourceProductId: string | null;
  sourceUrl: string | null; sourceBrand: string | null; sourceStatus: string | null; lastSyncedAt: string | null; overridesJson: string; affiliateEnabled: boolean; affiliateRateBps: number | null;
  seoTitle: string | null; seoDescription: string | null; createdAt: string; updatedAt: string; images: ProductImage[]; variants: ProductVariant[]; category: { id: string; name: string; slug: string } | null }
interface ProductsListResponse { data: ProductFull[]; meta: { page: number; size: number; total: number } }
```
**Errors**: auth-tier codes only (401/403/400 per requireActiveSellerStore) — no route-specific errors

### `POST /api/store/products` — create product
**File**: `src/app/api/store/products/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Create product with images and variants; moderation status and slug auto-derived.
**Request**: path: —; query: —; body:
```ts
interface ProductCreateBody { title: string; description?: string | null; images?: string[]; variants: VariantInput[]; categoryId?: string | null; storeCategoryId?: string | null; isFeatured?: boolean }
interface VariantInput { name?: string; optionName?: string | null; optionValue?: string | null; priceMinor: number; compareAtPriceMinor?: number | null; stock?: number; moq?: number; lowStockThreshold?: number; sku?: string | null }
```
**Response 200** (HTTP 201):
```ts
interface ProductCreateResponse { data: ProductFull }
```
**Errors**: `400 VALIDATION` title/variants/category/images URL guard (moderation: first-N or banned keywords → status "pending_review")

### `GET /api/store/products/[id]` — get own product
**File**: `src/app/api/store/products/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Fetch one own product with variants and images (no category — unlike list/create/PATCH).
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface ProductGetResponse { data: Omit<ProductFull, "category"> }
```
**Errors**: `404 NOT_FOUND` product missing or owned by another store

### `PATCH /api/store/products/[id]` — update product
**File**: `src/app/api/store/products/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Update fields, replace images, upsert variants, resubmit for moderation; recompute priceMinor.
**Request**: path: `id: string`; query: —; body:
```ts
interface ProductPatchBody { title?: string; description?: string | null; categoryId?: string | null; storeCategoryId?: string | null; isFeatured?: boolean; images?: string[]; variants?: VariantInput[]; regenerateSlug?: boolean; resubmit?: boolean }
```
**Response 200**:
```ts
interface ProductPatchResponse { data: ProductFull }
```
**Errors**: `400 VALIDATION` empty title/category not found/images guard · `404 NOT_FOUND` not own product (variants are never deleted — only updated/created)

### `DELETE /api/store/products/[id]` — archive product
**File**: `src/app/api/store/products/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Soft-archive the product (status "archived"); rows are never hard-deleted.
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface ProductDeleteResponse { data: { id: string; status: string } }
```
**Errors**: `404 NOT_FOUND` not own product

### `POST /api/store/products/[id]/variants` — add variant
**File**: `src/app/api/store/products/[id]/variants/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Add a variant to an own product; product priceMinor recomputed from active variants.
**Request**: path: `id: string (product id)`; query: —; body:
```ts
interface VariantCreateBody { name?: string; optionName?: string | null; optionValue?: string | null; priceMinor: number; compareAtPriceMinor?: number | null; stock?: number; lowStockThreshold?: number; sku?: string | null }
```
**Response 200** (HTTP 201):
```ts
interface VariantCreateResponse { data: ProductVariant }
```
**Errors**: `400 VALIDATION` priceMinor < 0 · `404 NOT_FOUND` not own product (moq not settable here — defaults 1)

### `PATCH /api/store/variants/[id]` — update variant
**File**: `src/app/api/store/variants/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Update variant price/stock/options; parent product priceMinor recomputed afterwards.
**Request**: path: `id: string (variant id)`; query: —; body:
```ts
interface VariantPatchBody { name?: string; optionName?: string | null; optionValue?: string | null; priceMinor?: number; compareAtPriceMinor?: number | null; stock?: number; lowStockThreshold?: number; sku?: string | null; isActive?: boolean }
```
**Response 200**:
```ts
interface VariantPatchResponse { data: ProductVariant }
```
**Errors**: `400 VALIDATION` priceMinor < 0 · `404 NOT_FOUND` variant not found or not store-owned

### `DELETE /api/store/variants/[id]` — deactivate variant
**File**: `src/app/api/store/variants/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Soft-deactivate variant (isActive=false); orders may still reference it.
**Request**: path: `id: string (variant id)`; query: —
**Response 200**:
```ts
interface VariantDeleteResponse { data: { id: string; isActive: boolean } }
```
**Errors**: `404 NOT_FOUND` variant not found or not store-owned

### `GET /api/store/categories` — list storefront categories
**File**: `src/app/api/store/categories/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Seller-defined storefront categories with product counts (chip row).
**Request**: path: —; query: —
**Response 200**:
```ts
interface StoreCategoriesResponse { data: { id: string; name: string; sortOrder: number; productCount: number }[] }
```
**Errors**: auth-tier codes only (unpaginated list — plain ok() envelope, no meta)

### `POST /api/store/categories` — create storefront category
**File**: `src/app/api/store/categories/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Create a store category appended after the last row (max 20, unique name).
**Request**: path: —; query: —; body:
```ts
interface StoreCategoryCreateBody { name: string }
```
**Response 200** (HTTP 201):
```ts
interface StoreCategoryCreateResponse { data: { id: string; name: string; sortOrder: number; productCount: number } }
```
**Errors**: `400 VALIDATION` empty/long name (>40), duplicate name (case-insensitive), cap of 20

### `PATCH /api/store/categories/[id]` — rename/reorder category
**File**: `src/app/api/store/categories/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Rename and/or move category up/down by swapping sortOrder with nearest neighbor.
**Request**: path: `id: string`; query: —; body:
```ts
interface StoreCategoryPatchBody { name?: string; direction?: "up" | "down" }
```
**Response 200**:
```ts
interface StoreCategoryPatchResponse { data: { id: string; name: string; sortOrder: number } }
```
**Errors**: `400 VALIDATION` empty/long/duplicate name or nothing to update · `404 NOT_FOUND` not own category (edge move is a silent no-op)

### `DELETE /api/store/categories/[id]` — delete category
**File**: `src/app/api/store/categories/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Delete a storefront category; products survive with storeCategoryId nulled (SetNull).
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface StoreCategoryDeleteResponse { data: { id: string; deleted: boolean } }
```
**Errors**: `404 NOT_FOUND` not own category

### `GET /api/store/collections` — list collections
**File**: `src/app/api/store/collections/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: List the store's collections with embedded product summaries and counts.
**Request**: path: —; query: —
**Response 200**:
```ts
interface CollectionRow { id: string; storeId: string; name: string; slug: string; description: string | null; createdAt: string; updatedAt: string; productCount: number; products: { id: string; title: string; slug: string; priceMinor: number; status: string }[] }
interface CollectionsListResponse { data: CollectionRow[] }
```
**Errors**: auth-tier codes only (unpaginated — plain ok() envelope, no meta)

### `POST /api/store/collections` — create collection
**File**: `src/app/api/store/collections/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Create a collection with unique slug (suffix -2, -3… on collision).
**Request**: path: —; query: —; body:
```ts
interface CollectionCreateBody { name: string; description?: string | null }
```
**Response 200** (HTTP 201):
```ts
interface CollectionCreateResponse { data: CollectionRow }
```
**Errors**: `400 VALIDATION` name required

### `PATCH /api/store/collections/[id]` — update collection
**File**: `src/app/api/store/collections/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Rename and/or change description of an own collection.
**Request**: path: `id: string`; query: —; body:
```ts
interface CollectionPatchBody { name?: string; description?: string | null }
```
**Response 200**:
```ts
interface CollectionPatchResponse { data: { id: string; storeId: string; name: string; slug: string; description: string | null; createdAt: string; updatedAt: string } }
```
**Errors**: `400 VALIDATION` empty name · `404 NOT_FOUND` not own collection

### `DELETE /api/store/collections/[id]` — delete collection
**File**: `src/app/api/store/collections/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Hard-delete an own collection (membership rows cascade).
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface CollectionDeleteResponse { data: { id: string; deleted: boolean } }
```
**Errors**: `404 NOT_FOUND` not own collection

### `POST /api/store/collections/[id]/products` — replace membership
**File**: `src/app/api/store/collections/[id]/products/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Replace collection membership with the given store-owned product ids.
**Request**: path: `id: string`; query: —; body:
```ts
interface CollectionProductsBody { productIds: string[] }
```
**Response 200**:
```ts
interface CollectionProductsResponse { data: { id: string; slug: string; productIds: string[] } }
```
**Errors**: `400 VALIDATION` productIds not an array · `404 NOT_FOUND` collection not found (non-owned ids silently dropped)

### `GET /api/store/coupons` — list coupons
**File**: `src/app/api/store/coupons/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: List the store's coupons, newest first.
**Request**: path: —; query: —
**Response 200**:
```ts
interface CouponRow { id: string; scope: string; storeId: string | null; code: string; description: string | null; type: string; percent: number | null; amountMinor: number | null; minSpendMinor: number; maxRedemptions: number | null; perCustomerLimit: number; startsAt: string | null; endsAt: string | null; isActive: boolean; timesUsed: number; createdAt: string; updatedAt: string }
interface CouponsListResponse { data: CouponRow[] }
```
**Errors**: auth-tier codes only (unpaginated — plain ok() envelope, no meta)

### `POST /api/store/coupons` — create coupon
**File**: `src/app/api/store/coupons/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Create a store-scope coupon (percent | fixed | freeship) with validation.
**Request**: path: —; query: —; body:
```ts
interface CouponCreateBody { code: string; type: "percent" | "fixed" | "freeship"; description?: string | null; percent?: number; amountMinor?: number; minSpendMinor?: number; maxRedemptions?: number | null; perCustomerLimit?: number; startsAt?: string | null; endsAt?: string | null; isActive?: boolean }
```
**Response 200** (HTTP 201):
```ts
interface CouponCreateResponse { data: CouponRow }
```
**Errors**: `400 VALIDATION` code format (3-24 A-Z0-9_-), type, percent 1..100, amountMinor · `409 CODE_TAKEN` code already exists

### `PATCH /api/store/coupons/[id]` — update coupon
**File**: `src/app/api/store/coupons/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Update coupon terms/active flag; code and type immutable.
**Request**: path: `id: string`; query: —; body:
```ts
interface CouponPatchBody { description?: string | null; percent?: number; amountMinor?: number; minSpendMinor?: number; maxRedemptions?: number | null; startsAt?: string | null; endsAt?: string | null; isActive?: boolean }
```
**Response 200**:
```ts
interface CouponPatchResponse { data: CouponRow }
```
**Errors**: `400 VALIDATION` percent out of range (type-conditional fields) · `404 NOT_FOUND` not own coupon

### `DELETE /api/store/coupons/[id]` — delete coupon
**File**: `src/app/api/store/coupons/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Hard-delete an own coupon.
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface CouponDeleteResponse { data: { id: string; deleted: boolean } }
```
**Errors**: `404 NOT_FOUND` not own coupon

### `GET /api/store/campaigns` — list tracking campaigns
**File**: `src/app/api/store/campaigns/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: campaigns (60/60s)
**Purpose**: List seller campaign tracking-link rows (any status, archived included).
**Request**: path: —; query: —
**Response 200**:
```ts
interface CampaignRow { id: string; name: string; slug: string; code: string; status: string; defaultSource: string | null; defaultMedium: string | null; createdAt: string; linkPath: string }
interface CampaignsListResponse { data: CampaignRow[] }
```
**Errors**: `429 RATE_LIMITED` over limit (linkPath = `/?sf=<storeSlug>&utm_campaign=…&nmcl=<code>`; unpaginated ok() envelope)

### `POST /api/store/campaigns` — create tracking campaign
**File**: `src/app/api/store/campaigns/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: campaigns (20/60s)
**Purpose**: Create campaign with unique slug and globally-unique short code for links.
**Request**: path: —; query: —; body:
```ts
interface CampaignCreateBody { name: string; source?: string; medium?: string }
```
**Response 200** (HTTP 201):
```ts
interface CampaignCreateResponse { data: CampaignRow }
```
**Errors**: `400 VALIDATION` name required (≤80) / JSON body · `400 CAMPAIGN_LIMIT` store already has 100 campaigns · `429 RATE_LIMITED`

### `PATCH /api/store/campaigns/[id]` — rename/archive campaign
**File**: `src/app/api/store/campaigns/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: campaigns (20/60s)
**Purpose**: Rename and/or archive/reactivate; slug and code immutable; response omits linkPath.
**Request**: path: `id: string`; query: —; body:
```ts
interface CampaignPatchBody { name?: string; status?: "active" | "archived" }
```
**Response 200**:
```ts
interface CampaignPatchResponse { data: { id: string; name: string; slug: string; code: string; status: string; defaultSource: string | null; defaultMedium: string | null; createdAt: string } }
```
**Errors**: `400 VALIDATION` empty name/bad status/nothing to update · `404 NOT_FOUND` not own campaign · `429 RATE_LIMITED`

### `GET /api/store/vouchers` — voucher panel
**File**: `src/app/api/store/vouchers/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Store-scope vouchers with claim/usage stats plus free-shipping cost-recovery setting.
**Request**: path: —; query: —
**Response 200**:
```ts
interface VoucherRow { id: string; code: string; title: string; kind: string; discountMinor: number; percentOff: number | null; maxDiscountMinor: number | null; minSpendMinor: number; expiryAt: string; isActive: boolean; createdAt: string; scope: string; storeId: string | null; regionLimit: string | null; quota: number | null; claimedCount: number; startsAt: string | null }
interface VouchersPanelResponse { data: { vouchers: { id: string; code: string; title: string; kind: string; discountMinor: number; percentOff: number | null; maxDiscountMinor: number | null; minSpendMinor: number; expiryAt: string; startsAt: string | null; isActive: boolean; scope: string; regionLimit: string | null; quota: number | null; claimedCount: number; holders: number; usedCount: number; createdAt: string }[]; fsPriceAdjustMinor: number } }
```
**Errors**: auth-tier codes only (unpaginated composite ok() envelope, no meta)

### `POST /api/store/vouchers` — create store voucher
**File**: `src/app/api/store/vouchers/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Create a STORE-scope voucher (discount flat/percent, or freeshipping peninsular-only).
**Request**: path: —; query: —; body:
```ts
interface VoucherCreateBody { title: string; kind: "discount" | "freeshipping"; code?: string; discountMinor?: number; percentOff?: number; maxDiscountMinor?: number; minSpendMinor?: number; quota?: number | null; startsAt?: string | null; expiryAt: string; isActive?: boolean }
```
**Response 200** (HTTP 201):
```ts
interface VoucherCreateResponse { data: { voucher: { id: string; code: string; title: string; kind: string; discountMinor: number; percentOff: number | null; maxDiscountMinor: number | null; minSpendMinor: number; expiryAt: string; startsAt: string | null; isActive: boolean; scope: string; regionLimit: string | null; quota: number | null } } }
```
**Errors**: `400 VALIDATION` title/kind/dates/amount rules (percentOff 1..90, quota, expiry future) · `409 CODE_TAKEN` duplicate code (auto-code retries 5× when omitted)

### `PATCH /api/store/vouchers/[id]` — toggle/edit voucher
**File**: `src/app/api/store/vouchers/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Toggle isActive always; term edits rejected once any shopper holds it.
**Request**: path: `id: string`; query: —; body:
```ts
interface VoucherPatchBody { isActive?: boolean; title?: string; kind?: "discount" | "freeshipping"; discountMinor?: number; percentOff?: number | null; maxDiscountMinor?: number | null; minSpendMinor?: number; expiryAt?: string; quota?: number | null }
```
**Response 200**:
```ts
interface VoucherPatchResponse { data: VoucherRow & { heldCount: number; redeemedCount: number } }
```
**Errors**: `400 VALIDATION` re-validated terms (parseSellerVoucherInput) · `404 NOT_FOUND` not own STORE-scope voucher · `409 VOUCHER_HAS_HOLDERS` term edit with holders

### `DELETE /api/store/vouchers/[id]` — pause voucher
**File**: `src/app/api/store/vouchers/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Soft delete — flips isActive=false so claims/history survive.
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface VoucherDeleteResponse { data: VoucherRow & { deleted: boolean } }
```
**Errors**: `404 NOT_FOUND` not own STORE-scope voucher

### `POST /api/store/vouchers/price-adjust` — FS markup apply/revert
**File**: `src/app/api/store/vouchers/price-adjust/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Apply or revert a flat price markup across all active variants of active products.
**Request**: path: —; query: —; body:
```ts
interface PriceAdjustBody { action: "apply" | "revert"; amountMinor?: number }
```
**Response 200**:
```ts
interface PriceAdjustResponse { data: { action: string; amountMinor: number; updatedCount: number; fsPriceAdjustMinor: number } }
```
**Errors**: `400 VALIDATION` bad action or amountMinor outside 100..5000 · `409 ALREADY_APPLIED` markup already live · `409 NOTHING_TO_REVERT` no live adjustment (revert only decrements variants priced ≥ adjust)

### `GET /api/store/pages` — list CMS pages
**File**: `src/app/api/store/pages/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: List the store's CMS pages with publish state and draft section count.
**Request**: path: —; query: —
**Response 200**:
```ts
interface PagesListResponse { data: { id: string; slug: string; title: string; pageType: string; draftVersion: number; publishedVersion: number; hasUnpublished: boolean; published: boolean; sectionCount: number; updatedAt: string }[] }
```
**Errors**: auth-tier codes only (unpaginated ok() envelope, no meta)

### `GET /api/store/pages/[id]` — get page with docs
**File**: `src/app/api/store/pages/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Fetch one page (by id OR slug) with parsed draft and published documents.
**Request**: path: `id: string (page id or slug)`; query: —
**Response 200**:
```ts
interface PageDoc { sections: { id: string; type: string; props: Record<string, unknown> }[]; version: number }
interface PageGetResponse { data: { page: { id: string; slug: string; title: string; pageType: string; draftVersion: number; publishedVersion: number; hasUnpublished: boolean; published: boolean }; draft: PageDoc; published: PageDoc | null } }
```
**Errors**: `404 NOT_FOUND` page not found

### `PUT /api/store/pages/[id]/draft` — save draft
**File**: `src/app/api/store/pages/[id]/draft/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Replace the page's draft sections; bumps draftVersion and flags unpublished.
**Request**: path: `id: string`; query: —; body:
```ts
interface PageDraftBody { sections: { id?: string; type?: string; props?: Record<string, unknown> }[] }
```
**Response 200**:
```ts
interface PageDraftResponse { data: { id: string; slug: string; draftVersion: number; hasUnpublished: boolean; doc: PageDoc } }
```
**Errors**: `400 VALIDATION` sections not an array · `404 NOT_FOUND` not own page (missing ids get new `sec_*` ids; type defaults "rich_text")

### `POST /api/store/pages/[id]/publish` — publish draft
**File**: `src/app/api/store/pages/[id]/publish/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Promote the current draft to the published version atomically.
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface PagePublishResponse { data: { id: string; slug: string; publishedVersion: number; hasUnpublished: boolean } }
```
**Errors**: `404 NOT_FOUND` not own page

### `POST /api/store/pages/[id]/revert` — revert draft
**File**: `src/app/api/store/pages/[id]/revert/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Discard draft; restore published sections while keeping version counter monotonic.
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface PageRevertResponse { data: { id: string; slug: string; draftVersion: number; hasUnpublished: boolean; doc: PageDoc } }
```
**Errors**: `400 NEVER_PUBLISHED` no published version to revert to · `404 NOT_FOUND` not own page

### `GET /api/store/imports` — import centre
**File**: `src/app/api/store/imports/route.ts` · **Auth**: Seller session (getSession only — no store required; deviation) · **Rate limit**: none
**Purpose**: Seller's import jobs, marketplace connection statuses, and env flags.
**Request**: path: —; query: —
**Response 200**:
```ts
interface StoreImportsResponse { data: { jobs: { id: string; trackingToken: string; platform: string; urlType: string; inputUrl: string; status: string; phaseDetail: string | null; isFixture: boolean; storeId: string | null; createdAt: string; finishedAt: string | null; itemCount: number; productsOk: number | null; productsFailed: number | null; progress: Record<string, number>; errorMessage: string | null }[]; connections: { platform: string; status: string; shopName: string | null; expiresAt: string | null; envConfigured: boolean }[]; env: { shopee: boolean; tiktok: boolean } } }
```
**Errors**: `401 UNAUTHENTICATED` non-seller session (plain fail(); latest 30 jobs; connections store-scoped, global rows invisible)

### `POST /api/import/jobs` — create import job
**File**: `src/app/api/import/jobs/route.ts` · **Auth**: Public (anonymous requires signed import_cap cookie; seller session bypasses) · **Rate limit**: import (5/60s per IP) + import-cap-jobs (15/h per capability)
**Purpose**: Create an import job from a pasted marketplace URL; fixture demo URLs allowed.
**Request**: path: —; query: —; body:
```ts
interface ImportJobCreateBody { url: string; allowFixture?: boolean }
```
**Response 200**:
```ts
interface ImportJobCreateResponse { data: { jobId: string; trackingToken: string; status: string; pollUrl: string } }
```
**Errors**: `400 MISSING_URL` no url · `400 INVALID_URL/UNSUPPORTED_MARKETPLACE/FIXTURE_NOT_ALLOWED` resolver rejections · `403 IMPORT_CAPABILITY_REQUIRED` anonymous without cap · `429 RATE_LIMITED` IP or capability budget · `503 IMPORT_CAP_SECRET_UNSET` prod secret missing (seller-created jobs pin their own marketplace connection)

### `GET /api/import/jobs/[id]` — poll import job
**File**: `src/app/api/import/jobs/[id]/route.ts` · **Auth**: Public (valid tracking token required) · **Rate limit**: none
**Purpose**: Poll job progress, error, summary (incl. claim token once generated), items.
**Request**: path: `id: string`; query: `token: string (required, must match trackingToken)`
**Response 200**:
```ts
interface ImportJobGetResponse { data: { id: string; platform: string; platformLabel: string; urlType: string; inputUrl: string; status: string; phaseDetail: string | null; isFixture: boolean; progress: Record<string, number>; error: { code?: string; message?: string } | null; summary: { shop: { name: string; sourceShopId: string; region?: string | null } | null; authorisationRequired: boolean; beginUrl: string | null; missingEnv: string[]; claimToken: string | null; claimExpiresAt: string | null; claimMethod: string | null; warnings: string[]; productsOk: number | null; productsFailed: number | null }; store: { id: string; name: string; slug: string; status: string } | null; items: { id: string; sourceProductId: string; title: string | null; status: string; error: string | null; warnings: string[] }[]; startedAt: string | null; finishedAt: string | null; createdAt: string } }
```
**Errors**: `403 INVALID_TRACKING_TOKEN` missing/mismatched token · `404 JOB_NOT_FOUND` no such job (items unpaginated)

### `POST /api/import/jobs/[id]/resume` — resume import
**File**: `src/app/api/import/jobs/[id]/resume/route.ts` · **Auth**: Public (valid tracking token required) · **Rate limit**: none
**Purpose**: Re-run a failed/partial import job; resets failed status then runs inline.
**Request**: path: `id: string`; query: `token: string (required, must match trackingToken)`
**Response 200**:
```ts
interface ImportJobResumeResponse { data: { status: string } }
```
**Errors**: `403 INVALID_TRACKING_TOKEN` missing/mismatched token · `404 JOB_NOT_FOUND` no such job (status one of queued/awaiting_authorisation/completed/completed_with_warnings/failed)

### `POST /api/import/jobs/[id]/claim/validate` — validate claim token
**File**: `src/app/api/import/jobs/[id]/claim/validate/route.ts` · **Auth**: Public · **Rate limit**: none
**Purpose**: Validate a raw claim token; return generated store identity and verification method.
**Request**: path: `id: string`; query: —; body:
```ts
interface ClaimValidateBody { claimToken: string }
```
**Response 200**:
```ts
interface ClaimValidateResponse { data: { storeId: string; storeSlug: string; storeName: string; method: string; store: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; productCount: number } | null } }
```
**Errors**: `400 MISSING_CLAIM_TOKEN` no token · `403 INVALID_CLAIM_TOKEN` invalid/used/expired or store mismatch (binding happens later in /api/claim/bind)

### `POST /api/import/resolve` — resolve marketplace URL
**File**: `src/app/api/import/resolve/route.ts` · **Auth**: Public (sets import_cap cookie for anonymous; sellers bypass) · **Rate limit**: import (5/60s per IP)
**Purpose**: Detect platform, validate URL, report connector auth state; issue onboarding capability.
**Request**: path: —; query: —; body:
```ts
interface ImportResolveBody { url: string }
```
**Response 200**:
```ts
interface ImportResolveResponse { data: { platform: string; platformLabel: string; urlType: string; shopId: string | null; productId: string | null; normalizedUrl: string; isFixture: boolean; setCap: boolean; connector: { envConfigured: boolean; connected: boolean; needsAuthorisation: boolean; missingEnv: string[] } } }
```
**Errors**: `400 MISSING_URL` no url · `400 INVALID_URL` malformed/SSRF-guarded · `400 UNSUPPORTED_MARKETPLACE` unknown host · `429 RATE_LIMITED` · `503 IMPORT_CAP_SECRET_UNSET` prod secret missing (httpOnly import_cap cookie, 60-min TTL)

### `POST /api/claim/bind` — bind-claimed-store
**File**: `src/app/api/claim/bind/route.ts` · **Auth**: Seller session (manual `getSession` userType==="seller" check — deviation: 401 code is `UNAUTHENTICATED`, not requireSeller's `UNAUTHORIZED`; errors returned via `fail()`, envelope identical) · **Rate limit**: none
**Purpose**: Binds a generated/imported store to the seller after single-use claim-token (and OAuth) verification.
**Request**: body:
```ts
interface ClaimBindBody { jobId: string; claimToken: string; method?: "oauth_shopee" | "oauth_tiktok" | "claim_code"; evidence?: { connectionShopId?: string } }
```
**Response 200**:
```ts
interface ClaimBindResponse { data: { store: { id: string; name: string; slug: string } | null; nextStep: string } }
```
**Errors**: `401 UNAUTHENTICATED` · `400 MISSING_FIELDS`/`METHOD_MISMATCH`/`METHOD_UNAVAILABLE`/`VERIFICATION_REQUIRED` · `404 JOB_NOT_FOUND` · `409 ALREADY_CLAIMED`/`STORE_LIMIT` · `403 INVALID_CLAIM_TOKEN`/`OWNERSHIP_NOT_VERIFIED`

### `POST /api/store/inventory/adjust` — adjust stock
**File**: `src/app/api/store/inventory/adjust/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Atomic stock delta with CAS guard and InventoryLog; notifies seller on low stock.
**Request**: path: —; query: —; body:
```ts
interface InventoryAdjustBody { variantId: string; delta: number; reason?: string }
```
**Response 200**:
```ts
interface InventoryAdjustResponse { data: { id: string; stock: number; lowStock: boolean } }
```
**Errors**: `400 VALIDATION` missing variantId, non-integer/zero/oversized delta (|delta| ≤ 1,000,000) · `404 NOT_FOUND` variant not store-owned · `409 INSUFFICIENT_STOCK` CAS guard would push stock below 0

### `GET /api/store/pending-releases` — release schedule
**File**: `src/app/api/store/pending-releases/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Grace-period pending seller credits with summary and per-order release schedule.
**Request**: path: —; query: `page: number (1)`, `size: number (25, max 100 — default deviates from global 20)`
**Response 200**:
```ts
interface PendingReleasesResponse { data: { summary: { totalMinor: number; count: number; nextReleaseAt: string | null }; releases: { orderId: string; orderNumber: string; orderStatus: string; amountMinor: number; paidAt: string; availableAt: string; holdDays: number }[] }; meta: { page: number; size: number; total: number } }
```
**Errors**: `404 NOT_FOUND` seller wallet missing (okPaged with composite data — allowed deviation from array-only lists)

---

## §11 Seller Backend — Orders & Fulfillment

### `GET /api/store/orders` — seller order list
**File**: `src/app/api/store/orders/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Paged seller orders, filterable by status group, searchable by number/customer.
**Request**: path: `—`; query: `status: string ("all" — group unpaid|to_fulfill|shipped|done|refunds|cancelled, "all", or raw status)`; `search: string (—)`; `page: number (1)`; `size: number (20, max 100)`
**Response 200**:
```ts
interface OrdersListResponse {
  data: Array<{ id: string; orderNumber: string; customerName: string; customerEmail: string; status: string; channel: string; totalMinor: number; currency: string; itemCount: number; trackingNumber: string | null; createdAt: string; paidAt: string | null; shippedAt: string | null }>;
  meta: { page: number; size: number; total: number };
}
```
**Errors**: — none route-specific (auth/suspension per tier)

### `GET /api/store/orders/[id]` — order detail
**File**: `src/app/api/store/orders/[id]/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Full order detail: items, status history, payment intents, refunds.
**Request**: path: `id: string (order id or orderNumber)`; query: none
**Response 200**:
```ts
interface OrderDetailResponse {
  data: {
    id: string; storeId: string; orderNumber: string; customerName: string; customerEmail: string;
    customerPhone: string | null; cartToken: string | null; shopperId: string | null; status: string;
    disputedFlag: boolean; channel: string; currency: string; subtotalMinor: number; discountMinor: number;
    shippingMinor: number; taxMinor: number; totalMinor: number; couponCode: string | null;
    customerNote: string | null; paymentProvider: string | null; idemKey: string | null; voucherId: string | null;
    paidAt: string | null; fulfilledAt: string | null; shippedAt: string | null; deliveredAt: string | null;
    receivedAt: string | null; completedAt: string | null; cancelledAt: string | null;
    trackingNumber: string | null; trackingProvider: string | null; riskFlagsJson: string;
    shippingAddressJson: string; shippingAddress: Record<string, unknown>; latestPaymentRef: string | null;
    shippingCountryCode: string; shippingCountrySource: string; attrCampaignId: string | null; attrSource: string | null;
    attrMedium: string | null; attrCampaign: string | null; attrTerm: string | null; attrContent: string | null;
    createdAt: string; updatedAt: string; paymentGroupId: string | null;
    items: Array<{ id: string; orderId: string; productId: string | null; variantId: string | null; title: string; variantLabel: string | null; unitPriceMinor: number; qty: number; lineSubtotalMinor: number; discountMinor: number; shippingMinor: number; commissionPercent: number; commissionMinor: number; fixedFeeMinor: number; sellerNetMinor: number; breakdownJson: string; refundedMinor: number; affiliateDirectId: string | null; affiliateSponsorId: string | null; affiliateLinkId: string | null; affiliateRateBps: number | null; affiliatePoolMinor: number; affiliateSponsorEnabled: boolean | null }>;
    history: Array<{ id: string; orderId: string; fromStatus: string | null; toStatus: string; actor: string; note: string | null; createdAt: string }>;
    paymentIntents: Array<{ id: string; orderId: string; provider: string; providerRef: string; amountMinor: number; status: string; redirectUrl: string | null; expiresAt: string; createdAt: string; updatedAt: string }>;
    refunds: Array<{ id: string; orderId: string; amountMinor: number; reason: string | null; status: string; requestedBy: string; restock: boolean; commissionReversalMinor: number; affiliateReversalMinor: number; processedAt: string | null; createdAt: string; updatedAt: string }>;
  };
}
```
**Errors**: `404 NOT_FOUND` order not in caller's store

### `GET /api/store/orders/[id]/label` — AWB label stream
**File**: `src/app/api/store/orders/[id]/label/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Streams the platform-booked AWB label as decoded inline SVG.
**Request**: path: `id: string (order id or orderNumber)`; query: `download: "1" (attachment disposition)`
**Response 200** **(non-envelope)**: raw `image/svg+xml` body (decoded from `Shipment.labelUrl` data-URL); headers `Content-Disposition: inline|attachment; filename="AWB-<awb|orderNumber>.svg"`, `Cache-Control: private, max-age=3600`
**Errors**: `404 NOT_FOUND` order not found · `404 LABEL_NOT_FOUND` no platform shipping label

### `POST /api/store/orders/[id]/fulfill` — mark fulfilled
**File**: `src/app/api/store/orders/[id]/fulfill/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Transitions paid order to processing, stamps fulfilledAt.
**Request**: path: `id: string (order id or orderNumber)`; query: none; body: none (ignored)
**Response 200**:
```ts
interface FulfillResponse { data: { id: string; status: string; fulfilledAt: string } }
```
**Errors**: `404 NOT_FOUND` order not found · `409 INVALID_STATUS` status not paid|processing

### `POST /api/store/orders/[id]/refund-request` — request refund
**File**: `src/app/api/store/orders/[id]/refund-request/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Creates a refund request row; notifies admin, logs activity.
**Request**: path: `id: string (order id or orderNumber)`; query: none; body:
```ts
interface RefundRequestBody { amountMinor: number; reason?: string; restock?: boolean }
```
**Response 201**:
```ts
interface RefundRequestResponse {
  data: { id: string; orderId: string; amountMinor: number; reason: string | null; status: string; requestedBy: string; restock: boolean; commissionReversalMinor: number; affiliateReversalMinor: number; processedAt: string | null; createdAt: string; updatedAt: string };
}
```
**Errors**: `400 VALIDATION` amountMinor not positive finite · `404 NOT_FOUND` order · `409 INVALID_STATUS` non-refundable status · `409 INVALID_AMOUNT` exceeds refundable balance

### `POST /api/store/orders/[id]/ship` — ship order
**File**: `src/app/api/store/orders/[id]/ship/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Ships order via platform mock courier booking or manual tracking.
**Request**: path: `id: string (order id or orderNumber)`; query: none; body:
```ts
interface ShipBody { mode?: "platform" | "manual"; rateId?: string; providerId?: string; provider?: string; trackingNumber?: string }
```
**Response 200**:
```ts
interface ShipResponse {
  data: { id: string; status: string; shippedAt: string; trackingNumber: string; trackingProvider: string; shipmentStatus: string | null; shipment: { awbNumber: string | null; courierName: string | null; etaFrom: string | null; etaTo: string | null; labelUrl: string | null } | null };
}
```
**Errors**: `400 VALIDATION` missing provider+trackingNumber / rateId / bad providerId / bad mode · `404 NOT_FOUND` order · `404 RATE_NOT_FOUND` stale quote · `409 INVALID_STATUS` not paid|processing

### `POST /api/store/orders/[id]/deliver` — mark delivered
**File**: `src/app/api/store/orders/[id]/deliver/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: none
**Purpose**: Seller marks shipped order delivered, with optional proof image.
**Request**: path: `id: string (order id or orderNumber)`; query: none; body:
```ts
interface DeliverBody { proof?: string; note?: string }
```
**Response 200**:
```ts
interface DeliverResponse { data: { id: string; orderNumber: string; status: string; deliveredAt: string; shipmentStatus: string | null } }
```
**Errors**: `400 VALIDATION` proof not data:image/* URL · `413 PROOF_TOO_LARGE` proof >1.2MB · `404 NOT_FOUND` order · `409 INVALID_STATUS` status not shipped

---

## §12 Seller Backend — Insights & Analytics

All insights routes: `requireActiveSellerStore`, shared rate limit `insights (60/60s)`, 45s server cache bypassed by `fresh=1`, KL-timezone day bucketing.

### `GET /api/store/insights/sales` — sales report
**File**: `src/app/api/store/insights/sales/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: Authoritative sales cards, trend buckets, top products, fulfillment stats.
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"custom" ("30d")`; `from: string (YYYY-MM-DD, custom only)`; `to: string (YYYY-MM-DD, custom only, ≤92d span, KL days)`; `granularity: "day"|"week"|"month" ("day")`; `fresh: "1" (bypass 45s cache)`
**Response 200**:
```ts
interface SalesInsightsResponse {
  data: {
    window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
    generatedAt: string;
    cards: { paidOrders: number; paidOrdersPrev: number; unitsSold: number; unitsSoldPrev: number; grossSalesMinor: number; grossSalesMinorPrev: number; grossProductSalesMinor: number; grossProductSalesMinorPrev: number; discountsMinor: number; discountsMinorPrev: number; shippingChargedMinor: number; shippingChargedMinorPrev: number; sellerProceedsMinor: number; sellerProceedsMinorPrev: number; refundedItemsMinor: number; refundsMinor: number; refundsMinorPrev: number; refundCount: number; refundCountPrev: number; cancelledOrders: number; cancelledOrdersPrev: number; aovMinor: number | null; aovMinorPrev: number | null; netProductSalesMinor: number; visitToPurchaseRate: number | null };
    byDay: Array<{ bucket: string; grossSalesMinor: number; netProductSalesMinor: number; orders: number; units: number; refundsMinor: number }>;
    granularity: string;
    topProducts: Array<{ productId: string; title: string; units: number; netSalesMinor: number }>;
    fulfillment: { unfulfilledPaidOrders: number; avgPaidToShippedHours: number | null; shippedSample: number; note: string };
    notes: string[];
  };
}
```
**Errors**: `400 VALIDATION` bad granularity/window/from/to · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/product-traffic` — per-product traffic
**File**: `src/app/api/store/insights/product-traffic/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: Top-8 viewed products, or one product's traffic drill-down detail.
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"1y"|"custom" ("30d")`; `from: string (YYYY-MM-DD, custom only)`; `to: string (YYYY-MM-DD, custom only)`; `productId: string (—; ^[A-Za-z0-9_-]{1,64}$)`; `fresh: "1"`
**Response 200**:
```ts
interface ProductTrafficResponse {
  data: {
    window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
    generatedAt: string;
    topViewedProducts?: Array<{ productId: string; title: string; slug: string; imageUrl: string | null; views: number; uniqueViewers: number; cartAddTimes: number; cartAddUnits: number; cartRemoveTimes: number; cartRemoveUnits: number; purchaseOrders: number; purchaseUnits: number }>;
    truncated: boolean;
    product?: { id: string; title: string; slug: string; imageUrl: string | null };
    totals?: { views: number; uniqueViewers: number; cartAddTimes: number; cartAddUnits: number; cartRemoveTimes: number; cartRemoveUnits: number; purchaseOrders: number; purchaseUnits: number };
    channels?: Array<{ channel: string; views: number; sessions: number }>;
    referrers?: Array<{ host: string; views: number }>;
    byDay?: Array<{ day: string; views: number }>;
    notes?: string[];
  };
}
```
**Errors**: `400 VALIDATION` bad productId/window · `404 PRODUCT_NOT_FOUND` foreign/unknown product · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/products` — product performance table
**File**: `src/app/api/store/insights/products/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: Paged sortable product table: views, cart, purchases, revenue, conversion.
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"custom" ("30d")`; `from/to: string (custom only)`; `sort: "views"|"adds"|"cartQty"|"purchases"|"revenue"|"conversion" ("views")`; `page: number (1)`; `size: number (20, max 50)`; `fresh: "1"`
**Response 200**:
```ts
interface ProductPerformanceResponse {
  data: {
    rows: Array<{ productId: string; title: string; slug: string; imageUrl: string | null; status: string; views: number; viewSessions: number; addUnits: number; addEvents: number; currentCartUnits: number; currentCarts: number; orderedUnits: number; purchasedUnits: number; grossSalesMinor: number; netSalesMinor: number; refundedMinor: number; viewToCartRate: number | null; checkoutToPurchaseRate: number | null }>;
    meta: { page: number; size: number; total: number };
    notes: string[];
  };
  meta: { page: number; size: number; total };
}
```
**Errors**: `400 VALIDATION` bad sort/window · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/markets` — sales by geography
**File**: `src/app/api/store/insights/markets/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: Sales by destination country or recorded state, with movers.
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"custom" ("30d")`; `from/to: string (custom only)`; `dimension: "country"|"state" ("country")`; `fresh: "1"`
**Response 200**:
```ts
interface MarketsResponse {
  data: {
    window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
    generatedAt: string; dimension: "country" | "state";
    rows: Array<{ code: string; label: string; paidOrders: number; paidOrdersPrev: number; unitsSold: number; grossProductSalesMinor: number; discountsMinor: number; refundsMinor: number; netProductSalesMinor: number; shippingChargedMinor: number; aovMinor: number | null; shareNetPct: number | null; shareOrdersPct: number | null; growthPct: number | null; isNew: boolean; source: string }>;
    totals: { paidOrders: number; netProductSalesMinor: number };
    notes: string[];
    movers: { risers: Array<{ code: string; label: string; growthPct: number }>; fallers: Array<{ code: string; label: string; growthPct: number }> };
  };
}
```
**Errors**: `400 VALIDATION` bad dimension/window · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/markets/products` — products in market
**File**: `src/app/api/store/insights/markets/products/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: Product performance inside one geographic market (country/state).
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"custom" ("30d")`; `from/to: string (custom only)`; `dimension: "country"|"state" ("country")`; `code: string (required — country code or state name, ≤64 chars)`; `fresh: "1"`
**Response 200**:
```ts
interface MarketProductsResponse {
  data: {
    window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
    generatedAt: string; dimension: "country" | "state"; code: string; label: string;
    rows: Array<{ productId: string; title: string; slug: string; imageUrl: string | null; unitsSold: number; grossProductSalesMinor: number; discountsMinor: number; refundedMinor: number; netProductSalesMinor: number; paidOrders: number; avgSellingPriceMinor: number | null; views: number; addUnits: number }>;
    notes: string[];
  };
}
```
**Errors**: `400 VALIDATION` bad dimension/code/window · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/funnel` — conversion funnel
**File**: `src/app/api/store/insights/funnel/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: Store-wide or product-scoped funnel with per-day series and selector.
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"1y"|"custom" ("30d")`; `from/to: string (custom only)`; `productId: string (—; length 10–64)`; `fresh: "1"`
**Response 200**:
```ts
interface FunnelResponse {
  data: {
    scope: "store" | "product";
    product: { id: string; title: string; slug: string; imageUrl: string | null; unitsSold: number; revenueMinor: number; ordersPaid: number } | null;
    products: Array<{ productId: string; title: string; slug: string; imageUrl: string | null; views: number; cartAdds: number }>;
    productsTruncated: boolean;
    window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
    generatedAt: string;
    freshness: { eventsUpTo: string | null; trackingSince: string | null; note: string | null };
    stages: Array<{ key: string; label: string; count: number; prev: number; stepRate: number | null; dropOff: number | null; dropOffPct: number | null }>;
    byDay: Array<{ day: string; visits?: number; productViews: number; cartAdds: number; checkouts: number; paidOrders: number }>;
    truncated: boolean; paymentAttempts: number; paymentAttemptsPrev: number; basis: string[];
  };
}
```
**Errors**: `400 VALIDATION` bad productId/window · `404 NOT_FOUND` product not in store · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/cart` — cart activity + snapshot
**File**: `src/app/api/store/insights/cart/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: Historical cart add/remove events plus current live cart snapshot.
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"custom" ("30d")`; `from/to: string (custom only)`; `fresh: "1"`
**Response 200**:
```ts
interface CartInsightsResponse {
  data: {
    window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
    generatedAt: string;
    freshness: { eventsUpTo: string | null; trackingSince: string | null };
    period: { addEvents: number; addEventsPrev: number; addUnits: number; addUnitsPrev: number; removeEvents: number; removeEventsPrev: number; removeUnits: number; removeUnitsPrev: number; byDay: Array<{ day: string; addUnits: number; removeUnits: number }>; topAdded: Array<{ productId: string; title: string; imageUrl: string | null; addUnits: number; addEvents: number }> };
    current: { sampledAt: string; activeCarts: number; totalUnits: number; totalLines: number; ineligibleUnits: number; byProduct: Array<{ productId: string; title: string; slug: string; imageUrl: string | null; units: number; carts: number }>; eligibilityNote: string };
  };
}
```
**Errors**: `400 VALIDATION` bad window/from/to · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/campaigns` — campaign attribution
**File**: `src/app/api/store/insights/campaigns/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: First-party campaign + raw UTM attribution joined to paid orders.
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"custom" ("30d")`; `from/to: string (custom only)`; `fresh: "1"`
**Response 200**:
```ts
interface CampaignsResponse {
  data: {
    window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
    generatedAt: string;
    rows: Array<{ campaignId: string; name: string; slug: string; code: string; status: string; defaultSource: string | null; defaultMedium: string | null; createdAt: string; visits: number; visitSessions: number; productViews: number; addUnits: number; attributedOrders: number; paidOrders: number; paidOrdersPrev: number; grossSalesMinor: number; grossProductSalesMinor: number; aovMinor: number | null; conversionPct: number | null; firstEventAt: string | null }>;
    utmRows: Array<{ source: string; medium: string | null; campaign: string | null; visits: number; visitSessions: number; productViews: number; addUnits: number; attributedOrders: number; paidOrders: number; grossSalesMinor: number }>;
    totals: { campaigns: number; attributedVisits: number; attributedPaidOrders: number; attributedGrossSalesMinor: number; unclaimedPaidOrders: number; unclaimedGrossSalesMinor: number };
    notes: string[];
  };
}
```
**Errors**: `400 VALIDATION` bad window/from/to · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/overview` — store overview
**File**: `src/app/api/store/insights/overview/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights (60/60s)
**Purpose**: Traffic, funnel, summary cards and evidence-gated observations combined.
**Request**: path: `—`; query: `window: "today"|"7d"|"30d"|"custom" ("30d")`; `from/to: string (custom only)`; `fresh: "1"`
**Response 200**:
```ts
interface OverviewResponse {
  data: {
    window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number };
    generatedAt: string;
    freshness: { eventsUpTo: string | null; trackingSince: string | null; note: string | null };
    traffic: { storeViews: number; storeViewsPrev: number; sessions: number; sessionsPrev: number; uniqueVisitors: number; uniqueVisitorsPrev: number; productViews: number; productViewsPrev: number; byDay: Array<{ day: string; storeViews: number; productViews: number }>; channels: Array<{ channel: string; views: number; sessions: number }>; topViewedProducts: Array<{ productId: string; title: string; slug: string; imageUrl: string | null; views: number }>; truncated: boolean };
    funnel: { stages: Array<{ key: string; label: string; count: number; prev: number; stepRate: number | null; dropOff: number | null; dropOffPct: number | null }>; paymentAttempts: number; paymentAttemptsPrev: number; basis: string[] };
    summary: { orders: number; ordersPrev: number; unitsSold: number; unitsSoldPrev: number; grossSalesMinor: number; grossSalesMinorPrev: number; grossProductSalesMinor: number; netProductSalesMinor: number; refundsMinor: number; refundsMinorPrev: number; refundCount: number; aovMinor: number | null; aovMinorPrev: number | null; cartAddUnits: number; cartAddUnitsPrev: number; activeCartsNow: number; unitsInCartsNow: number; visitToPurchaseRate: number | null };
    observations: Array<{ kind: string; text: string }>;
  };
}
```
**Errors**: `400 VALIDATION` bad window/from/to · `429 RATE_LIMITED` throttle

### `GET /api/store/insights/export` — CSV export
**File**: `src/app/api/store/insights/export/route.ts` · **Auth**: requireActiveSellerStore · **Rate limit**: insights-export (20/60s)
**Purpose**: CSV download of products/markets/sales/overview insight reports.
**Request**: path: `—`; query: `type: "products"|"markets"|"sales"|"overview" ("products")`; `window: "today"|"7d"|"30d"|"custom" ("30d")`; `from/to: string (custom only)`; `dimension: "country"|"state" ("country", markets type only)`
**Response 200** **(non-envelope)**: `text/csv; charset=utf-8` body — header block (Store/Type/Window/Generated at/Currency) then type-specific rows; money columns in RM (minor÷100); `Content-Disposition: attachment; filename="nomofee-insights-<type>-<from..to>.csv"`, `Cache-Control: no-store`
**Errors**: `400 VALIDATION` bad type/dimension/window · `429 RATE_LIMITED` throttle

---

## §13 Seller Backend — Monetization

Wallet (ledger-truth), payouts, bank accounts (sealed), seller-side affiliate programme.

### `GET /api/store/affiliate` — affiliate-programme-state
**File**: `src/app/api/store/affiliate/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: Seller affiliate programme state: platform settings, store opt-in, default rate, enrollment counts.
**Request**: path: `—`; query: none; body: none
**Response 200**:
```ts
interface AffiliateProgrammeResponse {
  data: {
    programmeEnabled: boolean; maxRateBps: number; optIn: boolean; defaultRateBps: number;
    enrolledProducts: number; totalProducts: number;
  };
}
```
**Errors**: none beyond auth tier

### `PATCH /api/store/affiliate` — affiliate-programme-settings
**File**: `src/app/api/store/affiliate/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: store-affiliate-settings (20/min)
**Purpose**: Update store affiliate opt-in and default commission rate; applies to future orders only.
**Request**: path: `—`; query: none; body:
```ts
interface AffiliateSettingsBody { optIn?: boolean; defaultRateBps?: number }
```
**Response 200**:
```ts
interface AffiliateSettingsResponse {
  data: { optIn: boolean; defaultRateBps: number; maxRateBps: number };
}
```
**Errors**: `400 VALIDATION` defaultRateBps outside 0–maxRateBps · `403 AFFILIATE_DISABLED` programme paused platform-wide · `429 RATE_LIMITED`

### `GET /api/store/affiliate/products` — affiliate-product-list
**File**: `src/app/api/store/affiliate/products/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: List seller products with affiliate enrollment state and effective commission rates.
**Request**: path: `—`; query: `enrolled: "true"|"false" (optional)`, `q: string (optional, title contains)`, `page: number (1)`, `size: number (30, clamped 6–60)`; body: none
**Response 200** (inline pagination — `total`/`page` in `data`, no `meta`; size default 30/max 60 deviates from global 20/100):
```ts
interface AffiliateProductsResponse {
  data: {
    total: number; page: number; maxRateBps: number; storeOptIn: boolean; storeDefaultRateBps: number;
    products: { id: string; title: string; slug: string; status: string; priceMinor: number; affiliateEnabled: boolean; effectiveRateBps: number; rateSource: "product" | "store_default"; salesCount: number; image: string | null }[];
  };
}
```
**Errors**: none beyond auth tier

### `PATCH /api/store/affiliate/products/[id]` — affiliate-product-enroll
**File**: `src/app/api/store/affiliate/products/[id]/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: store-affiliate-product (60/min)
**Purpose**: Enroll/pause one owned product and set its per-product affiliate rate override.
**Request**: path: `id: string (product id)`; query: none; body:
```ts
interface AffiliateProductBody { enabled?: boolean; rateBps?: number | null }
```
**Response 200**:
```ts
interface AffiliateProductResponse {
  data: { id: string; affiliateEnabled: boolean; affiliateRateBps: number | null; effectiveRateBps: number };
}
```
**Errors**: `404 NOT_FOUND` product not in seller's store · `403 AFFILIATE_DISABLED` programme paused · `400 STORE_NOT_ENROLLED` enabling without store opt-in · `400 VALIDATION` rateBps outside 0–maxRateBps · `429 RATE_LIMITED`

### `GET /api/store/affiliate/report` — affiliate-performance-report
**File**: `src/app/api/store/affiliate/report/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: Seller-scoped affiliate report: clicks, commission pool, allocations, current liability, recent commissions.
**Request**: path: `—`; query: `days: number (30, clamped 1–180)`; body: none
**Response 200**:
```ts
interface AffiliateReportResponse {
  data: {
    enrolledCount: number; totalProducts: number; clicks: number; productViews: number; attributedOrders: number;
    eligibleSalesMinor: number; totalPoolMinor: number; directAllocationMinor: number; sponsorAllocationMinor: number;
    reversalMinor: number; currentLiabilityMinor: number; days: number;
    recentCommissions: { orderNumber: string; createdAt: string; status: string; baseMinor: number; rateBps: number; poolMinor: number; directMinor: number; sponsorMinor: number; reversedMinor: number }[];
  };
}
```
**Errors**: none beyond auth tier

### `GET /api/store/payouts` — payout-history
**File**: `src/app/api/store/payouts/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: Seller payout history (latest 50) with batch info and parsed statements.
**Request**: path: `—`; query: none; body: none
**Response 200** (list via `ok()` without `meta` — deviation from paged list envelope):
```ts
interface PayoutWithStatement {
  id: string; batchId: string | null; sellerId: string; walletId: string; referenceNo: string; amountMinor: number;
  status: string; method: string; bankAccountId: string | null; providerRef: string | null; statementJson: string;
  failReason: string | null; paidAt: string | null; createdAt: string; updatedAt: string;
  batch: { id: string; runType: string; status: string } | null;
  statement: { sellerName: string; periodFrom: string; periodTo: string; orderCount?: number; reconciled?: true; generatedAt?: string; lines: { label: string; amountMinor: number }[] };
}
interface PayoutsListResponse { data: PayoutWithStatement[] }
```
**Errors**: none beyond auth tier

### `POST /api/store/payouts` — payout-request-create
**File**: `src/app/api/store/payouts/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: Create seller-initiated payout request; Serializable one-open-request guard; notifies ops and seller.
**Request**: path: `—`; query: none; body:
```ts
interface PayoutRequestBody { amountMinor?: number; amount?: number | string }
```
(`amount` = major MYR units × 100)
**Response 200**:
```ts
interface PayoutRequestResponse {
  data: {
    payout: { id: string; batchId: string | null; sellerId: string; walletId: string; referenceNo: string; amountMinor: number; status: string; method: string; bankAccountId: string | null; providerRef: string | null; statementJson: string; failReason: string | null; paidAt: string | null; createdAt: string; updatedAt: string };
    message: string; storeName: string;
  };
}
```
**Errors**: `400 BAD_AMOUNT` invalid/≤0/non-integer · `400 BELOW_MINIMUM` under payout.min_minor · `400 NO_BANK_ACCOUNT` no destination on file · `400 INSUFFICIENT_BALANCE` exceeds ledger-truth available · `404 NOT_FOUND` wallet missing · `409 REQUEST_PENDING` open request exists · `409 CONFLICT` serialization retries exhausted

### `GET /api/store/wallet` — wallet-overview
**File**: `src/app/api/store/wallet/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: Ledger-truth wallet balances, 20 recent payable lines, 20 payouts, minimum payout, open request.
**Request**: path: `—`; query: none; body: none
**Response 200**:
```ts
interface WalletResponse {
  data: {
    wallet: { id: string; sellerId: string; currency: string; pendingMinor: number; availableMinor: number; reservedMinor: number; lifetimeEarnedMinor: number; lifetimeCommissionMinor: number; createdAt: string; updatedAt: string };
    recentLines: { id: string; txnId: string; accountCode: string; direction: string; amountMinor: number; currency: string; walletId: string | null; availableAt: string | null; memo: string | null; refType: string | null; refId: string | null; createdAt: string; txn: { id: string; txnType: string; description: string | null; occurredAt: string } }[];
    payouts: { id: string; batchId: string | null; sellerId: string; walletId: string; referenceNo: string; amountMinor: number; status: string; method: string; bankAccountId: string | null; providerRef: string | null; statementJson: string; failReason: string | null; paidAt: string | null; createdAt: string; updatedAt: string }[];
    minPayoutMinor: number;
    openRequest: { id: string; referenceNo: string; amountMinor: number; createdAt: string } | null;
  };
}
```
**Errors**: `404 NOT_FOUND` wallet row missing

### `GET /api/store/wallet/activity/[id]` — wallet-activity-detail
**File**: `src/app/api/store/wallet/activity/[id]/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: One ledger journal line with full double-entry legs and related order/payout/settlement object.
**Request**: path: `id: string (ledger line id)`; query: none; body: none
**Response 200**:
```ts
interface WalletActivityResponse {
  data: {
    line: { id: string; accountCode: string; direction: string; amountMinor: number; availableAt: string | null; memo: string | null; createdAt: string };
    txn: { id: string; txnType: string; refType: string | null; refId: string | null; description: string | null; occurredAt: string };
    walletAmountMinor: number;
    related: { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; paidAt: string | null; itemCount: number } | { kind: "payout"; payoutId: string; referenceNo: string; status: string; method: string; amountMinor: number; paidAt: string | null } | { kind: "settlement"; reference: string | null } | { kind: "wallet_adjustment"; reference: string | null } | null;
    journal: { id: string; accountCode: string; direction: string; amountMinor: number; availableAt: string | null; memo: string | null; isMine: boolean }[];
  };
}
```
**Errors**: `404 NOT_FOUND` wallet or ledger line missing · `403 FORBIDDEN` activity not on seller's wallet

### `GET /api/store/bank-accounts` — bank-account-list
**File**: `src/app/api/store/bank-accounts/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: List seller's masked payout destination bank accounts (masked fields only, never ciphertext).
**Request**: path: `—`; query: none; body: none
**Response 200** (unbounded list via `ok()` without `meta` — deviation from paged list envelope):
```ts
interface BankAccountPublic { id: string; holderName: string; bankName: string; accountNumberMasked: string; verified: boolean; createdAt: string }
interface BankAccountsListResponse { data: BankAccountPublic[] }
```
**Errors**: none beyond auth tier

### `POST /api/store/bank-accounts` — bank-account-create
**File**: `src/app/api/store/bank-accounts/route.ts` · **Auth**: requireActiveSellerStore() · **Rate limit**: none
**Purpose**: Add a payout bank account; full number AES-256-GCM sealed, only masked projection returned.
**Request**: path: `—`; query: none; body:
```ts
interface BankAccountBody { holderName: string; bankName: string; accountNumber: string }
```
**Response 201** (deviation: success status 201, not 200):
```ts
interface BankAccountCreatedResponse { data: BankAccountPublic }
```
**Errors**: `400 VALIDATION` missing fields / >100-char names / accountNumber not 5–31 digits · `503 SECRETBOX_NOT_CONFIGURED` production without IMPORT_TOKEN_ENC_KEY

---

## §14 Seller Backend — Store Configuration & Operations

### `PATCH /api/store/settings` — update-store-settings
**File**: `src/app/api/store/settings/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Whitelist-patch store profile, storefront display toggles, socials, URLs; optional Seller.marketplaceOptIn.
**Request**: path: `—`; query: —; body:
```ts
interface StoreSettingsBody { name?: string; tagline?: string | null; description?: string | null; supportEmail?: string | null; supportPhone?: string | null; whatsapp?: string | null; logoUrl?: string | null; bannerUrl?: string | null; social?: Record<string, string> | string; cardShowStars?: boolean; cardMetric?: "views" | "sold"; homeShowFeatured?: boolean; homeShowFresh?: boolean; homeFeaturedFirst?: boolean; marketplaceOptIn?: boolean }
```
**Response 200**:
```ts
interface StoreSettingsResponse { data: { id: string; name: string; tagline: string | null; updated: string[]; marketplaceOptIn?: boolean } }
```
**Errors**: `400 VALIDATION` empty name · bad cardMetric · bad logoUrl/bannerUrl/social URL · no editable fields · (tier: 401/403 ACCOUNT_SUSPENDED|ACCOUNT_TERMINATED/400 NO_STORE)

### `GET /api/store/terms` — seller-effective-platform-terms
**File**: `src/app/api/store/terms/route.ts` · **Auth**: Active seller + store · **Rate limit**: seller-terms (60/60s/IP)
**Purpose**: Effective commission %, fees, clearing hold, payout minimum, moderation window (seller override ?? global).
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface TermsResponse { data: { commissionPercent: number; commissionSource: "seller_override" | "global_default"; fixedFeeMinor: number; hasFixedFee: boolean; minCommissionMinor: number; hasMinCommission: boolean; holdDays: number; holdSource: "seller_override" | "global_default"; payoutMinMinor: number; moderationFirstN: number } }
```
**Errors**: `429 RATE_LIMITED` retryAfterSeconds in details · (tier auth errors)

### `GET /api/store/theme` — get-store-theme
**File**: `src/app/api/store/theme/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Store theme tokens (defaults merged over stored themeJson).
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface ThemeResponse { data: { theme: { primaryColor: string; accentColor: string; fontHeading: string; fontBody: string; radius: "none" | "sm" | "md" | "lg" | "full"; buttonStyle: "solid" | "outline" | "pill" } } }
```
**Errors**: (tier auth errors only)

### `PUT /api/store/theme` — merge-store-theme
**File**: `src/app/api/store/theme/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Merge submitted tokens over existing theme; unspecified tokens persist.
**Request**: path: `—`; query: —; body:
```ts
interface ThemeBody { theme: Record<string, unknown> }
```
**Response 200**:
```ts
interface ThemeResponse { data: { theme: { primaryColor: string; accentColor: string; fontHeading: string; fontBody: string; radius: "none" | "sm" | "md" | "lg" | "full"; buttonStyle: "solid" | "outline" | "pill" } } }
```
**Errors**: `400 VALIDATION` theme object required · (tier auth errors)

### `GET /api/store/seo` — store-and-product-seo
**File**: `src/app/api/store/seo/route.ts` · **Auth**: Seller session (manual getSession — deviation: 401 UNAUTHENTICATED, no active-store/suspension gate) · **Rate limit**: none
**Purpose**: Store-level SEO defaults plus up to 100 products with effective SEO fields, locks, warnings.
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface SeoResponse { data: { store: { seoTitle: string; seoDescription: string; ogImage: string | null; canonicalUrl: string | null; noindex: boolean; lockedFields: string[]; warnings: string[] }; products: { id: string; title: string; slug: string; status: string; image: string | null; seoTitle: string; seoDescription: string; ogImage: string | null; noindex: boolean; lockedFields: string[]; warnings: string[] }[] } }
```
**Errors**: `401 UNAUTHENTICATED` seller session required

### `PATCH /api/store/seo` — upsert-seo-meta
**File**: `src/app/api/store/seo/route.ts` · **Auth**: Seller session (manual getSession — deviation as above) · **Rate limit**: none
**Purpose**: Upsert store or product SEO; manages locked fields and propagates locks to product overridesJson.
**Request**: path: `—`; query: —; body:
```ts
interface SeoBody { target?: "store" | "product"; productId?: string; seoTitle?: string; seoDescription?: string; ogImage?: string | null; canonicalUrl?: string | null; noindex?: boolean; lock?: string[]; unlock?: string[] }
```
**Response 200**:
```ts
interface SeoSaveResponse { data: { id: string; seoTitle: string | null; seoDescription: string | null; ogImage: string | null; noindex: boolean; lockedFields: string[]; warnings: string[] } }
```
**Errors**: `400 MISSING_PRODUCT` productId required for product target · `404 PRODUCT_NOT_FOUND` not owned · `401 UNAUTHENTICATED` · (title sliced 60 / description 155 chars)

### `GET /api/store/card-style` — get-card-typography
**File**: `src/app/api/store/card-style/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Product-card typography tokens plus the curated font catalogue.
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface CardStyleResponse { data: { style: { nameFont: string; nameSize: string; nameAlign: string; priceFont: string; priceSize: string; priceAlign: string } | null; fonts: { id: string; label: string; kind: string }[] } }
```
**Errors**: (tier auth errors only)

### `PUT /api/store/card-style` — save-card-typography
**File**: `src/app/api/store/card-style/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Upsert product-card typography (all six enum-validated fields).
**Request**: path: `—`; query: —; body:
```ts
interface CardStyleBody { nameFont: string; nameSize: "sm" | "md" | "lg"; nameAlign: "left" | "center" | "right"; priceFont: string; priceSize: "sm" | "md" | "lg"; priceAlign: "left" | "center" | "right" }
```
**Response 200**:
```ts
interface CardStyleSaveResponse { data: { style: { nameFont: string; nameSize: string; nameAlign: string; priceFont: string; priceSize: string; priceAlign: string }; fontLabels: { name: string; price: string } } }
```
**Errors**: `400 BAD_FONT` unsupported font id · `400 BAD_SIZE` bad size vocabulary · `400 BAD_ALIGN` bad alignment · (tier auth errors)

### `GET /api/store/me` — seller-console-bootstrap
**File**: `src/app/api/store/me/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Seller + store + wallet + onboarding checklist/step + console stats in one payload.
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface MeResponse { data: { seller: { id: string; email: string; fullName: string; displayName: string; phone: string | null; status: string; kycStatus: string | null; riskTier: string | null; planCode: string | null; marketplaceOptIn: boolean; submittedAt: string | null; rejectReason: string | null; emailVerified: boolean; emailVerifiedAt: string | null }; store: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; bannerUrl: string | null; description: string | null; status: string; supportEmail: string | null; supportPhone: string | null; whatsapp: string | null; marketplaceOptIn: boolean; theme: string; cardShowStars: boolean; cardMetric: string; homeShowFeatured: boolean; homeShowFresh: boolean; homeFeaturedFirst: boolean }; wallet: { id: string; sellerId: string; currency: string; pendingMinor: number; availableMinor: number; reservedMinor: number; lifetimeEarnedMinor: number; lifetimeCommissionMinor: number; createdAt: string; updatedAt: string } | null; onboarding: { step: string; checklist: { profile: boolean; storeIdentity: boolean; kyc: boolean; bank: boolean; products: boolean } }; stats: { ordersCount: number; productCount: number; revenue30dMinor: number } } }
```
**Errors**: (tier auth errors only)

### `POST /api/store/publish` — publish-store
**File**: `src/app/api/store/publish/route.ts` · **Auth**: Seller session (manual getSession — deviation; own status gates below) · **Rate limit**: none
**Purpose**: Take store live after seller-approval and completeness gates; routes claimed→draft→live via state machine.
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface PublishResponse { data: { status: string; publishedAt: string } }
```
**Errors**: `401 UNAUTHENTICATED` · `404 NO_STORE` (deviation: 404, not 400) · `403 ACCOUNT_SUSPENDED | ACCOUNT_TERMINATED | SELLER_ONBOARDING | SELLER_PENDING_REVIEW | SELLER_REJECTED | SELLER_NOT_APPROVED` fail-closed approval gate · `422 PUBLISH_BLOCKED` with `{ blockers: string[] }` · `409 INVALID_STATE` store not draft/maintenance/claimed

### `POST /api/store/onboarding` — submit-kyc-review
**File**: `src/app/api/store/onboarding/route.ts` · **Auth**: Seller · **Rate limit**: none
**Purpose**: Submit seller for KYC review (status→pending_review), notify admin, audit-log.
**Request**: path: `—`; query: —; body:
```ts
interface OnboardingBody { action: "submit" }
```
**Response 200**:
```ts
interface OnboardingResponse { data: { status: string; submittedAt: string } }
```
**Errors**: `400 BAD_REQUEST` action must be "submit" · `401 UNAUTHORIZED` seller not found · `409 INVALID_STATUS` status not onboarding/rejected

### `GET /api/store/dashboard` — seller-dashboard
**File**: `src/app/api/store/dashboard/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Revenue cards (today/7d/30d), wallet snapshot, low stock, latest orders, pending actions.
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface Card { orders: number; revenueMinor: number; commissionMinor: number; netMinor: number }
interface DashboardResponse { data: { cards: { today: Card; "7d": Card; "30d": Card }; wallet: { availableMinor: number; pendingMinor: number }; lowStock: { id: string; name: string; optionValue: string | null; sku: string | null; stock: number; lowStockThreshold: number; productId: string; productTitle: string }[]; latestOrders: { id: string; orderNumber: string; customerName: string; status: string; totalMinor: number; itemCount: number; createdAt: string }[]; pendingActions: { unfulfilledPaidOrders: number; openRefundRequests: number; productsPendingReview: number } } }
```
**Errors**: (tier auth errors only)

### `GET /api/store/notifications` — seller-bell-feed
**File**: `src/app/api/store/notifications/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Latest 30 in-app NotificationLog rows (bounded, no pagination) plus 24h recentCount.
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface NotificationsResponse { data: { notifications: { id: string; subject: string; createdAt: string; event: string }[]; recentCount: number } }
```
**Errors**: (tier auth errors only)

### `GET /api/store/shipping/quote` — courier-rate-quote
**File**: `src/app/api/store/shipping/quote/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Deterministic mock courier rates for a store order's ship dialog (weight bands + zone).
**Request**: path: `—`; query: `orderId: string (required; order id or orderNumber)`; body: none
**Response 200**:
```ts
interface QuoteResponse { data: { orderId: string; orderNumber: string; orderStatus: string; shippedAt: string | null; shipment: { status: string; awbNumber: string | null; courierName: string | null; etaFrom: string | null; etaTo: string | null } | null; destination: { state: string; city: string; zone: "peninsular" | "east" }; parcel: { weightGrams: number; itemCount: number }; rates: { rateId: string; providerId: string; courierName: string; serviceLevel: string; priceMinor: number; etaFromDays: number; etaToDays: number }[] } }
```
**Errors**: `400 VALIDATION` orderId required · `404 NOT_FOUND` order not in store · (tier auth errors)

### `GET /api/store/cart-settings` — get-cart-drawer-config
**File**: `src/app/api/store/cart-settings/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Cart drawer configuration, resolved manual upsell picks, free-shipping default.
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface CartSettingsResponse { data: { settings: { layout: string; showFreeShippingBar: boolean; freeShipThresholdMinor: number; upsellEnabled: boolean; upsellMode: string; upsellTitle: string; upsellLimit: number; urgencyStockEnabled: boolean; urgencyStockThreshold: number; urgencyViewersEnabled: boolean; urgencyViewersMin: number; urgencyViewersMax: number; urgencyCountdownEnabled: boolean; urgencyCountdownMinutes: number; showOrderNote: boolean; showDiscountHint: boolean; checkoutLabel: string; showContinueShopping: boolean; stickyCta: boolean; trustBadges: string[] } | null; upsellPicked: { id: string; title: string; priceMinor: number; status: string }[]; freeShippingDefaultMinor: number } }
```
**Errors**: (tier auth errors only)

### `PUT /api/store/cart-settings` — save-cart-drawer-config
**File**: `src/app/api/store/cart-settings/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Upsert drawer config; coerces defaults/clamps, validates upsell picks against own catalogue.
**Request**: path: `—`; query: —; body:
```ts
interface CartSettingsBody { layout?: string; showFreeShippingBar?: boolean; freeShipThresholdMinor?: number; upsellEnabled?: boolean; upsellMode?: string; upsellProductIds?: string[]; upsellTitle?: string; upsellLimit?: number; urgencyStockEnabled?: boolean; urgencyStockThreshold?: number; urgencyViewersEnabled?: boolean; urgencyViewersMin?: number; urgencyViewersMax?: number; urgencyCountdownEnabled?: boolean; urgencyCountdownMinutes?: number; trustBadges?: string[]; showOrderNote?: boolean; showDiscountHint?: boolean; checkoutLabel?: string; showContinueShopping?: boolean; stickyCta?: boolean }
```
**Response 200**:
```ts
interface CartSettingsSaveResponse { data: { settings: { layout: string }; savedAt: string } }
```
**Errors**: `400 BAD_LAYOUT` layout vocabulary · `400 BAD_UPSELL_MODE` mode vocabulary · `400 BAD_UPSELL_PRODUCT` picks not own catalogue · (tier auth errors)

### `GET /api/store/integrations` — list-tracking-integrations
**File**: `src/app/api/store/integrations/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: All four supported providers with current config and enablement. List via ok() — array data, no meta (deviation).
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface IntegrationsResponse { data: { provider: string; config: Record<string, unknown>; isEnabled: boolean; updatedAt: string | null }[] }
```
**Errors**: (tier auth errors only)

### `PUT /api/store/integrations` — upsert-integration
**File**: `src/app/api/store/integrations/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Upsert one provider's config JSON and enabled flag.
**Request**: path: `—`; query: —; body:
```ts
interface IntegrationBody { provider: "meta_pixel" | "ga4" | "tiktok_pixel" | "gtm"; config?: Record<string, unknown> | string; isEnabled?: boolean }
```
**Response 200**:
```ts
interface IntegrationSaveResponse { data: { provider: string; config: Record<string, unknown>; isEnabled: boolean } }
```
**Errors**: `400 VALIDATION` provider must be one of the four · (tier auth errors)

### `GET /api/store/domains` — list-custom-domains
**File**: `src/app/api/store/domains/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Store's custom domains, newest first. List via ok() — array data, no meta (deviation).
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface DomainsResponse { data: { id: string; storeId: string; domain: string; mode: string; status: string; sslStatus: string; isPrimary: boolean; lastCheckedAt: string | null; errorReason: string | null; createdAt: string; updatedAt: string }[] }
```
**Errors**: (tier auth errors only)

### `POST /api/store/domains` — add-custom-domain
**File**: `src/app/api/store/domains/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Connect a hostname via cname or ns mode; starts verifying/pending. Success status 201.
**Request**: path: `—`; query: —; body:
```ts
interface DomainBody { domain: string; mode: "cname" | "ns" }
```
**Response 201**:
```ts
interface DomainResponse { data: { id: string; storeId: string; domain: string; mode: string; status: string; sslStatus: string; isPrimary: boolean; lastCheckedAt: string | null; errorReason: string | null; createdAt: string; updatedAt: string } }
```
**Errors**: `400 VALIDATION` invalid hostname or mode · `409 DOMAIN_TAKEN` globally unique domain · (tier auth errors)

### `DELETE /api/store/domains/[id]` — delete-custom-domain
**File**: `src/app/api/store/domains/[id]/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Delete one of the store's custom domains.
**Request**: path: `id: string`; query: —; body: none
**Response 200**:
```ts
interface DomainDeleteResponse { data: { id: string; deleted: boolean } }
```
**Errors**: `404 NOT_FOUND` domain not in store · (tier auth errors)

### `POST /api/store/domains/[id]/verify` — verify-custom-domain
**File**: `src/app/api/store/domains/[id]/verify/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Sandbox DNS verify: instantly activates domain, issues SSL, notifies, audits.
**Request**: path: `id: string`; query: —; body: none
**Response 200**:
```ts
interface DomainVerifyResponse { data: { id: string; storeId: string; domain: string; mode: string; status: string; sslStatus: string; isPrimary: boolean; lastCheckedAt: string; errorReason: string | null; createdAt: string; updatedAt: string } }
```
**Errors**: `404 NOT_FOUND` domain not in store · (tier auth errors)

### `GET /api/store/webhooks` — list-webhook-endpoints
**File**: `src/app/api/store/webhooks/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Endpoints with masked secrets and last 10 deliveries. List via ok() — array data, no meta (deviation).
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface Delivery { id: string; endpointId: string; event: string; payloadJson: string; status: string; attempts: number; responseCode: number | null; lastAttemptAt: string | null; createdAt: string }
interface WebhooksResponse { data: { id: string; url: string; secretMasked: string; events: string[]; isActive: boolean; createdAt: string; deliveries: Delivery[] }[] }
```
**Errors**: (tier auth errors only)

### `POST /api/store/webhooks` — create-webhook-endpoint
**File**: `src/app/api/store/webhooks/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Create endpoint with generated signing secret; plaintext secret revealed exactly once. Success status 201.
**Request**: path: `—`; query: —; body:
```ts
interface WebhookBody { url: string; events?: string[] }
```
**Response 201**:
```ts
interface WebhookCreateResponse { data: { id: string; url: string; secret: string; events: string[]; isActive: boolean; deliveries: never[] } }
```
**Errors**: `400 VALIDATION` url must be http(s) · (tier auth errors) · (events default: ["order.paid","order.shipped","order.refunded"])

### `PATCH /api/store/webhooks/[id]` — update-webhook-endpoint
**File**: `src/app/api/store/webhooks/[id]/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Partially update url/events/isActive; secret stays masked.
**Request**: path: `id: string`; query: —; body:
```ts
interface WebhookPatchBody { url?: string; events?: string[]; isActive?: boolean }
```
**Response 200**:
```ts
interface WebhookPatchResponse { data: { id: string; url: string; secretMasked: string; events: string[]; isActive: boolean } }
```
**Errors**: `400 VALIDATION` bad url or empty events · `404 NOT_FOUND` endpoint not in store · (tier auth errors)

### `DELETE /api/store/webhooks/[id]` — delete-webhook-endpoint
**File**: `src/app/api/store/webhooks/[id]/route.ts` · **Auth**: Active seller + store · **Rate limit**: none
**Purpose**: Delete one of the store's webhook endpoints.
**Request**: path: `id: string`; query: —; body: none
**Response 200**:
```ts
interface WebhookDeleteResponse { data: { id: string; deleted: boolean } }
```
**Errors**: `404 NOT_FOUND` endpoint not in store · (tier auth errors)

### `POST /api/store/webhooks/[id]/rotate` — rotate-webhook-secret
**File**: `src/app/api/store/webhooks/[id]/rotate/route.ts` · **Auth**: Active seller + store · **Rate limit**: webhook-rotate (10/60s/IP)
**Purpose**: Replace signing secret; new plaintext returned exactly once; conditional updateMany is store-scoped.
**Request**: path: `id: string`; query: —; body: none
**Response 200**:
```ts
interface WebhookRotateResponse { data: { id: string; secret: string } }
```
**Errors**: `404 NOT_FOUND` endpoint not in store (checked twice: pre-read + updateMany count) · `429 RATE_LIMITED` · (tier auth errors)

### `GET /api/store/connections` — list-marketplace-connections
**File**: `src/app/api/store/connections/route.ts` · **Auth**: Seller session (manual getSession — deviation: 401 UNAUTHENTICATED, no active-store gate) · **Rate limit**: none
**Purpose**: Store-scoped marketplace connections (never tokens) plus per-platform env status.
**Request**: path: `—`; query: —; body: none
**Response 200**:
```ts
interface ConnectionsResponse { data: { connections: { id: string; platform: string; status: string; envConfigured: boolean; shopId: string | null; shopName: string | null; region: string | null; expiresAt: string | null; lastRefreshAt: string | null; lastError: string | null; createdAt: string }[]; env: { shopee: boolean; tiktok: boolean } } }
```
**Errors**: `401 UNAUTHENTICATED` seller session required · (no store → empty list, not an error)

### `GET /api/store/connections/[platform]/begin` — begin-oauth-flow
**File**: `src/app/api/store/connections/[platform]/begin/route.ts` · **Auth**: Seller session (manual getSession; platform validated BEFORE auth) · **Rate limit**: none
**Purpose**: Start marketplace OAuth: persist state nonce (Setting, 10-min TTL), return authorize URL.
**Request**: path: `platform: "shopee" | "tiktok"`; query: —; body: none
**Response 200**:
```ts
interface BeginResponse { data: { authorizeUrl: string | null; state: string; envConfigured: boolean } }
```
**Errors**: `400 INVALID_PLATFORM` platform must be shopee or tiktok · `401 UNAUTHENTICATED` seller session required

### `DELETE /api/store/connections/disconnect` — disconnect-marketplace
**File**: `src/app/api/store/connections/disconnect/route.ts` · **Auth**: Seller session (manual getSession — deviation as above) · **Rate limit**: none
**Purpose**: Soft-disconnect all the seller's store-scoped connections for a platform (audited).
**Request**: path: `—`; query: `platform: "shopee" | "tiktok" | "fixture" (required)`; body: none
**Response 200**:
```ts
interface DisconnectResponse { data: { disconnected: number } }
```
**Errors**: `400 INVALID_PLATFORM` unsupported platform · `401 UNAUTHENTICATED` seller session required

---

## §15 Admin — Sellers, KYC & Marketplace Moderation

Admin sessions via `requireAdmin()` (+RBAC caps). Shared row shapes referenced below:

```ts
interface SellerRow { id: string; email: string; fullName: string; displayName: string; countryCode: string; phone: string | null; status: string; riskTier: string; commissionOverridePercent: number | null; holdDaysOverride: number | null; kycStatus: string; planCode: string; marketplaceOptIn: boolean; rejectReason: string | null; submittedAt: string | null; approvedAt: string | null; createdAt: string; updatedAt: string }
interface StoreRow { id: string; sellerId: string | null; name: string; slug: string; tagline: string | null; logoUrl: string | null; bannerUrl: string | null; description: string | null; status: string; lifecycleSource: string; currency: string; timezone: string; themeJson: string; supportEmail: string | null; supportPhone: string | null; whatsapp: string | null; socialJson: string; templateKey: string; cardShowStars: boolean; cardMetric: string; homeShowFeatured: boolean; homeShowFresh: boolean; homeFeaturedFirst: boolean; fsPriceAdjustMinor: number; affiliateOptIn: boolean; affiliateDefaultRateBps: number; createdAt: string; updatedAt: string }
interface WalletRow { id: string; sellerId: string; currency: string; pendingMinor: number; availableMinor: number; reservedMinor: number; lifetimeEarnedMinor: number; lifetimeCommissionMinor: number; createdAt: string; updatedAt: string }
interface KycDocRow { id: string; sellerId: string; docType: string; fileName: string; status: string; rejectReason: string | null; reviewedBy: string | null; reviewedAt: string | null; createdAt: string }
interface SellerNoteRow { id: string; sellerId: string; author: string; body: string; createdAt: string }
```

### `GET /api/admin/sellers` — seller directory
**File**: `src/app/api/admin/sellers/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: Paginated seller directory with status/riskTier/search filters and 30-day GMV stats per store.
**Request**: path: —; query: `status: string (optional; "all" or absent = no filter)`, `riskTier: string (optional; "all" = no filter)`, `search: string (optional; matches email/fullName/displayName/store name/slug)`, `page: number (1)`, `size: number (20, max 100)`
**Response 200**:
```ts
interface AdminSellersResponse { data: (SellerRow & { store: (StoreRow & { gmv30dMinor: number; orders30d: number }) | null; wallet: WalletRow | null })[]; meta: { page: number; size: number; total: number } }
```
**Errors**: none notable (standard 401/403 auth)

### `GET /api/admin/sellers/[id]` — seller dossier
**File**: `src/app/api/admin/sellers/[id]/route.ts` · **Auth**: requireAnyCap sellers.approve | commission.manage (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Full seller dossier: profile, store, KYC docs, masked banks, wallet, recent products/orders, notes, GMV stats.
**Request**: path: `id`
**Response 200**:
```ts
interface AdminSellerDetailResponse { data: { seller: SellerDetail; store: StoreRow | null; kycDocuments: KycDocRow[]; bankAccounts: BankAcctRow[]; wallet: WalletRow | null; products: (ProductRow & { images: ProductImageRow[]; category: CategoryRow | null })[]; orders: OrderRow[]; notes: SellerNoteRow[]; gmv30dMinor: number; orders30d: number; productCount: number } }
interface SellerDetail extends SellerRow { emailVerifiedAt: string | null; store: StoreRow | null; wallet: WalletRow | null; kycDocuments: KycDocRow[]; bankAccounts: BankAcctRow[]; sellerNotes: SellerNoteRow[] }
interface BankAcctRow { id: string; holderName: string; bankName: string; accountNumberMasked: string; verified: boolean; verifiedAt: string | null; createdAt: string }
interface ProductRow { id: string; storeId: string; categoryId: string | null; storeCategoryId: string | null; title: string; slug: string; description: string | null; status: string; rejectReason: string | null; priceMinor: number; commissionPercentOverride: number | null; flagsJson: string; reportsCount: number; salesCount: number; viewCount: number; ratingAvg: number; ratingCount: number; isFeatured: boolean; publishedAt: string | null; sourcePlatform: string | null; sourceShopId: string | null; sourceProductId: string | null; sourceUrl: string | null; sourceBrand: string | null; sourceStatus: string | null; isFixture: boolean; lastSyncedAt: string | null; overridesJson: string; affiliateEnabled: boolean; affiliateRateBps: number | null; seoTitle: string | null; seoDescription: string | null; createdAt: string; updatedAt: string }
interface ProductImageRow { id: string; productId: string; url: string; sortOrder: number; alt: string | null }
interface CategoryRow { id: string; name: string; slug: string; parentId: string | null; commissionPercent: number | null; imageUrl: string | null; sortOrder: number; createdAt: string; updatedAt: string }
interface OrderRow { id: string; storeId: string; orderNumber: string; customerName: string; customerEmail: string; customerPhone: string | null; cartToken: string | null; shopperId: string | null; status: string; disputedFlag: boolean; channel: string; currency: string; subtotalMinor: number; discountMinor: number; shippingMinor: number; taxMinor: number; totalMinor: number; couponCode: string | null; shippingAddressJson: string; customerNote: string | null; paymentProvider: string | null; idemKey: string | null; paidAt: string | null; fulfilledAt: string | null; shippedAt: string | null; deliveredAt: string | null; receivedAt: string | null; completedAt: string | null; cancelledAt: string | null; trackingNumber: string | null; trackingProvider: string | null; riskFlagsJson: string; voucherId: string | null; shippingCountryCode: string; shippingCountrySource: string; attrCampaignId: string | null; attrSource: string | null; attrMedium: string | null; attrCampaign: string | null; attrTerm: string | null; attrContent: string | null; createdAt: string; updatedAt: string; paymentGroupId: string | null }
```
**Errors**: `404 NOT_FOUND` seller missing

### `PATCH /api/admin/sellers/[id]` — update seller policy
**File**: `src/app/api/admin/sellers/[id]/route.ts` · **Auth**: requireAdmin; if body carries riskTier/commissionOverridePercent/holdDaysOverride → requireCap commission.manage (superadmin | finance) · **Rate limit**: none
**Purpose**: Update risk tier, commission/hold overrides, or marketplace opt-in; audited.
**Request**: path: `id`; body:
```ts
interface SellerPatchBody { riskTier?: "low" | "medium" | "high"; commissionOverridePercent?: number | null; holdDaysOverride?: number | null; marketplaceOptIn?: boolean }
```
**Response 200**:
```ts
interface SellerPatchResponse { data: SellerRow }
```
**Errors**: `400 VALIDATION` bad riskTier/range/empty body · `400 BAD_JSON` malformed body · `404 NOT_FOUND` seller missing

### `GET /api/admin/sellers/[id]/notes` — seller notes list
**File**: `src/app/api/admin/sellers/[id]/notes/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: List internal admin notes for a seller, newest first (unpaged ok() list — no meta).
**Request**: path: `id`
**Response 200**:
```ts
interface SellerNotesResponse { data: SellerNoteRow[] }
```
**Errors**: none notable

### `POST /api/admin/sellers/[id]/notes` — add seller note
**File**: `src/app/api/admin/sellers/[id]/notes/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: Add an internal admin note authored by the admin; audited.
**Request**: path: `id`; body:
```ts
interface SellerNoteBody { body: string }
```
**Response 200**:
```ts
interface SellerNoteResponse { data: SellerNoteRow }
```
**Errors**: `400 VALIDATION` body required · `400 BAD_JSON` malformed body · `404 NOT_FOUND` seller missing

### `POST /api/admin/sellers/[id]/suspend` — suspend seller
**File**: `src/app/api/admin/sellers/[id]/suspend/route.ts` · **Auth**: requireCap sellers.suspend (superadmin | ops) · **Rate limit**: none
**Purpose**: Suspend active seller: store to draft, revoke sessions, notify, audit.
**Request**: path: `id`; body:
```ts
interface SuspendBody { reason?: string }
```
**Response 200**:
```ts
interface SellerSuspendResponse { data: SellerFullRow & { sessionsRevoked: number } }
interface SellerFullRow extends SellerRow { emailVerifiedAt: string | null }
```
**Errors**: `404 NOT_FOUND` seller missing · `409 CONFLICT` seller not active / store lifecycle blocks takedown

### `POST /api/admin/sellers/[id]/approve` — approve seller
**File**: `src/app/api/admin/sellers/[id]/approve/route.ts` · **Auth**: requireCap sellers.approve (superadmin | ops) · **Rate limit**: none
**Purpose**: Approve seller: active + KYC approved + store live, notify, audit.
**Request**: path: `id`; body: none
**Response 200**:
```ts
interface SellerApproveResponse { data: SellerFullRow }
```
**Errors**: `404 NOT_FOUND` seller missing · `409 CONFLICT` terminated seller / store cannot go live

### `POST /api/admin/sellers/[id]/activate` — reactivate seller
**File**: `src/app/api/admin/sellers/[id]/activate/route.ts` · **Auth**: requireCap sellers.suspend (superadmin | ops) · **Rate limit**: none
**Purpose**: Reactivate suspended seller: status active, store to live, notify, audit.
**Request**: path: `id`; body: none
**Response 200**:
```ts
interface SellerActivateResponse { data: SellerFullRow }
```
**Errors**: `404 NOT_FOUND` seller missing · `409 CONFLICT` terminated/rejected seller / store cannot go live

### `POST /api/admin/sellers/[id]/reject` — reject seller
**File**: `src/app/api/admin/sellers/[id]/reject/route.ts` · **Auth**: requireCap sellers.approve (superadmin | ops) · **Rate limit**: none
**Purpose**: Reject non-active seller: store to draft, sessions revoked, reason stored.
**Request**: path: `id`; body:
```ts
interface SellerRejectBody { reason: string }
```
**Response 200**:
```ts
interface SellerRejectResponse { data: SellerFullRow & { sessionsRevoked: number } }
```
**Errors**: `400 VALIDATION` reason required · `400 BAD_JSON` malformed body · `404 NOT_FOUND` seller missing · `409 CONFLICT` active seller / store lifecycle

### `POST /api/admin/sellers/[id]/terminate` — terminate seller
**File**: `src/app/api/admin/sellers/[id]/terminate/route.ts` · **Auth**: requireCap sellers.suspend (superadmin | ops) · **Rate limit**: none
**Purpose**: Terminate seller: store to draft, sessions revoked, notify, audit.
**Request**: path: `id`; body:
```ts
interface TerminateBody { reason?: string }
```
**Response 200**:
```ts
interface SellerTerminateResponse { data: SellerFullRow & { sessionsRevoked: number } }
```
**Errors**: `404 NOT_FOUND` seller missing · `409 CONFLICT` already terminated / store lifecycle

### `POST /api/admin/sellers/[id]/kyc/[docId]` — review KYC document
**File**: `src/app/api/admin/sellers/[id]/kyc/[docId]/route.ts` · **Auth**: requireCap sellers.approve (superadmin | ops) · **Rate limit**: none
**Purpose**: Approve/reject one KYC document; may auto-flip seller.kycStatus to approved.
**Request**: path: `id`, `docId`; body:
```ts
interface KycDecisionBody { decision: "approved" | "rejected"; reason?: string }
```
**Response 200**:
```ts
interface KycDecisionResponse { data: { doc: KycDocRow; sellerKycStatus: string | null } }
```
**Errors**: `400 VALIDATION` bad decision / reason required on reject · `400 BAD_JSON` malformed body · `404 NOT_FOUND` doc not found for seller · `409 CONFLICT` document already decided

### `GET /api/admin/stores` — store overview
**File**: `src/app/api/admin/stores/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: List all stores with seller summary, product/order/page counts, 30-day GMV (unpaged ok() list).
**Request**: path: —; query: `search: string (optional; matches name/slug/seller email)`
**Response 200**:
```ts
interface AdminStoresResponse { data: { id: string; name: string; slug: string; status: string; tagline: string | null; createdAt: string; seller: { id: string; email: string; fullName: string; displayName: string; status: string; riskTier: string } | null; productCount: number; orderCount: number; pageCount: number; gmv30dMinor: number }[] }
```
**Errors**: none notable

### `GET /api/admin/kyc-queue` — KYC review queue
**File**: `src/app/api/admin/kyc-queue/route.ts` · **Auth**: requireCap sellers.approve (superadmin | ops) · **Rate limit**: none
**Purpose**: Pending-review sellers with KYC docs, masked banks, wallet, product count (unpaged ok() list).
**Request**: path: —; query: —
**Response 200**:
```ts
interface KycQueueResponse { data: { id: string; email: string; fullName: string; displayName: string; phone: string | null; status: string; kycStatus: string; riskTier: string; submittedAt: string | null; createdAt: string; store: { id: string; name: string; slug: string; productCount: number } | null; docs: KycDocRow[]; docsApproved: number; docsTotal: number; banks: { id: string; bankName: string; holderName: string; accountNumberMasked: string; verified: boolean }[]; wallet: WalletRow | null }[] }
```
**Errors**: none notable

### `GET /api/admin/orders` — order list
**File**: `src/app/api/admin/orders/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: Paginated order list with store, item count, summed commission.
**Request**: path: —; query: `status: string (optional; "all" = no filter)`, `storeId: string (optional)`, `search: string (optional; orderNumber/customerName/customerEmail/store name)`, `page: number (1)`, `size: number (20, max 100)`
**Response 200**:
```ts
interface AdminOrdersResponse { data: (OrderRow & { store: { id: string; name: string; slug: string }; itemsCount: number; commissionMinor: number })[]; meta: { page: number; size: number; total: number } }
```
**Errors**: none notable

### `GET /api/admin/orders/[id]` — order dossier
**File**: `src/app/api/admin/orders/[id]/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: Full order dossier: items, history, payment intents, refunds, disputes, seller, wallet.
**Request**: path: `id`
**Response 200**:
```ts
interface AdminOrderDetailResponse { data: { order: OrderRow & { store: StoreRow & { seller: { id: string; email: string; fullName: string; displayName: string } | null } }; items: OrderItemRow[]; history: OrderHistoryRow[]; paymentIntents: PaymentIntentRow[]; refunds: RefundRow[]; dispute: DisputeRow | null; disputes: DisputeRow[]; seller: { id: string; email: string; fullName: string; displayName: string } | null; store: { id: string; name: string; slug: string }; wallet: WalletRow | null } }
interface OrderItemRow { id: string; orderId: string; productId: string | null; variantId: string | null; title: string; variantLabel: string | null; unitPriceMinor: number; qty: number; lineSubtotalMinor: number; discountMinor: number; shippingMinor: number; commissionPercent: number; commissionMinor: number; fixedFeeMinor: number; sellerNetMinor: number; breakdownJson: string; refundedMinor: number; affiliateDirectId: string | null; affiliateSponsorId: string | null; affiliateLinkId: string | null; affiliateRateBps: number | null; affiliatePoolMinor: number; affiliateSponsorEnabled: boolean | null }
interface OrderHistoryRow { id: string; orderId: string; fromStatus: string | null; toStatus: string; actor: string; note: string | null; createdAt: string }
interface PaymentIntentRow { id: string; orderId: string; provider: string; providerRef: string; amountMinor: number; status: string; redirectUrl: string | null; expiresAt: string; createdAt: string; updatedAt: string }
interface RefundRow { id: string; orderId: string; amountMinor: number; reason: string | null; status: string; requestedBy: string; restock: boolean; commissionReversalMinor: number; affiliateReversalMinor: number; processedAt: string | null; createdAt: string; updatedAt: string }
interface DisputeRow { id: string; orderId: string; reason: string; status: string; openedBy: string; resolution: string | null; resolvedAt: string | null; createdAt: string; updatedAt: string }
```
**Errors**: `404 NOT_FOUND` order missing

### `GET /api/admin/disputes` — dispute list
**File**: `src/app/api/admin/disputes/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: Paginated dispute list with slim order context.
**Request**: path: —; query: `status: string (optional; "all" = no filter)`, `page: number (1)`, `size: number (20, max 100)`
**Response 200**:
```ts
interface AdminDisputesResponse { data: (DisputeRow & { order: { id: string; orderNumber: string; status: string; totalMinor: number; customerName: string; customerEmail: string; store: { id: string; name: string; slug: string } } })[]; meta: { page: number; size: number; total: number } }
```
**Errors**: none notable

### `PATCH /api/admin/disputes/[id]` — update dispute
**File**: `src/app/api/admin/disputes/[id]/route.ts` · **Auth**: requireCap disputes.manage (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Update dispute status/resolution; resolving clears the order dispute flag.
**Request**: path: `id`; body:
```ts
interface DisputePatchBody { status: "open" | "under_review" | "resolved" | "rejected"; resolution?: string }
```
**Response 200**:
```ts
interface DisputePatchResponse { data: DisputeRow }
```
**Errors**: `400 VALIDATION` bad status / resolution required when resolving-rejecting · `400 BAD_JSON` malformed body · `404 NOT_FOUND` dispute missing

### `GET /api/admin/refunds` — refund queue list
**File**: `src/app/api/admin/refunds/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: Paginated refund queue with order/store context.
**Request**: path: —; query: `status: string (optional; "all" = no filter)`, `page: number (1)`, `size: number (20, max 100)`
**Response 200**:
```ts
interface AdminRefundsResponse { data: (RefundRow & { order: { id: string; orderNumber: string; status: string; totalMinor: number; currency: string; customerName: string; customerEmail: string; store: { id: string; name: string; slug: string } } })[]; meta: { page: number; size: number; total: number } }
```
**Errors**: none notable

### `POST /api/admin/refunds/[id]/process` — process refund
**File**: `src/app/api/admin/refunds/[id]/process/route.ts` · **Auth**: requireCap refunds.manage (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Post ledger refund T5 with order/item/stock updates atomically; notify, webhooks, audit.
**Request**: path: `id`; body: none
**Response 200**:
```ts
interface RefundProcessResponse { data: { refund: RefundRow; txnId: string; orderStatus: "refunded" | "partially_refunded"; totalRefundedMinor: number } }
```
**Errors**: `400 NO_WALLET` seller wallet missing · `400 NO_ITEMS` nothing refundable · `404 NOT_FOUND` refund/order missing · `409 ALREADY_PROCESSED` replay · `409 NOT_APPROVED` not approved yet · `409 CONFLICT` rejected refund · `409 OVER_REFUND` cumulative cap · `409 INSUFFICIENT_WALLET` ledger balance too low

### `POST /api/admin/refunds/[id]/approve` — approve refund
**File**: `src/app/api/admin/refunds/[id]/approve/route.ts` · **Auth**: requireCap refunds.manage (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Flip requested refund to approved — status-only claim, no money moves.
**Request**: path: `id`; body: none
**Response 200**:
```ts
interface RefundApproveResponse { data: RefundRow }
```
**Errors**: `404 NOT_FOUND` refund missing · `409 CONFLICT` not in requested state (incl. concurrent)

### `POST /api/admin/refunds/[id]/reject` — reject refund
**File**: `src/app/api/admin/refunds/[id]/reject/route.ts` · **Auth**: requireCap refunds.manage (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Conditionally reject a requested/approved refund; no money moves.
**Request**: path: `id`; body:
```ts
interface RefundRejectBody { reason?: string }
```
**Response 200**:
```ts
interface RefundRejectResponse { data: RefundRow }
```
**Errors**: `404 NOT_FOUND` refund missing · `409 CONFLICT` processed or otherwise non-rejectable state

### `GET /api/admin/products` — product list
**File**: `src/app/api/admin/products/route.ts` · **Auth**: requireAdmin (any admin role) · **Rate limit**: none
**Purpose**: Paginated product list with first image, store, category, parsed flags.
**Request**: path: —; query: `status: string (optional; e.g. pending_review; "all" = no filter)`, `search: string (optional; title/slug/store name)`, `storeId: string (optional)`, `page: number (1)`, `size: number (20, max 100)`
**Response 200**:
```ts
interface AdminProductsResponse { data: (Omit<ProductRow, "flagsJson"> & { flags: string[]; images: ProductImageRow[]; store: { id: string; name: string; slug: string; status: string }; category: { id: string; name: string } | null })[]; meta: { page: number; size: number; total: number } }
```
**Errors**: none notable

### `POST /api/admin/products/[id]/approve` — approve product
**File**: `src/app/api/admin/products/[id]/approve/route.ts` · **Auth**: requireCap products.moderate (superadmin | ops | moderator) · **Rate limit**: none
**Purpose**: Approve product: status active, publish, notify seller, audit.
**Request**: path: `id`; body: none
**Response 200**:
```ts
interface ProductApproveResponse { data: ProductRow }
```
**Errors**: `404 NOT_FOUND` product missing

### `POST /api/admin/products/[id]/reject` — reject product
**File**: `src/app/api/admin/products/[id]/reject/route.ts` · **Auth**: requireCap products.moderate (superadmin | ops | moderator) · **Rate limit**: none
**Purpose**: Reject product with reason, notify seller, audit.
**Request**: path: `id`; body:
```ts
interface ProductRejectBody { reason?: string }
```
**Response 200**:
```ts
interface ProductRejectResponse { data: ProductRow }
```
**Errors**: `404 NOT_FOUND` product missing

### `POST /api/admin/products/[id]/ban` — ban product
**File**: `src/app/api/admin/products/[id]/ban/route.ts` · **Auth**: requireCap products.moderate (superadmin | ops | moderator) · **Rate limit**: none
**Purpose**: Ban product, unfeature, delete featured slots, notify seller, audit.
**Request**: path: `id`; body:
```ts
interface ProductBanBody { reason?: string }
```
**Response 200**:
```ts
interface ProductBanResponse { data: ProductRow }
```
**Errors**: `404 NOT_FOUND` product missing

### `GET /api/admin/reviews` — review moderation queue
**File**: `src/app/api/admin/reviews/route.ts` · **Auth**: requireCap reviews.moderate (superadmin | ops | moderator) · **Rate limit**: none
**Purpose**: Paginated review queue with product/store/shopper/order/reward context and threat flag.
**Request**: path: —; query: `status: string (optional; pending | published | rejected — validated)`, `productId: string (optional)`, `page: number (1)`, `size: number (20, max 100)`
**Response 200**:
```ts
interface AdminReviewsResponse { data: { id: string; productId: string; orderId: string | null; customerName: string; rating: number; unsafeContent: boolean; title: string | null; body: string | null; reply: string | null; status: string; createdAt: string; product: { id: string; title: string; slug: string; store: { id: string; name: string; slug: string } }; shopper: { id: string; email: string; fullName: string } | null; order: { id: string; orderNumber: string; status: string } | null; reward: { id: string; points: number; reversed: boolean; reversalReason: string | null } | null }[]; meta: { page: number; size: number; total: number } }
```
**Errors**: `400 VALIDATION` bad status · `503 REVIEWS_NOT_MIGRATED` migration pending

### `POST /api/admin/reviews/[id]` — moderate review
**File**: `src/app/api/admin/reviews/[id]/route.ts` · **Auth**: requireCap reviews.moderate (superadmin | ops | moderator) · **Rate limit**: admin-reviews (60/min)
**Purpose**: Moderately approve/reject a pending review; recompute rating; optional reward reversal.
**Request**: path: `id`; body:
```ts
interface ReviewModerateBody { action: "approve" | "reject"; reason?: string; reverseReward?: boolean }
```
**Response 200**:
```ts
interface ReviewModerateResponse { data: { id: string; status: "published" | "rejected"; ratingAvg: number; ratingCount: number; rewardReversed: boolean } }
```
**Errors**: `400 VALIDATION` bad action / reverseReward misuse · `404 NOT_FOUND` review missing · `409 ALREADY_MODERATED` not pending · `429 RATE_LIMITED` · `503 REVIEWS_NOT_MIGRATED`

---

## §16 Admin — Finance (Payouts, Commission, Ledger, Wallets, Banks, Reconciliation)

Shared payout row shape:

```ts
interface PayoutRow { id: string; batchId: string | null; sellerId: string; walletId: string; referenceNo: string; amountMinor: number; status: string; method: string; bankAccountId: string | null; providerRef: string | null; statementJson: string; failReason: string | null; paidAt: string | null; createdAt: string; updatedAt: string }
```

### `GET /api/admin/payouts` — list payouts
**File**: `src/app/api/admin/payouts/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Paged payout list with bank account, batch, seller, store info.
**Request**: path: —; query: `status: string (optional; "all" = no filter)`, `batchId: string (optional)`, `page: number (1)`, `size: number (20, max 100)`; body: none
**Response 200**:
```ts
interface PayoutsResponse {
  data: {
    id: string; batchId: string | null; sellerId: string; walletId: string; referenceNo: string; amountMinor: number; status: string; method: string; bankAccountId: string | null; providerRef: string | null; statementJson: string; failReason: string | null; paidAt: string | null; createdAt: string; updatedAt: string;
    bankAccount: { id: string; bankName: string; holderName: string; accountNumberMasked: string } | null;
    batch: { id: string; status: string; runType: string; startedAt: string } | null;
    seller: { id: string; email: string; displayName: string; fullName: string; store: { id: string; name: string; slug: string } | null } | null;
    storeName: string | null;
  }[];
  meta: { page: number; size: number; total: number };
}
```
**Errors**: none notable

### `GET /api/admin/payouts/requests` — seller payout request queues
**File**: `src/app/api/admin/payouts/requests/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Seller-initiated payout requests split into open and recent queues (latest 100).
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface PayoutRequest { id: string; batchId: string | null; sellerId: string; walletId: string; referenceNo: string; amountMinor: number; status: string; method: string; bankAccountId: string | null; providerRef: string | null; statementJson: string; failReason: string | null; paidAt: string | null; createdAt: string; updatedAt: string; bankAccount: { id: string; bankName: string; holderName: string; accountNumberMasked: string; verified: boolean } | null; seller: { id: string; email: string; displayName: string } | null; storeName: string | null }
interface PayoutRequestsResponse { data: { open: PayoutRequest[]; recent: PayoutRequest[] } }
```
**Errors**: none notable

### `GET /api/admin/payouts/due` — payouts due now
**File**: `src/app/api/admin/payouts/due/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Wallets owed money now; balances re-derived from ledger truth (like a batch run).
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface PayoutsDueResponse {
  data: {
    minMinor: number; mode: string; asOf: string; dueTotalMinor: number; dueCount: number; requestedTotalMinor: number; pendingTotalMinor: number; belowMinCount: number; belowMinTotalMinor: number;
    due: { walletId: string; sellerId: string; sellerName: string; storeName: string | null; availableMinor: number; requestedMinor: number; requestedRef: string | null; bank: { id: string; bankName: string; holderName: string; accountNumberMasked: string; verified: boolean } | null; lastPayout: { amountMinor: number; paidAt: string } | null }[];
  };
}
```
**Errors**: none notable

### `POST /api/admin/payouts/sweep` — operations sweep
**File**: `src/app/api/admin/payouts/sweep/route.ts` · **Auth**: admin requireCap `payouts.manage` (superadmin | finance) · **Rate limit**: fixed-window (6/60s)
**Purpose**: Bounded repeatable sweep: stuck payouts, unprocessed webhook replay, ledger invariants.
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface WalletCacheDrift { walletId: string; cachedAvailable: number; cachedPending: number; truthAvailable: number; truthPending: number; availableDelta: number; pendingDelta: number; maturedSinceLastWrite: number; lastCacheWriteAt: string }
interface SweepResponse {
  data: {
    stuck: { payoutId: string; referenceNo: string; hoursStuck: number; updatedAt: string; alerted: boolean }[];
    stuckHours: number;
    webhooks: { scanned: number; reprocessed: number; stillFailing: number; skipped: number };
    invariants: { ok: boolean; problems: string[]; hardDrift: WalletCacheDrift[]; timeMaturityStale: WalletCacheDrift[]; txnCount: number; walletCount: number };
    ranAt: string;
  };
}
```
**Errors**: `429 RATE_LIMITED` over 6 requests/min

### `POST /api/admin/payouts/[id]/sync` — payout reconciliation report
**File**: `src/app/api/admin/payouts/[id]/sync/route.ts` · **Auth**: admin requireCap `payouts.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Read-only reconciliation: wallet truth vs cache, T3/T4/T4f postings, statement rebuild.
**Request**: path: `id: string`; query: none; body: none
**Response 200**:
```ts
interface PayoutSyncResponse {
  data: {
    payoutId: string; status: string;
    walletTruth: { pendingMinor: number; availableMinor: number; lifetimeEarnedMinor: number; lifetimeCommissionMinor: number };
    cacheMatches: boolean;
    expectedTxns: { T3: boolean; T4: boolean; T4f: boolean };
    statementRebuilt: boolean;
    findings: string[];
  };
}
```
**Errors**: `404 NOT_FOUND` payout / wallet / seller missing

### `POST /api/admin/payouts/[id]/mark-paid` — mark payout paid (T4)
**File**: `src/app/api/admin/payouts/[id]/mark-paid/route.ts` · **Auth**: admin requireCap `payouts.manage` (superadmin | finance) · **Rate limit**: fixed-window (20/60s)
**Purpose**: Transition processing→paid, post T4 ledger transaction, notify seller.
**Request**: path: `id: string`; query: none; body:
```ts
interface MarkPaidBody { referenceNo: string }
```
**Response 200**:
```ts
interface MarkPaidResponse { data: PayoutRow }
```
**Errors**: `400 VALIDATION` referenceNo required · `404 NOT_FOUND` payout/seller missing · `409 STATE_INVALID` illegal transition · `409 CONFLICT` claim lost (not processing) · `429 RATE_LIMITED`

### `POST /api/admin/payouts/[id]/approve` — approve seller payout request
**File**: `src/app/api/admin/payouts/[id]/approve/route.ts` · **Auth**: admin requireCap `payouts.manage` (superadmin | finance) · **Rate limit**: fixed-window (20/60s)
**Purpose**: Transition requested→processing, post T3, attach ledger-derived statement, notify.
**Request**: path: `id: string`; query: none; body: none
**Response 200**:
```ts
interface ApproveResponse { data: PayoutRow }
```
**Errors**: `404 NOT_FOUND` payout/seller missing · `409 STATE_INVALID` illegal transition · `409 CONFLICT` claim lost · `409 INSUFFICIENT_BALANCE` truth below amount · `429 RATE_LIMITED`

### `POST /api/admin/payouts/[id]/reject` — reject seller payout request
**File**: `src/app/api/admin/payouts/[id]/reject/route.ts` · **Auth**: admin requireCap `payouts.manage` (superadmin | finance) · **Rate limit**: fixed-window (20/60s)
**Purpose**: Transition requested→rejected; no ledger movement; notify seller.
**Request**: path: `id: string`; query: none; body:
```ts
interface RejectBody { reason: string }
```
**Response 200**:
```ts
interface RejectResponse { data: PayoutRow }
```
**Errors**: `400 VALIDATION` reason required · `404 NOT_FOUND` payout/seller missing · `409 STATE_INVALID` illegal transition · `409 CONFLICT` claim lost · `429 RATE_LIMITED`

### `POST /api/admin/payouts/[id]/fail` — fail payout (T4f reversal)
**File**: `src/app/api/admin/payouts/[id]/fail/route.ts` · **Auth**: admin requireCap `payouts.manage` (superadmin | finance) · **Rate limit**: fixed-window (20/60s)
**Purpose**: Transition processing→failed, post T4f reversal, notify ops and seller.
**Request**: path: `id: string`; query: none; body:
```ts
interface FailBody { reason: string }
```
**Response 200**:
```ts
interface FailResponse { data: PayoutRow }
```
**Errors**: `400 VALIDATION` reason required · `404 NOT_FOUND` payout/seller missing · `409 STATE_INVALID` illegal transition · `409 CONFLICT` claim lost · `429 RATE_LIMITED`

### `GET /api/admin/payout-batches` — list payout batches
**File**: `src/app/api/admin/payout-batches/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: All payout batches with nested payouts plus seller names (unpaged ok() list).
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface BatchPayout { id: string; batchId: string | null; sellerId: string; walletId: string; referenceNo: string; amountMinor: number; status: string; method: string; bankAccountId: string | null; providerRef: string | null; statementJson: string; failReason: string | null; paidAt: string | null; createdAt: string; updatedAt: string; sellerName: string | null; sellerEmail: string | null }
interface PayoutBatchesResponse { data: { id: string; runType: string; status: string; currency: string; totalMinor: number; payoutCount: number; startedAt: string; finishedAt: string | null; payouts: BatchPayout[] }[] }
```
**Errors**: none notable · **(deviation**: list without `meta` — ok() not okPaged()**)**

### `POST /api/admin/payout-batches` — run payout batch
**File**: `src/app/api/admin/payout-batches/route.ts` · **Auth**: admin requireCap `payouts.manage` (superadmin | finance) · **Rate limit**: fixed-window (20/60s)
**Purpose**: Sweep eligible wallets into payouts (T3 each) or dry-run preview; skips pending-request wallets.
**Request**: path: —; query: none; body:
```ts
interface PayoutBatchRunBody { dryRun?: boolean }
```
**Response 200**:
```ts
interface BatchBank { id: string; bankName: string; holderName: string; accountNumberMasked: string; verified: boolean }
interface PayoutBatchRunResponse {
  data:
    | { dryRun: true; minMinor: number; mode: string; eligibleCount: number; eligibleTotalMinor: number; eligible: { walletId: string; sellerId: string; sellerName: string; storeName: string | null; availableMinor: number; bank: BatchBank | null }[]; skipped: { walletId: string; sellerName: string; storeName: string | null; availableMinor: number; reason: string; bank: BatchBank | null }[] }
    | { batch: { id: string; runType: string; status: string; currency: string; totalMinor: number; payoutCount: number; startedAt: string; finishedAt: string | null; payouts: PayoutRow[] }; payouts: PayoutRow[] };
}
```
**Errors**: `409 NO_ELIGIBLE_WALLETS` no wallet meets minimum (or all skipped) · `429 RATE_LIMITED`

### `GET /api/admin/payment-reconciliation` — late-payment refund cases
**File**: `src/app/api/admin/payment-reconciliation/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Paged late-payment refund cases with status stats (meta nested inside data).
**Request**: path: —; query: `status: string (optional; requested|processing|succeeded|failed|unknown, invalid ignored)`, `page: number (1)`, `size: number (20, max 100)`; body: none
**Response 200**:
```ts
interface ReconCase { id: string; provider: string; providerRef: string; providerPaymentId: string | null; amountMinor: number; currency: string; reason: string; status: string; providerRefundId: string | null; attempts: number; lastAttemptAt: string | null; lastError: string | null; resolutionNote: string | null; createdAt: string; updatedAt: string }
interface PaymentReconciliationResponse {
  data: {
    cases: ReconCase[];
    stats: { counts: Record<string, number>; total: number; exhaustedAttempts: number; awaitingOperator: number };
    runbook: string;
    meta: { page: number; size: number; total: number };
  };
}
```
**Errors**: none notable · **(deviation**: `meta` nested in `data`, not top-level**)**

### `GET /api/admin/banks` — bank verification queue
**File**: `src/app/api/admin/banks/route.ts` · **Auth**: admin requireAnyCap `sellers.approve`|`payouts.manage` (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Bank accounts with seller identity info, filterable by verification state (unpaged).
**Request**: path: —; query: `verified: "true"|"false"|"all" (optional)`; body: none
**Response 200**:
```ts
interface BanksResponse { data: { id: string; holderName: string; bankName: string; accountNumberMasked: string; verified: boolean; verifiedAt: string | null; createdAt: string; sellerId: string; sellerLegalName: string; sellerEmail: string; sellerStatus: string; storeName: string | null }[] }
```
**Errors**: none notable

### `POST /api/admin/banks/[id]/verify` — verify bank account
**File**: `src/app/api/admin/banks/[id]/verify/route.ts` · **Auth**: admin requireCap `sellers.approve` (superadmin | ops) · **Rate limit**: none
**Purpose**: Mark bank account verified, stamp verifiedAt, notify seller.
**Request**: path: `id: string`; query: none; body: none
**Response 200**:
```ts
interface BankVerifyResponse { data: { id: string; sellerId: string; holderName: string; bankName: string; accountNumberMasked: string; accountNumberEnc: string; verified: boolean; verifiedAt: string | null; createdAt: string } }
```
**Errors**: `404 NOT_FOUND` bank account missing

### `POST /api/admin/banks/[id]/reject` — reject bank account
**File**: `src/app/api/admin/banks/[id]/reject/route.ts` · **Auth**: admin requireCap `sellers.approve` (superadmin | ops) · **Rate limit**: none
**Purpose**: Mark bank account unverified, clear verifiedAt.
**Request**: path: `id: string`; query: none; body: none
**Response 200**:
```ts
interface BankRejectResponse { data: { id: string; sellerId: string; holderName: string; bankName: string; accountNumberMasked: string; accountNumberEnc: string; verified: boolean; verifiedAt: string | null; createdAt: string } }
```
**Errors**: `404 NOT_FOUND` bank account missing

### `GET /api/admin/wallets` — wallets with truth-refreshed balances
**File**: `src/app/api/admin/wallets/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: All wallets with seller/store info; balances re-derived from ledger (unpaged).
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface WalletsResponse {
  data: {
    id: string; sellerId: string; currency: string; pendingMinor: number; availableMinor: number; reservedMinor: number; lifetimeEarnedMinor: number; lifetimeCommissionMinor: number; createdAt: string; updatedAt: string;
    seller: { id: string; email: string; displayName: string; fullName: string; status: string; riskTier: string; store: { id: string; name: string; slug: string; status: string } | null };
    cacheRefreshed: boolean; storeName: string | null; storeSlug: string | null;
  }[];
}
```
**Errors**: none notable

### `POST /api/admin/wallets/[id]/adjust` — manual wallet adjustment (T6)
**File**: `src/app/api/admin/wallets/[id]/adjust/route.ts` · **Auth**: admin requireCap `payouts.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Post T6 admin adjustment (credit/debit) to a seller wallet with before/after truth.
**Request**: path: `id: string`; query: none; body:
```ts
interface WalletAdjustBody { amountMinor: number; direction: "credit" | "debit"; reason: string }
```
**Response 200**:
```ts
interface WalletTruth { pendingMinor: number; availableMinor: number; lifetimeEarnedMinor: number; lifetimeCommissionMinor: number }
interface WalletAdjustResponse {
  data: {
    wallet: { id: string; sellerId: string; currency: string; pendingMinor: number; availableMinor: number; reservedMinor: number; lifetimeEarnedMinor: number; lifetimeCommissionMinor: number; createdAt: string; updatedAt: string };
    txnId: string; before: WalletTruth; after: WalletTruth;
  };
}
```
**Errors**: `400 VALIDATION` amountMinor ≤ 0 / bad direction · `404 NOT_FOUND` wallet missing

### `GET /api/admin/ledger/accounts` — chart of accounts with balances
**File**: `src/app/api/admin/ledger/accounts/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Ledger accounts with summed debit/credit and signed balances (unpaged).
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface LedgerAccountsResponse { data: { code: string; name: string; type: string; walletId: string | null; debitMinor: number; creditMinor: number; balanceMinor: number; lineCount: number }[] }
```
**Errors**: none notable

### `GET /api/admin/ledger/transactions` — ledger transactions (cursor)
**File**: `src/app/api/admin/ledger/transactions/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Latest 100 ledger transactions with lines, cursor-paginated by id desc.
**Request**: path: —; query: `type: string (optional; "all" = no filter)`, `walletId: string (optional)`, `cursor: string (optional — id lt)`; body: none
**Response 200**:
```ts
interface LedgerLineRow { id: string; txnId: string; accountCode: string; direction: string; amountMinor: number; currency: string; walletId: string | null; availableAt: string | null; memo: string | null; createdAt: string; refType: string | null; refId: string | null }
interface LedgerTxnRow { id: string; txnType: string; refType: string | null; refId: string | null; description: string | null; occurredAt: string; dedupKey: string | null; lines: LedgerLineRow[] }
interface LedgerTransactionsResponse { data: { items: LedgerTxnRow[]; nextCursor: string | null; count: number } }
```
**Errors**: none notable · **(deviation**: cursor pagination, not page/size**)**

### `POST /api/admin/commission/simulate` — commission simulator
**File**: `src/app/api/admin/commission/simulate/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Pure commission computation for one simulated item, no persistence.
**Request**: path: —; query: none; body:
```ts
interface SimulateBody { priceMinor?: number; qty?: number; discountMinor?: number; shippingMinor?: number; categoryId?: string | null; sellerId?: string | null; productId?: string | null }
```
**Response 200**:
```ts
interface SimulateResponse { data: { commissionMinor: number; sellerNetMinor: number; holdDays: number; trace: { rule_source: string; source_id?: string; holiday_id?: string; percent: number; base: number; percent_part: number; fixed_fee_allocated: number; discount_allocated: number; shipping_allocated: number; affiliate_rate_bps?: number; affiliate_base?: number; affiliate_pool?: number; flags: string[] } } }
```
**Errors**: `400 BAD_JSON` malformed body

### `GET /api/admin/commission/psp-settings` — PSP split scaffold state
**File**: `src/app/api/admin/commission/psp-settings/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Read dormant split-settlement scaffold state: auto-settle flag, provider, candidates.
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface PspSettingsResponse { data: { autoSettle: boolean; provider: string; candidates: { id: string; label: string; note: string; awaitingAdapter: boolean }[] } }
```
**Errors**: none notable

### `PUT /api/admin/commission/psp-settings` — update PSP scaffold settings
**File**: `src/app/api/admin/commission/psp-settings/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Write autoSettle/provider Setting keys only; no functional behaviour wired.
**Request**: path: —; query: none; body:
```ts
interface PspSettingsPutBody { autoSettle?: boolean; provider?: string }
```
**Response 200**:
```ts
interface PspSettingsPutResponse { data: { updated: { autoSettle?: string; provider?: string } } }
```
**Errors**: `400 VALIDATION` unknown provider id / nothing to update · `409 PSP_ADAPTER_REQUIRED` enabling autoSettle or adapter-less provider

### `GET /api/admin/commission/settings` — commission settings
**File**: `src/app/api/admin/commission/settings/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Global commission settings singleton (auto-created on first read).
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface CommissionSettingsResponse { data: { id: number; defaultPercent: number; appliesToShipping: boolean; basePriceRule: string; fixedFeeMinor: number; minCommissionMinor: number; payoutHoldDays: number; holdReleaseRule: string; graceDaysAfterDelivered: number } }
```
**Errors**: none notable

### `PUT /api/admin/commission/settings` — update commission settings
**File**: `src/app/api/admin/commission/settings/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Partial update of commission settings singleton with range validation.
**Request**: path: —; query: none; body:
```ts
interface CommissionSettingsPutBody { defaultPercent?: number; payoutHoldDays?: number; appliesToShipping?: boolean; basePriceRule?: "paid_price" | "list_price"; fixedFeeMinor?: number; minCommissionMinor?: number; holdReleaseRule?: "days_after_paid" | "days_after_delivered"; graceDaysAfterDelivered?: number }
```
**Response 200**:
```ts
interface CommissionSettingsPutResponse { data: { id: number; defaultPercent: number; appliesToShipping: boolean; basePriceRule: string; fixedFeeMinor: number; minCommissionMinor: number; payoutHoldDays: number; holdReleaseRule: string; graceDaysAfterDelivered: number } }
```
**Errors**: `400 VALIDATION` range checks / nothing to update

### `GET /api/admin/commission/holidays` — list fee holidays
**File**: `src/app/api/admin/commission/holidays/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Fee holidays with parsed scopeIdsList (unpaged, startsAt desc).
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface HolidaysResponse { data: { id: string; name: string; scope: string; scopeIds: string | null; percent: number; startsAt: string; endsAt: string; isActive: boolean; createdAt: string; updatedAt: string; scopeIdsList: string[] }[] }
```
**Errors**: none notable

### `POST /api/admin/commission/holidays` — create fee holiday
**File**: `src/app/api/admin/commission/holidays/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Create a fee holiday (rate override window) scoped globally or by ids.
**Request**: path: —; query: none; body:
```ts
interface HolidayCreateBody { name: string; scope?: "all" | "sellers" | "categories"; scopeIds?: string[]; percent?: number; startsAt: string; endsAt: string; isActive?: boolean }
```
**Response 200**:
```ts
interface HolidayCreateResponse { data: { id: string; name: string; scope: string; scopeIds: string | null; percent: number; startsAt: string; endsAt: string; isActive: boolean; createdAt: string; updatedAt: string } }
```
**Errors**: `400 VALIDATION` scopeIds required for scoped holidays · percent 0..100 · dates required/ordered (scope defaults "all", percent 0, isActive true)

### `PATCH /api/admin/commission/holidays/[id]` — update fee holiday
**File**: `src/app/api/admin/commission/holidays/[id]/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Partially update a fee holiday's name, percent, dates, active flag.
**Request**: path: `id: string`; query: none; body:
```ts
interface HolidayPatchBody { name?: string; percent?: number; startsAt?: string; endsAt?: string; isActive?: boolean }
```
**Response 200**:
```ts
interface HolidayPatchResponse { data: { id: string; name: string; scope: string; scopeIds: string | null; percent: number; startsAt: string; endsAt: string; isActive: boolean; createdAt: string; updatedAt: string } }
```
**Errors**: `400 VALIDATION` percent range / invalid dates / nothing to update · `404 NOT_FOUND` holiday missing

### `DELETE /api/admin/commission/holidays/[id]` — delete fee holiday
**File**: `src/app/api/admin/commission/holidays/[id]/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Permanently delete a fee holiday.
**Request**: path: `id: string`; query: none; body: none
**Response 200**:
```ts
interface HolidayDeleteResponse { data: { deleted: true } }
```
**Errors**: `404 NOT_FOUND` holiday missing

### `GET /api/admin/commission/analytics` — commission analytics
**File**: `src/app/api/admin/commission/analytics/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Ledger-truth commission analytics, recent exports, dormant PSP scaffold state.
**Request**: path: —; query: `days: number (90, clamped 7..730)`; body: none
**Response 200**:
```ts
interface CommissionAnalyticsResponse {
  data: {
    days: number;
    summary: { commissionMinor: number; salesMinor: number; effectiveRatePct: number; orderCount: number; refundsReversalMinor: number; allTimeCommissionMinor: number };
    weekly: { weekStart: string; commissionMinor: number; orderCount: number }[];
    stores: { walletId: string; storeName: string; orderCount: number; commissionMinor: number }[];
    exports: { id: string; periodFrom: string; periodTo: string; totalMinor: number; orderCount: number; lineCount: number; format: string; createdByEmail: string; createdAt: string }[];
    psp: { webhookPath: string; candidates: { id: string; label: string; note: string; awaitingAdapter: boolean }[]; autoSettle: boolean; provider: string; lastSettlement: { description: string | null; occurredAt: string; amountMinor: number } | null; note: string };
  };
}
```
**Errors**: none notable

### `GET /api/admin/commission/overrides` — list commission overrides
**File**: `src/app/api/admin/commission/overrides/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Commission override rows with resolved category/seller/product names (unpaged).
**Request**: path: —; query: `scope: string (optional)`; body: none
**Response 200**:
```ts
interface OverridesResponse { data: { id: string; scope: string; categoryId: string | null; sellerId: string | null; productId: string | null; percent: number | null; fixedFeeMinor: number | null; holdDays: number | null; validFrom: string | null; validTo: string | null; isActive: boolean; createdBy: string | null; createdAt: string; updatedAt: string; categoryName: string | null; sellerName: string | null; sellerEmail: string | null; productName: string | null }[] }
```
**Errors**: none notable

### `POST /api/admin/commission/overrides` — create commission override
**File**: `src/app/api/admin/commission/overrides/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Create a scoped commission override (category/seller/product).
**Request**: path: —; query: none; body:
```ts
interface OverrideCreateBody { scope: "category" | "seller" | "product"; categoryId?: string | null; sellerId?: string | null; productId?: string | null; percent?: number; fixedFeeMinor?: number; holdDays?: number; validFrom?: string | null; validTo?: string | null }
```
**Response 200**:
```ts
interface OverrideCreateResponse { data: { id: string; scope: string; categoryId: string | null; sellerId: string | null; productId: string | null; percent: number | null; fixedFeeMinor: number | null; holdDays: number | null; validFrom: string | null; validTo: string | null; isActive: boolean; createdBy: string | null; createdAt: string; updatedAt: string } }
```
**Errors**: `400 VALIDATION` scope/target required · percent 0..100 · fixedFee ≥ 0 · holdDays 0..60 · validFrom ≤ validTo

### `PATCH /api/admin/commission/overrides/[id]` — update commission override
**File**: `src/app/api/admin/commission/overrides/[id]/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Partially update an override's rate fields, validity window, active flag.
**Request**: path: `id: string`; query: none; body:
```ts
interface OverridePatchBody { percent?: number; fixedFeeMinor?: number; holdDays?: number; validFrom?: string | null; validTo?: string | null; isActive?: boolean }
```
**Response 200**:
```ts
interface OverridePatchResponse { data: { id: string; scope: string; categoryId: string | null; sellerId: string | null; productId: string | null; percent: number | null; fixedFeeMinor: number | null; holdDays: number | null; validFrom: string | null; validTo: string | null; isActive: boolean; createdBy: string | null; createdAt: string; updatedAt: string } }
```
**Errors**: `400 VALIDATION` range checks / nothing to update · `404 NOT_FOUND` override missing

### `DELETE /api/admin/commission/overrides/[id]` — delete commission override
**File**: `src/app/api/admin/commission/overrides/[id]/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Permanently delete a commission override.
**Request**: path: `id: string`; query: none; body: none
**Response 200**:
```ts
interface OverrideDeleteResponse { data: { deleted: true } }
```
**Errors**: `404 NOT_FOUND` override missing

### `GET /api/admin/commission/exports` — export history
**File**: `src/app/api/admin/commission/exports/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Latest 50 commission export history rows (unpaged).
**Request**: path: —; query: none; body: none
**Response 200**:
```ts
interface ExportsResponse { data: { id: string; periodFrom: string; periodTo: string; totalMinor: number; orderCount: number; lineCount: number; format: string; createdByEmail: string; createdAt: string }[] }
```
**Errors**: none notable

### `POST /api/admin/commission/exports` — create commission CSV export
**File**: `src/app/api/admin/commission/exports/route.ts` · **Auth**: admin requireCap `commission.manage` (superadmin | finance) · **Rate limit**: none
**Purpose**: Snapshot commission aggregates into history and return CSV (status 201).
**Request**: path: —; query: none; body:
```ts
interface ExportCreateBody { days?: number }
```
**Response 201**:
```ts
interface CommissionSnapshot { periodFrom: string; periodTo: string; generatedAt: string; createdByEmail: string; summary: { commissionMinor: number; salesMinor: number; effectiveRatePct: number; orderCount: number; refundsReversalMinor: number }; weekly: { weekStart: string; commissionMinor: number; orderCount: number }[]; stores: { walletId: string; storeName: string; orderCount: number; commissionMinor: number }[] }
interface ExportCreateResponse { data: { export: { id: string; periodFrom: string; periodTo: string; totalMinor: number; orderCount: number; lineCount: number; format: string; snapshotJson: string; createdByEmail: string; createdAt: string }; csv: string; snapshot: CommissionSnapshot } }
```
**Errors**: `409 EMPTY_PERIOD` no commission activity in period (days default 90, clamped 7..730)

---

## §17 Admin — Affiliate Program Management

```ts
interface AffiliateBalances { pendingMinor: number; approvedMinor: number; availableMinor: number; payoutInFlightMinor: number; paidMinor: number; reversedMinor: number; heldMinor: number; recoveryMinor: number; requestableMinor: number }
```

### `GET /api/admin/affiliate/accounts` — affiliate review list
**File**: `src/app/api/admin/affiliate/accounts/route.ts` · **Auth**: requireCap("affiliate.manage") [superadmin | ops] · **Rate limit**: none
**Purpose**: Paginated affiliate account list with referral and lifetime earnings aggregates.
**Request**: path: —; query: `status?: string`; `q?: string`; `page: number (1)`; `size: number (20, clamped 5–50)`
**Response 200**:
```ts
interface AccountsResponse { data: {
  total: number; page: number;
  accounts: { id: string; displayName: string; slug: string; code: string; email: string; status: string;
    sponsorName: string | null; referrals: number; lifetimeEarningsMinor: number; activatedAt: string;
    suspendedReason: string | null }[]; } }
```
**Errors**: (auth 401 UNAUTHORIZED / 403 FORBIDDEN / 403 MFA_ENROLLMENT_REQUIRED only) · **(list via ok() with inline total/page — no meta envelope, size not echoed)**

### `GET /api/admin/affiliate/accounts/[id]` — affiliate investigation detail
**File**: `src/app/api/admin/affiliate/accounts/[id]/route.ts` · **Auth**: requireCap("affiliate.manage") [superadmin | ops] · **Rate limit**: none
**Purpose**: Full affiliate detail: profile, balances, sponsor audit, commissions, payouts.
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface AccountDetailResponse { data: {
  profile: { id: string; displayName: string; slug: string; code: string; email: string; fullName: string; status: string;
    bio: string | null; sponsor: { id: string; displayName: string } | null; sponsorSource: string | null;
    sponsorAssignedAt: string | null; activatedAt: string; suspendedReason: string | null; userCreatedAt: string };
  balances: AffiliateBalances;
  referralCount: number;
  sponsorAudit: { fromSponsorId: string | null; toSponsorId: string | null; reason: string; actorId: string; createdAt: string }[];
  commissions: { id: string; orderNumber: string; status: string; poolMinor: number; rateBps: number; createdAt: string;
    directMinor: number; sponsorMinor: number }[];
  payouts: { id: string; amountMinor: number; status: string; reference: string | null; requestedAt: string; processedAt: string | null }[]; } }
```
**Errors**: `404 NOT_FOUND` affiliate not found

### `POST /api/admin/affiliate/accounts/[id]/sponsor` — sponsor correction
**File**: `src/app/api/admin/affiliate/accounts/[id]/sponsor/route.ts` · **Auth**: requireCap("affiliate.manage") [superadmin | ops] · **Rate limit**: admin-aff-sponsor (20/min)
**Purpose**: Audited administrative correction of an affiliate's sponsor (or detach via null).
**Request**: path: `id: string`; body:
```ts
interface SponsorBody { sponsorCode?: string | null; reason: string }
```
**Response 200**:
```ts
interface SponsorResponse { data: { sponsorId: string | null } }
```
**Errors**: `400 VALIDATION` reason ≥10 chars · `400 SELF_REFERRAL` self-sponsor · `400 SPONSOR_CYCLE` would create cycle · `404 NOT_FOUND` affiliate or referral code not found

### `POST /api/admin/affiliate/accounts/[id]/status` — suspend/reinstate/terminate
**File**: `src/app/api/admin/affiliate/accounts/[id]/status/route.ts` · **Auth**: requireCap("affiliate.manage") [superadmin | ops] · **Rate limit**: admin-aff-status (30/min)
**Purpose**: Affiliate review controls; holds/releases sponsor-role entries transactionally.
**Request**: path: `id: string`; body:
```ts
interface StatusBody { action: "suspend" | "reinstate" | "terminate"; reason?: string | null }
```
**Response 200**:
```ts
interface StatusResponse { data: { status: string } }
```
**Errors**: `400 VALIDATION` invalid action / reason <10 chars required (suspend|terminate) · `404 NOT_FOUND` affiliate not found

### `GET /api/admin/affiliate/commissions` — commission allocation inspector
**File**: `src/app/api/admin/affiliate/commissions/route.ts` · **Auth**: requireAnyCap("affiliate.manage","affiliate.finance") [superadmin | ops | finance] · **Rate limit**: none
**Purpose**: Filterable commission list with full-scope totals and per-entry allocations.
**Request**: path: —; query: `status?: string`; `affiliateId?: string`; `storeId?: string`; `orderNumber?: string`; `from?: string`; `to?: string`; `page: number (1)`; `size: number (20, clamped 5–50)`
**Response 200**:
```ts
interface CommissionsResponse { data: {
  total: number; page: number; size: number;
  totals: { poolMinor: number; baseMinor: number };
  filters: { status: string | null; affiliateId: string | null; storeId: string | null; orderNumber: string | null; from: string | null; to: string | null };
  rows: { id: string; orderNumber: string; orderItemId: string; affiliate: string; status: string; rateBps: number;
    baseMinor: number; poolMinor: number; createdAt: string;
    entries: { role: string; status: string; amountMinor: number; reversedMinor: number; availableAt: string | null; holdReason: string | null }[] }[]; } }
```
**Errors**: (auth only; invalid status value silently ignored) · **(list via ok() with inline total/page/size — no meta envelope)**

### `POST /api/admin/affiliate/commissions/[id]/hold` — hold/release commission
**File**: `src/app/api/admin/affiliate/commissions/[id]/hold/route.ts` · **Auth**: requireCap("affiliate.manage") [superadmin | ops] · **Rate limit**: admin-aff-hold (30/min)
**Purpose**: Manual hold or release of a commission's unpaid entries (fraud review).
**Request**: path: `id: string`; body:
```ts
interface HoldBody { action: "hold" | "release"; reason: string }
```
**Response 200**:
```ts
interface HoldResponse { data: { status: string } }
```
**Errors**: `400 VALIDATION` invalid action / hold reason <10 chars · `404 NOT_FOUND` commission not found

### `GET /api/admin/affiliate/reconciliation` — 7-point reconciliation report
**File**: `src/app/api/admin/affiliate/reconciliation/route.ts` · **Auth**: requireCap("affiliate.finance") [superadmin | finance] · **Rate limit**: none
**Purpose**: Platform-wide affiliate liability reconciliation cross-checked against ledger.
**Request**: path: —; query: —
**Response 200**:
```ts
interface ReconciliationResponse { data: {
  points: { expectedPoolMinor: number; allocatedMinor: number; heldMinor: number; availableMinor: number;
    paidOutMinor: number; reversalsMinor: number; remainingLiabilityMinor: number };
  ledgerBalanceMinor: number; invariantOk: boolean; commissionCount: number;
  entriesByStatus: { status: string; count: number; amountMinor: number; reversedMinor: number }[];
  payoutsByStatus: { status: string; count: number; amountMinor: number }[];
  pendingEntryCount: number; } }
```
**Errors**: (auth only)

### `GET /api/admin/affiliate/overview` — programme dashboard
**File**: `src/app/api/admin/affiliate/overview/route.ts` · **Auth**: requireAnyCap("affiliate.manage","affiliate.finance") [superadmin | ops | finance] · **Rate limit**: none
**Purpose**: Programme settings, entity counts, and reconciliation summary.
**Request**: path: —; query: —
**Response 200**:
```ts
interface OverviewResponse { data: {
  settings: { enabled: boolean; sponsorEnabled: boolean; maxRateBps: number; attrWindowDays: number;
    sponsorWindowDays: number; reviewDays: number; minPayoutMinor: number; collectionsEnabled: boolean; showcaseEnabled: boolean };
  counts: { affiliates: number; suspended: number; links: number; attributionTouches: number };
  reconciliation: { points: { expectedPoolMinor: number; allocatedMinor: number; heldMinor: number; availableMinor: number;
    paidOutMinor: number; reversalsMinor: number; remainingLiabilityMinor: number };
    ledgerBalanceMinor: number; invariantOk: boolean; commissionCount: number;
    entriesByStatus: { status: string; count: number; amountMinor: number; reversedMinor: number }[];
    payoutsByStatus: { status: string; count: number; amountMinor: number }[]; pendingEntryCount: number }; } }
```
**Errors**: (auth only)

### `GET /api/admin/affiliate/payouts` — payout queue
**File**: `src/app/api/admin/affiliate/payouts/route.ts` · **Auth**: requireCap("affiliate.finance") [superadmin | finance] · **Rate limit**: none
**Purpose**: Payout queue with per-status aggregates and affiliate payout references.
**Request**: path: —; query: `status?: string`; `page: number (1)`; `size: number (20, clamped 5–50)`
**Response 200**:
```ts
interface PayoutsResponse { data: {
  total: number; page: number;
  queue: { status: string; count: number; amountMinor: number }[];
  payouts: { id: string; amountMinor: number; status: string; method: string; reference: string | null; note: string | null;
    failReason: string | null; statementJson: string; requestedAt: string; processedAt: string | null;
    affiliate: { displayName: string; slug: string; code: string; email: string; fullName: string; payoutRef: string | null } }[]; } }
```
**Errors**: (auth only) · **(list via ok() with inline total/page — no meta envelope, size not echoed)**

### `POST /api/admin/affiliate/payouts/[id]/process` — payout state machine
**File**: `src/app/api/admin/affiliate/payouts/[id]/process/route.ts` · **Auth**: requireCap("affiliate.finance") [superadmin | finance] · **Rate limit**: admin-aff-payout (30/min)
**Purpose**: Manual payout workflow: approve, mark-paid, fail, reject with ledger postings.
**Request**: path: `id: string`; body:
```ts
interface ProcessBody { action: "approve" | "mark-paid" | "fail" | "reject"; reference?: string | null; reason?: string | null }
```
**Response 200**:
```ts
interface ProcessResponse { data: { status: string; amountMinor: number; reference?: string | null; reason?: string | null } }
```
**Errors**: `400 VALIDATION` invalid action / reason required (fail|reject) / reference required (mark-paid, amount>0) · `404 NOT_FOUND` payout not found · `409 STATE_INVALID` wrong current status · `409 FROZEN_AMOUNT_STALE` refunds shrank frozen amount since request

---

## §18 Admin — Security (MFA) & Support

### `POST /api/admin/mfa/enroll` — start TOTP enrollment
**File**: `src/app/api/admin/mfa/enroll/route.ts` · **Auth**: requireAdminUngated() [any admin role; MFA bootstrap — gate skipped] · **Rate limit**: admin-mfa (10/min)
**Purpose**: Start/restart TOTP enrollment; returns plaintext secret exactly once.
**Request**: path: —; body:
```ts
interface MfaEnrollBody { password: string }
```
**Response 200**:
```ts
interface MfaEnrollResponse { data: { secretBase32: string; otpauthUrl: string } }
```
**Errors**: `503 MFA_NOT_CONFIGURED` encryption key unset · `401 INVALID_CREDENTIALS` · `409 MFA_ALREADY_ENROLLED` confirmed enrollment exists · `503 MFA_NOT_MIGRATED`

### `POST /api/admin/mfa/confirm` — confirm enrollment
**File**: `src/app/api/admin/mfa/confirm/route.ts` · **Auth**: requireAdminUngated() [any admin role; MFA bootstrap — gate skipped] · **Rate limit**: admin-mfa (10/min)
**Purpose**: Verify TOTP, confirm enrollment, mint recovery codes, revoke all sessions.
**Request**: path: —; body:
```ts
interface MfaConfirmBody { password: string; code: string }
```
**Response 200**:
```ts
interface MfaConfirmResponse { data: { recoveryCodes: string[] } }
```
**Errors**: `401 INVALID_CREDENTIALS` · `404 MFA_NOT_ENROLLED` no pending enrollment · `409 MFA_ALREADY_ENROLLED` · `401 INVALID_CODE` bad/replayed code · `503 MFA_NOT_MIGRATED`

### `GET /api/admin/mfa/status` — own enrollment state
**File**: `src/app/api/admin/mfa/status/route.ts` · **Auth**: requireAdminUngated() [any admin role; MFA bootstrap — gate skipped] · **Rate limit**: admin-mfa (10/min)
**Purpose**: Signed-in admin's own MFA enrollment state; no secrets returned.
**Request**: path: —; query: —
**Response 200**:
```ts
interface MfaStatusResponse { data: { enrolled: boolean; confirmed: boolean } }
```
**Errors**: (auth only; unmigrated table answers enrolled:false)

### `POST /api/admin/mfa/disable` — disable MFA
**File**: `src/app/api/admin/mfa/disable/route.ts` · **Auth**: requireAdminUngated() [any admin role; MFA bootstrap — gate skipped] · **Rate limit**: admin-mfa (10/min)
**Purpose**: Remove MFA enrollment after password + TOTP/recovery-code reauthentication; revokes sessions.
**Request**: path: —; body:
```ts
interface MfaDisableBody { password: string; code: string }
```
**Response 200**:
```ts
interface MfaDisableResponse { data: { disabled: boolean; revokedSessions: number } }
```
**Errors**: `401 INVALID_CREDENTIALS` wrong password · `404 MFA_NOT_ENROLLED` · `401 INVALID_CODE` TOTP/recovery mismatch · `503 MFA_NOT_MIGRATED`

### `GET /api/admin/tickets` — support ticket list
**File**: `src/app/api/admin/tickets/route.ts` · **Auth**: requireAdmin() [any admin role] · **Rate limit**: none
**Purpose**: Paginated ticket queue with last message and message counts.
**Request**: path: —; query: `status?: string ("all" = no filter)`; `page: number (1)`; `size: number (20, max 100)`
**Response 200**:
```ts
interface TicketsResponse { data: {
  id: string; storeId: string | null; sellerEmail: string | null; subject: string; status: string; priority: string;
  contextType: string | null; contextId: string | null; createdAt: string; updatedAt: string;
  store: { id: string; name: string; slug: string } | null;
  lastMessage: { id: string; ticketId: string; authorType: string; authorLabel: string; body: string; createdAt: string } | null;
  messageCount: number; }[];
  meta: { page: number; size: number; total: number }; }
```
**Errors**: (auth only) · **(messages/_count set to undefined are dropped by JSON serialization)**

### `GET /api/admin/tickets/[id]` — ticket thread
**File**: `src/app/api/admin/tickets/[id]/route.ts` · **Auth**: requireAdmin() [any admin role] · **Rate limit**: none
**Purpose**: Single ticket with full ascending message thread and store resolution.
**Request**: path: `id: string`; query: —
**Response 200**:
```ts
interface TicketDetailResponse { data: {
  id: string; storeId: string | null; sellerEmail: string | null; subject: string; status: string; priority: string;
  contextType: string | null; contextId: string | null; createdAt: string; updatedAt: string;
  messages: { id: string; ticketId: string; authorType: string; authorLabel: string; body: string; createdAt: string }[];
  store: { id: string; name: string; slug: string } | null; } }
```
**Errors**: `404 NOT_FOUND` ticket not found

### `PATCH /api/admin/tickets/[id]` — update ticket status/priority
**File**: `src/app/api/admin/tickets/[id]/route.ts` · **Auth**: requireAdmin() [any admin role] · **Rate limit**: none
**Purpose**: Update ticket status and/or priority with admin audit trail.
**Request**: path: `id: string`; body:
```ts
interface TicketPatchBody { status?: "open" | "pending" | "closed"; priority?: "low" | "normal" | "high" | "urgent" }
```
**Response 200**:
```ts
interface TicketPatchResponse { data: { id: string; storeId: string | null; sellerEmail: string | null; subject: string;
  status: string; priority: string; contextType: string | null; contextId: string | null; createdAt: string; updatedAt: string } }
```
**Errors**: `404 NOT_FOUND` ticket not found · `400 VALIDATION` invalid status/priority or empty update

### `POST /api/admin/tickets/[id]/reply` — admin reply
**File**: `src/app/api/admin/tickets/[id]/reply/route.ts` · **Auth**: requireAdmin() [any admin role] · **Rate limit**: none
**Purpose**: Post admin reply message; flips ticket to pending.
**Request**: path: `id: string`; body:
```ts
interface TicketReplyBody { body: string }
```
**Response 200**:
```ts
interface TicketReplyResponse { data: {
  message: { id: string; ticketId: string; authorType: string; authorLabel: string; body: string; createdAt: string };
  ticket: { id: string; storeId: string | null; sellerEmail: string | null; subject: string; status: string; priority: string;
    contextType: string | null; contextId: string | null; createdAt: string; updatedAt: string }; } }
```
**Errors**: `404 NOT_FOUND` ticket not found · `400 VALIDATION` body required

### `GET /api/admin/announcements` — list announcements
**File**: `src/app/api/admin/announcements/route.ts` · **Auth**: requireAdmin() [any admin role] · **Rate limit**: none
**Purpose**: All announcements, newest first.
**Request**: path: —; query: —
**Response 200**:
```ts
interface AnnouncementsResponse { data: {
  id: string; title: string; body: string | null; audience: string; startsAt: string | null; endsAt: string | null;
  isActive: boolean; createdAt: string; }[] }
```
**Errors**: (auth only) · **(list returned via ok() with NO meta envelope — unpaginated deviation)**

### `POST /api/admin/announcements` — create announcement
**File**: `src/app/api/admin/announcements/route.ts` · **Auth**: requireAdmin() [any admin role] · **Rate limit**: none
**Purpose**: Create an announcement with audience and scheduling window.
**Request**: path: —; body:
```ts
interface AnnouncementPostBody { title: string; body?: string | null; audience?: "all" | "sellers" | "admins"; startsAt?: string | null; endsAt?: string | null; isActive?: boolean }
```
**Response 200**:
```ts
interface AnnouncementCreatedResponse { data: { id: string; title: string; body: string | null; audience: string; startsAt: string | null; endsAt: string | null; isActive: boolean; createdAt: string } }
```
**Errors**: `400 VALIDATION` title required / invalid audience · `400 BAD_JSON` malformed body

### `PATCH /api/admin/announcements/[id]` — update announcement
**File**: `src/app/api/admin/announcements/[id]/route.ts` · **Auth**: requireAdmin() [any admin role] · **Rate limit**: none
**Purpose**: Partial update of announcement fields with audit trail.
**Request**: path: `id: string`; body:
```ts
interface AnnouncementPatchBody { title?: string; body?: string; audience?: "all" | "sellers" | "admins"; startsAt?: string | null; endsAt?: string | null; isActive?: boolean }
```
**Response 200**:
```ts
interface AnnouncementUpdatedResponse { data: { id: string; title: string; body: string | null; audience: string; startsAt: string | null; endsAt: string | null; isActive: boolean; createdAt: string } }
```
**Errors**: `404 NOT_FOUND` announcement not found · `400 VALIDATION` invalid audience / invalid date / empty update

---

## §19 Admin — Content, Config & Reporting

```ts
interface CampaignTheme { accent: string; accentSoft: string; gradientFrom: string; gradientTo: string; greeting: string; greetingBm: string; tagline: string; taglineBm: string; ornament: string }
interface CampaignItem { id: string; name: string; description: string | null; presetId: string | null; themeJson: string; isPublished: boolean; placement: string; priority: number; displayOrder: number; ctaLabel: string | null; ctaHref: string | null; bannerDesktopUrl: string | null; bannerMobileUrl: string | null; thumbnailUrl: string | null; productQuery: string | null; archivedAt: string | null; startAt: string; endAt: string; createdAt: string; updatedAt: string; theme: CampaignTheme; status: "draft" | "scheduled" | "live" | "ended" | "archived"; daysUntilStart: number; daysLeft: number }
```

### `GET /api/admin/banners` — list banners
**File**: `src/app/api/admin/banners/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: List all marketplace banners ordered by sortOrder asc, createdAt desc.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface BannersResponse { data: { id: string; title: string; imageUrl: string; linkUrl: string | null; sortOrder: number; isActive: boolean; createdAt: string }[] }
```
**(deviation: plain `{data}` list, no meta — unpaginated)**
**Errors**: none notable (auth via handle only).

### `POST /api/admin/banners` — create banner
**File**: `src/app/api/admin/banners/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Create a marketplace banner; audited as `banner.create`.
**Request**: path: —; query: —; body:
```ts
interface BannerCreateBody { title: string; imageUrl?: string (default "/api/img/banner-new?w=1600&h=520&label=Banner"); linkUrl?: string | null; sortOrder?: number (0); isActive?: boolean (true) }
```
**Response 200**:
```ts
interface BannerCreateResponse { data: { id: string; title: string; imageUrl: string; linkUrl: string | null; sortOrder: number; isActive: boolean; createdAt: string } }
```
**Errors**: `400 VALIDATION` title required · `400 BAD_JSON` malformed body.

### `PATCH /api/admin/banners/[id]` — update banner
**File**: `src/app/api/admin/banners/[id]/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Partially update a banner; audited as `banner.update`.
**Request**: path: `id: string`; query: —; body:
```ts
interface BannerUpdateBody { title?: string; imageUrl?: string; linkUrl?: string | null; sortOrder?: number; isActive?: boolean }
```
**Response 200**:
```ts
interface BannerUpdateResponse { data: { id: string; title: string; imageUrl: string; linkUrl: string | null; sortOrder: number; isActive: boolean; createdAt: string } }
```
**Errors**: `404 NOT_FOUND` banner missing · `400 VALIDATION` empty patch · `400 BAD_JSON` malformed body.

### `DELETE /api/admin/banners/[id]` — delete banner
**File**: `src/app/api/admin/banners/[id]/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Hard-delete a banner; audited as `banner.delete`.
**Request**: path: `id: string`; query: —; body: none.
**Response 200**:
```ts
interface BannerDeleteResponse { data: { deleted: true } }
```
**Errors**: `404 NOT_FOUND` banner missing.

### `GET /api/admin/categories` — category tree
**File**: `src/app/api/admin/categories/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Full category list as a nested parent/child tree with product counts.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface CategoriesResponse { data: CategoryNode[] }
interface CategoryNode { id: string; name: string; slug: string; commissionPercent: number | null; imageUrl: string | null; sortOrder: number; productCount: number; children: CategoryNode[] }
```
**(deviation: plain `{data}` list, no meta — unpaginated)**
**Errors**: none notable.

### `POST /api/admin/categories` — create category
**File**: `src/app/api/admin/categories/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Create category with unique slugified slug; audited as `category.create`.
**Request**: path: —; query: —; body:
```ts
interface CategoryCreateBody { name: string; parentId?: string | null; commissionPercent?: number (null) }
```
**Response 200**:
```ts
interface CategoryCreateResponse { data: { id: string; name: string; slug: string; parentId: string | null; commissionPercent: number | null; imageUrl: string | null; sortOrder: number; createdAt: string; updatedAt: string } }
```
**Errors**: `400 VALIDATION` name required / commissionPercent 0..100 · `404 NOT_FOUND` parent category missing.

### `PATCH /api/admin/categories/[id]` — update category
**File**: `src/app/api/admin/categories/[id]/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Partially update category; audited as `category.update`.
**Request**: path: `id: string`; query: —; body:
```ts
interface CategoryUpdateBody { name?: string; commissionPercent?: number | null; sortOrder?: number }
```
**Response 200**:
```ts
interface CategoryUpdateResponse { data: { id: string; name: string; slug: string; parentId: string | null; commissionPercent: number | null; imageUrl: string | null; sortOrder: number; createdAt: string; updatedAt: string } }
```
**Errors**: `404 NOT_FOUND` category missing · `400 VALIDATION` commissionPercent range / empty patch.

### `DELETE /api/admin/categories/[id]` — delete category
**File**: `src/app/api/admin/categories/[id]/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Delete category; detaches products, re-parents children to null first.
**Request**: path: `id: string`; query: —; body: none.
**Response 200**:
```ts
interface CategoryDeleteResponse { data: { deleted: true } }
```
**Errors**: `404 NOT_FOUND` category missing.

### `GET /api/admin/coupons` — list coupons
**File**: `src/app/api/admin/coupons/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Paged coupon list joined with store id/name, newest first.
**Request**: path: —; query: `page: number (1)`, `size: number (20, max 100)`, `scope: string (none; "all" = no filter)`; body: none.
**Response 200**:
```ts
interface CouponsResponse { data: { id: string; scope: string; storeId: string | null; code: string; description: string | null; type: string; percent: number | null; amountMinor: number | null; minSpendMinor: number; maxRedemptions: number | null; perCustomerLimit: number; startsAt: string | null; endsAt: string | null; isActive: boolean; timesUsed: number; createdAt: string; updatedAt: string; store: { id: string; name: string } | null }[]; meta: { page: number; size: number; total: number } }
```
**Errors**: none notable.

### `POST /api/admin/coupons` — create coupon
**File**: `src/app/api/admin/coupons/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Create platform/store coupon (money lever); audited as `coupon.create`.
**Request**: path: —; query: —; body:
```ts
interface CouponCreateBody { code: string; type?: "percent" | "fixed" | "freeship" ("percent"); percent?: number; amountMinor?: number; storeId?: string | null; description?: string | null; minSpendMinor?: number (0); maxRedemptions?: number | null; perCustomerLimit?: number (1); startsAt?: string | null; endsAt?: string | null; isActive?: boolean (true) }
```
**Response 200**:
```ts
interface CouponCreateResponse { data: { id: string; scope: string; storeId: string | null; code: string; description: string | null; type: string; percent: number | null; amountMinor: number | null; minSpendMinor: number; maxRedemptions: number | null; perCustomerLimit: number; startsAt: string | null; endsAt: string | null; isActive: boolean; timesUsed: number; createdAt: string; updatedAt: string } }
```
**Errors**: `409 CONFLICT` code exists · `400 VALIDATION` type/percent/amountMinor rules · `404 NOT_FOUND` store missing · `403 FORBIDDEN` missing cap.

### `PATCH /api/admin/coupons/[id]` — update coupon
**File**: `src/app/api/admin/coupons/[id]/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Partially update coupon; audited as `coupon.update`.
**Request**: path: `id: string`; query: —; body:
```ts
interface CouponUpdateBody { description?: string; percent?: number; amountMinor?: number; minSpendMinor?: number; maxRedemptions?: number; perCustomerLimit?: number; startsAt?: string | null; endsAt?: string | null; isActive?: boolean }
```
**Response 200**:
```ts
interface CouponUpdateResponse { data: { id: string; scope: string; storeId: string | null; code: string; description: string | null; type: string; percent: number | null; amountMinor: number | null; minSpendMinor: number; maxRedemptions: number | null; perCustomerLimit: number; startsAt: string | null; endsAt: string | null; isActive: boolean; timesUsed: number; createdAt: string; updatedAt: string } }
```
**Errors**: `404 NOT_FOUND` coupon missing · `400 VALIDATION` ranges / empty patch · `403 FORBIDDEN` missing cap.

### `DELETE /api/admin/coupons/[id]` — delete coupon
**File**: `src/app/api/admin/coupons/[id]/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Hard-delete coupon; audited as `coupon.delete`.
**Request**: path: `id: string`; query: —; body: none.
**Response 200**:
```ts
interface CouponDeleteResponse { data: { deleted: true } }
```
**Errors**: `404 NOT_FOUND` coupon missing · `403 FORBIDDEN` missing cap.

### `GET /api/admin/campaigns` — list campaigns
**File**: `src/app/api/admin/campaigns/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Paged campaigns with parsed theme, derived status and day countdowns; archived excluded by default.
**Request**: path: —; query: `page: number (1)`, `size: number (20, max 100)`, `status: string ("": draft|scheduled|live|ended|archived)`, `placement: string ("")`, `q: string ("")`; body: none.
**Response 200**:
```ts
interface CampaignsResponse { data: CampaignItem[]; meta: { page: number; size: number; total: number } }
```
**Errors**: `403 FORBIDDEN` missing campaigns.manage.

### `POST /api/admin/campaigns` — create campaign
**File**: `src/app/api/admin/campaigns/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Create campaign; preset auto-fills dates; theme validated; busts public caches.
**Request**: path: —; query: —; body:
```ts
interface CampaignCreateBody { name: string; presetId?: string | null; startAt?: string; endAt?: string; theme?: CampaignTheme; isPublished?: boolean (false); description?: string | null; placement?: string; priority?: number; displayOrder?: number; ctaLabel?: string | null; ctaHref?: string | null; bannerDesktopUrl?: string | null; bannerMobileUrl?: string | null; thumbnailUrl?: string | null; productQuery?: string | null }
```
**Response 200**:
```ts
interface CampaignCreateResponse { data: CampaignItem }
```
**Errors**: `400 VALIDATION` name >120 / unknown presetId / missing or reversed dates / invalid theme / merch limits · `403 FORBIDDEN` missing cap.

### `PATCH /api/admin/campaigns/[id]` — update/publish/archive campaign
**File**: `src/app/api/admin/campaigns/[id]/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Edit, publish/unpublish, or soft-archive campaign; validates effective window.
**Request**: path: `id: string`; query: —; body:
```ts
interface CampaignUpdateBody { publish?: boolean; isPublished?: boolean; name?: string; presetId?: string | null; startAt?: string; endAt?: string; theme?: CampaignTheme; archived?: boolean; description?: string | null; placement?: string; priority?: number; displayOrder?: number; ctaLabel?: string | null; ctaHref?: string | null; bannerDesktopUrl?: string | null; bannerMobileUrl?: string | null; thumbnailUrl?: string | null; productQuery?: string | null }
```
**Response 200**:
```ts
interface CampaignUpdateResponse { data: CampaignItem }
```
**Errors**: `404 NOT_FOUND` campaign missing · `400 VALIDATION` empty name/dates/theme/merch · `403 FORBIDDEN` missing cap.

### `DELETE /api/admin/campaigns/[id]` — delete campaign
**File**: `src/app/api/admin/campaigns/[id]/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Hard-delete campaign (archive preferred for history); busts public caches.
**Request**: path: `id: string`; query: —; body: none.
**Response 200**:
```ts
interface CampaignDeleteResponse { data: { deleted: true } }
```
**Errors**: `404 NOT_FOUND` campaign missing · `403 FORBIDDEN` missing cap.

### `POST /api/admin/campaign-media` — upload campaign image
**File**: `src/app/api/admin/campaign-media/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Upload one PNG/JPEG/WebP ≤3 MB (magic-byte sniffed) to `public/uploads/campaigns/`.
**Request**: path: —; query: —; body (multipart/form-data):
```ts
interface CampaignMediaBody { file: File }
```
**Response 200**:
```ts
interface CampaignMediaResponse { data: { url: string; bytes: number; mime: string } }
```
**Errors**: `400 VALIDATION` non-multipart / missing file / empty / >3 MB / unsupported type · `403 FORBIDDEN` missing cap.

### `GET /api/admin/featured` — list featured slots
**File**: `src/app/api/admin/featured/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Featured slots joined with product, image, store info.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface FeaturedResponse { data: { id: string; slot: string; sortOrder: number; isActive: boolean; createdAt: string; product: { id: string; title: string; slug: string; priceMinor: number; status: string; imageUrl: string | null; storeName: string; storeSlug: string } }[] }
```
**(deviation: plain `{data}` list, no meta — unpaginated)**
**Errors**: none notable.

### `POST /api/admin/featured` — add featured slot
**File**: `src/app/api/admin/featured/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Feature a product in a slot; sets product.isFeatured; audited.
**Request**: path: —; query: —; body:
```ts
interface FeaturedCreateBody { productId: string; slot?: string ("home_grid"); sortOrder?: number (0) }
```
**Response 200**:
```ts
interface FeaturedCreateResponse { data: { id: string; productId: string; slot: string; sortOrder: number; isActive: boolean; createdAt: string } }
```
**Errors**: `404 NOT_FOUND` product missing.

### `DELETE /api/admin/featured/[id]` — remove featured slot
**File**: `src/app/api/admin/featured/[id]/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Delete slot; clears product.isFeatured when its last slot goes.
**Request**: path: `id: string`; query: —; body: none.
**Response 200**:
```ts
interface FeaturedDeleteResponse { data: { deleted: true } }
```
**Errors**: `404 NOT_FOUND` slot missing.

### `GET /api/admin/featured-stores` — list featured stores
**File**: `src/app/api/admin/featured-stores/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Ordered featured stores from Setting `home.featured_stores` (missing stores dropped).
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface FeaturedStoresResponse { data: { key: string; stores: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; productCount: number; status: string }[] } }
```
**Errors**: none notable.

### `PUT /api/admin/featured-stores` — replace featured stores
**File**: `src/app/api/admin/featured-stores/route.ts` · **Auth**: admin + settings.manage (superadmin) · **Rate limit**: none
**Purpose**: Replace ordered featured-store id list (max 12); busts market/stores caches.
**Request**: path: —; query: —; body:
```ts
interface FeaturedStoresPutBody { storeIds: string[] }
```
**Response 200**:
```ts
interface FeaturedStoresPutResponse { data: { key: string; stores: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; productCount: number; status: string }[] } }
```
**Errors**: `400 VALIDATION` storeIds not array / >12 · `404 NOT_FOUND` unknown store ids · `403 FORBIDDEN` missing cap.

### `GET /api/admin/home-layout` — homepage layout
**File**: `src/app/api/admin/home-layout/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Current homepage section order, defaults, and section catalogue.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface HomeLayoutResponse { data: { order: string[]; defaults: string[]; sections: { id: string; label: string; description: string; requires: string }[] } }
```
**Errors**: `403 FORBIDDEN` missing campaigns.manage.

### `PUT /api/admin/home-layout` — set homepage order
**File**: `src/app/api/admin/home-layout/route.ts` · **Auth**: admin + campaigns.manage (superadmin | ops) · **Rate limit**: none
**Purpose**: Save normalized section order to Setting `home.section_order`; busts campaign/market caches.
**Request**: path: —; query: —; body:
```ts
interface HomeLayoutPutBody { order: string[] }
```
**Response 200**:
```ts
interface HomeLayoutPutResponse { data: { order: string[] } }
```
**Errors**: `400 VALIDATION` order not array / empty after normalize · `403 FORBIDDEN` missing cap.

### `GET /api/admin/reports/[type]` — analytics report
**File**: `src/app/api/admin/reports/[type]/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Aggregate report from paid orders or payout batches over day window.
**Request**: path: `type: string (sales|sellers|commission|payouts)`; query: `days: number (30, clamped 1–365)`; body: none.
**Response 200**:
```ts
interface ReportResponse { data: { series: { date: string; gmvMinor: number; orders: number; commissionMinor: number }[]; totals: { gmvMinor: number; orders: number; commissionMinor: number; aovMinor: number }; days: number } | { rows: { storeName: string; gmvMinor: number; orders: number; commissionMinor: number; aovMinor: number }[]; totals: { gmvMinor: number; orders: number; commissionMinor: number; stores: number }; days: number } | { series: { date: string; commissionMinor: number; gmvMinor: number; orders: number }[]; byCategory: { categoryName: string; commissionMinor: number }[]; effectiveRate: number; totals: { commissionMinor: number; gmvMinor: number; items: number; itemsValueMinor: number }; days: number } | { batches: { id: string; runType: string; status: string; totalMinor: number; payoutCount: number; startedAt: string; finishedAt: string | null; payouts: { id: string; referenceNo: string; sellerName: string; amountMinor: number; status: string; method: string; paidAt: string | null }[] }[]; totals: { totalMinor: number; count: number; paidMinor: number; processingMinor: number; failedMinor: number; batchCount: number }; days: number } }
```
**Errors**: `400 BAD_TYPE` unknown type.

### `GET /api/admin/export` — CSV export
**File**: `src/app/api/admin/export/route.ts` · **Auth**: admin + reports.export (superadmin | finance) · **Rate limit**: none
**Purpose**: Bulk CSV export of orders/sellers/ledger (PII + money); activity-logged.
**Request**: path: —; query: `entity: string ("orders" | "sellers" | "ledger", default "orders")`; body: none.
**Response 200** **(non-envelope)**: raw `text/csv; charset=utf-8` body with `Content-Disposition: attachment; filename="orders.csv" | "sellers.csv" | "ledger.csv"`; orders/sellers capped at 500 rows, ledger at 3000 lines; columns per entity: orders→`order_number,created_at,paid_at,store,customer_email,status,subtotal_minor,discount_minor,shipping_minor,total_minor,commission_minor`; sellers→`email,display_name,legal_name,status,kyc_status,risk_tier,store_name,wallet_available_minor,created_at`; ledger→`txn_id,occurred_at,txn_type,ref_type,ref_id,account_code,direction,amount_minor,memo`.
**Errors**: `400 BAD_ENTITY` unknown entity · `403 FORBIDDEN` missing cap.

### `GET /api/admin/audit-logs` — list audit logs
**File**: `src/app/api/admin/audit-logs/route.ts` · **Auth**: admin + logs.view (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Paged admin audit trail with before/after JSON parsed.
**Request**: path: —; query: `page: number (1)`, `size: number (20, max 100)`, `adminEmail: string (contains)`, `action: string (contains)`, `entityType: string (exact)`; body: none.
**Response 200**:
```ts
interface AuditLogsResponse { data: { id: string; adminId: string; adminEmail: string; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown; createdAt: string }[]; meta: { page: number; size: number; total: number } }
```
**Errors**: `403 FORBIDDEN` missing logs.view.

### `GET /api/admin/activity-logs` — list activity logs
**File**: `src/app/api/admin/activity-logs/route.ts` · **Auth**: admin + logs.view (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Paged activity trail across actor types with meta JSON parsed.
**Request**: path: —; query: `page: number (1)`, `size: number (20, max 100)`, `actorType: string (exact; "all" = no filter)`, `action: string (contains)`; body: none.
**Response 200**:
```ts
interface ActivityLogsResponse { data: { id: string; actorType: string; actorId: string | null; actorLabel: string | null; action: string; entityType: string | null; entityId: string | null; meta: unknown; createdAt: string }[]; meta: { page: number; size: number; total: number } }
```
**Errors**: `403 FORBIDDEN` missing logs.view.

### `GET /api/admin/activity-logs/purge` — purge count
**File**: `src/app/api/admin/activity-logs/purge/route.ts` · **Auth**: admin + logs.purge (superadmin) · **Rate limit**: none
**Purpose**: ActivityLog counts for the purge confirm dialog.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface PurgeCountResponse { data: { total: number; byActor: { actorType: string; count: number }[] } }
```
**Errors**: `403 FORBIDDEN` missing logs.purge.

### `POST /api/admin/activity-logs/purge` — purge activity logs
**File**: `src/app/api/admin/activity-logs/purge/route.ts` · **Auth**: admin + logs.purge (superadmin) · **Rate limit**: none
**Purpose**: Password-reverified batched wipe of whole ActivityLog table (≤500k rows/call).
**Request**: path: —; query: —; body:
```ts
interface PurgeBody { password: string }
```
**Response 200**:
```ts
interface PurgeResponse { data: { deleted: number; remaining: number } }
```
**Errors**: `400 VALIDATION` password missing · `401 INVALID_PASSWORD` wrong password (400 ms delay, denial audited) · `403 FORBIDDEN` missing cap.

### `GET /api/admin/webhook-deliveries` — list webhook deliveries
**File**: `src/app/api/admin/webhook-deliveries/route.ts` · **Auth**: admin + logs.view (superadmin | ops | finance) · **Rate limit**: none
**Purpose**: Paged real webhook delivery state with last-attempt detail and derived retry time.
**Request**: path: —; query: `page: number (1)`, `size: number (50, max 100 — deviation: default 50)`, `status: string (exact)`, `endpointId: string (exact)`, `event: string (exact)`; body: none.
**Response 200**:
```ts
interface WebhookDeliveriesResponse { data: { id: string; event: string; status: string; attempts: number; maxAttempts: number; responseCode: number | null; lastAttemptAt: string | null; createdAt: string; nextRetryAt: string | null; endpoint: { id: string; url: string; isActive: boolean }; store: { id: string; name: string } | null; lastError: string | null; lastResponseBody: string | null; lastAttemptSigned: boolean | null; replayPath: string | null }[]; meta: { page: number; size: number; total: number } }
```
**Errors**: `403 FORBIDDEN` missing logs.view. (Route sets `dynamic = "force-dynamic"`.)

### `POST /api/admin/webhook-deliveries/[id]/replay` — replay delivery
**File**: `src/app/api/admin/webhook-deliveries/[id]/replay/route.ts` · **Auth**: admin + settings.manage (superadmin) · **Rate limit**: none
**Purpose**: Force a real (signed, SSRF-guarded) redelivery attempt; outcome recorded honestly.
**Request**: path: `id: string`; query: —; body: none.
**Response 200**:
```ts
interface ReplayResponse { data: { replayed: boolean; deliveryId: string; status: string; attempts: number; responseCode: number | null; error: string | null; responseBody: string | null; durationMs: number | null; nextRetryAt: string | null; endpointUrl: string; storeName: string } }
```
**Errors**: `404 NOT_FOUND` delivery missing · `409 ALREADY_DELIVERED` terminal success · `409 ENDPOINT_INACTIVE` endpoint paused · `409 EVENT_UNSUBSCRIBED` no longer subscribed · `403 FORBIDDEN` missing cap.

### `GET /api/admin/feature-flags` — list feature flags
**File**: `src/app/api/admin/feature-flags/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: All feature flags ordered by key asc.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface FeatureFlagsResponse { data: { key: string; description: string | null; isEnabled: boolean; rolloutPercent: number }[] }
```
**(deviation: plain `{data}` list, no meta — unpaginated)**
**Errors**: none notable.

### `PATCH /api/admin/feature-flags` — upsert feature flag
**File**: `src/app/api/admin/feature-flags/route.ts` · **Auth**: admin + settings.manage (superadmin) · **Rate limit**: none
**Purpose**: Update or create flag by key (upsert); audited as `feature_flag.update`.
**Request**: path: —; query: —; body:
```ts
interface FeatureFlagPatchBody { key: string; isEnabled?: boolean; rolloutPercent?: number; description?: string }
```
**Response 200**:
```ts
interface FeatureFlagPatchResponse { data: { key: string; description: string | null; isEnabled: boolean; rolloutPercent: number } }
```
**Errors**: `400 VALIDATION` key required / rolloutPercent 0..100 · `403 FORBIDDEN` missing cap. (Deviation: PATCH on collection path, upsert semantics; create defaults isEnabled=false, rolloutPercent=100.)

### `GET /api/admin/notifications` — list notification logs
**File**: `src/app/api/admin/notifications/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Latest 100 notification log rows, newest first.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface NotificationsResponse { data: { id: string; event: string; channel: string; recipient: string; subject: string | null; status: string; error: string | null; createdAt: string; dedupKey: string | null }[] }
```
**(deviation: plain `{data}` list, no meta — unpaginated, capped at 100)**
**Errors**: none notable.

### `GET /api/admin/system/health` — system health
**File**: `src/app/api/admin/system/health/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Entity counts, payment reconciliation counts, ledger invariants, recent audit trail.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface HealthResponse { data: { status: "healthy" | "degraded"; db: "up"; counts: { sellers: number; stores: number; products: number; orders: number }; paymentReconciliation: { requested: number; processing: number; succeeded: number; failed: number; unknown: number }; ledger: { ok: boolean; problems: string[]; txnCount: number; walletCount: number; hardDrift: WalletDrift[]; timeMaturityStale: WalletDrift[] }; recentAudit: { id: string; adminId: string; adminEmail: string; action: string; entityType: string; entityId: string | null; beforeJson: string | null; afterJson: string | null; createdAt: string }[] } }
interface WalletDrift { walletId: string; cachedAvailable: number; cachedPending: number; truthAvailable: number; truthPending: number; availableDelta: number; pendingDelta: number; maturedSinceLastWrite: number; lastCacheWriteAt: string }
```
**Errors**: none notable (recentAudit = 5 raw rows, JSON columns unparsed).

### `GET /api/admin/dashboard` — dashboard KPIs
**File**: `src/app/api/admin/dashboard/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: Command-centre KPIs: today's GMV/commission, queues, payouts due, 30d series.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface DashboardResponse { data: { gmvTodayMinor: number; ordersToday: number; commissionTodayMinor: number; activeStores: number; pendingKyc: number; productsToModerate: number; refundsQueue: number; disputesOpen: number; payoutsDueMinor: number; payoutsDueSellers: number; gmvSeries30d: { date: string; gmvMinor: number; orders: number }[]; topStores: { storeName: string; gmv30dMinor: number; orders30d: number }[]; recentSellers: { id: string; displayName: string; storeName: string | null; status: string; createdAt: string }[] } }
```
**Errors**: none notable (payoutsDue derived from raw SELLER:*:PAYABLE ledger lines vs `payout.min_minor`).

### `GET /api/admin/settings` — list settings
**File**: `src/app/api/admin/settings/route.ts` · **Auth**: admin (any role) · **Rate limit**: none
**Purpose**: DB settings merged with registry meta; unknown keys in Advanced group.
**Request**: path: —; query: —; body: none.
**Response 200**:
```ts
interface SettingsResponse { data: { key: string; valueJson: string; description: string | null; updatedAt: string | null; meta: { key: string; group: string; label: string; description: string; field: { kind: "boolean" | "integer" | "enum" | "string" | "weights" | "string_list" | "readonly" | "json" } & Record<string, unknown>; wired: boolean; wiredNote?: string; danger?: boolean; hidden?: boolean } }[] }
```
**(deviation: plain `{data}` list, no meta — unpaginated; known keys always carry description, absent rows show registry default valueJson)**
**Errors**: none notable.

### `PUT /api/admin/settings` — update settings
**File**: `src/app/api/admin/settings/route.ts` · **Auth**: admin + settings.manage (superadmin) · **Rate limit**: none
**Purpose**: Bulk upsert settings validated against registry; audited as `settings.update`.
**Request**: path: —; query: —; body:
```ts
interface SettingsPutBody { settings: { key: string; valueJson: string | unknown }[] }
```
**Response 200**:
```ts
interface SettingsPutResponse { data: { key: string; valueJson: string; description: string | null; updatedAt: string }[] }
```
**Errors**: `400 VALIDATION` settings array required/empty / bad value · `400 READ_ONLY` readonly key · `403 FORBIDDEN` missing cap.

---

## §20 Coverage & Maintenance Notes

### Endpoint census (this snapshot)

| Domain | Files | Endpoints |
|---|---|---|
| §2 Auth & Identity | 17 | 17 |
| §3 Platform & Ops | 20 | 27 |
| §4 Public Marketplace & Storefront | 19 | 21 |
| §5 Cart & Checkout | 14 | 17 |
| §6 Orders, Receipts & Guest Access | 4 | 4 |
| §7 Shopper Account Hub | 18 | 26 |
| §8 Messaging (Chat) | 10 | 14 |
| §9 Affiliate — Shopper Side | 15 | 20 |
| §10 Seller — Catalog & Imports | 30 | 43 |
| §11 Seller — Orders & Fulfillment | 7 | 7 |
| §12 Seller — Insights | 10 | 10 |
| §13 Seller — Monetization | 8 | 11 |
| §14 Seller — Config & Ops | 22 | 30 |
| §15 Admin — Sellers/KYC/Moderation | 25 | 27 |
| §16 Admin — Finance | 27 | 35 |
| §17 Admin — Affiliate Management | 10 | 10 |
| §18 Admin — MFA & Support | 9 | 11 |
| §19 Admin — Content/Config/Reporting | 25 | 39 |
| **Total** | **290** | **369** |

*(File counts exclude the non-existent `store/chat/threads/[id]/route.ts` — seller chat only has `read/` and `messages/` subroutes. Endpoint counts count exported HTTP method handlers; totals include manually-audited `admin/refunds` and `admin/settings`.)*

### Known contract deviations (frontend/backend split watch-list)

1. **Unpaginated lists via `ok()`** (no `meta`): market/stores, admin banners/categories/featured/feature-flags/notifications/announcements/settings/payout-batches/wallets/ledger-accounts/commission exports+holidays+overrides/banks, seller payouts/bank-accounts/categories/collections/coupons etc. — frontend must not assume `meta.total`.
2. **Inline pagination inside `data`**: affiliate discover/earnings/network, admin affiliate accounts/commissions/payouts, seller affiliate products — `total`/`page` fields in body, not `meta`.
3. **Nested meta**: admin payment-reconciliation (`data.meta`).
4. **Cursor pagination**: admin ledger transactions (`cursor`), chat messages (`before`).
5. **Non-envelope responses**: `img/[seed]` (SVG), orders receipt (PDF), seller AWB label (SVG), insights export (CSV), admin export (CSV), OAuth callback (307 redirect).
6. **Auth-code deviations**: `UNAUTHENTICATED` (vs `UNAUTHORIZED`) on claim/bind, store/seo, store/publish, store/connections×3, store/imports.
7. **`/api/me/password`** accepts any principal type (admin/seller/shopper), unlike the rest of `/api/me/*`.

### Maintenance rule

When a route's serialization changes, update its block here in the same commit — this file is the contract both the current frontend and any future separated backend must honor.

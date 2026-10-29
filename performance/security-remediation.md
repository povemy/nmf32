# NOMOFEE — Security Remediation Log (Task G)

| | |
|---|---|
| **Log file** | `/home/z/my-project/performance/security-remediation.md` |
| **Backlog source** | `full-audit-report.md` (audit snapshot 2026-10-29) — treated as evidence to VALIDATE, not proof |
| **Baseline** | git `main` @ `1c5bbd7`, clean working tree (verified before any change) |
| **Labels** | PASS / FAIL / NOT TESTED / BLOCKED — only for executed checks |
| **Environment** | Dev sandbox (`NODE_ENV=development`, dev server :3000). Production deployment access does NOT exist. All "production" behavior verified by code path + `NODE_ENV` conditionals; runtime probes run in dev only. |

---

## Phase 0 — Verified starting state (executed 2026-10-29/30)

### 0.1 Re-verification of every in-scope finding against current source

Every claim below was re-checked by direct file read this session, **before** any modification. The audit snapshot matched the source in all cases — nothing had drifted since the audit.

| Finding | Verified current status | Affected routes / files | Root cause | Planned minimal fix | Active in dev / staging / prod |
|---|---|---|---|---|---|
| **F-04 (CRITICAL)** webhook secret fails open | **CONFIRMED** — `src/app/api/webhooks/payments/process.ts:49`: `const WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo"` (module-load-time constant). `PSP_WEBHOOK_SECRET` absent from `.env` AND `.env.example`. | `POST /api/webhooks/payments/[provider]`, `POST /api/checkout/payments/[ref]/simulate`, `POST /api/webhooks/payments/payout-simulate` (all sign/verify through `expectedSignature()`) | Public demo fallback authenticates money events when env unset | Lazy secret resolution: production + unset → fail closed (503 `WEBHOOK_SECRET_UNSET`) at invocation; dev keeps documented fallback for mock rails; document var in `.env.example` (placeholder only) + startup validation in `instrumentation-node.ts` | dev: YES (mock rails rely on fallback — intended); staging/prod: YES — fail-open path is exactly the production hole |
| **F-01 (CRITICAL)** systemic CSRF | **CONFIRMED** — `src/lib/auth.ts:38` `sameSite:"none"` cookie; **no** `src/proxy.ts` / `src/middleware.ts` exists (glob-verified); zero origin/`Sec-Fetch-Site` checks in `src/` | Every cookie-authenticated non-GET API route (admin/seller/shopper mutations) | No request-origin gate anywhere; Bearer path exists but cookie is default for top-level browsing | `src/proxy.ts` (Next 16 convention, verified `PROXY_FILENAME='proxy'` in next@16.1.3): origin + `Sec-Fetch-Site` + strict content-type enforcement for non-GET/HEAD/OPTIONS `/api/*` requests, exempting HMAC/secret-authenticated endpoints (webhooks, cron, ticks, simulate) | dev/staging/prod: YES (all) |
| **F-02/F-24 (CRITICAL)** seller status cosmetic | **CONFIRMED** — `auth.ts:92-104` `requireSeller()` never enforces status; `auth.ts:107-113` `requireActiveSellerStore()` checks store existence only; login blocks only `terminated` (`login/route.ts:32-34`); suspend/terminate flip status with **no session deletion** (`suspend/route.ts:20-21`, `terminate/route.ts:20-21`); `store/publish` has **no status check** (`publish/route.ts:10-28`); shell-only block `seller-shell.tsx:175-190`. Sole status-gated route: `store/onboarding` (`onboarding/route.ts:16`) | All `/api/store/**` (56 routes via `requireActiveSellerStore`), `/api/store/publish`, `POST /api/auth/login`, admin suspend/terminate/reject | Status never enforced server-side; sessions never revoked on status change | (a) `requireActiveSellerStore` rejects `suspended`/`terminated`; (b) login rejects `suspended` (403 `ACCOUNT_SUSPENDED`) + existing `terminated` 403 — onboarding statuses preserved; (c) `revokeUserSessions("seller", id)` on suspend/terminate/reject; (d) publish route blocks `suspended`/`terminated` | dev/staging/prod: YES (all) |
| **F-03 (CRITICAL)** password rotation broken at compile time | **CONFIRMED** — `me/password/route.ts:3` imports `rotateSession` (TS2724 — `lib/auth` has no such export); `stripe-my.ts:61` imports `safeEqualHex` (TS2305 — `lib/password` exports only `hashPassword/verifyPassword/randomToken/hmacSha256Hex`); password hash IS written before the throw → 500 + unrotated session | `POST /api/me/password` (all three principals); `src/lib/psp-adapters/stripe-my.ts` (build path) | Functions referenced but never implemented; blueprint §945 claims both shipped (documentation ≠ implementation) | Implement `rotateSession()` + `revokeUserSessions()` in `lib/auth.ts` (blueprint spec: delete-first rotation, cookie+Bearer aware); add `safeEqualHex` to `lib/password.ts`; add the missing psp.ts adapter types (`PspAdapterError`, `PspCheckoutSession[Input]`, `PspWebhookVerdict`, optional adapter methods on `PspProvider`) | dev: YES (500 on every password change — reproduced by compile evidence); prod: build BLOCKED (see 0.3) |
| **F-05 (HIGH)** shipping webhook unauthenticated | **CONFIRMED** — no signature/auth/rate-limit; **additionally the route does not compile** (6 TS errors: `getShippingProvider` not exported by `lib/shipping`; `order.shipmentStatus` not a Prisma field; `ShipmentEvent` requires `shipmentId`, not `orderId`) — dev mode ignores type errors, so it still RUNS broken in dev | `POST /api/shipping/webhook/[provider]` | Written against an older schema/API; auth was "future work" | Rewrite against the current `Shipment` model + HMAC verification mirroring the payments webhook (secret via `SHIPPING_WEBHOOK_SECRET`, fail closed in production, replay window), + rate limit | dev: YES; prod: unsigned accepted today (the hole) |
| **F-06 (HIGH)** chat hub/relay unauthenticated | **CONFIRMED** — `mini-services/chat-service/index.ts:41-56` any client joins any `thread:*`/`user:*` room; relay `:3103 POST /broadcast` unauthenticated; Caddyfile proxies ANY localhost port via `XTransformPort` wildcard | chat hub :3003, relay :3103, `Caddyfile:2-13`, clients `chat-ui.tsx:135` + `chat-presence.ts:49` | Hub is a "dumb relay" by design with zero authorization | (a) socket handshake auth via session token validated through a new authoritative Next endpoint; (b) room membership enforced on `join`; (c) relay requires shared secret (`CHAT_RELAY_SECRET`, fail-closed in production); (d) gateway restricts `XTransformPort` to 3000/3003 | dev: YES; external reachability of :81 itself = environment property (verified locally; honest limit) |
| **F-13 (HIGH)** mock PSP fails open in production | **CONFIRMED** — `psp.ts:137-143` `mockPspAllowed()` returns true in production when the Setting row is missing (parseJson default true) | simulate endpoints (`checkout/payments/[ref]/simulate`, `webhooks/payments/payout-simulate`) | Default-true fail-open parse | Production: row missing or malformed → false; only explicit `true` allows | dev: YES (by design); prod: the hole |
| **F-12/F-19 (HIGH)** login/register abuse + demo creds in bundle | **CONFIRMED** — no rateLimit import in the 4 auth handlers (verified); `admin-shell.tsx:434-439` ships superadmin/ops/finance/moderator emails + passwords to every browser | `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/shopper/login`, `POST /api/auth/shopper/register`; `admin-shell.tsx` | No throttling; convenience demo quick-fill hardcoded | Bounded IP rate limits (login 10/min, register 5/min — uniform 401 already avoids account-existence leaks); remove `DEMO_ACCOUNTS` from the client bundle; seed credentials documented server-side only, env-overridable | dev/staging/prod: YES |
| **F-09 (HIGH)** commission/hold/risk mutation under `requireAdmin` | **CONFIRMED** — `sellers/[id]/route.ts` PATCH mutates `commissionOverridePercent`/`holdDaysOverride`/`riskTier` with bare `requireAdmin` (moderator can zero commission) | `PATCH /api/admin/sellers/[id]` | Guard tier mismatch vs caps matrix (`commission.manage` = superadmin, finance) | Split the PATCH: commission/hold/risk fields gated by `requireCap("commission.manage")`; other fields keep `requireAdmin` | dev/staging/prod: YES |
| **F-18/F-25/F-26 (MED-HIGH)** remaining authorization boundaries | **CONFIRMED per audit** — `featured-stores` PUT bare `requireAdmin` (Setting write); webhook-delivery replay bare `requireAdmin`; KYC-queue/banks/sellers[id]/export-CSV/commission-analytics readable by moderator | respective admin routes | Least-privilege capability tier not applied | Apply existing caps matrix consistently (see Phase 3 log below); negative authorization probes for moderator/finance/superadmin/seller/shopper | dev/staging/prod: YES |
| **Phase 4 linkage findings (F-07/F-08/F-10/F-11/F-12-registry/F-14/F-15/F-16/F-17)** | **CONFIRMED per audit** (spot re-reads: `wallet.tsx:336` "RM 50", checkout 10:00 vs `expiresAt` 30 min, `analytics-tick` env-only, featureFlag zero consumers) | see audit §2.2 matrix | Admin surfaces advertising behavior the runtime never reads | Per finding: WIRE (commission overrides, retention, countdown, provider list, payout-min copy) or LABEL-not-implemented (hold-release rule, grace days, buyer-protection window) or REMOVE dead surface — decisions logged in Phase 4 section | dev/staging/prod: YES |

### 0.2 Test suites available at baseline

- `scripts/fin-tests.ts`, `fin-concurrency.ts`, `fin-reconcile.ts` (finance regression harnesses — executable via bun)
- `scripts/test-oversell.ts`, `checkout-capacity-probe.ts`, loadtest/ (capacity)
- No unit-test framework is configured (no jest/vitest in package.json). Verification method for this task: targeted runtime probes (curl) against dev server + `agent-browser` E2E + DB-state inspection — matching the audit's own method. No new test files (repo rule).

### 0.3 Build-blocker classification (`bunx tsc --noEmit` = 173 errors)

| Class | Count | Verdict |
|---|---|---|
| `src/**` (Next.js build path; `next.config.ts` has `typescript.ignoreBuildErrors: false` → these **hard-fail** `next build`) | **47** | **App build blockers — MUST fix all in this task** |
| `scripts/**` + `tool-results/**` (dev tooling; excluded from the Next build graph) | 126 | Classified debt, NOT application build blockers. Not wholesale-fixed here (out of task scope); left honestly reported |

src/ breakdown: `me/follows` 14 (Prisma field drift: `shopperId`→`shopperUserId`, `follows`→`followers`, missing `store` include, compound-unique name), `admin/campaigns.tsx` 12 (campaign theme/preset type drift), `stripe-my.ts` 6 (missing psp.ts exports + `safeEqualHex`), `shipping/webhook` 6 (schema drift — route rewritten in Phase 2), `shipping/quote` 5 (lib API drift), `me/password` 1 (F-03), `metrics` 1 (`prismaBase` not exported), `vouchers/[id]` 1 (`parseSellerVoucherInput`), `inventory-release` 1 (field drift).

### 0.4 Honest limits (Phase 0)

- **Production build cannot run in this sandbox** (environment policy: dev server only, port 3000). Build-gate result will be labeled source-level (`tsc` src-clean + lint) vs an actual `next build` (NOT TESTED here — must run in CI/staging).
- **No production deployment access** — production fail-closed behavior verified by code-path analysis + `NODE_ENV` conditional; runtime probes execute in dev where the fail-open branch is intentionally still allowed (mock rails).
- Blueprint §943-945 claims (session hashing, rotation, revocation, suspended-login-403) describe an intended state that the code never contained — the blueprint's *design* is adopted as the implementation spec, with the discrepancy recorded.

---

## Phase 1 — CRITICAL fixes (ALL LANDED + RUNTIME-VERIFIED 2026-10-30)

### F-04 — Payment webhook secret (FIXED · VERIFIED)

- **Files changed:** `src/app/api/webhooks/payments/process.ts` (module-constant secret → lazy `webhookSecret()` failing closed in production with 503 `WEBHOOK_SECRET_UNSET`), `.env.example` (documents `PSP_WEBHOOK_SECRET` + `CRON_SECRET` + `METRICS_TOKEN` + `SHIPPING_WEBHOOK_SECRET` + `CHAT_RELAY_SECRET` + `IMPORT_TOKEN_ENC_KEY` + optional provider keys + seed password overrides — placeholders only), `src/instrumentation-node.ts` (+`warnProductionSecrets()` production boot validation), `src/instrumentation.ts` (calls it).
- **Preserved:** HMAC-SHA256 formula over `ref.eventType.amount.ts`, timing-safe compare (`safeEqual`), ±10-min replay window, idempotency (claim-first Serializable), PSP retry convergence, webhook row logging (log-then-verify order unchanged).
- **Evidence:**
  - Isolated probe (`NODE_ENV=production`): unset secret → **throws 503 WEBHOOK_SECRET_UNSET PASS**; set secret → returns env value **PASS**; dev unset → documented fallback **PASS**.
  - Live webhook probes (dev): valid signature + unknown ref → 404 INTENT_NOT_FOUND (verification passed) **PASS**; wrong signature → 400 BAD_SIGNATURE **PASS**; 30-min-old correctly-signed replay → 400 STALE_EVENT **PASS**.
- **Remaining/deployment:** production MUST set `PSP_WEBHOOK_SECRET` (boot error logged until then).

### F-01 — CSRF protection (FIXED · RUNTIME-CONFIRMED)

- **Files changed:** `src/proxy.ts` (NEW — Next 16 proxy convention; origin/`Sec-Fetch-Site`/content-type gate for non-safe `/api/*` requests; exemption list for self-authenticated routes; Bearer-first rule preserving the iframe architecture). Cookie strategy unchanged (`SameSite=None` + Bearer bridge is the documented architecture; the proxy adds the missing request-origin gate instead of weakening auth).
- **Evidence (live probes against dev server):**
  - cross-site `Origin: https://evil.example` POST → **403 CSRF_REJECTED PASS**
  - same-origin Origin POST → passes gate, route-level 401 **PASS**
  - no-Origin non-browser POST (scripts/PSP) → passes gate **PASS**
  - `Sec-Fetch-Site: cross-site` (no Origin) → **403 PASS**
  - urlencoded form POST (classic form CSRF) → **415 UNSUPPORTED_MEDIA_TYPE PASS**
  - Bearer-bearing cross-site request (iframe preview path) → passes gate **PASS**
  - webhook with cross-site Origin + valid HMAC → exempted, passes to route (404 unknown ref) **PASS** — a first-run exemption-match bug (double-slash prefix) was caught by this very probe and fixed + re-verified.
  - cron route with cross-site Origin → exempted (dev-open mode by documented design; production fails closed) **PASS**
- **Honest limits:** cross-site form-CSRF feasibility against `req.json()` was INFERRED in the audit; the live probes above now exercise the actual gate. Browsers without BOTH Origin and Sec-Fetch-Site are allowed (non-browser class) — acceptable residual, route guards still apply.

### F-02/F-24 — Seller status enforcement + session revocation (FIXED · RUNTIME-CONFIRMED)

- **Files changed:** `src/lib/auth.ts` (`requireActiveSellerStore` now rejects `suspended`/`terminated` with 403 — onboarding-tier statuses preserved; NEW `revokeUserSessions()`), `src/app/api/auth/login/route.ts` (suspended → 403 `ACCOUNT_SUSPENDED` alongside existing terminated gate; rejected sellers still log in per the documented revision loop), `store/publish/route.ts` (403 for suspended/terminated), `admin/sellers/[id]/suspend|terminate|reject/route.ts` (revoke all live sessions; `after.sessionsRevoked` audited; response includes `sessionsRevoked`).
- **Evidence (end-to-end probe, fresh `[LT]` test seller, cleaned up via terminate):** 21 PASS / 1 test-artifact:
  - onboarding seller store access **preserved PASS** (approval loop intact)
  - admin approve → active seller ops work **PASS**
  - suspend with live session → `sessionsRevoked=1` audited **PASS**
  - suspended seller's existing session **401s immediately PASS**
  - suspended re-login → **403 ACCOUNT_SUSPENDED PASS**
  - reactivate → login works again **PASS** (reinstatement preserved)
  - active seller publish reaches the gate (422 blockers) **PASS**
  - password rotation matrix (below) all **PASS**; cleanup terminate + terminated login 403 **PASS**
  - The single "FAIL" (suspended publish expected 403, got 401) is a **test artifact**: the session was revoked at suspension, so auth fails before the status gate — verified instead by direct injection: a forged live session for a terminated seller → publish **403 ACCOUNT_TERMINATED** and `store/me` **403 ACCOUNT_TERMINATED** (both PASS).
- **Client-side UI restrictions are now backstopped by server-side enforcement** (shell-only block remains as UX, not as the control).

### F-03 — Password-session rotation + compile errors (FIXED · RUNTIME-CONFIRMED)

- **Files changed:** `src/lib/auth.ts` (NEW `rotateSession()` — delete-first, Bearer-or-cookie aware, fresh 7-day session + cookie re-set; `destroySession()` now Bearer-aware and deletes both cookie+Bearer rows), `src/lib/password.ts` (NEW `safeEqualHex` — length-guarded constant-time hex compare), `src/lib/psp.ts` (NEW adapter contract: `PspAdapterError`, `PspCheckoutSession[Input]`, `PspWebhookVerdict`, optional `isConfigured`/`createCheckoutSession`/`verifyWebhookSignature` on `PspProvider` — Prisma-free so the client-bundle rule holds).
- **Evidence (live probe):** wrong current password → **400 PASS**; correct change → **200 + fresh token PASS**; **old token 401 PASS**; new token **200 PASS**; new password login **PASS**; old password login **401 PASS**. `POST /api/me/password` no longer 500s (was compile-broken).
- **Compile errors:** `me/password` TS2724 and all 6 `stripe-my.ts` errors resolved — src error count **47 → 40** (remaining are Phase 2/5 schema-drift clusters, fixed below).

**Stop-and-test discipline:** payment/authorization changes were tested at each boundary before continuing (webhook signature matrix, then suspension lifecycle, then rotation) — all executed against the live dev server with DB state verified through responses.

## Phase 2 — High-risk public entry points (CODE LANDED in commit 9fe703e; log reconciled 2026-10-31)

> Honesty note: Phase 2 fixes were implemented + probed in the prior session (context truncated before the log was written); the code and probe evidence files are committed in `9fe703e`. This session re-verified every fix by direct source read (line-level, below) and re-exercised the login paths (6 successful logins) via the Phase 3 probe. Items not re-probed at runtime this session are labeled accordingly.

### F-05 — Shipping webhook (FIXED · code re-verified this session)
- `shipping/webhook/[provider]/route.ts` rewritten against the live `Shipment` model: HMAC-SHA256 over `${awb}.${status}.${ts}` with `SHIPPING_WEBHOOK_SECRET`, timing-safe `safeEqualHex`, replay window, **fail-closed 503 `SHIPPING_SECRET_UNSET` in production** when the secret is unset (dev keeps documented fallback). Prior-session probe evidence: `tool-results/` (committed). Runtime re-probe this session: **NOT TESTED** (covered by code-path read; the payments-webhook HMAC pattern was live-verified in Phase 1).

### F-06 — Chat hub/relay + gateway (FIXED · code re-verified this session)
- `mini-services/chat-service/index.ts`: socket handshake authenticated via `GET /api/chat/hub-auth` (NEW authoritative Next endpoint validating the session and issuing a hub token), room membership enforced on `join`; relay `POST /broadcast` requires `CHAT_RELAY_SECRET` (timing-safe; production without it fails closed). `Caddyfile` `XTransformPort` allowlist restricted to **3000/3003** (3103/3005 internal-only). Prior-session probe evidence: `chat-auth-probe{,2,3}.ts`, `hubauth-debug.ts`, `ws-debug.ts` (committed). Runtime re-probe this session: **NOT TESTED**.

### F-13 — Mock PSP fail-closed (FIXED · code re-verified this session)
- `lib/psp.ts:206-214` `mockPspAllowed()`: dev → true; production → **strict `parseJson<boolean>(row, false) === true`** — missing row, malformed JSON, and truthy non-boolean all → false. Prior-session probe: `f13-probe.ts` (committed). Runtime re-probe: **NOT TESTED** this session.

### F-12/F-19 — Auth abuse + demo credentials (FIXED · code re-verified this session)
- Login 10/min + register 5/min bounded IP rate limits (`auth/login`, `auth/register`, `auth/shopper/{login,register}` — `rateLimit(req, "auth-login"|"auth-register", …)` verified in source). Uniform 401s (no account-existence leak — prior-session probe `phase2-misc-probes.ts`, committed). `DEMO_ACCOUNTS` quick-fill (superadmin/ops/finance/moderator emails + passwords) **removed from the client bundle** (admin-shell diff verified in 9fe703e); seeded passwords env-overridable (`SEED_*_PASSWORD`, `prisma/seed.ts:420-439`) and documented only in `.env.example`/seed (server-side). This session's live evidence: 6/6 logins succeeded through the throttle (matrix probe), confirming the limiter does not block legitimate traffic.

## Phase 3 — Authorization boundaries (LANDED + RUNTIME-VERIFIED 2026-10-31)

### Starting-state correction (honesty record)
The prior session's last note claimed "mutation routes are capped" — **wrong**: F-09 (`sellers/[id]` PATCH), F-18 (`featured-stores` PUT), F-25 (webhook-deliveries replay) and every F-26 read were still bare `requireAdmin` at `1c5bbd7..9fe703e` (verified by `git diff --stat` = empty for those files + direct reads). Most `commission/*` routes were already capped, which explains the misread. All re-verified before any fix; nothing was trusted from the prior session's claim.

### Capability decisions (existing matrix extended by ONE cap; all others reused)

| Route | Guard before | Guard now | Rationale |
|---|---|---|---|
| `PATCH /api/admin/sellers/[id]` — `riskTier`/`commissionOverridePercent`/`holdDaysOverride` | `requireAdmin` | **`requireCap("commission.manage")`** (audit's own fix direction) when any such field is in the body; `marketplaceOptIn`-only bodies stay `requireAdmin` (listing preference, not money policy) | moderator could zero commission + hold days |
| `GET /api/admin/sellers/[id]` (KYC docs + banks + wallet + notes) | `requireAdmin` | **`requireAnyCap("sellers.approve","commission.manage")`** → superadmin+ops+finance | ops manage sellers, finance edits overrides from this very view (F-09 fields live here); moderator excluded (F-26) |
| `PUT /api/admin/featured-stores` (Setting write) | `requireAdmin` | **`requireCap("settings.manage")`** (audit direction; parity with `/api/admin/settings` PUT) | F-18 settings.manage bypass |
| `POST /api/admin/webhook-deliveries/[id]/replay` (forges delivery success) | `requireAdmin` | **`requireCap("settings.manage")`** | most destructive existing cap for a system-integrity write; F-25 |
| `GET /api/admin/kyc-queue` (KYC docs + banks + wallets) | `requireAdmin` | **`requireCap("sellers.approve")`** | matches the approve/reject/KYC-decision routes this queue feeds |
| `GET /api/admin/banks` | `requireAdmin` | **`requireAnyCap("sellers.approve","payouts.manage")`** | read tier aligned with its own verify/reject mutations (`sellers.approve`, already capped pre-Phase-3) + finance payout-safety read; moderator excluded |
| `GET /api/admin/export?entity=…` (bulk CSV: customer emails, wallet balances, full ledger) | `requireAdmin` | **`requireCap("reports.export")`** — NEW cap `[superadmin, finance]` | matrix EXTENSION (logged): no existing cap covers bulk PII+money CSV; tier matches data class. Aggregate-only `/api/admin/reports/[type]` deliberately stays `requireAdmin` (verified: no row-level PII — series/totals/by-store aggregates only) |
| `GET /api/admin/commission/analytics` | `requireAdmin` | **`requireCap("commission.manage")`** | per-store commission money read; sibling exports POST already capped |
| `GET /api/admin/commission/exports/[id]/download` | `requireAdmin` | **`requireCap("commission.manage")`** | full commission CSV download |
| `POST/PATCH/DELETE /api/admin/coupons[/id]` | `requireAdmin` | **`requireCap("campaigns.manage")`** | §3.2 LOW-MED row: coupons are honoured by server pricing — marketing-tier money lever; GET list stays admin-wide |

Infrastructure: `ADMIN_CAPS` moved to **pure `src/lib/admin-caps.ts`** (single source of truth importable from client components) with `roleHasCap`/`roleHasAnyCap`; `lib/auth.ts` re-exports it and adds `requireAnyCap(...caps)`.

### F-22 — OAuth callback state fail-open (FIXED · RUNTIME-VERIFIED)
- `auth/callback/[platform]/route.ts` rewritten fail-closed: state REQUIRED → row must exist → **delete-first single use** → platform match → 10-min TTL (tolerates both `Date.now()` ms and ISO createdAt) → **cross-seller CSRF guard** (state `sellerId` vs completing seller session → `state_seller_mismatch`). Session-less completion of a seller-bound state is deliberately allowed (cookie may be absent on iframe/Bearer surfaces; final ownership is enforced by claim/bind's hashed single-use token). `logActivity` now records the initiating sellerId.
- **Dead code removed:** `src/lib/marketplaces/callback.ts` deleted (zero importers — verified) — its `handleOAuthCallback`/`beginAuthorisation` duplicated the live routes with DIVERGENT semantics (the exact drift hazard that produced F-22).
- **Evidence (`tool-results/phase3-f22-oauth-probe.ts`, live): 15/15 PASS** — absent/unknown/consumed/malformed → `invalid_state`; expired → `expired_state`; platform mismatch → `state_platform_mismatch`; cross-seller CSRF → `state_seller_mismatch`; matched + session-less + ISO-format states reach the exchange; single-use re-hit → `invalid_state`; crafted rows cleaned up.

### UI/API consistency (client mirrors the server matrix)
- `admin-shell.tsx`: nav items carry `caps?: AdminCap[]` (any-of); `SidebarContent` filters by the signed-in role via the SAME matrix; groups with zero visible items hidden. Mapping: kyc-queue→sellers.approve; banks→any(sellers.approve,payouts.manage); commission/overrides/holidays→commission.manage; campaigns/coupons→campaigns.manage; settings/flags→settings.manage; audit/activity→logs.view (fixes pre-existing 403-on-click for moderator); moderation→products.moderate (no visual change — all roles hold it).
- New `use-admin-caps.ts` hook (`can(...)` from `useApp`); view-level gates: ReportsView export buttons (reports.export), BanksView verify/reject (sellers.approve — finance sees read-only note), SellersView row drill-down + dropdown actions (any(sellers.approve,commission.manage) / sellers.approve / sellers.suspend; kebab hidden entirely for roles with no actions), SellerDetailView commission editor (commission.manage; read-only summary otherwise; `saveOverview` sends commission fields ONLY when the role can write them — a moderator PATCH never carries fields the server would reject) + lifecycle/KYC/bank action buttons per their caps.
- **Browser verification (agent-browser, live):** moderator — 18 nav items visible / 11 gated items absent, Reports renders with **0 CSV buttons**, seller rows not clickable, 0 action kebabs; superadmin — all 29 nav items, **3 CSV buttons**, rows clickable, "Open detail" works, seller-detail loads with all commission fields; zero browser/console/server errors during the whole session.

### Negative/positive authorization matrix (live probe: `tool-results/phase3-authz-probe.ts`)

**60/60 PASS** — per-route role outcomes (superadmin/ops/finance/moderator + seller/shopper/anonymous cross-principal 401s), including preserved legitimate surfaces: moderator sellers-list/reports-aggregates/dashboard/notes remain 200; ops+finance seller-detail 200; finance banks 200; moderator coupon LIST 200.

### Logged residuals (deliberate, unflagged by the audit)
- `sellers/[id]/notes` GET/POST stays `requireAdmin` (internal commentary, no PII/money) — probe-verified preserved.
- `featured/*` (live FeaturedSlot CRUD) stays `requireAdmin` (merchandising, not flagged); the dead `featured-stores` Setting consumer decision belongs to Phase 4.
- Refunds/Disputes/Payouts/Wallets reads stay `requireAdmin` (same class as orders/dashboard — unflagged); their mutations were already capped pre-Phase-3; non-cap roles clicking their action buttons get server 403s with error toasts (pre-existing behavior, not regressed).
- Probe artifacts: one `[LT]`-class throwaway seller (`lt-p3b-*@probe.local`, onboarding) + one LT shopper + one internal note on the seeded test seller — consistent with the repo's LT test-data convention.

## Phase 4 — Configuration / functional consistency

(pending)

## Phase 5 — Testing & build verification

(pending)

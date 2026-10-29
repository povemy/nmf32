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

## Phase 4 — Configuration / functional consistency (LANDED + RUNTIME-VERIFIED 2026-10-31)

Decision rule applied per finding: **WIRE** (make the admin control actually drive the runtime), **LABEL** (honestly mark not-yet-enforced), or **REMOVE** (delete the dead surface). All decisions below executed and verified against the live dev server.

### F-08 — Commission Overrides wired into the engine (WIRED · VERIFIED)
- **Files changed:** `src/lib/commission.ts` (`resolveRate` now resolves active, validity-windowed `CommissionOverride` rows interleaved into the M09 chain at their scope position: product-scope row > product direct field > category-scope row (nearest ancestor first) > category direct field > seller-scope row > seller direct field > global; `percent`/`fixedFeeMinor`/`holdDays` resolve field-wise — a holdDays-only row contributes holdDays while the rate falls through; deterministic tie-break = earliest createdAt, then id), `src/app/api/admin/commission/overrides/[id]/route.ts` (removed a dead `name` field write that would have thrown a Prisma validation error — the model has no such column).
- **Interleaving rationale:** the admin UI itself promises "the affected scope falls back to the next rule in the M09 chain" (finance.tsx deactivate hint) — windowed rows beat same-scope direct fields, direct fields at HIGHER scope beat lower-scope rows.
- **Consequence (intended):** the SEEDED demo row (seller-scope 10% on Glow Theory/MeiLing, createdBy finance@nomofee.io) — dead since seeding — now takes effect for MeiLing products in categories without a direct percent. Existing order snapshots are never recomputed (frozen at checkout by design); only NEW orders change.
- **Evidence (`tool-results/phase4-config-probe.ts`, live, 32/32 PASS):** clean-baseline 0.5% global → seeded glow row resolves 10% `override` with correct sourceId → category direct field 9% beats seller-scope row (interleaved precedence) → CRUD row drives 12.5% → deactivate falls back → past validity window ignored → current window applies → category-scope row 7% beats category field 9% → no cross-category leak → holdDays-only row applies 9 hold days with percent still 12.5% (field-wise) → moderator 403 on create → cleanup restores baseline; seeded row untouched.
- **Real-order verification:** browser E2E checkout (order NM-103628, provider `fpx_curlec`) — item snapshot `rule_source:"global"`, `percent:0.5`, `min_commission_floor` flag intact; the full commission pipeline (changed `resolveRate` + unchanged floor/reconcile logic) produces correct money on a live order.
- **Bug found & fixed during verification:** the scoped-row Prisma query originally used a `\u0000` sentinel for "no target" — Postgres rejects `0x00` in UTF-8 text parameters (`22021`), which 500'd every resolution without a productId. Replaced with `"__no_target__"` (ids are cuids; no collision possible).
- **Regression note:** `scripts/fin-tests.ts` + `test-commission-parity.ts` are pre-existing import-drift debt (reference money.ts/commission.ts exports that never existed in the current code — part of the 126→ classified scripts/ errors, NOT caused by this change; `verify-finance-hardening.ts` is 127.0.0.1-hardcoded and blocked by the sandbox bind). The commission path was therefore verified by the 32-check live probe + real-order snapshot above.

### F-11 — Analytics retention reads the Setting row (WIRED · VERIFIED)
- **Files changed:** `src/app/api/cron/analytics-tick/route.ts` (`retentionDays()` now async: reads Setting `analytics.retention_days` first, falls back to env `SI_RETENTION_DAYS`, then default 180; clamped 7–730 matching the registry field). The route's own header comment already CLAIMED it read the Setting — documentation ≠ implementation, now aligned.
- **Evidence (live, in phase4-config-probe):** no row → 180; Setting 730 → tick reports 730 & purges nothing; Setting 365 → 365; settings PUT REJECTS a non-integer value (registry validation working); DB-corrupted `"not-a-number"` row → falls back to 180; row deleted → default restored.
- **Registry:** `analytics.retention_days` `wired:true` claim is now TRUE; wiredNote updated to document Setting-primary + env fallback.

### F-15 — Checkout countdown driven by server expiresAt (WIRED · VERIFIED)
- **Files changed:** `src/components/shopper/checkout.tsx` (`PaymentT.expiresAt` added; countdown initialized/synced from the payment's server `expiresAt` on every 3 s poll — provisional 30:00 until first load; "expired" phase remains server-authoritative).
- **Evidence (browser, live):** pay screen shows "Session expires in **29:38**" (server's 30-min window; was a hardcoded 10:00 that expired 20 minutes before the real enforcement).

### F-14 — Payment method list single-sourced (WIRED · VERIFIED)
- **Files changed:** `src/lib/payment-methods.ts` (NEW client-safe module: `CHECKOUT_PAYMENT_METHODS` — 5 methods incl. `fpx_curlec`), `src/app/api/checkout/create/route.ts` (validates against `KNOWN_PAYMENT_METHODS` from the module), `src/components/shopper/checkout.tsx` (renders from the module; icons mapped client-side by id).
- **Evidence (browser, live):** checkout renders all 5 methods including "FPX Online Banking (Curlec)"; a full E2E order placed WITH `fpx_curlec` (order NM-103628, `paymentProvider: "fpx_curlec"` in DB) — the previously-hidden method now passes server validation end-to-end.
- **Registry honesty (F-12 linkage):** `payments.providers` description corrected — it claimed methods came from "the PSP provider registry (src/lib/psp.ts)" which was FALSE (that registry is the adapter layer: mock + future candidates); now points at `lib/payment-methods.ts`.

### F-17 — Wallet payout-minimum copy (FIXED · VERIFIED)
- **Files changed:** `src/components/seller/wallet.tsx` (empty-state hint now uses `formatMinor(minPayout)` — the same live variable the request CTA uses, instead of hardcoded "RM 50" while the live minimum is RM 10).
- **Evidence (browser, live):** payout-free seller (Glow Theory) sees "…clears the minimum (**RM 10.00**)"; the request CTA on the same page shows the identical live value.

### F-16 — Buyer-protection copy (LABELED honestly · VERIFIED)
- **Files changed:** `src/components/shopper/pdp.tsx` ("7-day buyer protection" → "Buyer protection — returns & refunds supported"), `src/lib/sections.ts` (storefront FAQ default template: "7-day returns…" → window-free copy).
- **Rationale:** the return-request route enforces STATUS only (accepts paid→completed, no time window; even completed orders can open disputes) and auto-complete is 14 days — NO 7-day window exists anywhere in code, so any number claim would be fabricated. LABEL chosen over WIRE: inventing a buyer-protection window is a product policy decision, not a remediation call.
- **Evidence (browser, live):** PDP renders the honest copy.

### F-10 — Hold-release rule + grace days (LABELED · VERIFIED)
- **Files changed:** `src/components/admin/commission.tsx` (both controls now carry amber "NOT ENFORCED" / "DAYS AFTER DELIVERY: NOT ENFORCED" badges + explanatory hints: payouts release holdDays after payment regardless; delivered orders auto-complete after a fixed 14-day window).
- **Evidence (browser, live):** superadmin commission form renders both badges and hints.

### F-07 — Feature Flags dead surface (REMOVED · VERIFIED)
- **Files changed:** `src/components/admin/system.tsx` (FlagsView deleted, removal note left), `src/components/admin/admin-shell.tsx` (nav entry + view mapping + ToggleLeft import removed), `src/app/api/admin/feature-flags/route.ts` (DELETED).
- **Rationale:** zero runtime consumers read `db.featureFlag` outside the CRUD route itself; the page promised "runtime switches for progressive delivery" (false). NOTE: `src/lib/feature-flags.ts` (`NOMO_FINANCE_ENABLED=false`) is a SEPARATE compile-time constant for the dormant Nomo Finance scaffold WITH live consumers — untouched.
- **Kept:** the `FeatureFlag` model + seed rows (inert, no migration churn; restorable from git).
- **Evidence (live):** `/api/admin/feature-flags` → 404; superadmin nav contains no "Feature Flags" entry (browser-eval verified); zero remaining `db.featureFlag` readers (grep).

### F-12 — Registry honesty fixes (FIXED)
- **Files changed:** `src/lib/settings-registry.ts`.
- `psp.payouts.mode`: `wired:true` → `wired:false` + honest note — `resolvePayoutMode` exists in `lib/psp-adapter.ts` but has ZERO live callers (dormant payout adapter scaffold, R2 decision); engages only when a real provider payout phase ships.
- `analytics.retention_days`: note now documents Setting-primary + env fallback (true after F-11).
- `payments.providers`: description corrected (see F-14).

### Phase 4 residuals (deliberate)
- The dead `orders/[id]/shipping/quote` route and dead `admin/campaigns.tsx` component found during Phase 5 were removed as superseded duplicates (see Phase 5).
- The seeded 10% Glow override row now LIVE (intended F-08 consequence) — ops should review whether the demo row should stay (it was configured by the seeded finance user and represents admin intent that was silently ignored for weeks).

## Phase 5 — Testing & build verification (LANDED 2026-10-31)

### Build-blocker cleanup (47 → **0 src errors**)
Baseline 47 src `tsc` errors (hard `next build` blockers per Phase 0 classification); 13 were fixed en route in Phases 1–2 (F-03 cluster + shipping webhook rewrite). The remaining 34 fixed now:

| Cluster | Count | Resolution |
|---|---|---|
| `api/me/follows` | 14 | Schema-drift rewrite: `shopperId`→`shopperUserId`, `follows`→`followers` count, `shopperId_storeId`→`shopperUserId_storeId` compound unique, `store` include now type-valid. Verified live: GET/POST/DELETE follow cycle 6/6 PASS (`tool-results/phase5-follows-cycle.ts`) |
| `components/admin/campaigns.tsx` | 12 | **DELETED — dead code** (zero importers; the live CampaignsView lives in marketing.tsx and is already type-clean). First fixed against the current lib types, then the import-scan proved it dead — removed per the never-ship-dead-surfaces rule. The LIVE view was browser-verified end-to-end instead (preset → create → row → delete) |
| `api/store/orders/[id]/shipping/quote` | 5 | **DELETED — dead duplicate** (zero callers; UI uses `GET /api/store/shipping/quote?orderId=`; written against the pre-rebuild shipping API: `quoteRatesFor`/`eddWindow`/`weightGrams`/`shipmentStatus` none of which exist) |
| `api/metrics` | 1 | `prismaBase` (never exported) → `db` + structural cast for the runtime-only `$metrics` extension with a fail-closed 503 `METRICS_UNAVAILABLE` fallback. Live: unauthenticated GET → 503/401 fail-closed PASS |
| `api/store/vouchers/[id]` | 1 | Implemented the missing `parseSellerVoucherInput` in `lib/vouchers.ts` (create-route validation semantics extracted verbatim so create and edit share one source of truth; returns the full normalized payload incl. regionLimit) |
| `lib/inventory-release.ts` | 1 | **`reReserveOrderStock` DELETED — superseded dead code** (zero callers; written for a late-payment RE-RESERVATION policy that never shipped — the landed policy is refund-based: PaymentReconciliation + refund-reconcile sweep). Removal note left pointing at the real implementation |

- **`bunx tsc --noEmit` src/: 0 errors.** Total 282 remain in `scripts/`+`tool-results/` (126 baseline + probe files added since) — classified dev-tooling debt, NOT app build blockers (excluded from the Next build graph). Honestly reported, not suppressed.
- **`bun run lint`: 0 errors, 18 warnings** (all pre-existing in scripts/tool-results).

### Verification suite executed (all live against dev server)
1. Phase 4 probe re-run after all Phase 5 changes: **32/32 PASS** (commission overrides, retention, flags-404).
2. Phase 5 regression probe: **follows cycle 6/6, metrics fail-closed, both deleted routes 404** (`tool-results/phase5-regression-probe.ts` + `phase5-follows-cycle.ts`).
3. Browser E2E (agent-browser): full shopper golden path — PDP (F-16 copy) → cart → address → shipping → 5 payment methods (F-14) → pay screen countdown 29:38 from `expiresAt` (F-15) → payment confirmed → order snapshot verified in DB (`fpx_curlec`, 0.5% global, min-commission floor flag); admin commission form NOT-ENFORCED badges (F-10); no Feature Flags nav (F-07); seller wallet live minimum (F-17); live CampaignsView create-from-preset → delete E2E. Zero browser console/page errors at the end of every flow.
4. Mini-services healthy: webapp :3000, chat hub :3003, expiry scheduler :3005.

### Build gate — honest labeling
- **Source-level gate: PASS** — `tsc` src-clean (0 errors), lint 0 errors, dev server runs every touched route without runtime errors, all probes green.
- **`next build`: NOT RUN HERE** — the sandbox forbids production builds (dev server only, port 3000; environment policy). With `ignoreBuildErrors:false`, src-clean ⇒ no known TS build blockers remain, but the actual build must run in CI/staging before launch. Labeled NOT TESTED (environment), not PASS.
- **Sandbox OOM note:** the 3.9 GB sandbox OOM-killed `next-server` 4× during this session (heavy admin-view compiles / concurrent tsc runs). Mitigation applied: never run `tsc`/lint concurrently with route compiles; dev server + mini-services restarted with the durable orphan pattern (`bash -c 'nohup … >> log 2>&1 &'`; `setsid &` is killed at tool-call boundaries — documented in `scripts/dev-supervisor.sh`).

---

# Post-Remediation Verification Gate (Task H — independent verification)

| | |
|---|---|
| **Date executed** | 2026-10-29 (sandbox clock) / session 2026-10-31+ — Asia/Kuala_Lumpur |
| **Mandate** | Independently verify the Task G remediation against `full-audit-report.md` and the CURRENT repository (including the two post-remediation UI commits `0da0b29`/`65a5eb2`/`d57414e`/`7612414` — dashboard restyle + Seller-Insights nav reorg + Markets API docs), and decide whether NOMOFEE may proceed to the Seller Insights & Marketing Intelligence feature. |
| **Method** | Read-analyse-understand of audit + remediation log → direct source re-reads → **7 runtime probe suites (144 checks) against the live dev server** → production fail-closed branches exercised in isolated `NODE_ENV=production` module executions → `tsc`/`lint` → agent-browser E2E. A successful grep was NOT accepted as evidence for any runtime-testable behavior. |
| **Baseline verified** | git `main` @ `7612414`, clean tree (only scheduler state + probe outputs). All 8 security-critical engine files UNCHANGED since `79a1e17` (proxy.ts, auth.ts, psp.ts, commission.ts, webhooks/payments/process.ts, checkout.tsx, payment-methods.ts, analytics-tick) — the post-remediation commits touched UI components only, and those were re-verified live anyway. |
| **Environment** | Dev sandbox (`NODE_ENV=development`, webapp :3000, chat hub :3003, scheduler :3005, relay :3103, Caddy gateway :81 live). Production deployment access does NOT exist — production branches verified by isolated execution with `NODE_ENV=production`, never by code-read alone. |

## 1. The four critical findings — verdicts

### F-01 (CSRF) — **PASS**
- **Files inspected:** `src/proxy.ts` (full read — origin/Sec-Fetch-Site/content-type/Bearer rules + self-authenticated exemption list).
- **Tests executed (live, `tool-results/gate-probe-a-csrf-webhooks.ts`, 8/8 PASS):** cross-site Origin → 403 `CSRF_REJECTED`; same-origin Origin → passes gate (route 401); no-Origin non-browser POST → passes; `Sec-Fetch-Site: cross-site` → 403; urlencoded form POST → 415 `UNSUPPORTED_MEDIA_TYPE`; Bearer + cross-site Origin → passes (iframe bridge intact); `Origin: null` → 403; GET unaffected.
- **Exemption correctness:** webhook route with cross-site Origin + valid HMAC → exempted, reaches route (404 INTENT_NOT_FOUND) — self-authenticated routes are not blocked by the CSRF gate.
- **Legitimate flows unbroken:** every login/checkout/mutation probe across all 7 suites passed THROUGH the gate (Bearer bridge); browser E2E logins (seller/admin/moderator) all worked.
- **Limitations:** browsers sending neither Origin nor Sec-Fetch-Site are allowed by design (non-browser class; route guards still apply) — documented residual, unchanged.

### F-02/F-24 (seller suspension) — **PASS**
- **Files inspected:** `lib/auth.ts` (`requireActiveSellerStore` status gates, `revokeUserSessions`), `auth/login/route.ts` (suspended/terminated 403s), `store/publish/route.ts` (republish gates), `admin/sellers/[id]/suspend|terminate|reject` (revocation wiring), `store/payouts`, `store/me` guards.
- **Tests executed (live, `tool-results/gate-probe-c-suspension-rotation.ts`, 23/23 PASS):** fresh seller register → onboarding access PRESERVED (approval loop intact); admin approve → active ops 200; suspend with live session → `sessionsRevoked≥1` audited; existing session 401 immediately; re-login → 403 `ACCOUNT_SUSPENDED`; **forged live session (DB-injected — bypasses revocation)** still blocked: `store/me`, payout request, product mutation, republish → all 403 `ACCOUNT_SUSPENDED`; terminate → login 403 `ACCOUNT_TERMINATED`; post-terminate forged session → 403 `ACCOUNT_TERMINATED` on me + republish; test data fully cleaned.
- **Notable strength found during verification:** `terminate` ALSO revokes sessions injected after suspension (observed live — the earlier forged token was correctly killed by the terminate call).
- **Limitations:** none material.

### F-03 (password change + build errors) — **PASS**
- **Files inspected:** `me/password/route.ts` (three-principal rotation), `lib/auth.ts` (`rotateSession` delete-first + Bearer/cookie aware), `lib/password.ts` (`safeEqualHex`), `lib/psp.ts` (adapter contract types).
- **Tests executed (live, in Probe C, 6/6 PASS):** wrong current password → 400 `INVALID_CURRENT_PASSWORD`; correct change → 200 + fresh token; **old token 401**; new token 200; new-password login works; old-password login 401.
- **Build errors:** `bunx tsc --noEmit` → **0 errors in `src/`** (607 total, ALL in `scripts/`+`tool-results/` dev-tooling — classified debt outside the Next build graph, incl. this gate's own probe files; same classification as remediation). `bun run lint` → **0 errors**, 18 warnings (pre-existing, scripts/tool-results).
- **Limitations:** `next build` NOT RUNNABLE in this sandbox (dev-only policy) — must pass in CI/staging before deployment. tsc-src-clean ⇒ no known TS build blockers remain (`ignoreBuildErrors:false`).

### F-04 (webhook secret) — **PASS**
- **Files inspected:** `webhooks/payments/process.ts` (lazy `webhookSecret()`, timing-safe compare, ±10-min replay window, claim-first Serializable).
- **Tests executed:**
  - Live signature matrix (`gate-probe-a`, 6/6 PASS): valid sig + unknown ref → 404 `INTENT_NOT_FOUND` (authentication passed); wrong sig → 400 `BAD_SIGNATURE`; correctly-signed 30-min-old event → 400 `STALE_EVENT` (replay guard); missing sig → 400; cross-site Origin + valid HMAC → CSRF-exempt; empty ref → 400 `BAD_REQUEST`.
  - **Production fail-closed (isolated `NODE_ENV=production`, `gate-probe-b`, 2/2 PASS):** `PSP_WEBHOOK_SECRET` unset → **503 `WEBHOOK_SECRET_UNSET`** (no demo-constant fallback); set → returns env value.
  - **Invalid signatures cannot create financial state (live):** every BAD_SIGNATURE/STALE probe left no order/refund/ledger change (all rejected before intent lookup); Probe F's cross-tenant checks confirm no state changes.
  - **Valid signed events still work (live, Probe G):** server-signed `payment.succeeded` via `/simulate` → order `paid`, webhook log `signatureValid=true processed=true`, wallet credited, ledger T1 posted, inventory decremented.
- **Required production config:** `PSP_WEBHOOK_SECRET` MUST be set (boot warning + 503 until then — fail closed, not open).

## 2. High-risk findings — verdicts

| Finding | Verdict | Evidence (tests actually executed) |
|---|---|---|
| **F-05 shipping webhook auth + replay** | **PASS** | Live matrix 5/5 (no sig → 400; wrong sig → 400; valid sig + unknown AWB → 404 no state change; stale signed → 400 STALE_EVENT; forged status value → 400 VALIDATION whitelist). Production-mode isolated 4/4: sig presented + secret unset → **503 SHIPPING_SECRET_UNSET**; no-sig + unset secret → 400 (rejected BEFORE secret resolution — ordering verified, both paths fail closed); secret set + wrong sig → 400; correct sig + unknown AWB → 404 (valid events work). |
| **F-06 chat socket auth / rooms / relay / gateway** | **PASS** | Live 18/18 (`gate-probe-e-chat.ts`): hub-auth garbage token 401; membership decisions (own user room allowed, other's denied, participant thread allowed, unknown thread denied); unauthenticated + garbage-token sockets DISCONNECTED by hub; shopper A receives own/participant events only; non-participant B denied; store-owner seller receives via ownership; relay no/wrong secret → 401. Gateway allowlist live on :81 (3/3): `XTransformPort=3103` and `=3005` fall through to the webapp (internal ports NOT proxied); `=3003` reaches the hub. |
| **F-13 mock PSP fail-closed** | **PASS** | Isolated production: `mockPspAllowed()` with Setting row missing → **false**; simulate route in production → **404** (mock rails closed). Dev row `psp.mock.enabled` confirmed absent in DB (default-denied posture). |
| **F-12 login/register rate limiting** | **PASS** | Live: login 429 fires within 10/min with `RATE_LIMITED` code; register 429 within 5/min; invalid registrations created **0** accounts. All 4 auth routes carry `rateLimit` (source read + live firing). Legitimate logins unblocked across all suites (spacing respected). |
| **F-19 demo credentials out of client bundle** | **PASS** (static — bundle membership is source-derived) | `admin-shell.tsx` contains no `DEMO_ACCOUNTS`/credentials (only a literal "DEMO" badge label); seeded passwords env-overridable server-side (`SEED_*_PASSWORD`), documented in `.env.example` only. |
| **F-09/F-18/F-25/F-26 admin capability checks** | **PASS** | Live matrix 33/33 (`gate-probe-d-admin-caps.ts`): moderator denied on commission/hold PATCH (F-09), seller-detail PII, kyc-queue, banks, bulk CSV export, commission analytics + CSV download, webhook-delivery replay (F-25), featured-stores PUT (F-18), coupon create; **split-guard preserved** (moderator `marketplaceOptIn`-only PATCH → 200); legitimate surfaces preserved (seller list, report aggregates, coupon list); finance tier correct (banks/detail/analytics/export 200; kyc-queue correctly 403); superadmin passes; seller/shopper/anonymous → 401. Browser: moderator nav hides KYC Queue/Banks/Overrides/Fee Holidays/Coupons/Settings — matches server matrix (Simulator/Ledger-Explorer/Reports visible = admin-wide routes by documented design; UI == API). |
| **F-26-class money/PII reads** | **PASS** | Included in the 33/33 matrix above. |
| **F-20 marketplace connection isolation** | **OPEN** (unchanged) | `connections/route.ts:15` + `disconnect/route.ts:18` still query/mutate `OR storeId:null` global rows — pre-existing, explicitly deferred out of Task G scope, NOT silently dropped. Cross-store leak of unclaimed platform connections + global-row disconnect mutation. Recommend scheduling as its own task (small, self-contained). |
| F-27 anonymous auto-published reviews | **OPEN** (LOW, deferred) | unchanged since audit |
| F-28 order lookup/receipt enumeration | **OPEN** (LOW, deferred) | unchanged since audit |

## 3. Configuration & attribute linkage — verdicts

| Item | Verdict | Evidence |
|---|---|---|
| **F-08 commission overrides wired** | **PASS** | Engine (`lib/commission.ts`) UNCHANGED since the 32/32 live Phase-4 matrix; real-order evidence this session: item snapshot `commissionPercent=0.5` + `commissionMinor=100` (min-commission floor honoured: max(0.5%×RM89, RM1)=100) + `breakdownJson` present; refund reversal 92 ≤ earned 100 (cumulative cap intact). |
| **F-10 hold-release policy + grace days** | **PASS (labeled, not wired — honest)** | Browser: superadmin Commission form renders both "Not enforced" amber badges + hints. Explicitly marked unavailable; no invented business rule. |
| **F-11 analytics retention** | **PASS** | `analytics-tick` reads Setting `analytics.retention_days` (Setting-primary, env fallback, 7–730 clamp) — code re-read; Phase-4 live matrix stands (file unchanged since). |
| **F-14 payment-provider config** | **PASS** | Single source `lib/payment-methods.ts` (5 methods incl. `fpx_curlec`); server validation `KNOWN_PAYMENT_METHODS` live in checkout (Probe G order placed with `fpx_toyyibpay`; prior E2E used `fpx_curlec`). |
| **F-15 checkout expiry display** | **PASS** | Server truth verified live: payment group persisted with ~30-min `expiresAt` (Probe G); UI countdown code unchanged since Phase-4 browser verification (29:38 live then). |
| **F-07 feature flags dead surface** | **PASS (removed)** | `/api/admin/feature-flags` → 404; zero `db.featureFlag` runtime readers (only a removal-note comment in system.tsx). |
| **F-17 payout-minimum display** | **PASS** | Browser: seller Wallet shows live **RM 10.00** minimum (survived the post-remediation wallet.tsx restyle). |
| **F-16 buyer-protection policy** | **PASS (labeled honestly)** | Browser: PDP renders "Buyer protection — returns & refunds supported" (no fabricated window). |
| Markets route API documentation | **PASS (exists)** | `docs/seller-insights/markets-api.md` (273 lines) + `metric-definitions.md` — landed in `d57414e` for the upcoming dashboard work. |

## 4. Core behaviors after the security changes — regression verdicts

| Behavior | Verdict | Evidence |
|---|---|---|
| Checkout | **PASS** | Live E2E: create (Idempotency-Key enforced, 201, server pricing) → simulate → paid; 4 orders through the full path this session. |
| Payment (valid signed events) | **PASS** | Probe G: signature valid + processed webhook log rows; exactly the F-04 "still works" requirement. |
| Inventory | **PASS** | Decrement on payment (−1), restock on refund (+1), InventoryLog written. |
| Wallet | **PASS** | pendingMinor credited on payment; **wallet cache == ledger truth** verified via the app's own `walletTruth()` (pending/available parity on both refunded orders). |
| Ledger | **PASS** | T1 postings per order; **T5 refund postings balanced** (DR 8808+92 = CR 8900) with `refund:refund:{id}` dedupKey; commission-reversal cap enforced. |
| Refund | **PASS** | Full flow ×3 this session (request → approve → process): statuses terminal, wallet totals decreased by seller share, stock restored, order `partially_refunded`. In-hold semantics correct (pending constant by design — debit nets at maturity). |
| Scheduler | **PASS** | expiry-scheduler :3005 alive (state.json fresh, 30 s interval); cron routes 200 live (expiry-sweep, refund-reconcile, analytics-tick); dev.log shows continuous successful ticks; alert history stale (last alert 06:00, from an old restart window). |
| **Seller isolation (live — the audit's §6.3.8 "NOT TESTED at runtime" gap)** | **PASS** | Two-session abuse test executed (`gate-probe-f`, 14/14): seller A (lumina) → B's (glow) order by id AND orderNumber → 404; B's product GET/PATCH → 404; refund-request on B's order → 404; positive controls both directions 200. |
| Buyer ownership | **PASS** | Shopper sees own order 200 (Probe G); cross-principal 401s (Probe D). |

## 5. Executed checks — totals

| Suite | Checks | Result | File |
|---|---|---|---|
| A — CSRF + webhook signatures + gateway + public | 26 | **26 PASS** | `tool-results/gate-probe-a-csrf-webhooks.ts` |
| B — production fail-closed (isolated NODE_ENV=production) | 8 | **8 PASS** | `tool-results/gate-probe-b-prod-failclosed.ts` |
| C — suspension lifecycle + password rotation | 23 | **23 PASS** | `tool-results/gate-probe-c-suspension-rotation.ts` |
| D — admin capability matrix | 33 | **33 PASS** | `tool-results/gate-probe-d-admin-caps.ts` |
| E — chat hub auth + relay | 18 | **18 PASS** | `tool-results/gate-probe-e-chat.ts` |
| G — order lifecycle E2E (+G-verify money invariants) | 23 + 22 | **45 PASS** (G's 5 initial "fails" were probe-assertion bugs — response shapes/201/case — corrected in G-verify with correct semantics; no code defect found) | `tool-results/gate-probe-g-order-lifecycle.ts`, `gate-probe-g2-verify.ts` |
| F — isolation + rate limits | 14 | **14 PASS** | `tool-results/gate-probe-f-isolation-ratelimit.ts` |
| tsc / lint | — | src **0 errors**; lint **0 errors / 18 pre-existing warnings** | — |
| Browser E2E | — | home renders; PDP honest copy; seller wallet RM 10.00; admin commission badges; moderator nav gating; **zero browser console/page errors; zero 5xx / errors in dev.log across the entire campaign** | screenshots: `tool-results/gate-browser-{home,moderator}.png` |

## 6. Test hygiene (probe-induced state changes — all documented)

- **Gate orders NM-103629–NM-103632** (lumina-living, RM 97 each): created by the probe campaign, taken through pay → refund → restock; left in the dev DB as money-consistent artifacts (deleting would falsify the ledger mirror). Wallet cache == ledger truth verified on them.
- 4 order-bound probe shoppers kept (FK), 4 orderless removed.
- Rejected/stale webhook probe deliveries logged in `PaymentWebhookLog` with `signatureValid=false` (by-design logging).
- **One probe-induced data mutation, caught and RESTORED:** the first Probe-D run read `marketplaceOptIn` from a wrong response path and wrote `false` to seller `lt-si-b-mvs909g7` (moderator-tier field — allowed, but not the intended no-op). Restored to `true`; all subsequent runs used correct no-op values (verified post-run). No other writes to seeded data.
- Suspension + chat probes: full DB cleanup executed and verified.

## 7. Honest limits

1. **`next build` NOT RUNNABLE in this sandbox** (dev-only policy). Source-level gate PASS (tsc src-clean, lint clean) ⇒ no known TS build blockers; the actual build MUST run in CI/staging before any deployment. NOT TESTED (environment), not claimed as PASS.
2. **Production deployment access does not exist.** All production fail-closed branches were verified by isolated execution of the REAL route/module code under `NODE_ENV=production` with controlled env — not by code-read alone, but also not against a real production deployment.
3. **Caddy external reachability:** the :81 gateway port allowlist was verified live from inside the sandbox; the external network path is an environment property (same honest limit as the audit).
4. Redis rate-limit path untested (`RATE_LIMIT_REDIS_URL` unset — in-memory limiter only, single-process).
5. Load/capacity behavior (checkout rush, PSP retry storms) — out of this gate's scope; covered by the F1/F2/F3 readiness runs and their own open items.

## 8. Required production configuration / deployment actions (carry-forward)

1. Set `PSP_WEBHOOK_SECRET` (else payment webhooks 503 fail-closed — correct but disabled).
2. Set `SHIPPING_WEBHOOK_SECRET` (same fail-closed posture for tracking webhooks).
3. Set `CHAT_RELAY_SECRET` (production relay rejects all broadcasts without it).
4. Set `CRON_SECRET` + `METRICS_TOKEN` (fail-closed / disabled until set).
5. Run `next build` in CI/staging (sandbox cannot).
6. Review the seeded 10% Glow commission override row (live since F-08 wiring — intended, but an ops decision).
7. Schedule remediation for the three OPEN items: **F-20** (marketplace connections cross-store visibility + global-row disconnect), F-27 (anonymous reviews), F-28 (lookup throttling).

## 9. Completion gate — verdict

**All four critical findings PASS at runtime. All in-scope high-risk findings PASS (or are explicitly OPEN and unchanged, none silently removed). Core money-path behaviors verified unregressed.**

### ✅ The repository is READY to proceed to the Seller Insights & Marketing Intelligence implementation.

Grounds: the four CRITICALs (F-01/F-02+F-24/F-03/F-04) are independently runtime-verified; the auth/authorization baseline they underpin is intact (60/60-class matrix re-verified 33/33 live); the money path (checkout → payment → inventory → wallet → ledger → refund) is regression-verified end-to-end including seller-isolation at runtime; the Seller Insights data plane (analytics queries, markets API) is untouched by any open finding and its route API is already documented (`docs/seller-insights/markets-api.md`).

This is NOT a production-readiness claim: deployment prerequisites (§8 secrets, CI build, capacity work in the F1/F2/F3 readiness track, and the three OPEN findings) remain separate and explicitly scheduled.

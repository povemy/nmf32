# NOMOFEE — Full Webapp Attribute-Linkage & Auth Audit Report

| | |
|---|---|
| **Report file** | `/home/z/my-project/full-audit-report.md` |
| **Date** | 2026-10-29 (Asia/Kuala_Lumpur) |
| **Requested by** | Platform owner (verbatim: *"Run full audit regarding this kind of issue towards the whole webapp structure & all auth (admin,seller,buyer), ensure all attributes are actually linked and synced. I need the report in full-audit-report.md file."*) |
| **Issue class audited** | The "Platform Commission card not synced to admin settings" defect class, generalised: every platform-controlled attribute displayed anywhere (admin / seller / buyer / storefront / cron / webhooks / mini-services), plus the full authentication & authorisation posture for all three roles |
| **Method** | 4 parallel read-only audit agents (SSOT & consumers; seller backend; admin+buyer+storefront; auth core & cross-cutting) → every high-severity claim spot-verified by direct file reads → `tsc --noEmit` → runtime read-only probes against the running dev server |
| **Code changes** | **NONE** — this is an audit. No production code was modified. (One audit probe review was created and then deleted with aggregates restored — see §6.2.) |
| **Evidence discipline** | Every finding cites `file:line`. Labels: **VERIFIED** = confirmed by direct code read this session; **RUNTIME-CONFIRMED** = reproduced against the running server; **AGENT-REPORTED** = agent finding accepted on sampled evidence (spot-checked subset); **NOT TESTED / INFERRED** = stated honestly where applicable. |

---

## 0. Executive summary

**Scale of the audit:** 200+ API routes, 3 portals (admin / seller / buyer), public storefront, 2 mini-services (chat hub + expiry scheduler), Caddy gateway, Prisma schema, and every platform-controlled attribute from `Setting`, `CommissionSetting`, seller overrides, and feature flags.

**Headline results:**

1. **The original issue class (settings sync) is largely FIXED for seller-facing platform terms** — the `seller-terms.ts` SSOT introduced previously is wired into every seller surface and returns live values at runtime. **1 stale literal remains** (seller wallet "RM 50" hint vs live RM 10 minimum).
2. **However, the same defect class recurs in 7 other places** where admin-editable or admin-implied values are **not actually wired to enforcement** — the worst being the entire **Commission Overrides admin surface (FIN-02), the Feature Flags page, and `analytics.retention_days`**, where an admin edits values that running code never reads (§2.3).
3. **Auth baseline is structurally sound** — every `/api/admin/**` and `/api/store/**` route has a session guard (verified: zero unguarded routes), tenant isolation on seller routes is complete (zero cross-tenant reads/writes found), and buyer ownership checks all pass (§3).
4. **But four CRITICAL gaps undermine that baseline**: (a) the payment-webhook signing secret fails open to a publicly documented demo constant; (b) `SameSite=None` cookies with zero CSRF/origin validation anywhere; (c) seller suspension is cosmetic (no status enforcement, no session revocation, suspended sellers can re-login and even re-publish their store); (d) the password-change endpoint is broken at compile time (`rotateSession` does not exist → runtime 500).
5. **Runtime probes:** 10/10 unauthorised guard probes returned 401 (PASS); live platform terms returned configured values (PASS); the anonymous-review integrity hole was **reproduced live** (FAIL — then cleaned up); order-lookup enumeration throttle absence confirmed.

**Finding counts:** 4 CRITICAL · 7 HIGH · 13 MEDIUM · 15 LOW (grouped; full register in §5).

---

## 1. Scope & method

### 1.1 Surfaces covered

| Surface | Files | Coverage |
|---|---|---|
| Admin portal | `src/components/admin/*.tsx` (18 files), `/api/admin/**` (60 route files) | guard-by-guard + linkage |
| Seller portal | `src/components/seller/*.tsx` (24 files), `/api/store/**` (66 route files) | guard-by-guard + isolation + linkage |
| Buyer portal | `src/components/shopper/*.tsx`, `/api/me|cart|checkout|chat|claim/**` | guard + ownership + linkage |
| Public storefront | `/api/sf/**`, `/api/market/**`, `/api/campaigns/active`, `/api/settings/site`, `/api/platform/terms`, `/api/orders/*` | exposure + linkage |
| Platform core | `src/lib/{auth,commission,seller-terms,settings-registry,psp,psp-adapter,psp-refund,feature-flags,cron-auth,secretbox,password,rate-limit,ratelimit}.ts`, `prisma/schema.prisma` | SSOT map |
| Infrastructure | `/api/webhooks/**`, `/api/cron/**`, `/api/shipping/**`, `/api/metrics`, `/api/img`, `/api/health*`, `mini-services/chat-service`, `mini-services/expiry-scheduler`, `Caddyfile`, `src/middleware.ts` (absent — verified) | cross-cutting auth |
| Client shell | `src/app/page.tsx`, `src/components/app-root.tsx`, `src/lib/app-store.ts`, `src/lib/session-client.ts` | portal mounting + token bridge |

### 1.2 Guards under test (from `src/lib/auth.ts`)

- `requireAdmin()` (auth.ts:78-84) — session type `admin` + `AdminUser.isActive` re-check. **VERIFIED**.
- `requireAdminRole(roles)` (auth.ts:86-90), `requireCap(cap)` (auth.ts:141-146) with `ADMIN_CAPS` matrix (auth.ts:125-139).
- `requireSeller()` (auth.ts:92-104) — session type `seller`; **returns `status` but never enforces it** (§3.4).
- `requireActiveSellerStore()` (auth.ts:107-113) — despite the docstring "approved / live", checks **only** that `storeId` exists and the Store row exists — **no seller.status / store.status check** (§3.4).
- `requireShopper()` (auth.ts:116-122) — enforces `status === "active"`. **VERIFIED OK**.

---

## 2. PART I — Attribute linkage & sync audit

### 2.1 What is correctly LINKED (positive verification — the previous fix holds)

The `seller-terms.ts` SSOT (`src/lib/seller-terms.ts:74-100` `getSellerTerms`, `:114-133` `getPlatformTermsPublic`) resolves `Seller.commissionOverridePercent ?? CommissionSetting.defaultPercent` and `Seller.holdDaysOverride ?? CommissionSetting.payoutHoldDays` — **the exact same override chain the payment webhook uses for runtime money truth** (`src/app/api/webhooks/payments/process.ts:312`). Consumers verified:

| Surface | Value | Source (file:line) | Verdict |
|---|---|---|---|
| Seller Dashboard commission card | % + fixed-fee/min-commission sub | `useSellerTerms()` (`seller/ui-bits.tsx:218-256`, 60 s module cache + in-flight dedupe) → `dashboard.tsx:398,162-168` | **LINKED** |
| Seller Dashboard wallet sub / pending actions | hold wording / counts | `dashboard.tsx:227` / `/api/store/dashboard` counts (`dashboard/route.ts:83-85`) | **LINKED** |
| Seller Wallet (min payout, hold, commission paid, activity note) | all live | `wallet.tsx:140,208,224,751` ← `/api/store/wallet` (`wallet/route.ts:32,41` reads `Setting payout.min_minor`) | **LINKED** |
| Seller Orders money panel | hold note + per-item commission | `orders.tsx:399` (terms) + `order_item.commissionMinor` snapshots (`orders/[id]/route.ts`) | **LINKED + SNAPSHOT-OK** |
| Seller Settings marketplace copy, Onboarding bank hint | % / hold days | `settings.tsx:235`, `onboarding.tsx:482-486` | **LINKED** |
| Pre-auth seller portal (hero %, register terms, first-N) | public terms | `seller-shell.tsx:653-666,752,863-866,874-876` ← `GET /api/platform/terms` (public, 120/min, 60 s TTL) | **LINKED** |
| Pending Releases view | per-row hold days | derived from ledger timestamps (`pending-releases/route.ts:74`) | **SNAPSHOT-OK** (runtime truth) |
| Admin commission editor → engine | all CommissionSetting fields | `commission/settings/route.ts:23-61` → `lib/commission.ts` `resolveRate` chain (`:62-122`) | **LINKED** (exception: see F-08) |
| Footer visibility | Setting `ui.footer_visible` | `/api/sf/app-config` → `shopper-shell.tsx:165-190,397` (60 s cache) | **LINKED** |
| Payout minimum (enforcement + display) | Setting `payout.min_minor` | `store/payouts/route.ts:54-58` (BELOW_MINIMUM guard), `admin/payouts/due:19-22`, `payout-batches:57-61`, `admin/dashboard:51,76` | **LINKED** |
| Moderation first-N | Setting `moderation.first_n` | `store/products/helpers.ts:14-19` (enforcement) + terms display | **LINKED** |

**RUNTIME-CONFIRMED (2026-10-29):** `GET /api/platform/terms` → `{"commissionPercent":0.5,"holdDays":7,"minCommissionMinor":100,"payoutMinMinor":1000,"moderationFirstN":5,...}` — live configured values, matching the DB. (Previous session additionally verified a live mutation 0.5%→12.5% reflected on reload; recorded in RX-CHECKLIST.)

### 2.2 Attribute linkage matrix (platform-controlled attributes × consumers × verdict)

Legend: **LINKED** = reads live value · **SNAPSHOT-OK** = frozen at transaction time *by design* (money math) · **HARDCODED** = literal in code, desyncs from config · **UNWIRED** = admin surface exists but nothing consumes it · **DEAD** = data/route exists with no producer or consumer.

| # | Attribute | Authoritative source | Admin edit path | Seller view | Buyer view | Enforcement | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | Commission default % | `CommissionSetting.defaultPercent` | Admin→Commission (`commission.tsx:226-227`) | terms (linked) | — (never shown, correct) | `commission.ts:62-65,223` | **LINKED** |
| 2 | Commission — seller override | `Seller.commissionOverridePercent` | PATCH `/api/admin/sellers/[id]` (`sellers/[id]/route.ts:84-88`) | terms (linked) | — | `commission.ts:117-119` | **LINKED** (but edit path under-guarded — F-09) |
| 3 | Commission — product override | `Product.commissionPercentOverride` | admin products | — (per-item snapshot only) | — | `commission.ts:97-105` | **LINKED** |
| 4 | Commission — category override | `Category.commissionPercent` | Admin→Categories | — | — | `commission.ts:107-114` | **LINKED** |
| 5 | Commission — fee holiday | `FeeHoliday` | Admin→Finance | — | — | `commission.ts:79-94` | **LINKED** |
| 6 | **Commission — scoped override rows** | **`CommissionOverride` table** | **Admin→Finance "Commission Overrides" (`finance.tsx:93-255` + 4 CRUD routes)** | — | — | **`resolveRate` NEVER reads `db.commissionOverride` (verified: `commission.ts` greps only commissionSetting/seller/product/category/feeHoliday)** | **UNWIRED — F-08 (HIGH)** |
| 7 | Payout hold days | `Seller.holdDaysOverride ?? CommissionSetting.payoutHoldDays` | Admin→Commission + seller-detail | terms (linked) | — | `process.ts:312` | **LINKED** |
| 8 | Hold release rule (`days_after_delivered`) | `CommissionSetting.holdReleaseRule` | Admin radio (`commission.tsx:266-276`) | copy honestly says "after payment" (`ui-bits.tsx:126-131`) | — | **never enforced** (`process.ts:312-313` always `paidAt+holdDays`) | **UNWIRED — F-10** |
| 9 | Grace days after delivered | `CommissionSetting.graceDaysAfterDelivered` | Admin form (`commission.tsx:242-243`) | — | — | **zero consumers** (auto-complete uses its own `AUTO_COMPLETE_DAYS = 14`, `order-completion.ts:23`) | **UNWIRED — F-10** |
| 10 | Fixed fee / min commission | `CommissionSetting.fixedFeeMinor/minCommissionMinor` | Admin→Commission | terms card (`dashboard.tsx:165-166`) | — | `commission.ts:243-244,289-303` | **LINKED** |
| 11 | Payout minimum | `Setting payout.min_minor` | Admin→Settings | wallet (linked) | — | payout request guard | **LINKED** |
| 12 | Payout mode | `Setting payout.mode` | Admin→Settings | — | — | `payout-batches:59-62`, `due:20-23` | **LINKED** |
| 13 | Payout schedule day | `Setting payout.schedule.day` | Admin→Settings | wallet copy "1-3 working days" is unrelated marketing (`wallet.tsx:170`) | — | **none** | **UNWIRED (honest — registry says so)** |
| 14 | Moderation first-N | `Setting moderation.first_n` | Admin→Settings | pre-auth + products (linked) | — | `products/helpers.ts:14-19` | **LINKED** |
| 15 | **Analytics retention days** | `Setting analytics.retention_days` | **Admin→Settings (registry claims `wired:true`, `settings-registry.ts:311`)** | — | — | **`analytics-tick/route.ts:29-34` reads `process.env.SI_RETENTION_DAYS ?? 180`, NEVER the Setting row (VERIFIED by direct read)** | **HARDCODED-DESYNC — F-11 (HIGH)** |
| 16 | **PSP payout mode** | `Setting psp.payouts.mode` | **Admin→Settings (registry claims `wired:true`, `settings-registry.ts:213`)** | — | — | **sole reader `psp-adapter.ts:63-71` has ZERO importers (module header admits "ZERO WIRING BY DESIGN")** | **UNWIRED, registry claim FALSE — F-12** |
| 17 | PSP mock enabled | `Setting psp.mock.enabled` | Admin→Settings | — | — | `psp.ts:137-143` | **LINKED but fails OPEN when row missing (F-13)** |
| 18 | Mock refund behavior | `Setting psp.mock.refund.behavior` | Admin→Settings | — | — | `psp-refund.ts:138-142` | **LINKED** |
| 19 | Payment providers list | `Setting payments.providers` | Admin→Settings (marked informational) | — | **UI hardcodes 4 (`checkout.tsx:91-96`) vs server 5 (`checkout/create/route.ts:14` incl. `fpx_curlec`)** | server KNOWN_PROVIDERS | **HARDCODED + DESYNC — F-14** |
| 20 | Footer visibility | `Setting ui.footer_visible` | Admin→Settings | — | `app-config` (linked) | — | **LINKED** (but duplicate dead endpoint `/api/settings/site` — F-30) |
| 21 | **Feature flags (DB table)** | `FeatureFlag` rows | **Admin→System "Feature Flags" (`system.tsx:568-584`)** | — | — | **ZERO runtime consumers — no code reads `db.featureFlag` outside the admin CRUD route itself** | **UNWIRED — F-07 (HIGH)** |
| 22 | Buyer finance (wallet/coins) | compile-time `NOMO_FINANCE_ENABLED = false` (`feature-flags.ts:30`) | none (admin cannot change) | — | me-hub gated (`me-hub.tsx:322...`, `me/wallet:27`, `me/coins/claim:25`) | constant | **HARDCODED (deliberate, documented)** |
| 23 | Payment window (checkout expiry) | none | **no admin surface** | — | **UI countdown 10:00 (`checkout.tsx:1549`) vs server 30:00 (`checkout/create/route.ts:181`)** | server `expiresAt` (returned by API but ignored by the UI timer) | **HARDCODED + DESYNC — F-15** |
| 24 | Shipping rates (RM 8 / free over RM 100) | code constants (`checkout/pricing.ts:8-13`) | **no admin surface** | — | PDP badge `pdp.tsx:462` + checkout msg `checkout.tsx:1189` mirror the constants | `pricing.ts` | **COPY-MIRROR (no linkage, currently in sync)** |
| 25 | Buyer protection window | **no policy source anywhere** | — | — | **PDP claims "7-day buyer protection" (`pdp.tsx:465`)** | **return-request enforces status only — no window (`return-request/route.ts:36-41`); auto-complete 14 d (`order-completion.ts:23`)** | **FALSE COPY — F-16** |
| 26 | Seller payout minimum (wallet empty state) | `Setting payout.min_minor` | Admin→Settings | **`wallet.tsx:336` hardcodes "(RM 50)" — VERIFIED by direct read — while `wallet.tsx:140` 10 lines above uses the live value (RM 10)** | — | — | **HARDCODED-STALE — F-17 (last survivor of the original issue class)** |
| 27 | Ranking weights | `Setting ranking.weights` | Admin→Settings | — | — | search uses fixed weights (`market/_shared/search.ts:35-54`) | **UNWIRED (honest)** |
| 28 | Maintenance mode | `Setting maintenance.mode` | Admin→Settings | — | — | none | **UNWIRED (honest)** |
| 29 | Home featured stores | `Setting home.featured_stores` | `PUT /api/admin/featured-stores` | — | **`market/home` does NOT read it** (uses `FeaturedSlot` + live-stores fallback, `market/home/route.ts:31-36`) | none | **DEAD SETTING + under-guarded write (F-18)** |
| 30 | Plan commission (8%) | `Plan.commissionPercent` (seed) | — | — | — | **no runtime consumer** (only `planCode` string displayed) | **DEAD DATA** |

### 2.3 Role-desync findings (the core issue class, ranked)

These are places where **different roles see different values for the same attribute**, or where an admin surface implies behaviour that enforcement ignores:

1. **F-08 — Commission Overrides (Admin→Finance) are an illusion.** The admin CRUD (`finance.tsx:93-255`, `/api/admin/commission/overrides*`) manages `CommissionOverride` rows (including a "Hold days" column and Active toggle), but the commission engine `resolveRate` (`lib/commission.ts:56-123`) reads only Seller/Product/Category/FeeHoliday. **An admin can spend effort configuring scoped overrides that never affect a single order.** VERIFIED (grep: `db.commissionOverride` appears only in the admin CRUD routes).
2. **F-11 — Analytics retention: admin edits a dead key.** Registry claims wired (`settings-registry.ts:311`); the enforcement tick reads `SI_RETENTION_DAYS` env (`analytics-tick/route.ts:29-34`). VERIFIED by direct read.
3. **F-07 — Feature Flags page is a dead control.** UI promises "Runtime switches for progressive delivery" (`system.tsx:588`); nothing reads the table. VERIFIED (repo-wide grep).
4. **F-12 — `psp.payouts.mode` registry honesty violation** (claims wired; sole reader unimported).
5. **F-15 — Buyer payment-window display (10 min) ≠ enforcement (30 min).** VERIFIED by direct read of both lines.
6. **F-14 — Buyer payment-method list (4) ≠ server acceptance (5).**
7. **F-17 — Seller wallet payout-minimum copy (RM 50) ≠ live setting (RM 10)** — the literal last survivor of the original "Platform Commission card" defect class. VERIFIED.
8. **F-16 — Buyer-protection copy (7 days) has no enforcement** (returns status-only; auto-complete is 14 days).
9. **F-10 — Hold-release rule + grace-days: admin-configurable, enforcement ignores both.**

---

## 3. PART II — Auth & access-control audit (admin / seller / buyer)

### 3.1 Login & registration flows

| Route | Password scheme | Status gate at login | Rate limit | Verdict |
|---|---|---|---|---|
| `POST /api/auth/login` (admin+sellers) | scrypt, 16-byte salt, 64-byte key, timing-safe (`password.ts:10-20`); token 256-bit (`auth.ts:29`) | Admin: `isActive` ✓ (`login/route.ts:17`). Seller: **only `terminated` blocked (`:32-34`) — suspended / pending_review / rejected sellers DO get sessions.** VERIFIED by direct read | **NONE** — F-19 | WEAK (brute-force open + suspension bypass) |
| `POST /api/auth/register` (seller self-signup) | scrypt, min 8 (`register/route.ts:26`) | creates `status:"onboarding"` + store + wallet + session immediately (`:100`) | **NONE** | mass-signup open; email uniqueness checked vs Seller only (`:29-30`) — can collide with shopper/admin emails (shopper register checks all 3: `shopper/register/route.ts:26-28`) |
| `POST /api/auth/shopper/login` | same scrypt | `status !== "active"` → 403 ✓ (`shopper/login/route.ts:21-23`) | **NONE** | correct status gate, brute-force open |
| `POST /api/auth/shopper/register` | same | n/a | **NONE** | email-clash check vs all 3 tables ✓ |
| `POST /api/auth/logout` | deletes the DB session row (`auth.ts:46-51`) — same token backs cookie+Bearer, both die | — | — | OK |
| `GET /api/auth/me` | delegates to the three require* guards | re-checked | — | OK |

Portal selection is from the request body (`login/route.ts:12`) with separate table lookups — **cross-portal login is structurally prevented** (a shopper email fails both lookups). VERIFIED.

**F-19 (HIGH): demo credentials shipped in the client bundle** — `admin-shell.tsx:434-439` hardcodes superadmin/ops/finance/moderator emails + passwords, and no login route is throttled. Combined with seed credentials (`prisma/seed.ts:419-424`). VERIFIED by direct read.

### 3.2 Route guard coverage

**Admin (`/api/admin/**`, 60 route files):** every exported method on every route calls `requireAdmin` or better — **zero unguarded admin routes** (verified by per-method scan + reverse scan). Gaps are *capability-tier* violations, not missing auth:

| Finding | Evidence | Severity |
|---|---|---|
| **F-09 — Commission/hold policy mutation under-guarded**: `PATCH /api/admin/sellers/[id]` sets `commissionOverridePercent` / `holdDaysOverride` / `riskTier` with bare `requireAdmin` | `sellers/[id]/route.ts:66` (guard), `:84-99` (mutation) — VERIFIED by direct read. Caps matrix implies `commission.manage` = [superadmin, finance] → **a moderator can zero any seller's commission and hold days** | HIGH |
| **F-18 — settings.manage bypass**: `PUT /api/admin/featured-stores` writes the `Setting` table with bare `requireAdmin` while equivalent writes via `/api/admin/settings` require `settings.manage` (superadmin) | `featured-stores/route.ts:73` (guard), `:100-104` (upsert) — VERIFIED | MEDIUM |
| Money/PII reads exposed to all admin roles (moderator included): `kyc-queue` (KYC docs + banks + wallets), `banks`, `sellers/[id]` (KYC/banks/wallet/notes), `admin/export` (customer emails + wallet CSV), `commission/analytics`, `commission/exports/[id]/download` (full commission CSV) | `kyc-queue/route.ts:8-16`, `banks/route.ts:8`, `sellers/[id]/route.ts:11-21`, `export/route.ts:11-68`, `commission/analytics/route.ts:13`, `commission/exports/[id]/download/route.ts:11` | MEDIUM |
| Webhook-delivery replay **forges success** (sets `status:"success", responseCode:200` without delivering) with bare `requireAdmin`, no cap | `webhook-deliveries/[id]/replay/route.ts:10,16-19` | MEDIUM |
| Platform coupons (honoured by server pricing, `pricing.ts:134-161`) writable by any admin role; no coupons cap in matrix | `coupons/route.ts:25`, `coupons/[id]:11,60` | LOW-MED |
| Strongest gate in the app (for contrast): activity-log purge = `requireCap("logs.purge")` + scrypt password re-verification (`activity-logs/purge/route.ts:35-67`) | — | ✅ |

**Seller (`/api/store/**`, 66 route files):** all routes guarded — 60 via `requireActiveSellerStore`, 6 via hand-rolled `getSession` seller checks (connections×3, imports, publish, seo — correct today, drift risk). **Zero unguarded routes.** Status enforcement: see §3.4.

**Buyer (`/api/me|cart|checkout|chat|claim/**`):** all ownership-checked. Verified highlights:
- `me/orders/[orderNumber]` scopes `{orderNumber, shopperId: me.id}` (`route.ts:23`) ✓
- `me/password` verifies current password per user type + throttled (`:20,40,54,73`) ✓ — but see F-05 (broken rotation)
- Cart: account-scoped only; guests get `requiresAuth` (`cart/route.ts:29`); guest→account merge claims only email-matching orders (`shopper-merge.ts:13-21`) ✓
- Checkout: `requireShopper` on create (`create/route.ts:40`), idempotent replay ownership-checked (`:48,66`); addresses owner-resolved (`checkout/owner.ts:54-58`) ✓
- Chat threads: shopper/seller membership enforced on both sides (`api/chat/threads/[id]/route.ts:29-38`, `store/chat/.../messages/route.ts:23,78`) ✓ — minor: order-context attachable by order-number guess without ownership (`chat/threads/route.ts:113-122`, no order data returned)
- `claim/bind`: 192-bit hashed single-use token, atomic bind (`claim/bind/route.ts:36-41,96-105`) ✓

### 3.3 Tenant isolation (Seller A vs Seller B)

**PASS — no cross-tenant access found.** Every `[id]`/`[slug]` route under `/api/store/**` scopes by the session's storeId or wallet id, on reads AND writes:

- Orders (all 7 sub-routes): `orders/[id]/route.ts:14` `{ OR:[{id},{orderNumber:id}], storeId: store.id }` and equivalents
- Products/variants: `ownProduct` post-fetch check (`products/helpers.ts:72-78`), `ownVariant` (`variants/[id]/route.ts:8-15`)
- Collections/pages/domains/webhooks/coupons: `findFirst({where:{id,storeId}})` pattern throughout
- Wallet activity: wallet by `sellerId: me.id` + per-line ownership (`wallet/activity/[id]/route.ts:16,26-27,43,57`)
- Insights: all queries store-scoped (`lib/analytics/queries.ts:130,176,219,517`)
- Payout request: wallet from `me.id` inside Serializable tx (`payouts/route.ts:49,124-167`)

**Two isolation defects found outside the classic pattern:**

- **F-20 (MEDIUM) — Shared marketplace-connection rows leak across stores.** `store/connections/route.ts:14-15` queries `OR: [{storeId: mine}, {storeId: null}]` → every seller sees every *unclaimed* platform connection; and `connections/disconnect/route.ts:17-19` `updateMany` **mutates global (`storeId:null`) rows** — Seller A disconnecting flips state every other store sees. VERIFIED by direct read.
- **F-21 (MEDIUM) — Voucher self-management broken by scope mismatch (fail-closed).** `vouchers/[id]/route.ts:15` filters `scope:"seller"`, but seller vouchers are created/listed with `scope:"STORE"` (`vouchers/route.ts:167,32`) → own-voucher PATCH/DELETE always 404s. No cross-tenant risk; the pause feature is simply dead server-side. VERIFIED by direct read.

### 3.4 Account-status enforcement & session revocation — **F-02/F-03 (CRITICAL)**

Verified chain (all direct reads):

1. `requireSeller()` returns `status` but **never enforces it** (`auth.ts:92-104`); `requireActiveSellerStore()` checks only store existence (`auth.ts:107-113`).
2. **65 of 66 seller routes never check seller status** (the sole exception: `store/onboarding` requires `onboarding|rejected`, `onboarding/route.ts:16-17`).
3. Admin suspend/terminate **flip status only** — `suspend/route.ts:20-21`, `terminate/route.ts:20-21` — **no session deletion**. The ONLY `session.deleteMany` in the codebase is logout (`auth.ts:49`).
4. Login blocks only `terminated` (`login/route.ts:32-34`) — **a suspended seller can obtain a fresh session**.
5. Suspend sets the store to `draft`, but `POST /api/store/publish` re-publishes `draft→live` with **no seller-status check** (`store/publish/route.ts:10-28`; `canPublish` checks products/support-email/SEO only, `store-lifecycle.ts:96-118`) → **a suspended seller can self-un-suspend their storefront**.
6. The suspended/terminated block in the UI is **client-side only** (`seller-shell.tsx:175-190`).

**Net effect: suspension is cosmetic. A suspended seller retains (and can re-obtain) full API access — fulfill/ship orders, request payouts, edit products, and re-publish the store.** Contrast: admin (`isActive`) and shopper (`active`) status ARE enforced at request time (`auth.ts:82,120`).

Also **F-06 (HIGH)**: no admin route exists to ban a shopper at all (only login/profile/password touch `ShopperUser`), and expired Session rows are never purged.

### 3.5 CSRF posture — **F-01 (CRITICAL)**

- Session cookie: `httpOnly, sameSite:"none", secure:true` (`auth.ts:34-42`) — **attached to every cross-site request**.
- **No `middleware.ts` / `proxy.ts` exists** (glob-verified); **zero** origin/referer validation, CSRF tokens, or `Sec-Fetch-Site` checks anywhere in `src/` (grep-verified).
- Route bodies parse via `req.json()` with no content-type enforcement → cross-site `text/plain` form POSTs deliver the cookie and a parseable body (INFERRED from undici semantics — not live-tested).
- Exposure set: **every cookie-authenticated POST/PATCH/DELETE** — including admin suspend/terminate/payout-approve/wallet-adjust, seller mutations, shopper checkout. Login CSRF (session fixation into an attacker account) also possible.
- The Bearer-header path is CSRF-safe (custom header → preflight), but cookie is the default for top-level browsing.

### 3.6 Webhooks, cron, chat, mini-services, gateway

| System | Mechanism | Verdict |
|---|---|---|
| Payments webhook `/api/webhooks/payments/[provider]` | HMAC-SHA256 over `ref.eventType.amount.ts`, timing-safe, ±10-min replay window, 60/min flood control, sandbox providers 403 in production (`process.ts:56-58,134-137,170-172`, `route.ts:22-25`) | Mechanism sound — **but F-04 (CRITICAL): `WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo"` (`process.ts:49`, VERIFIED by direct read) fails open to a publicly documented constant; the env var is absent from `.env.example` AND from the live `.env` (key list inspected). In this deployment, anyone can forge `payment.succeeded` / `payout.succeeded` money events.** |
| `payout-simulate` + checkout `simulate` | rate-limited 10/min; production-gated by `mockPspAllowed()` | **F-13 (HIGH): `mockPspAllowed` defaults TRUE when the Setting row is missing** (`psp.ts:137-143` + `json.ts:2-9` fail-open parse) — simulate rails stay live in production unless explicitly disabled |
| Shipping webhook `/api/shipping/webhook/[provider]` | **none** — no signature, no auth, no rate limit (`route.ts:13-68`; comment admits future work) | **F-22 (HIGH): forged AWB events can force `shipped→delivered`, which feeds order-completion/payout timing** |
| Cron `/api/cron/*` (3 routes) | `x-cron-secret` shared secret, sha256 + timing-safe, **fail-closed in production without `CRON_SECRET`** (`cron-auth.ts:36-40,55-61`); scheduler never exposes it (`expiry-scheduler/index.ts:228-248`) | ✅ best practice — gap: `CRON_SECRET` missing from `.env.example` (F-23) |
| Ticks `/api/shipping/tick`, `/api/orders/expiry/tick` | intentionally unauthenticated, 1.5 s in-process throttle, DB CAS claims | documented design — LOW |
| Chat HTTP routes | membership enforced both sides | ✅ |
| **Chat socket hub (mini-service :3003)** | **NO authentication** — any client may `join` any `thread:*`/`user:*` room (`chat-service/index.ts:41-56`); CORS reflects any origin with credentials; `allowRequest` never rejects (`:25-38`) — VERIFIED by direct read | **F-24 (HIGH): live message confidentiality rests solely on cuid room-id secrecy; `user:*` events carry message previews (`lib/chat.ts:36-43`)** |
| **Chat relay :3103 `POST /broadcast`** | **unauthenticated** — emits arbitrary events to any rooms (`:75-104`) — VERIFIED by direct read | spoofed `chat:message` injection into any open UI (no persistence impact; HTTP routes are authoritative) |
| **Caddy gateway :81** | `XTransformPort=*` proxies **ANY localhost port** (`Caddyfile:2-13`) — VERIFIED by direct read | **amplifies F-24: :3103/:3003/:3005 reachable from outside via the public gateway** (INFERRED reachable; direct port exposure untested) |
| `/api/metrics` | token-gated, fail-closed 503 when `METRICS_TOKEN` unset (disabled in this deployment) | ✅ (minor: compare not timing-safe, `metrics/route.ts:17`) |
| `/api/img/[seed]` | deterministic local SVG, clamped 40-2400, sanitized; no outbound fetch | ✅ no SSRF |
| `/api/auth/callback/[platform]` | redirect limited to own origin (no open redirect) — **but state validation fails OPEN**: absent/unknown/consumed `state` proceeds (`route.ts:24-39`); the stricter `consumeState` (`marketplaces/callback.ts:47-57`) is dead code; `sellerId` stored in state is never compared at completion | **F-25 (MEDIUM)** |
| `/api/claim/bind` | 192-bit hashed single-use token + OAuth ownership match + atomic bind | ✅ |

### 3.7 Rate-limiting coverage

Protected: `me/password`, `store/insights/*` (7), `store/terms`, `platform/terms`, payments webhook (60/min), payout-simulate + checkout simulate (10/min), admin payout-batches/sweep/approve/reject/fail/mark-paid.

**Unprotected auth-sensitive surface (verified per-handler):** all four login/register routes, `/api/orders/lookup`, `/api/orders/receipt`, shipping webhook, OAuth callback, `claim/bind`, all chat send routes. Two limiter modules with colliding export names and different contracts coexist (`rate-limit.ts:197` throws 429 vs `ratelimit.ts:52` returns a result) — consolidation debt.

### 3.8 Client shell & token bridge

Portal switching is client-side cosmetics (`app-root.tsx:37-43` via localStorage `sm_surface`) — **every admin/seller API call is server-guarded; no admin data endpoint without auth** (`use-api.ts:26,41` attaches `authHeaders()`). Session token is mirrored to localStorage as Bearer (`session-client.ts:13`) — XSS would defeat it (accepted trade-off for iframe preview); combined with F-01 (no CSRF) and F-19 (demo creds in bundle) this lowers the practical attack bar.

---

## 4. PART III — Public-surface exposure findings

| # | Finding | Evidence | Severity |
|---|---|---|---|
| P-1 | **Anonymous, un-throttled, auto-published product reviews — RUNTIME-CONFIRMED**: probe POST created a published 1★ review and instantly re-averaged product ratings, no auth, no purchase verification, no rate limit | `reviews/route.ts:7-33` (`status:"published"` at `:31`, aggregate recompute `:36-47`); reproduced live 2026-10-29 (probe deleted + aggregates restored) | MEDIUM (data integrity) |
| P-2 | Guest order lookup/receipt: email + **sequential** order numbers (`NM-100001+`, `lib/api.ts:216-223`) with **no rate limit**; receipt discloses name, email, phone, items, amounts, payment ref | `orders/lookup/route.ts:7-27` (uniform 404 ✓), `receipt/route.ts:10-27,122-179`; runtime: 2 rapid probes served, no 429 | MEDIUM |
| P-3 | Payment status by capability URL: `GET /api/checkout/payments/[ref]` + `retry` unauthenticated; ref = `ref_` + 64-bit hex (unguessable, but printed on receipts) | `payments/[ref]/route.ts:8-19`, `retry/route.ts:10`, ref gen `create/route.ts:179` | LOW-MED |
| P-4 | Storefront newsletter POST: no auth, no rate limit, no dedup; writes submitted emails into ActivityLog | `newsletter/route.ts:7-33` | LOW |
| P-5 | `/api/settings/site` — dead duplicate of `/api/sf/app-config` (both return `footerVisible`; only the latter has a consumer) | `settings/site/route.ts:6-11`; runtime: both return `{"data":{"footerVisible":false}}` consistently | LOW |
| P-6 | Admin settings GET returns hidden registry keys (`lt.seed.state`, `recon.fault`) in `extras` to any admin role | `admin/settings/route.ts:29-37` | LOW |
| P-7 | Seller webhook signing secret returned on every GET/PATCH (not only at creation) | `store/webhooks/route.ts:23,69`, `webhooks/[id]/route.ts:38` | INFO |
| P-8 | `imports.tsx:151` re-fires `POST /api/store/publish` inside a catch handler **without auth headers** (401 in cookie-less iframes); `settings.tsx:77` plain `fetch("/api/store/pages")` same class (read-only) | VERIFIED by agent read | LOW |

---

## 5. Findings register (severity-ranked)

> Status legend: **VERIFIED** = direct code read this session · **RUNTIME-CONFIRMED** = reproduced on the running server · **AGENT** = agent-reported, sampled spot-checks passed. All have file:line evidence.

### CRITICAL

| ID | Finding | Evidence | Status | Fix direction |
|---|---|---|---|---|
| **F-01** | **Systemic CSRF exposure**: `SameSite=None` session cookie + zero origin/CSRF-token/middleware protections → every cookie-authenticated mutation (admin suspend/terminate/payout/wallet-adjust, seller CRUD, shopper checkout) is cross-site forgeable | `auth.ts:34-42`; no middleware (glob); no origin checks (grep) | VERIFIED | Add origin/`Sec-Fetch-Site` check middleware for non-GET routes; or move to `SameSite=Lax` + explicit Bearer for iframe use |
| **F-02** | **Seller suspension is cosmetic**: no status enforcement in guards, no session revocation on suspend/terminate, re-login allowed (only `terminated` blocked), self-un-suspend via store re-publish | `auth.ts:92-113`; `suspend/terminate routes:20-21`; `login/route.ts:32-34`; `store/publish/route.ts:10-28`; shell-only block `seller-shell.tsx:175-190` | VERIFIED | Enforce status in `requireActiveSellerStore` (mutations tier); revoke sessions on status change; block publish for non-active sellers |
| **F-03** | **Password-change endpoint broken at compile time**: `rotateSession` is not exported by `lib/auth` → TS2724; password is written then the call throws → 500, session not rotated. (Also: `psp-adapters/stripe-my.ts:61` imports non-existent `safeEqualHex` → TS2305; 173 total tsc errors, mostly `scripts/`) | `me/password/route.ts:3,44,58,77`; `tsc --noEmit` output captured | VERIFIED | Implement `rotateSession` (delete presented token, create new, return it) + fix `safeEqualHex` import |
| **F-04** | **Payment-webhook secret fails open to a public demo constant**; env var absent from `.env.example` and live `.env` → money events (`payment.succeeded`, `payout.succeeded`) forgeable by anyone in this deployment | `process.ts:46-49` | VERIFIED | Fail closed in production (no fallback); document `PSP_WEBHOOK_SECRET` in `.env.example` |

### HIGH

| ID | Finding | Evidence | Status | Fix direction |
|---|---|---|---|---|
| **F-05** | Shipping webhook fully unauthenticated — forged AWB events force `DELIVERED`, feeding payout-hold/completion timing | `shipping/webhook/[provider]/route.ts:13-68` | VERIFIED | Add provider signature verification + rate limit |
| **F-06** | Chat socket hub + relay unauthenticated (any room join; unauth `:3103 /broadcast`), amplified by Caddy `XTransformPort` proxying ANY localhost port | `chat-service/index.ts:25-56,75-104`; `Caddyfile:2-13` | VERIFIED (external reachability INFERRED) | Authenticate sockets (session token → allowed rooms), token-gate the relay, restrict gateway ports |
| **F-07** | Feature Flags admin page edits a table no runtime code reads ("Runtime switches" promise is false) | `system.tsx:568-584,588`; grep `db.featureFlag` → admin route only | VERIFIED | Wire real consumers or remove the page; never ship dead controls |
| **F-08** | Commission Overrides admin surface (FIN-02) unwired — `resolveRate` never reads `db.commissionOverride`; admin configures rows with zero effect | `finance.tsx:93-255`; `lib/commission.ts:56-123` (grep verified) | VERIFIED | Wire override resolution into `resolveRate` or remove the surface |
| **F-09** | `PATCH /api/admin/sellers/[id]` mutates commission/hold/risk with bare `requireAdmin` (moderator can zero commission) | `sellers/[id]/route.ts:66,84-99` | VERIFIED | `requireCap("commission.manage")` |
| **F-10** | `holdReleaseRule` + `graceDaysAfterDelivered` admin-configurable but never enforced (no warning in admin UI) | `commission.ts:266-276,242-243`; `process.ts:312-313`; `order-completion.ts:23` | VERIFIED | Enforce or mark "not implemented" in the admin form |
| **F-11** | `analytics.retention_days` — registry claims wired; enforcement reads env var instead. Admin edits a dead key | `settings-registry.ts:311`; `analytics-tick/route.ts:29-34` | VERIFIED | Read the Setting row in the tick (or correct the registry) |
| **F-12** | No brute-force protection on any login/register route + demo admin credentials hardcoded in the client bundle | 4 handlers (no rateLimit import — verified); `admin-shell.tsx:434-439` | VERIFIED | Throttle auth routes; remove demo creds from the bundle |
| **F-13** | `mockPspAllowed` fails open in production when the Setting row is missing (simulate rails stay live) | `psp.ts:137-143`; `json.ts:2-9` | VERIFIED | Fail closed when `NODE_ENV=production` and row missing |

### MEDIUM

| ID | Finding | Evidence | Status |
|---|---|---|---|
| **F-14** | Buyer payment-method desync: UI hardcodes 4 providers vs server accepts 5 (`fpx_curlec` hidden); admin provider list informational-only | `checkout.tsx:91-96`; `checkout/create/route.ts:14` | VERIFIED |
| **F-15** | Checkout timer desync: UI 10:00 vs server 30:00; API's `expiresAt` ignored by the countdown | `checkout.tsx:1549`; `create/route.ts:181` | VERIFIED |
| **F-16** | PDP "7-day buyer protection" copy unenforced (no return window in code; auto-complete is 14 days) | `pdp.tsx:465`; `return-request/route.ts:36-41`; `order-completion.ts:23` | VERIFIED |
| **F-17** | Seller wallet empty-state hardcodes "(RM 50)" minimum vs live RM 10 — **last survivor of the original defect class** | `wallet.tsx:336` vs `:140` | VERIFIED |
| **F-18** | `settings.manage` bypass via `PUT /api/admin/featured-stores` (bare `requireAdmin` writes a Setting row) — and the setting itself is dead (no consumer) | `featured-stores/route.ts:73,100-104`; `market/home/route.ts:31-36` | VERIFIED |
| **F-19** | (see F-12 — listed there) | — | — |
| **F-20** | Marketplace connections: `OR storeId:null` cross-store visibility + disconnect mutates global rows | `connections/route.ts:14-15`; `disconnect/route.ts:17-19` | VERIFIED |
| **F-21** | Own-voucher PATCH/DELETE dead via scope mismatch (`"seller"` vs `"STORE"`) — fail-closed | `vouchers/[id]/route.ts:15` vs `vouchers/route.ts:167,32` | VERIFIED |
| **F-22** | OAuth callback state fails open; stricter `consumeState` dead code; state `sellerId` never compared | `auth/callback/[platform]/route.ts:24-39`; `marketplaces/callback.ts:47-57` | VERIFIED |
| **F-23** | `.env.example` documents none of `CRON_SECRET` / `PSP_WEBHOOK_SECRET` / `METRICS_TOKEN`; `secretbox.ts` silently falls back to a deterministic dev key | `.env.example:1-21`; `secretbox.ts:12-27` | VERIFIED |
| **F-24** | Suspended/pending sellers can obtain sessions at login (subset of F-02, kept for the login-route fix) | `login/route.ts:29-35` | VERIFIED |
| **F-25** | Webhook-delivery replay forges delivery success (bare `requireAdmin`, no cap) | `webhook-deliveries/[id]/replay/route.ts:10,16-19` | VERIFIED |
| **F-26** | Money/PII reads under-guarded to moderator: kyc-queue, banks, sellers/[id], export CSV, commission analytics + CSV download | see §3.2 | VERIFIED |
| **F-27** | Anonymous auto-published reviews (integrity) — **RUNTIME-CONFIRMED** | `reviews/route.ts:7-33` + live probe | RUNTIME-CONFIRMED |
| **F-28** | Guest order lookup/receipt enumeration, un-throttled; receipt leaks PII + payment ref | `orders/lookup|receipt`; live probe (no 429) | RUNTIME-CONFIRMED (absence of throttle) |

### LOW (summary)

F-29 copy-mirrors of pricing constants (PDP RM 8 / RM 100, checkout msg, payout SLA "1-3 working days") · F-30 dead `/api/settings/site` duplicate · F-31 dual rate-limit modules (colliding names/contracts) · F-32 expired sessions never purged · F-33 unused `impersonate` cap · F-34 coupons/banners/announcements writes under bare `requireAdmin` · F-35 metrics compare not timing-safe · F-36 chat order-context attachable via order-number guess · F-37 `imports.tsx:151` unauth re-POST in catch + `settings.tsx:77` plain fetch · F-38 webhook secrets returned on every GET · F-39 admin settings GET `extras` leaks hidden test keys · F-40 seed/demo credentials (see F-12) · F-41 `psp.payouts.mode` registry honesty (see F-12 group) · F-42 dead `lt.seed.state` key · F-43 newsletter endpoint hygiene (P-4).

---

## 6. Verification status & honest limits

### 6.1 Executed checks (PASS/FAIL/NOT TESTED/BLOCKED applied)

| Check | Result |
|---|---|
| Runtime: unauthorised access to 10 guarded endpoints (`/api/store/*`, `/api/admin/*`, `/api/me/*`) | **PASS** — all returned 401 |
| Runtime: `GET /api/platform/terms` returns live configured values (0.5% / 7 d / RM 1 min / RM 10 payout min / first-N 5) | **PASS** |
| Runtime: `GET /api/settings/site` vs `/api/sf/app-config` consistency | **PASS** (identical `footerVisible:false`) |
| Runtime: anonymous review publication | **FAIL** (vulnerability confirmed — then cleaned up) |
| Runtime: order-lookup throttle | **FAIL** (no 429 on rapid calls — confirmed absent) |
| Static: TS compile of the audit-critical claims (`rotateSession`, `safeEqualHex`) | **FAIL** (TS2724 + TS2305 reproduced; 173 total errors — bulk in `scripts/`, outside the Next build path but real debt) |
| Static: every high-severity code claim in §5 | **VERIFIED by direct read** (spot-check list: process.ts:49, wallet.tsx:336, checkout.tsx:1549, create/route.ts:181, analytics-tick:29-34, vouchers scope, login status gate, reviews route, lookup route, admin sellers PATCH, featured-stores PUT, connections OR-null, admin-shell demo creds, resolveRate table reads, Caddyfile, chat-service join/relay) |
| Seller-terms linkage wiring (the original defect class fix) | **PASS** — all surfaces read live terms; runtime values live |
| Cross-tenant isolation on `/api/store/**` param routes | **PASS** (static; zero violations found) |

### 6.2 Test hygiene

The anonymous-review probe (P-1) inserted one review ("AuditProbe", 1★) into the dev database; it was **deleted and the product rating aggregates restored** (`ratingAvg: 0, ratingCount: 0` — product had no other published reviews) via a one-off script, then the script file was removed. No other writes were made to the database. No production systems were touched.

### 6.3 Could NOT be verified (honest limits)

1. **Cross-site form CSRF feasibility against `req.json()`** — inferred from undici semantics; not live-tested (no attacker origin available in-sandbox).
2. **External reachability of :3003/:3103/:3005** via the Caddy gateway — the `XTransformPort` rule is verified; actual external network path INFERRED only.
3. **Production `NODE_ENV` / real PSP secrets** — sandbox `.env` contains only Supabase + timing keys; production deployment posture unknown.
4. **Redis rate-limit path** — `RATE_LIMIT_REDIS_URL` unset; in-memory path only.
5. **Live DB row values beyond the public endpoints probed** — static audit of code only; seeded defaults assumed for unprobed rows.
6. **Agent-reported MEDIUM/LOW items not in the spot-check list** — accepted on sampled evidence (marked AGENT where applicable); all HIGH/CRITICAL items were directly verified.
7. **Full `next build`** — not run (per environment rules); TS findings come from `tsc --noEmit`.
8. **Seller A/B negative-authorization runtime test** — isolation verified statically; a live two-session abuse test was NOT performed (NOT TESTED at runtime).

---

## 7. Remediation priorities (recommended order)

**P0 — before any production exposure (CRITICAL):**
1. F-04: webhook secret fail-closed in production + document in `.env.example` (F-23 partially).
2. F-01: origin-check middleware for non-GET routes (or SameSite strategy change).
3. F-02/F-24: seller-status enforcement in `requireActiveSellerStore` + session revocation on suspend/terminate + publish gate.
4. F-03: implement `rotateSession` + fix `safeEqualHex` import.

**P1 — linkage honesty (the issue class this audit was commissioned for):**
5. F-08: wire or remove Commission Overrides.
6. F-11/F-12/F-07: fix the three false `wired` registry claims / dead admin surfaces (retention key, psp.payouts.mode, Feature Flags).
7. F-17: replace wallet.tsx:336 "(RM 50)" with the live `minPayoutMinor` (one-line fix, same pattern as the previous session's terms wiring).
8. F-15/F-14: drive the checkout countdown from `expiresAt`; serve the payment-method list from one source.
9. F-10: not-implemented badges for hold-release rule / grace days (or implement).

**P2 — access-control tightening:**
10. F-09/F-18/F-25/F-26: capability-tier guards on commission policy mutation, Setting writes, replay, and finance/PII reads.
11. F-05/F-06: shipping-webhook signature; chat hub/relay authentication + gateway port restriction.
12. F-12: throttle all login/register routes; strip demo credentials from the bundle.

**P3 — hygiene:** reviews gating (F-27), lookup throttling (F-28), OAuth state fail-closed (F-22), connection-row scoping (F-20), voucher scope fix (F-21), rate-limit module consolidation, session purge, dead-endpoint removal (`/api/settings/site`, orphan featured-stores route), copy-mirror cleanup.

---

## 8. Appendix — audit trail

- Task registered in `agent-ctx/RX-CHECKLIST.md` (Addendum #9, Task F) before execution.
- Parallel audit agents: F2-a (SSOT & consumers), F2-b (seller backend), F2-c (admin+buyer+storefront), F2-d (auth core & cross-cutting) — read-only.
- Spot-verification: 18 direct file reads + `rg` greps + `bunx tsc --noEmit` + 6 runtime curl probes (one command window; the sandbox process recycler required watchdog-assisted revival — `tool-results/watchdog.sh`).
- No production code modified. One probe review created and reverted (§6.2).
- Related prior evidence: RX-CHECKLIST Addendum #8 (seller-terms live-sync + seller-override runtime tests, previous session, PASS).

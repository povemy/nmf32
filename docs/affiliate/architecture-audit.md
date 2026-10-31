# Affiliate Programme — Phase-0 Subsystem Architecture Audit

**Project:** NOMOFEE multi-vendor marketplace (Next.js 16 App Router, TypeScript, Prisma, PostgreSQL/Supabase)
**Scope:** Pre-implementation audit of every existing subsystem the affiliate programme will touch, classified for reuse in the affiliate build.
**Method:** Direct code inspection of `/home/z/my-project` (schema, lib, API routes, components, mini-services). No code was modified.
**Status:** Phase-0 deliverable. Companion documents: `implementation-plan.md`, `commission-definitions.md`, `security-and-fraud-rules.md`, `rollout-checklist.md`.

---

## 1. Classification legend

| Class | Meaning |
|---|---|
| **A — Implemented and reusable** | Ships correct, exercised behaviour the affiliate build can call or copy with no changes. |
| **B — Implemented but requires extension** | Core behaviour is correct and exercised; the affiliate build adds columns, lines, recipes, or fields alongside it without changing existing semantics. |
| **C — Partially implemented** | The mechanism exists but a documented portion is dormant, dead, or divergent; affiliate dependency on the missing portion must be designed around or the portion completed first. |
| **D — Missing** | Nothing exists; must be built. |
| **E — Unsafe to reuse without refactoring** | Exists but its shape would create the wrong affiliate semantics if reused verbatim. |
| **F — Blocked by an unresolved business or operational decision** | The technical path exists, but enabling it is gated on a non-engineering decision. |

---

## 2. Classification summary

| # | Subsystem | Class | Primary evidence (paths) |
|---|---|---|---|
| 1 | Authentication & sessions | **A** | `src/lib/auth.ts` |
| 2 | Products & catalogue | **B** | `prisma/schema.prisma` (`Product`, `ProductVariant`), `src/app/api/store/products/**` |
| 3 | Cart | **A** | `src/app/api/cart/**`, `src/lib/analytics/track.ts` |
| 4 | Checkout (Option B) | **B** | `src/app/api/checkout/create/route.ts`, `src/app/api/checkout/pricing.ts` |
| 5 | Payment webhooks | **B** | `src/app/api/webhooks/payments/process.ts`, `[provider]/route.ts` |
| 6 | Order lifecycle | **C** | `src/lib/api.ts` (`transitionOrder`), `src/lib/order-completion.ts` |
| 7 | Refunds | **B** | `src/app/api/admin/refunds/[id]/process/route.ts` |
| 8 | Seller wallet | **A** (as pattern) | `prisma/schema.prisma` (`Wallet`), `src/lib/ledger.ts` (`walletTruth`, `refreshWalletCache`) |
| 9 | Double-entry ledger | **B** | `src/lib/ledger.ts` |
| 10 | Seller payouts | **A** (manual workflow) | `src/app/api/store/payouts/route.ts`, `src/app/api/admin/payouts/**` |
| 11 | Commission engine | **B** | `src/lib/commission.ts` |
| 12 | Analytics (Seller Insights) | **B** | `src/lib/analytics/{identity,queue,track,attribution}.ts` |
| 13 | Campaign links | **A** (as pattern) | `prisma/schema.prisma` (`SellerCampaign`), `src/lib/analytics/attribution.ts`, `src/app/api/store/campaigns/**` |
| 14 | Settings registry | **A** | `src/lib/settings-registry.ts`, `src/components/admin/system.tsx` |
| 15 | Admin capabilities (RBAC) | **A** | `src/lib/admin-caps.ts`, `src/lib/auth.ts` (`requireCap`) |
| 16 | Rate limiting | **E** | `src/lib/rate-limit.ts`, `src/lib/ratelimit.ts` |
| 17 | CSRF gate (proxy) | **A** | `src/proxy.ts` |
| 18 | Shells & navigation (single-route SPA) | **A** | `src/app/page.tsx`, `src/components/app-root.tsx`, `src/components/{shopper,seller}/ui-bits.tsx`, `src/components/admin/admin-shell.tsx` |
| 19 | Cron / scheduler | **A** | `mini-services/expiry-scheduler/`, `src/app/api/cron/**`, `src/lib/cron-auth.ts` |
| 20 | Feature flags | **C** | `src/lib/feature-flags.ts`, `prisma/schema.prisma` (`FeatureFlag`) |
| 21 | COD / offline payment rails | **F/D** | `src/lib/payment-methods.ts` (absent from list) |
| 22 | Sponsor override enablement | **F** | legal gate, see §5 and `rollout-checklist.md` |

---

## 3. Per-subsystem findings

### 3.1 Authentication & sessions — Class A

- **Evidence:** `src/lib/auth.ts`; `prisma/schema.prisma` `Session` model (token unique, userType `admin|seller|shopper`, expiresAt).
- **Behaviour:** DB-backed revocable sessions delivered via `sm_session` cookie (httpOnly, SameSite=None, Secure, 7-day TTL) or `Authorization: Bearer` bridge for cross-site iframes. Guards: `requireAdmin`, `requireAdminRole`, `requireSeller`, `requireActiveSellerStore` (blocks `suspended`/`terminated` sellers server-side), `requireShopper` (rejects non-`active` shoppers). Session revocation (`revokeUserSessions`) and rotation (`rotateSession`) are wired into admin suspend/terminate and credential changes.
- **Affiliate reuse:** Affiliate principals ARE shopper users — `requireShopper()` returns the identity the `AffiliateProfile` hangs off. The affiliate build adds a `requireAffiliate()` helper (own module, e.g. `src/lib/affiliate/auth.ts`) that calls `requireShopper()` then loads and status-checks the `AffiliateProfile`; `src/lib/auth.ts` itself needs no change.
- **Notes:** `ShopperUserDTO` exposes only `{id, email, fullName, phone}` — sufficient for affiliate hub use; display-name-only network views (privacy rule) are enforced at query level in new affiliate routes.

### 3.2 Products & catalogue — Class B

- **Evidence:** `prisma/schema.prisma` `Product` (lines 305+), `ProductVariant` (363+), `Category` (290+); `src/app/api/store/products/route.ts` and `[id]/route.ts`; admin moderation routes `src/app/api/admin/products/[id]/{approve,reject,ban}/route.ts`.
- **Behaviour:** Full CRUD with variants, stock, MOQ, category tree, moderation workflow.
- **Affiliate extension required:** new columns on `Product` (`affiliateEnabled Boolean @default(false)`, `affiliateRateBps Int?`) and a product-level rate resolution step. Nothing in existing product flows breaks; columns are additive.
- **Risk:** none identified. Backfill default is "off", so existing catalogues do not silently become commissionable.

### 3.3 Cart — Class A

- **Evidence:** `src/app/api/cart/route.ts`, `cart/items/**`, `cart/selection/route.ts`, `cart/cart.ts`; `CartItem.selected` buyer-controlled selection; `src/lib/analytics/track.ts` (`add_to_cart`/`remove_from_cart` with qty deltas).
- **Affiliate reuse:** unchanged. Self-purchase exclusion and per-item attribution resolution happen at **checkout create**, not in the cart (see `implementation-plan.md` Phase 3). Selection-aware carts mean affiliate-attributed and non-attributed lines can coexist in one checkout, which the per-`OrderItem` snapshot design already handles.

### 3.4 Checkout (Option B) — Class B

- **Evidence:** `src/app/api/checkout/create/route.ts` (single transaction: one `PaymentGroup` + N per-seller `Order`s, `idemKey` group-level unique, per-order `${idemKey}:${storeId}`); `src/app/api/checkout/pricing.ts` (`computeGroupPricing`, `assertShippingAvailable`); `src/lib/checkout-gate.ts` (`withCheckoutAdmission`, bounded FIFO semaphore, 503 `CHECKOUT_BUSY`); conditional stock decrement `updateMany({ where: { stock: { gte: qty } } })` (launch-rush oversell guard); voucher redemption atomic in the same tx.
- **Behaviour verified:** server recomputes ALL money; commission snapshots computed via `computeOrderCommissions` per seller group on voucher-adjusted totals and frozen onto `OrderItem` (`commissionPercent`, `commissionMinor`, `fixedFeeMinor`, `sellerNetMinor`, `breakdownJson`); marketing attribution resolved server-side from the `nm_ins_attr` cookie and frozen onto `Order.attr*` columns; 15-second tx timeout; order-of-writes is idempotent-replay → admission gate → validate → tx.
- **Affiliate extension required (Phase 3 + 4):**
  - resolve affiliate attribution **per item** (last eligible `AffiliateAttributionTouch` per product, 30-day window, server-validated from httpOnly visitor cookie — never a client-supplied affiliate id);
  - self-purchase exclusion (item whose attributed affiliate === buyer's own `AffiliateProfile` → no snapshot);
  - freeze affiliate snapshot columns onto each `OrderItem` (`affiliateRateBps`, `affiliatePoolMinor`, `affiliateLinkCode`, `affiliateId`, plus denial reason when excluded);
  - compute the affiliate pool alongside `computeOrderCommissions` so the seller-net figure written to `OrderItem.sellerNetMinor` is already net of the pool.
- **Conflict to manage:** the existing invariant `Σ sellerNet + Σ commission === orderTotal` (enforced in `src/lib/commission.ts` `reconcileSplits` and re-checked by the ledger at T1) becomes `Σ sellerNet + Σ commission + Σ affiliatePool === orderTotal` once the pool is carved from seller proceeds. This must be changed **once, deliberately**, in `computeOrderCommissions`/checkout and in `postOrderPaid` in the same release (see `commission-definitions.md` §6).

### 3.5 Payment webhooks — Class B

- **Evidence:** `src/app/api/webhooks/payments/process.ts` (`processPaymentWebhook`) shared by `POST /api/webhooks/payments/[provider]/route.ts` and the sandbox `POST /api/checkout/payments/[ref]/simulate`, `POST /api/webhooks/payments/payout-simulate`; `src/lib/secretbox.ts` (`safeEqual`); `src/lib/password.ts` (`hmacSha256Hex`).
- **Behaviour verified:** HMAC-SHA256 over `${providerRef}.${eventType}.${amountMinor}.${ts}` with `PSP_WEBHOOK_SECRET` resolved at call time and **fail-closed in production** (503 `WEBHOOK_SECRET_UNSET`); ±10-minute replay window (`WEBHOOK_TS_WINDOW_MS`); log-then-verify (`PaymentWebhookLog` row always written first, `signatureValid` includes freshness); sandbox-only providers rejected in production; success path is claim-first (`paymentGroup.updateMany({ where: { status: { notIn: ["succeeded","expired"] } } })`) inside a **Serializable** transaction with **bounded P2034 retry** (3 attempts, jittered 50–150 ms), `SET LOCAL statement_timeout = '10s'`, 15 s tx timeout; per-order `transitionOrder` to `paid` + T1 `postOrderPaid` per order; wallet-cache refresh moved post-commit; late payment after expiry → `recordLatePaymentObligation` + 409 `GROUP_EXPIRED` (money never enters the ledger); amount-mismatch refusal; `payment.failed` → group `failed`, no money moves.
- **Affiliate extension required (Phase 4):** T1 gains its 4th credit line to `PLATFORM:AFFILIATE_LIABILITY` (see `commission-definitions.md` §6). Because T1 is called per order inside the existing Serializable tx, the affiliate commission rows (`AffiliateCommission` + 2 `AffiliateCommissionEntry` rows max) must be created in the **same transaction**, keyed by `orderItemId` unique — the webhook is the only place money-confirmed state is created, so it is the only place commission `pending` rows may be born. No changes to signature/claim logic.

### 3.6 Order lifecycle — Class C

- **Evidence:** status machine driven exclusively through `transitionOrder` (`src/lib/api.ts`, writes `OrderStatusHistory`); buyer completion `POST /api/me/orders/[orderNumber]/receive` (shipped|delivered → completed); seller fulfil/ship/deliver routes `src/app/api/store/orders/[id]/{fulfill,ship,deliver}/route.ts`; `Shipment`/`ShipmentEvent` models with `providerId String @default("mock")`.
- **Partially implemented / gaps:**
  1. **Dead code:** `autoCompleteDeliveredOrders` (`src/lib/order-completion.ts`) has **zero callers** (verified by search) despite its header describing lazy wiring on order reads — the "auto-confirm 14 days after delivery" path is unreachable; completion only happens via the buyer's receive button.
  2. **Carrier delivery timestamps are mock:** `deliveredAt` derives from seller/courier events on the mock shipping rails (`/api/shipping/tick`, `/api/shipping/webhook/[provider]`); there is no trustworthy third-party carrier proof-of-delivery integration.
  3. **`holdReleaseRule: "days_after_delivered"` is stored but unimplemented** (`CommissionSetting.holdReleaseRule`, `prisma/schema.prisma` line 36): the webhook computes `holdUntil = paidAt + holdDays` unconditionally (`src/app/api/webhooks/payments/process.ts`, `seller.holdDaysOverride ?? settings.payoutHoldDays`) and never consults the rule or `graceDaysAfterDelivered`.
- **Affiliate impact:** the affiliate lifecycle definition `approved = delivered/completed` (see `commission-definitions.md` §5) must lean on the **order status** as the authoritative signal, not on carrier-verified delivery timestamps; the affiliate review window (`affiliate.review_days`) is measured from that authoritative transition. Any copy claiming carrier-verified delivery gating would be false. Fixing the dead auto-complete path is optional for affiliate launch (review window covers it), but should be tracked.

### 3.7 Refunds — Class B

- **Evidence:** `POST /api/admin/refunds/[id]/{approve,process,reject}/route.ts`; `Refund` model (`status requested → approved → processed | rejected`, `commissionReversalMinor`); `deriveCommissionReversal` (in-file) — **breakdown-proportional** against per-`OrderItem` snapshots with a cumulative cap (`Σ reversals ≤ Σ commissionMinor`) and order-row + wallet-row `FOR UPDATE` locks; T5 `postRefund` (dedupKey `refund:refund:{refundId}`); approve-then-process enforced.
- **Known gap (documented in the code itself):** the **fallback path for legacy rows without valid snapshots is first-fit** — first item with un-refunded capacity, `reversal = round(refundAmount × commissionPercent / 100)`, uncapped (route lines 99–106). Modern rows take the proportional path; the affiliate reversal math (Phase 5) must be proportional against the frozen affiliate snapshot columns with the same cumulative clamp, and must define behaviour for pre-affiliate rows (no affiliate columns → no affiliate reversal, which is naturally correct).
- **Affiliate extension required (Phase 5):** T5 gains an affiliate reversal debit line; `AffiliateCommission` rows transition to `reversed` (or partially reversed) proportionally; late-refund recovery entries offset future earnings. Refunds are order-level in this codebase — the affiliate reversal must allocate the order-level refund amount across items using the same proportional allocation family (`allocateProportionally`, `src/lib/money.ts`) to stay consistent with FIN-3a.

### 3.8 Seller wallet — Class A (as a pattern)

- **Evidence:** `Wallet` model (cache columns `pendingMinor`, `availableMinor`, `reservedMinor`, `lifetimeEarnedMinor`, `lifetimeCommissionMinor`); `walletTruth` / `refreshWalletCache` / `safeRefreshWalletCache` in `src/lib/ledger.ts` — ledger lines are the truth, the wallet row is a cache refreshed on write; credits with `availableAt > now` are pending.
- **Affiliate reuse:** the affiliate balance is **not** stored in `Wallet` (that table is seller-scoped, `sellerId @unique`). The affiliate build replicates the pattern against `PLATFORM:AFFILIATE_LIABILITY` lines: affiliate available/pending balances are derived (sum of credit − debit, `availableAt` gating), with an optional `AffiliateProfile`-level cache refreshed by the same on-write discipline. Copying the pattern, not the table, is the correct reuse.
- **Note:** `ShopperWallet` is a **dormant** buyer-finance scaffold (`src/lib/feature-flags.ts`, `NOMO_FINANCE_ENABLED = false`); it is NOT the affiliate balance mechanism and must not be reactivated for affiliate money (e-money licensing exposure is explicitly documented in that file).

### 3.9 Double-entry ledger — Class B

- **Evidence:** `src/lib/ledger.ts`. Accounts (`ACCOUNTS`): `PLATFORM:BANK_MAIN`, `PLATFORM:PAYOUT_CLEARING`, `PLATFORM:REVENUE_COMMISSION`, `PLATFORM:REVENUE_ADJUST`, `GATEWAY:{provider}`, `SELLER:{walletId}:PAYABLE`; `ACCOUNT_META` types asset/liability/revenue/expense; `postTransaction` with optional caller/recipe `dedupKey` (unique; P2002 → idempotent replay returns the ORIGINAL posting, `wasReplay()`); balanced-line enforcement; `runLedgerInvariants`.
- **Recipes verified:**
  - **T1 `postOrderPaid`** — 3 lines today: DR `GATEWAY:{p}` total / CR `SELLER:{walletId}:PAYABLE` sellerNet (with `availableAt = holdUntil`) / CR `REVENUE_COMMISSION` commission; dedupKey `order_paid:order:{orderId}`.
  - **T2 `postGatewaySettlement`** — exists with **zero callers by design** (dormant until a real PSP contract; `psp.split.auto_settle` default false, `AUTO_SETTLE_SETTING_KEY`).
  - **T3 `postPayoutInitiated`** / **T4 `postPayoutConfirmed`** / **T4f `postPayoutFailed`** — dedupKeys `payout_{initiated,confirmed,failed}:payout:{payoutId}`.
  - **T5 `postRefund`** — DR `SELLER:PAYABLE` + DR `REVENUE_COMMISSION` | CR `GATEWAY:{p}`; dedupKey `refund:refund:{refundId}`.
  - **T6 `postAdminAdjustment`** — deliberately NO dedupKey (corrections are legitimately repeatable).
- **Affiliate extension required (Phase 4/5):** new account `PLATFORM:AFFILIATE_LIABILITY` (liability) in `ACCOUNTS`/`ACCOUNT_META`; T1 gains a 4th CR line (pool) and its input contract gains `affiliatePoolMinor`; T5 gains a DR reversal line; new recipes T-A3/T-A4/T-A4f mirroring T3/T4/T4f for affiliate payouts. All new recipes follow the existing dedupKey discipline. The header comment "rate model under discussion" is historical; mechanics are stable.

### 3.10 Seller payouts — Class A (manual workflow)

- **Evidence:** seller request `POST /api/store/payouts` (`status "requested"`, `method "seller_request"`, one-open-request rule via Serializable tx + bounded P2034 retry, `payout.min_minor` setting, bank account required); admin ops `src/app/api/admin/payouts/[id]/{approve,mark-paid,fail,reject,sync}/route.ts` + `sweep`/`requests`/`due`; state machine `src/lib/payout-state.ts` (`assertTransition`: requested→processing|rejected, processing→paid|failed, failed→processing); `PayoutBatch` (runType manual); `auditAdmin` on every admin op; mark-paid requires a bank `referenceNo` and posts T4 inside the claim transaction.
- **Affiliate reuse:** this is the exact workflow shape the affiliate payout mirrors (request → admin approve → mark-paid with references). **There is NO automated PSP payout capability**: `psp.payouts.mode` is registered but `wired: false` (`src/lib/settings-registry.ts` lines 199–216; the dormant adapter scaffold is `src/lib/psp-adapter.ts`). Manual is the only real payout process — which matches the affiliate design (manual affiliate payout workflow). Affiliate payouts get their own `AffiliatePayout` rows + T-A3/T-A4/T-A4f recipes; they must NOT reuse the seller `Payout` table (different principal, different liability account).

### 3.11 Commission engine — Class B

- **Evidence:** `src/lib/commission.ts`. Resolution chain verified: **fee holiday → scoped `CommissionOverride` rows and direct field overrides interleaved by scope (product > category ancestor > seller) → global default**; field-wise first-match for `holdDays`/`fixedFeeMinor`; deterministic tie-break (earliest `createdAt`, then id). `computeOrderCommissions` at checkout create: proportional discount/shipping/tax allocation (`allocateProportionally`, remainder to largest line), `commission = round_half_up(base × percent/100) + allocated fixed fee`, `sellerNet = gross − commission`, min-commission floor per order, final `reconcileSplits` enforcing `Σ sellerNet + Σ commission === orderTotal`. Snapshots are stored per `OrderItem` and **never recomputed**. Rate sources recorded in `breakdownJson` (`rule_source`, `source_id`, `holiday_id`).
- **Affiliate reuse:** the affiliate pool rate resolution mirrors this shape but is **separate**: `Product.affiliateRateBps ?? Store.defaultRateBps` (seller-funded, capped by `affiliate.max_rate_bps`), resolved at checkout and frozen. The affiliate computation must run **inside** the existing `computeOrderCommissions` call site so the seller-net reduction happens in the same snapshot pass (one consistent set of frozen numbers per item).
- **Conflict to manage:** see §3.4 — the sellerNet+commission===total invariant changes to include the affiliate pool. Both the snapshot math and T1 must move together.

### 3.12 Analytics (Seller Insights) — Class B

- **Evidence:** `src/lib/analytics/identity.ts` (`nm_ins_vid` visitor cookie, 365 d, httpOnly; `nm_ins_sid` session cookie, 24 h life with 30-min inactivity window; **no IP, no UA, no fingerprinting, no PII**); `src/lib/analytics/queue.ts` (bounded in-memory queue, batch flush 250 rows, `createMany skipDuplicates`, dropped-count metrics); `src/lib/analytics/track.ts` (event types `store_view | product_view | view_cart | add_to_cart | remove_from_cart`, per-event dedup rules); `AnalyticsEvent` model (`dedupKey String @unique`, `visitorId`, `sessionId`, `campaignId`, `utm*`, `referrerHost ≤100 chars`); retention via `analytics.retention_days` purged by `POST /api/cron/analytics-tick`; landing beacon `POST /api/analytics/landing`.
- **Affiliate extension required (Phase 2/3):** new affiliate columns on `AnalyticsEvent` (e.g. `affiliateLinkCode`, `affiliateEventType` for click tracking) and a dedicated `AffiliateAttributionTouch` table for last-eligible-click-per-product resolution. The visitor cookie `nm_ins_vid` is the join key for server-side attribution — httpOnly server-side identity, exactly what §16 requires (no client-supplied affiliate ids in money paths).
- **Retention note:** attribution touches must align their retention with the analytics retention tick (see `rollout-checklist.md` §8); financial records (commissions, payouts, ledger) are retained indefinitely and are NOT covered by the analytics purge.

### 3.13 Campaign links — Class A (as pattern)

- **Evidence:** `SellerCampaign` model (`code String @unique` URL-safe short token, `slug` unique per store, `status active|archived`); `src/lib/analytics/attribution.ts` — `resolveCampaignToken` **fails closed** (campaign must exist, be active, and BELONG to the landing store — single query where the storeId clause IS the ownership check); `campaignLinkPath` builds `/?sf={slug}&utm_…&nmcl={code}`; cookie `nm_ins_attr` (30 d, non-sliding, httpOnly, validated UTMs only); `Order.attr*` frozen at checkout, never backfilled.
- **Affiliate reuse:** this is the direct precedent for `AffiliateLink` codes (`randomToken` from `src/lib/password.ts`, 16–24 bytes hex → unpredictable) and for the "resolve server-side, fail closed, freeze at checkout" discipline. Cross-store pollution prevention (token resolves only against its owning entity) carries over to affiliate link resolution.

### 3.14 Settings registry — Class A

- **Evidence:** `src/lib/settings-registry.ts` — pure-data `SETTING_GROUPS` (storefront, payouts, moderation, payments, ranking, analytics, system, advanced) + `SETTINGS_REGISTRY` with typed fields (`boolean|integer|enum|string|weights|string_list|readonly|json`), `wired`/`wiredNote` honesty badges, `danger` accents; auto-rendered by the admin System→Settings page (`src/components/admin/system.tsx`) against `GET/PUT /api/admin/settings` (superadmin-gated `settings.manage`).
- **Affiliate reuse:** add one group (`affiliate`) and the seven launch keys (`affiliate.enabled`, `affiliate.sponsor_enabled`, `affiliate.max_rate_bps`, `affiliate.min_payout_minor`, `affiliate.review_days`, `affiliate.attr_window_days`, `affiliate.sponsor_window_days`) plus a kill-switch key (or treat `affiliate.enabled=false` as the kill switch). The registry's honesty rule applies: a key may only ship `wired: true` when running code reads it — the kill switch must actually gate every affiliate route, not just render.

### 3.15 Admin capabilities (RBAC) — Class A

- **Evidence:** `src/lib/admin-caps.ts` (`ADMIN_CAPS` matrix, pure module imported by both server guards `requireCap`/`requireAnyCap` in `src/lib/auth.ts` and client nav gating `src/components/admin/use-admin-caps.ts` — UI == API by construction); `auditAdmin` (`src/lib/api.ts`) writes `AdminAuditLog` with before/after JSON.
- **Count discrepancy (spec vs code):** the affiliate brief states "14 capabilities"; **the matrix actually defines 13** (`sellers.approve`, `sellers.suspend`, `products.moderate`, `commission.manage`, `payouts.manage`, `refunds.manage`, `disputes.manage`, `settings.manage`, `impersonate`, `logs.view`, `logs.purge`, `campaigns.manage`, `reports.export`). Recorded here as an honest conflict; the affiliate build adds its own cap(s) (e.g. `affiliate.manage` → superadmin, finance) which will bring the total to 14.
- **Affiliate reuse:** new affiliate admin routes gate on the new capability; every mutation writes `auditAdmin` exactly like the payout routes do.

### 3.16 Rate limiting — Class E (unsafe to reuse without refactoring for affiliate purposes)

- **Evidence — TWO parallel modules with different contracts:**
  1. `src/lib/rate-limit.ts`: `rateLimit(req, bucket, limit, windowMs)` — **synchronous throw** `ApiError 429 RATE_LIMITED`; key = `bucket:clientIp`; in-memory fixed window by default, optional Redis shared store (`RATE_LIMIT_REDIS_URL`, shadow-counter convergence, degrade-to-memory on any failure; Redis path unproven in staging per its own header).
  2. `src/lib/ratelimit.ts`: `rateLimit(req, { limit, windowMs })` — returns `{ ok, retryAfterSec }`; key = `clientIp:path`; strictly single-process Map; used by financial mutation routes (e.g. payout mark-paid, 20/min).
- **Why unsafe for affiliate verbatim:** both key on **IP** only. Affiliate fraud controls require **per-account** buckets (activation 5/min, link create 30/min, payout request 3/min per affiliate), and several affiliate endpoints are hit by logged-in shoppers whose IP says nothing about the account (shared NAT/mobile carriers). Reusing either module as-is would let one abusive account rotate IPs freely, or punish a whole office behind one IP.
- **Refactor required (Phase 1/7):** one shared limiter module with a key function that takes `(bucket, principal)` where principal is `shopperId` when authenticated and IP otherwise; preserve the synchronous-throw contract at call sites. Unify the two modules or wrap them; do not add a third.

### 3.17 CSRF gate (proxy) — Class A

- **Evidence:** `src/proxy.ts` (Next.js 16 proxy convention; matcher `/api/*`). Rules in order: self-authenticated route prefixes exempt (HMAC webhook, cron secret, single-use claim token, system ticks — `/api/webhooks/payments/`, `/api/shipping/webhook/`, `/api/cron/`, `/api/checkout/payments/`, `/api/claim/bind`, `/api/shipping/tick`, `/api/orders/expiry/tick`); Bearer header → allow; `X-SM-Client: web` marker → allow (preflight-gated; attached by `src/lib/session-client.ts` `authHeaders()`/`deviceHeaders()` on every app fetch, pre-auth included); `Sec-Fetch-Site` same-origin/same-site/none → allow, `cross-site` → 403; Origin host match; JSON-only bodies (415); non-browser clients allowed.
- **Affiliate reuse:** every new affiliate route inherits the gate automatically as long as the SPA calls them through the shared client (`authHeaders()`/`deviceHeaders()`). Public affiliate link/collection/showcase GETs are safe methods and pass anyway. **Rule for the affiliate build:** affiliate link redirect/track endpoints that are hit by *external* browsers navigating (top-level GET navigations) are fine (safe method); any affiliate POST from third-party pages must be designed as a beacon to an exempt self-authenticated route or rejected by design. No changes needed to `proxy.ts`.

### 3.18 Shells & navigation (single-route SPA) — Class A

- **Evidence:** `src/app/page.tsx` → `src/components/app-root.tsx` (single route; surface switching shopper/seller/admin). Shopper surface: `ShopperView` union in `src/components/shopper/ui-bits.tsx` (`market | category | search | storefront | pdp | checkout | pay | order-status | orders | lookup | messages | store-page | generate | me`); deep links `?sf={storeSlug}` / `?sf=&sp={productSlug}` (SEO + campaign links) and `?claim_job=…&claim_token=…` (claim landing) handled in `src/components/shopper/shopper-shell.tsx`; me-hub `src/components/shopper/me-hub.tsx`. Seller surface: `SellerViewName` in `src/components/seller/ui-bits.tsx` (13 views; tab discriminators on `SellerNav`). Admin surface: `NAV_GROUPS` in `src/components/admin/admin-shell.tsx` with per-item `caps` gating.
- **Affiliate reuse:** add union members/views rather than routes — an affiliate hub view (shopper), a seller "Affiliate" section (seller centre), and an admin affiliate nav group (capped). Public showcase pages extend the existing deep-link pattern (`?af=`-style param or a dedicated public view). No router changes.

### 3.19 Cron / scheduler — Class A

- **Evidence:** `mini-services/expiry-scheduler/` (port **3005**; always-on tick service POSTing `/api/cron/expiry-sweep`, `/api/cron/refund-reconcile`, `/api/cron/analytics-tick` with `x-cron-secret`; durable state file; throttled alerts; production equivalent is any platform cron with the same contract); `mini-services/chat-service/` (port **3003**, socket.io hub); `src/lib/cron-auth.ts` (`assertCronAuth` — fails closed in production without `CRON_SECRET`, timing-safe compare); durable observability via `Setting` keys (`cron.expiry_sweep.last`, `cron.analytics.last`).
- **Affiliate reuse:** the affiliate review-window sweep (pending → available when `review_days` elapse), attribution-touch retention, and payout reconciliation checks ride the same scheduler pattern: new `/api/cron/affiliate-tick` endpoint (cron-secret auth, idempotent, claim-first where it transitions rows) + one line added to the scheduler's route list. The sandbox scheduler IS the deployment's proof; production swaps in platform cron with the identical contract.

### 3.20 Feature flags — Class C

- **Evidence:** `FeatureFlag` model exists (`key`, `isEnabled`, `rolloutPercent`) but the only actual gate in code is the hardcoded const `NOMO_FINANCE_ENABLED = false` in `src/lib/feature-flags.ts`; nothing reads the `FeatureFlag` table on a hot path.
- **Affiliate decision:** the programme kill switch is specified as a **Setting** (`affiliate.enabled`, runtime-changeable via the settings registry by superadmin, audited) rather than a code flag or the dormant `FeatureFlag` table — a deploy-time flag cannot be flipped during a fraud incident. `FeatureFlag` remains unused by the affiliate build. Classified C because the subsystem as shipped (table + one const) is not a usable runtime mechanism.

### 3.21 COD / offline payment rails — Class F/D

- **Evidence:** `src/lib/payment-methods.ts` — the single source of truth for buyer-selectable methods lists exactly five online methods (`fpx_toyyibpay`, `fpx_curlec`, `tng`, `grabpay`, `card_stripe`). **COD is not supported anywhere.**
- **Impact:** affiliate commissions on COD orders are out of scope by construction (no COD orders exist). If COD ever ships, the affiliate pool carve (which assumes PSP-captured payment and the T1 mirror) needs a redesign for cash-on-delivery — a business decision that does not exist today. Class F for "COD commissions", D for "COD rails".

### 3.22 Sponsor override enablement — Class F

- The technical design (sponsor FK immutable post-activation, first-touch registration attribution, 90/10 split, held sponsor share) is buildable, but **enabling the sponsor override in production is blocked** on legal review under the Direct Sales and Anti-Pyramid Scheme Act 1993 and KPDN clarification (`rollout-checklist.md` §1). The build ships with `affiliate.sponsor_enabled = false`; the split degrades to `D = P` (direct affiliate receives 100%) with no redistribution. Single-generation-only, no recruitment bonuses, no click rewards are hard structural constraints of the design (see `security-and-fraud-rules.md` §3).

---

## 4. Known gaps (verified in code) and their affiliate consequences

1. **COD not supported** — §3.21. No affiliate impact today; documented so no doc claims COD commission handling.
2. **No trustworthy carrier delivery timestamps beyond seller/courier mock events** — §3.6. Affiliate `approved` transitions use order status (`delivered`/`completed` via `transitionOrder`) as the authoritative signal; the review window absorbs residual dispute risk. Do NOT gate affiliate approval on `Shipment.deliveredAt` alone.
3. **Automated PSP payout capability ABSENT (manual only)** — §3.10. The affiliate payout workflow is manual by design and mirrors the seller manual runbook; nothing may assume a PSP transfer API exists. `psp.payouts.mode` remains `wired: false`.
4. **Item-level refund allocation is first-fit on the legacy fallback** — §3.7. New affiliate reversal math is proportional against frozen affiliate snapshots with cumulative clamps; rows predating the affiliate feature have no affiliate columns and therefore zero affiliate reversal (correct default).
5. **`holdReleaseRule: days_after_delivered` stored but unimplemented** — §3.6. The seller hold remains days-after-paid. The affiliate review window is specified independently (`affiliate.review_days`, measured from the approved transition) and must not silently inherit the seller hold rule; a future fix to the seller rule must not change already-frozen affiliate semantics.
6. **Dead code: `autoCompleteDeliveredOrders`, `maybeRunExpirySweepLazy`** — §3.6 and below. Both have zero callers. The affiliate build must not cite auto-completion as a completion guarantee; if the dead code is ever wired, affiliate approval semantics (delivered/completed) remain unchanged because they key on order status.
7. **Expiry tick path leaves `PaymentGroup` in `requires_payment` (late-payment guard divergence)** — two expiry mechanisms exist:
   - `POST /api/cron/expiry-sweep` (`src/app/api/cron/expiry-sweep/route.ts`): claims the **group** `requires_payment → expired`, orders `payment_pending → payment_expired`, restocks.
   - `POST /api/orders/expiry/tick` (`src/app/api/orders/expiry/tick/route.ts` → `src/lib/expiry-sweep.ts` → `releaseOrderReservation` in `src/lib/inventory-release.ts`): claims only the **order** `payment_pending → cancelled` + restock; the **group is never touched and stays `requires_payment`**, with a *different* terminal order status (`cancelled` vs `payment_expired`).
   
   Consequence: a late `payment.succeeded` webhook for a tick-expired group does **not** hit the `group.status === "expired"` refusal (process.ts line 215) — it enters the success path, wins the group claim (`notIn ["succeeded","expired"]`), and then attempts `transitionOrder` from `cancelled`, whose outcome depends on the status guard rather than the documented GROUP_EXPIRED policy. For affiliates this matters only insofar as commissions are created inside that success transaction: the affiliate build must rely on the **webhook's order-status result** (post-transition state actually `paid`), which it does by construction (commission rows are created for orders transitioned within the same tx). Recommendation (non-affiliate, pre-existing): converge the two expiry paths before launch; tracked in `rollout-checklist.md` §9.
8. **`ShopperWallet` dormant** — §3.8. The affiliate balance lives in the ledger (`PLATFORM:AFFILIATE_LIABILITY`), never in the dormant buyer wallet scaffold; reactivating that scaffold carries documented e-money licensing exposure (FSA 2013/BNM) and is explicitly out of scope.

---

## 5. Spec-vs-code conflicts stated honestly

- **"14 admin capabilities"** — the matrix has **13** (`src/lib/admin-caps.ts`). The affiliate cap will make it 14. See §3.15.
- **Rate limiting "rate-limit(req,bucket,limit) sync throw 429"** — true for `src/lib/rate-limit.ts`, but a second limiter with a different contract exists (`src/lib/ratelimit.ts`) and is what the financial routes actually call. Both are IP-keyed; neither satisfies the affiliate per-account requirement without refactor. See §3.16.
- **Settlement (T2)** — implemented but deliberately dormant with zero callers; any statement that PSP settlement is automatic is false today. Affiliate ledger extension must not assume T2 runs.
- **`maybeRunExpirySweepLazy` / `autoCompleteDeliveredOrders`** — present in `src/lib/expiry-sweep.ts` / `src/lib/order-completion.ts` with descriptive headers implying wiring, but **zero call sites**. Their comments overstate reality; audit treats them as dead.
- **Commission rate model** — `src/lib/ledger.ts` header still says the rate model is "under discussion"; `CommissionSetting.defaultPercent` defaults to 8.0 and is admin-configurable. The affiliate pool rate is a **separate, seller-funded** rate chain and does not touch the platform commission rate.
- **Affiliate system itself** — **does not exist yet** (no `AffiliateProfile`, no affiliate routes, no affiliate columns anywhere in `prisma/schema.prisma`). Everything in the companion `implementation-plan.md` is to-be-built; nothing here claims otherwise.

---

## 6. Reuse summary for the build

**Call directly, unchanged:** sessions (`src/lib/auth.ts`), CSRF gate (`src/proxy.ts`), settings registry (`src/lib/settings-registry.ts` + admin System→Settings), admin RBAC (`requireCap` + `auditAdmin`), cron auth + scheduler pattern (`src/lib/cron-auth.ts`, `mini-services/expiry-scheduler`), money helpers (`src/lib/money.ts`), `randomToken` (`src/lib/password.ts`), analytics identity cookies (`src/lib/analytics/identity.ts`), SPA shells/deep-links.

**Extend deliberately (schema + code, additive):** `Product`/`Store` affiliate columns, `AnalyticsEvent` affiliate columns, `OrderItem` affiliate snapshot columns, checkout create (attribution + self-purchase exclusion + pool snapshot), webhook process (T1 4th line + commission row creation), T5 refund reversal, settings registry affiliate group + keys, admin nav.

**Copy as pattern, do not share tables:** seller wallet cache discipline → affiliate balance derivation; seller payout manual workflow → `AffiliatePayout`; `SellerCampaign` link codes + fail-closed token resolution → `AffiliateLink`.

**Refactor before reuse:** rate limiting (per-account keying, unify the two modules).

**Do not touch / do not assume:** `ShopperWallet` (dormant), `FeatureFlag` table (unused at runtime), T2 (dormant), COD (absent), carrier delivery proof (mock), automated PSP payouts (absent).

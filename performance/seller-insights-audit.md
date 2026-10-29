# Seller Store Insights + Sales & Market Insights — Codebase Audit

Date: 2026-10-28 · Mission trace: 1a182c544c761a81 · Method: 4 parallel read-only audit agents (auth/store, storefront/cart, checkout/payment/finance, analytics/db/UI) + main-agent verification of schema/git/scripts. **No code was modified during this audit.** Labels: verified facts only; NOT FOUND marks absence in the tree.

---

## 1. Architecture (verified)

- **Single-route SPA.** `src/app/page.tsx` → `AppRoot` (`src/components/app-root.tsx`) switches three client surfaces (shopper / seller / admin) via zustand (`src/lib/app-store.ts`, persisted `localStorage["sm_surface"]`). There are **no** `/seller/*` page routes; deep links are query params (`/?sf={storeSlug}`, `&sp={productSlug}`).
- **Seller backend** = client views in `src/components/seller/*` + API family **`/api/store/*`** (there is no `/api/seller/*`). Every route: `export const dynamic = "force-dynamic"` + `handle()` wrapper (`src/lib/api.ts`), envelope `ok()/okPaged()`, errors `ApiError(status, code, msg)`.
- **Auth** = custom DB-backed sessions (`src/lib/auth.ts`): cookie `sm_session` (httpOnly, SameSite=None, Secure, 7d) or `Authorization: Bearer`. `Session.userType ∈ admin|seller|shopper`.
- **Authorization guard for all seller routes**: `requireActiveSellerStore()` — resolves store from the session's sellerId (never from client input), 400 `NO_STORE` if none. Nested ownership via scoped where-clauses (`where: { …, storeId: store.id }`) or `ownProduct()` (404 on mismatch). One seller ↔ one store (`Store.sellerId @unique`).

## 2. Data available for insights (verified)

| Domain | Facts |
|---|---|
| Orders | `Order` (store-scoped, one Order **per seller** per multi-seller checkout; `paymentGroupId` groups them). Statuses: `payment_pending, paid, processing, shipped, delivered, completed, cancelled, refunding, partially_refunded, refunded, closed`. `PAID_ORDER_STATUSES = [paid, processing, shipped, delivered, completed]` (`src/lib/membership.ts`). Timestamps: `paidAt, fulfilledAt, shippedAt, deliveredAt, completedAt, cancelledAt`. `channel` default `storefront`. `currency` MYR. `shippingAddressJson` = frozen `{line1, city, state, postcode}` (no country). |
| Order items | `OrderItem`: `productId?, variantId?, title, qty, unitPriceMinor, lineSubtotalMinor, discountMinor, shippingMinor, commissionPercent, commissionMinor, fixedFeeMinor, sellerNetMinor, refundedMinor, breakdownJson`. **No sellerId** — attribution = `OrderItem → Order.storeId`. Commission snapshots persisted at checkout, never recomputed. Invariant: Σ sellerNet + Σ commission = Order.totalMinor (FIN-1). |
| Payments | `PaymentGroup` (ref, status `requires_payment|succeeded|failed|expired`, `idemKey` unique, `expiresAt` 30 min) + N Orders per group. Authoritative success = `processPaymentWebhook()` (`src/app/api/webhooks/payments/process.ts`): claim-first Serializable tx, dedup via conditional `updateMany`, ledger T1 `postOrderPaid` (dedupKey `order_paid:order:{orderId}`), cart clearing of purchased variants. |
| Refunds | `Refund` (`requested|approved|rejected|processed`, amountMinor, restock, commissionReversalMinor) — money moves only in `/api/admin/refunds/[id]/process` (T5 `postRefund`, dedupKey per refund row). Late-payment refunds live in `PaymentReconciliation` (separate rail, never touches Order). `OrderItem.refundedMinor` accrues money-level; `qty` never mutated. |
| Carts | **Account-scoped only** (guest carts removed): `Cart.shopperId @unique` (≤1 cart/shopper), `token` legacy. **No status, no expiresAt, no deletedAt** — a cart is "active" by existing. `CartItem`: `cartId, variantId, qty (1–99), selected` — unchecked items survive checkout; purchased variants are deleted on verified payment success. Cart clearing only via webhook (`process.ts:335–345` group path / `:534–543` legacy). |
| Products | `Product.storeId`, statuses `draft|pending_review|active|rejected|banned|archived` (archived = soft delete). `ProductVariant`: `priceMinor, stock, moq, isActive` (soft delete). `salesCount` incremented at checkout-create. Money = **integer minor units** (`src/lib/money.ts`), percent commission (Float), single currency MYR everywhere. |
| Traffic | **NOT FOUND** — no page-view/visitor/referrer tracking exists. `UserActivity` is a recency-dedup table (`@@unique(userId,productId,activityType)`, values LIKE|VIEWED, account-scoped only — guests invisible, counts impossible). `ActivityLog` = ops audit (no indexes). `src/lib/metrics.ts` = load-test latency instrumentation (currently unwired; `/api/metrics` broken — imports non-existent `prismaBase`). |

## 3. Instrumentation hook points (verified exact locations)

| Event | Insertion point | Notes |
|---|---|---|
| `store_view` | `src/app/api/sf/[slug]/route.ts` after the `store.status === "live"` gate | Client re-fetches on nav → dedup per session/window required |
| `product_view` | `src/app/api/sf/[slug]/products/[pSlug]/route.ts` after the `product.status === "active"` gate | Related products ride the payload but are not separate views; the products **list** route must NOT count as views |
| `add_to_cart` | `src/app/api/cart/items/route.ts` after `cartItem.create/update` (lines ~46/59) | qty delta = post−pre (merge semantics; MOQ capping; stock caps) |
| `remove_from_cart` | `src/app/api/cart/items/[id]/route.ts` DELETE + PATCH qty→0 | qty = removed item qty |
| `view_cart` | `GET /api/cart` when cart has items | dedup per cart per minute |
| `begin_checkout` | **Derived from `Order.createdAt`** (authoritative — no event row) | order idemKey unique prevents duplicates |
| `purchase` | **Derived from `Order.paidAt` + `PAID_ORDER_STATUSES`** (authoritative) | webhook dedup already proven (exactly-once) |
| `refund` | **Derived from `Refund.status='processed'` + `PaymentReconciliation`** (authoritative) | never client-reported |

## 4. Gaps / constraints (verified)

1. **No anonymous identity mechanism**: `sm_shopper_id` cookie/`ensureOwnerToken()` is legacy; cart tokens dead. New pseudonymous cookies required (visitor + session).
2. **No country on orders**: only Malaysian `state` inside frozen `shippingAddressJson`; postcode `/^\d{5}$/` validated at checkout; `MY_STATES` UI. `Seller.countryCode` exists (seller attribution, not buyer geo). **Billing country: NOT RECORDED.**
3. **Missing indexes** on every table insights will aggregate: `Order` has none on `storeId`/`paidAt`/`createdAt`; `OrderItem`/`CartItem`/`ProductVariant`/`OrderStatusHistory` have **zero indexes**.
4. **No caching/rollups**: all routes `force-dynamic`; house pattern = in-process `globalThis` TTL cache (60s precedent in `/api/health`, `?fresh=1` bypass). No event bus/queue (webhook fan-out and imports run inline).
5. **Connection budget (binding)**: Prisma pool 10 (Supavisor session ceiling 15/user); ops scripts run with `connection_limit=2`, serially. Analytics must not add pressure: batched single-`createMany` flush, bounded queries, TTL cache.
6. **Checkout protection (must not touch)**: `withCheckoutAdmission` gate wraps `/api/checkout/create` (8/32/5s); Serializable claim-first payment tx + P2034 retry (`tx-retry.ts`); expiry-sweep/refund-reconcile ticks. Analytics collection must stay **off** these paths (never awaited inside them).
7. **Migration process**: `bun run db:push` (`prisma db push --accept-data-loss`) is the established workflow (worklog precedent: additive changes + row-count snapshots + `prisma generate`). `prisma/migrations` holds only `0_init` baseline.
8. **Scheduler pattern available**: `mini-services/expiry-scheduler` (port 3005, 30s tick, durable `state.json`, cron-auth `x-cron-secret` timing-safe, fail-closed in prod) — generic over endpoints; a third analytics tick endpoint can ride it with **0 new persistent DB connections**.
9. **UI**: recharts 2.15.4 installed; admin `dashboard.tsx`/`reports.tsx` chart idioms (teal `#0d9488`/amber `#a16207`, `CHART_MARGIN`, `formatMinor`); seller surface has **zero charts** today; `StatCard/CardsSkeleton/RowsSkeleton/useApi/apiSend/runMutation` in `seller/ui-bits.tsx`; shadcn `calendar.tsx` exists but is unused (no date-range filter anywhere yet). CSV export conventions in `/api/admin/export` + `lib/commission-export.ts`.
10. **Settings registry** (`src/lib/settings-registry.ts`): pure-data registry with friendly fields + `wired` honesty badges — retention config belongs there.
11. **Pre-existing defect found**: `/api/me/recommendations/route.ts:31` reads `UserActivity` **without a `userId` filter** (personalisation seeds are global). To fix during instrumentation work (one-line where clause) with regression tests.
12. **Prior-session scope check**: ADDENDUM #6 (Admin Settings friendly form + Activity Log purge w/ password re-verify) is already implemented in the tree — verified, not re-done.

## 5. Data-volume reality

343 orders / 368 paymentGroups at audit time (Phase-1 verification). Event volume projection: low (sandbox marketplace). **Decision (documented):** direct bounded queries on a new event table + TTL cache; **daily rollup tables deferred** until volume justifies (design note + threshold documented in metric-definitions.md). Retention purge rides the scheduler tick.

## 6. Proposed implementation (consolidated — see agent-ctx/SI-PLAN.md)

1. **Schema (additive)**: `AnalyticsEvent` (append-only, `dedupKey @unique`, storeId/productId?/variantId?/shopperId?/visitorId?/sessionId?/qty?/referrerHost?/channel?, indexes `[storeId,eventType,createdAt]`,`[storeId,createdAt]`) + `Order.shippingCountryCode`/`shippingCountrySource` + missing FK/date indexes (`Order(storeId,paidAt)`, `Order(paidAt)`, `OrderItem(orderId)`, `ProductVariant(productId)`, `CartItem(cartId)`).
2. **Collection**: `src/lib/analytics/` — pseudonymous identity (visitor cookie 365d + session cookie 30-min sliding window, SameSite=None+Secure to match app posture), bounded in-memory queue (≤500, drop-oldest counted) flushing via single `createMany skipDuplicates` every 2s (unref'd timer), fire-and-forget `track*()` helpers that never throw. Referrer = host-only + channel classification (direct/search/social/internal/other).
3. **Instrumentation**: the hook points in §3 (sf routes, cart routes); checkout-create writes `shippingCountryCode='MY'` (source `checkout`) into the frozen snapshot; backfill script sets historical orders per the postcode+state rule (source `backfill`, else `ZZ`).
4. **Queries + APIs**: `/api/store/insights/{overview,cart,products,sales,markets,markets/products,export}` — all `requireActiveSellerStore()`, rate-limited (`rateLimit()` throwing), 45s TTL cache keyed by store+window, `?fresh=1` bypass, `lastUpdated` + freshness metadata in every response.
5. **UI**: seller view `insights` (NAV entry) with tabs Overview / Cart activity / Products / Sales / Markets, date filters (today/7d/30d/custom) + previous-period comparison, recharts trends + funnel bars, sortable product table, country/state market tables, CSV export, empty/loading/error states, "how it's calculated" explanations, observations only when measurements support them.
6. **Ops**: `/api/cron/analytics-tick` (cron-auth, retention purge + `cron.analytics.last` setting) registered as third endpoint in expiry-scheduler.
7. **Tests**: `scripts/readiness/seller-insights.ts` ([LT] fixtures, own `connection_limit=2` client) + re-run finance-regression + deployment-smoke + browser golden path.

## 7. Honest limitations to carry into delivery

- Traffic metrics (visits/visitors/views) begin accruing **only after release**; no historical traffic exists anywhere. Empty states + "data collection started" messaging required.
- Unique visitors are **estimates** based on a first-party cookie (no login required); cookie deletion resets identity. Sessions = 30-min inactivity windows (documented definition).
- Sales-by-country: single-country platform (MY) — the country table will show Malaysia (+Unspecified for legacy rows failing the backfill rule); the **recorded destination state/region** is the genuinely useful geo dimension and is exposed alongside. Billing-country dimension: not available (not recorded). No IP-based inference, no currency conversion (MYR only, verified).
- Refund metrics cover the `Refund` rail (processed) and late-payment reconciliation rail; shipping-specific refunds are not distinguished in the data model (documented).
- Attribution of traffic channels: referrer-host classification is heuristic, last-touch on the view event; no ad-platform integrations (out of scope per spec).

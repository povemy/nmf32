# Seller Insights — Implementation Report

Mission: Seller Store Insights + Sales & Market Insights (unified spec + addendum), trace 1a182c544c761a81.
Date: 2026-10-28. All test evidence below was EXECUTED against the live dev deployment (dev-mode label per house policy; production build = NOT TESTED in this sandbox, unchanged from prior verdicts).

## 1. What was found in the existing code (audit)

See `performance/seller-insights-audit.md` (4 parallel read-only agents). Headlines: single-route SPA; seller APIs at `/api/store/*` behind `requireActiveSellerStore()`; **no analytics infrastructure existed** (UserActivity = per-user recency table, ActivityLog = ops audit); carts are account-scoped with no status/expiry; purchase truth = `Order.paidAt`/`OrderItem` snapshots; **no country field on orders** (MY-only platform with state inside the frozen `shippingAddressJson`); single currency MYR; established `db:push` migration flow; globalThis TTL-cache + mini-service scheduler patterns; recharts available but unused on the seller surface. A pre-existing defect was found (`/api/me/recommendations` read UserActivity without a `userId` filter).

## 2. What was implemented

**Schema (additive, via `bun run db:push`, row counts verified unchanged: order 1051, orderItem 1071, cart 106, cartItem 103, productVariant 5106):**
- New `AnalyticsEvent` model (append-only event log, `dedupKey @unique`, indexes `[storeId,eventType,createdAt]`, `[storeId,createdAt]`).
- `Order.shippingCountryCode` / `Order.shippingCountrySource` (checkout-time snapshot).
- New indexes: `Order(storeId,paidAt)`, `Order(paidAt)`, `OrderItem(orderId)`, `OrderItem(productId)`, `ProductVariant(productId)`, `CartItem(cartId)`, `CartItem(variantId)`.
- Historical backfill executed: 1051/1051 orders → `MY`/`backfill` (all had valid MY postcode+state; 0 `ZZ`), idempotent script `scripts/backfill-order-country.ts`.

**Collection (`src/lib/analytics/`):**
- `identity.ts` — pseudonymous cookies `nm_ins_vid` (365 d) + `nm_ins_sid` (30-min inactivity session window); httpOnly/SameSite=None/Secure; no IP/UA/PII.
- `referrer.ts` — host-only referrer classification (direct/search/social/internal/other).
- `queue.ts` — bounded (500) drop-oldest queue, single `createMany skipDuplicates` flush every 2 s, never throws into host requests.
- `track.ts` — event rules per metric-definitions.md §2.
- Instrumented: `/api/sf/[slug]` (store_view), `/api/sf/[slug]/products/[pSlug]` (product_view), `GET /api/cart` (view_cart, per store), `POST /api/cart/items` (add_to_cart with applied delta), `DELETE`/`PATCH qty→0` `/api/cart/items/[id]` (remove_from_cart). `purchase`/`begin_checkout`/`refund` are derived from authoritative records only.
- `/api/checkout/create` writes the MY country snapshot (source `checkout`).
- `/api/cron/analytics-tick` (cron-auth, retention purge in bounded batches, `cron.analytics.last` Setting) — registered as the third endpoint of `mini-services/expiry-scheduler` (0 new persistent DB connections).
- Settings registry: new `analytics` group + `analytics.retention_days` (7–730, default 180, wired).
- Fixed pre-existing defect: `/api/me/recommendations` now scopes UserActivity to the authenticated shopper.

**Queries + APIs (`src/lib/analytics/queries.ts` + 7 routes, all seller-session-scoped, rate-limited, 45 s TTL cache with `fresh=1` bypass, zod-free param validation per house style):**
`/api/store/insights/{overview, cart, products, sales, markets, markets/products, export}` — covering traffic, funnel, cart activity + live snapshot, product performance (sortable/paged), sales trends (day/week/month) + fulfilment, markets by country/state with growth/movers + per-market products, CSV exports (seller-scoped, audited).

**UI:** `src/components/seller/insights.tsx` (1 919 lines) + NAV wiring (`seller-shell.tsx`, `ui-bits.tsx`) — 5 tabs (Overview / Cart activity / Products / Sales / Markets), Today/7 d/30 d/Custom window filter with previous-period deltas ("New" badges when previous = 0), recharts traffic + sales trends (teal/amber house idioms), conversion funnel bars, sortable product table with pagination, markets tables with dimension toggle + drill-down Dialog, CSV export buttons, empty/loading/error states, "How it's calculated" honesty notes, observations rendered only when server-gated evidence exists.

## 3. How displayed metrics are calculated / real vs post-release data

Full definitions: `docs/seller-insights/metric-definitions.md`. Summary of data provenance:
- **Real historical data (complete):** paid orders, units, gross/discount/shipping/net sales, seller proceeds, AOV, refunds, cancelled counts, markets by country/state, fulfilment metrics — all from authoritative Order/OrderItem/Refund records.
- **Post-release-only data (from 2026-10-28):** all traffic metrics (store views, visits, unique visitors — an estimate via first-party cookie, product views, channels), view_cart, and view→cart conversion. Empty states + "tracking started fresh" callouts make this explicit in the UI.
- Visitor counts are approximate (cookie identity, 30-min session window); consent: platform has no consent banner — functional first-party cookies only; documented for future gating.

## 4. Tests actually executed (results)

| Suite | Result | Archive |
|---|---|---|
| `scripts/readiness/seller-insights.ts` (NEW — 56 checks: auth negatives incl. seller-A↔B isolation, dedup, referrer, cart deltas/removals, view_cart, multi-vendor attribution, live-snapshot-excludes-purchased, authoritative sales/funnel, duplicate-webhook no-double-count, country snapshot+backfill honesty, window/prev-period math incl. 400 rejections, CSV export + auth, refund reflection, rate limiting) | **ALL PASS (56/56)** after fixing a real defect found by the suite (shared rate-limit bucket mixed limits — export now uses its own bucket) | `performance/runs/2026-10-28-seller-insights.json` |
| `finance-regression.ts` | **37 PASS / 0 FAIL** | `performance/runs/2026-10-28-finance-regression.json` |
| `deployment-smoke.ts` (`SMOKE_TARGET_CONFIRM=dev-sandbox-local`) | **ALL PASS (23/23)** | `performance/runs/2026-10-28-deployment-smoke.json` |
| `remediation-live-tests.ts` | First run: F1-c FAIL (14/15 dup-ok, one raw P2034 under storm — money stayed exactly-once; the pre-existing documented contention flake). Re-run: **ALL PASS (25/25)**, F1-c 15/15, postings 341→341 | console log (suite does not archive) |
| Lint (`bun run lint`) | 0 errors / 14 pre-existing k6 warnings (none in new code) | — |
| Browser (agent-browser) | Seller Insights UI verified: all 5 tabs, window switching refetches with new params, Markets drill-down Dialog, Products sorting/pagination, CSV export, mobile 390 px + desktop 1280 px, **zero console errors on clean reload**; golden path: real browser storefront visit + PDP → Insights showed 2 visits / 1 product view / correct funnel + authoritative sales (RM 174) | screenshots `tool-results/si-*.png` |
| VLM review of dashboard screenshot | "professional and polished … no obvious visual glitches … data highly readable" | — |

**Performance impact:** collection adds zero DB work to the request path (enqueue is in-memory; the flush is one batched `createMany` per ~2 s); the checkout-create addition is two constant string columns; dashboard queries are indexed + cached 45 s + rate-limited (60/min). The checkout admission gate, Serializable payment confirmation, expiry sweep and refund-reconcile paths were untouched (remediation-live + finance-regression + deployment-smoke green). Full-table pressure was reduced relative to before (new `Order(storeId,paidAt)`/`Order(paidAt)`/`OrderItem(orderId)` indexes also serve the pre-existing dashboard queries).

## 5. Remaining limitations (honest)

1. Traffic history begins at release; no backfilled visitor data exists (by design — none was ever collected).
2. Unique visitors/sessions are cookie-based estimates; no consent banner exists yet — if one is introduced, collection must be gated.
3. Single-currency MYR only (verified); no exchange-rate model — nothing to convert, nothing invented.
4. Country dimension is checkout-snapshot `MY` + labelled backfill for history; **billing country is not recorded anywhere** — dimension unavailable, disclosed in UI + API notes. State is the genuinely recorded geo datum.
5. Refunds are order-level money on their own processed date (may relate to orders paid earlier); shipping-only refunds and per-item refund units are not separable in the current model; late-payment reconciliation refunds (expired-group rail) are not attributed to orders/geography.
6. Referrer attribution is last-touch, host-heuristic; no ad-platform or campaign attribution (out of scope per spec).
7. Daily rollup tables intentionally NOT built (event volume does not justify them — direct indexed queries + 45 s cache; revisit when event volume grows, documented in the audit §5).
8. Delivery-time metrics not shown (no trustworthy carrier delivery timestamps).
9. Automated abandoned-cart emails / marketing automation deliberately excluded (spec).

## 6. Changed files

Schema/migrations: `prisma/schema.prisma`.
Analytics lib: `src/lib/analytics/{identity,referrer,queue,track,queries}.ts`.
Instrumented routes: `src/app/api/sf/[slug]/route.ts`, `src/app/api/sf/[slug]/products/[pSlug]/route.ts`, `src/app/api/cart/route.ts`, `src/app/api/cart/items/route.ts`, `src/app/api/cart/items/[id]/route.ts`, `src/app/api/checkout/create/route.ts`, `src/app/api/me/recommendations/route.ts` (defect fix).
New APIs: `src/app/api/store/insights/**` (7 routes), `src/app/api/cron/analytics-tick/route.ts`.
Ops: `src/lib/settings-registry.ts`, `mini-services/expiry-scheduler/index.ts`, `scripts/backfill-order-country.ts`.
UI: `src/components/seller/insights.tsx` (new), `src/components/seller/seller-shell.tsx`, `src/components/seller/ui-bits.tsx`.
Tests: `scripts/readiness/seller-insights.ts` (new).
Docs: `performance/seller-insights-audit.md`, `docs/seller-insights/metric-definitions.md`, this report, `agent-ctx/RX-CHECKLIST.md` (ADDENDUM #7), `agent-ctx/SI-PLAN.md`, `worklog.md`.

Deployment steps for staging/production: (1) apply schema via the established `db:push` flow (or generate a migration from the diff in a maintenance window, ≤2 connections per topology §7); (2) run `scripts/backfill-order-country.ts` once (idempotent); (3) ensure the expiry-scheduler (or platform cron) hits `/api/cron/analytics-tick` — the scheduler service was restarted in this deployment and ticks all three endpoints; (4) no new env vars required (CRON_SECRET behavior unchanged).

# Seller Insights & Marketing Intelligence — Implementation Plan

Last updated: 2026-10-30 · Scope: the combined Seller Store Insights + Sales & Market Insights + Sales Funnel + Marketing Intelligence feature (post-remediation gate verdict: READY — see `full-audit-report.md` §"INDEPENDENT VERIFICATION").
Companion docs: `metric-definitions.md` (formulas), `markets-api.md` (binding Markets contract), `implementation-report.md` (what shipped 2026-10-28 + test evidence), `performance/seller-insights-audit.md` (original architecture audit).

This document is the **Phase 0 audit + consolidated plan** required before implementation. Ground rule from the spec: *do not create duplicate tables, events, APIs, or UI sections simply because they appear in the feature specification.*

---

## 1. Audit of the existing implementation (what is already there)

The first analytics mission (2026-10-28, trace 1a182c544c761a81) shipped a complete first-party pipeline. Everything below is **already implemented and test-verified** (56/56 readiness checks, finance regression 37/0, smoke 23/23, browser-verified — see `implementation-report.md`).

### 1.1 Implemented and reusable as-is

| Requirement area | Status | Evidence |
|---|---|---|
| Store/product views (events) | ✅ Implemented | `AnalyticsEvent` (`store_view`, `product_view`), hour-bucket dedup, collected in `/api/sf/[slug]` + `/api/sf/[slug]/products/[pSlug]` after live/active gates |
| Cart additions, removals, current cart quantities | ✅ Implemented | `add_to_cart` (applied-delta semantics), `remove_from_cart`, `view_cart`; live snapshot `currentCartSnapshot()` (eligibility = active variant + active product + live store); **historical adds never used to compute current cart state** (separate live query by design) |
| Checkout starts | ✅ Implemented (derived, not an event) | `begin_checkout` = `Order.createdAt` count (authoritative, idemKey-unique) |
| Authoritatively confirmed purchases | ✅ Implemented | `purchase` = `Order.paidAt` + status; money only from Order/OrderItem/Refund |
| Refunds | ✅ Implemented | `Refund.status='processed'`, processed-date basis, honest mixed-window note |
| Cancellations | ✅ Implemented | `Order.cancelledAt` basis |
| Country + product attribution (sales by geography) | ✅ Implemented | `Order.shippingCountryCode` checkout snapshot + audited backfill; state from frozen `shippingAddressJson`; `geoKey()` single source; drill-down reconciles |
| Overview dashboard section | ✅ Implemented | Overview tab: visits, unique visitors, product views, cart adds, paid orders, gross sales, AOV, in-carts-now, traffic trend, channels, top viewed, funnel, observations |
| Traffic & Carts section | ✅ Implemented | Cart activity tab: period add/remove events + units, byDay chart, top added, **current** live snapshot (active carts, units, top products in carts, unavailable units reported separately) |
| Sales & Markets sections | ✅ Implemented | Sales tab (authoritative cards, trends day/week/month, top products, fulfilment) + Markets tab (country/state, growth, shares, movers w/ min-5 guard, drill-down, CSV) |
| Sales Funnel | ✅ Implemented (inside Overview) | 5 stages: store visit → product view → add to cart → checkout started → paid order; session-scoped vs order-exact bases documented in `funnel.basis`; **drop-off display: partial** (step % shown, absolute drop-off not shown) → enhanced in Phase 2 below |
| Store-ownership authorization for analytics queries | ✅ Implemented | every insights route resolves the store from the seller session (`requireActiveSellerStore()`); negative cross-seller tests (T15) |
| `analytics.retention_days` | ✅ Implemented + wired | `/api/cron/analytics-tick` bounded purge; Setting 7–730 d, default 180 |
| Geographic data / historical order-address snapshots | ✅ Audited | 1051/1051 orders backfilled `MY`/`backfill` (postcode+state rule); state = genuinely recorded datum |
| Performance envelope | ✅ Implemented | indexed pulls, ≤20 k event scans w/ `truncated` flag, 45 s TTL cache + `fresh=1`, 60/min + 20/min export rate limits, bounded queue, analytics never on the money path |

### 1.2 Absent (genuine gaps this mission must add)

| Requirement | Status | Notes |
|---|---|---|
| Campaign attribution (any form) | ❌ Absent | No UTM capture, no seller campaign entity, no event→order attribution link. `channel` (direct/search/social/internal/other) + `referrerHost` are the only source signals; `referrerHost` is never even used by queries |
| Seller-generated campaign tracking links | ❌ Absent | Nothing exists. `Campaign` model is the **platform festive-theme engine** (admin banners) — unrelated; will not be overloaded |
| Validated UTM parameters | ❌ Absent | No code reads `utm_*` anywhere (verified by grep) |
| Advertising integration (Meta/TikTok/Google) | ❌ Absent (by design) | Spec forbids connectors now; Phase 4 = audit + provider-neutral adapter design only |
| Payment attempts metric | ⚪ Derivable | `PaymentIntent` rows are authoritative per-attempt records — no new collection needed; surface as funnel-adjacent note |
| Search activity | ⚪ Not collectable store-scoped today | Marketplace search (`/api/market/products?search=`) is platform-wide and multi-store; per-store search attribution would be noisy impression counting. **Decision: defined in the event vocabulary but NOT collected in this iteration**; revisit with a dedicated spec. Never displayed |

### 1.3 Defects found during this audit (fixed as part of Phase 1)

1. **Session-window bug** (`src/lib/analytics/identity.ts:75`): the session cookie is only re-set on rotation, so `mintedAt` never advances for an active visitor → a continuously active visitor is fragmented into a new session every 30 min of *elapsed* time, not 30 min of *inactivity* (documented semantics). Fix: sliding refresh — re-set the cookie with advanced `mintedAt` on every tracked event (same token). This matters for session-scoped funnel + attribution fidelity.
2. **Channel classification isSPA-degenerate**: all storefront fetches are same-origin, so `classifyReferrer` sees the app's own host → real external landings register as `internal`/`direct`; `social`/`search` essentially never fire. Fix: when attribution (UTM/campaign) is present, derive `channel` from the validated `utm_source` (facebook→social, google→search, …); referrer classification remains the fallback and its limitation stays documented.
3. **Shareable storefront URL inconsistency**: seller Settings shows `/{store.slug}` (no route — 404) while the real deep link is `/?sf={slug}`. The campaign-link generator will emit the correct `/?sf=…` form; the Settings copy fix is included.

### 1.4 Marketplace-connection infrastructure (Phase 4 dependency, finding F-20)

- `MarketplaceConnection` (nullable `storeId` = global/unclaimed handshake rows; `@@unique([platform, shopId])`), sealed tokens via `secretbox`, OAuth nonce flow (F-22 remediated).
- **F-20 (OPEN)**: `store/connections` list leaks global rows to every seller (`OR storeId:null`); `disconnect` mutates global rows. Same pattern in `store/imports`. Root cause: deferred-binding design leaves anonymous global rows.
- **Decision for this mission**: implement the *minimal fail-closed scoping fix* (list/disconnect/import queries scoped to the seller's own `storeId` only) so the isolation defect is resolved before any advertising design builds on the pattern; the deeper refactor (seller-stamped handshake rows, shopId-matched claim binding) is specified in the ad-integration design doc and scheduled with the actual connector implementation, not needed by a design-only phase.

---

## 2. Canonical event & metric architecture (Phase 1)

### 2.1 Event vocabulary (single `AnalyticsEvent` table — extended, not duplicated)

Existing: `store_view`, `product_view`, `view_cart`, `add_to_cart`, `remove_from_cart` (dedup-keyed, append-only).
Derived (never events): `begin_checkout` (Order.createdAt), `purchase` (Order.paidAt), `refund` (Refund processedAt), `payment_attempts` (PaymentIntent rows — new, surfaced as a funnel-adjacent count only).
Defined-but-not-collected: `search` (see §1.2 — no store-scoped datum; documented, never displayed).

**Extension (this mission)** — attribution columns on every event row (all nullable, additive):

```
campaignId   String?   → SellerCampaign.id (seller-generated link token resolved server-side)
utmSource    String?   ≤100 chars, validated
utmMedium    String?   ≤50
utmCampaign  String?   ≤100
utmTerm      String?   ≤100
utmContent   String?   ≤100
@@index([campaignId, createdAt])
```

### 2.2 Historical events vs current database state (restated binding rule)

- Current cart quantity / active carts / top products in carts = **live `CartItem` snapshot** (eligibility-filtered) — NEVER computed from historical `add_to_cart` − `remove_from_cart`.
- Historical cart activity (adds/removes per window) = event log.
- Attribution on events = the attribution cookie state **at event time**; attribution on an order = the cookie state **frozen at checkout creation**. These are different measurements (a visitor may land tagged, then buy days later after the cookie expired — then the order is honestly unattributed).

### 2.3 Attribution model (explicit definition — Phase 3 implementation)

- **Model: last-touch first-party association.** The most recent validated tagged landing within the attribution window (30 days) before the event/order.
- **Mechanism:** landing URL params (`utm_*` and/or `nmcl` campaign token) → validated server-side by a same-origin beacon → stored in a first-party httpOnly cookie `nm_ins_attr` (30-day sliding) → stamped on every tracked event → frozen onto the Order at checkout creation (`attrCampaignId`, `attrSource`, `attrMedium`, `attrCampaign`, `attrTerm`, `attrContent` — nullable string columns, additive; index `[storeId, attrCampaignId]`).
- **Campaign links:** seller creates a named campaign (short globally-unique `code`, optional default source/medium) → shareable URL `/?sf={storeSlug}&utm_source=…&utm_medium=…&utm_campaign={campaign-slug}&nmcl={code}`. `nmcl` is canonical (resolves to the campaign row, store-matched); raw UTMs are also accepted standalone (attributed as unclaimed tagged traffic). Precedence when both present: `nmcl` resolves `campaignId`; raw UTMs are stored as captured.
- **Honesty rules (enforced in UI copy + notes, not just docs):** a tagged visit is *associated with* a campaign — never claimed to *cause* a sale; ad-platform-reported conversions are a different measurement and are not shown; no spend exists in first-party data → **no ROAS/CPC/CPA is computed anywhere**; pre-release orders/traffic have no attribution (shown as "attribution tracking started {date}", never backfilled).
- **Privacy:** the attribution cookie carries no PII (validated short strings only); anonymous shoppers are never identified to sellers (`shopperId` remains cart-events-only, exactly as before).

### 2.4 Metric definition discipline

Every new metric gets a `metric-definitions.md` entry: formula, numerator/denominator basis (sessions vs orders — mixed bases disclosed), time window, freshness, currency (MYR sen only), and limitations. Campaign metrics:
- Campaign visits = distinct sessions over attributed `store_view` events in window.
- Campaign product views / cart-add units = attributed event counts/sums.
- Attributed orders = `Order.attrCampaignId = campaign` (createdAt basis); attributed paid orders + sales = same filter, `paidAt` basis (authoritative money).
- Attributed conversion = attributed paid orders ÷ campaign visits (mixed bases — disclosed).
- Unclaimed tagged traffic = grouped by (utmSource, utmMedium, utmCampaign) over events + order attribution columns.

---

## 3. Dashboard plan (Phase 2 — reuse, extend, no duplication)

| Spec section | Existing surface | Action |
|---|---|---|
| 1. Overview | Overview tab | **Keep.** Already shows visits/product views/cart activity/paid orders/sales/conversion + funnel + observations |
| 2. Traffic & Carts | Cart activity tab | **Keep.** Already shows current cart quantity, active carts, top products in carts, removals, trends |
| 3. Sales & Markets | Sales + Markets tabs | **Keep unchanged** (Markets contract frozen per `markets-api.md`) |
| 4. Sales Funnel | Funnel card inside Overview | **Enhance in place** (no new tab — duplication rule): add per-stage **absolute drop-off + drop-off %** (`1 − stepRate`, zero-division-safe), add `paymentAttempts` (authoritative PaymentIntent count) as an annotated figure, keep the existing `basis` honesty notes |

New tab: **Campaigns** (this is genuinely new surface — campaign list with per-campaign metrics, UTM-source breakdown, campaign-link generator with copyable share URL, "tracking started" honesty callout, no ad-platform claims).

---

## 4. Campaign attribution implementation (Phase 3)

1. Schema: `SellerCampaign` model (storeId, name, slug, code unique, default utm source/medium, status active/archived, createdAt) + `AnalyticsEvent`/`Order` attribution columns (§2.2/§2.3) — additive, `db:push`.
2. `src/lib/analytics/attribution.ts` — UTM validation (charset/length whitelist), `nmcl` resolution (store-matched), cookie read/write (30-day sliding), channel derivation from `utm_source`.
3. `POST /api/analytics/landing` — same-origin beacon (CSRF gate + `sec-fetch-site` guard + JSON-only + rate-limited 30/min/IP); validates params, resolves `nmcl`, sets `nm_ins_attr`. Idempotent per landing.
4. Shopper shell mount effect: read `utm_*`/`nmcl` once from the landing URL → fire the beacon (fire-and-forget) → attribution persists through SPA navigation and checkout (cookie).
5. `checkout/create`: freeze attribution onto each Order (inside the existing create; no transaction changes — two extra constant columns like the country snapshot).
6. Queries: `campaignReport(storeId, win)` in `queries.ts` (bounded, cached, session-scoped) + route `GET /api/store/insights/campaigns` (same envelope/conventions as the other insights routes).
7. Campaign link CRUD: `GET/POST /api/store/campaigns`, `PATCH /api/store/campaigns/[id]` (archive/rename) — seller-session-scoped, rate-limited, validated.
8. UI: Campaigns tab in `insights.tsx` (lazy fetch pattern) + link generator + honest notes.

## 5. Advertising integration preparation (Phase 4 — design only)

- Deliverable: `docs/seller-insights/ad-integration-design.md` — provider-neutral `AdPlatformConnector` interface (auth lifecycle + read-only insights; no campaign mutation), separate `AdConnection`-style model with **required storeId from day one**, sealed-token reuse, generalized OAuth nonce helper, staged rollout plan, and the explicit rule: **no ROAS/attributed-revenue claims without actual spend + a documented attributed-revenue measure; no fake connected states.**
- F-20 minimal fix lands now (fail-closed scoping of the three read/mutate sites) so the design does not build on a known isolation defect; deeper refactor specified in the design doc.
- No connectors, no Meta/TikTok/Google SDKs, no conversion-event sending in this mission.

## 6. Security, correctness, performance (Phase 5 — carried through all phases)

- Seller scope always from the authenticated session; campaign CRUD and the campaigns report get the same negative cross-seller tests as T15.
- Beacon: CSRF-proxy-protected (POST + JSON + same-origin), rate-limited, validated, no PII.
- Attribution columns are constant snapshots — money-path behaviour untouched; checkout admission gate / Serializable confirmation / webhook paths unchanged (regression suites re-run).
- New queries reuse the bounded-scan (≤20 k events), 45 s cache, 60/min limit conventions; campaign report scans events by `[campaignId, createdAt]` index and orders by `[storeId, attrCampaignId]`.
- Retention: attribution columns live on `AnalyticsEvent` → purged with the existing retention rule; Order attribution columns are order data (never purged).
- Re-run: seller-insights readiness (extended with attribution cases), finance-regression, deployment-smoke, lint, tsc; browser golden path (tagged landing → storefront → PDP → cart → checkout → mock pay → Campaigns tab shows attributed visit + sale).

## 7. Execution record (per phase — filled as implementation proceeds)

| Phase | Files changed | Tests executed | Result | Remaining limitations |
|---|---|---|---|---|
| 0 — audit + this plan | this doc | read-only audits (3 parallel agents) | complete | — |
| 1 — foundation | `prisma/schema.prisma` (AnalyticsEvent attribution cols + `@@index([campaignId,createdAt])`; `SellerCampaign`; Order `attr*` snapshot cols + `@@index([storeId,attrCampaignId])`; `db:push` applied); `src/lib/analytics/attribution.ts` (new); `identity.ts` (session sliding-window fix); `queue.ts` + `track.ts` (attribution fields + campaign-suffix dedup); `src/app/api/analytics/landing/route.ts` (new beacon); `shopper-shell.tsx` (mount capture, bounded wait); `app-store.ts` (`?sf=` deep-link surface rule); `checkout/create/route.ts` (freeze) | attribution suite B/C/D/E sections | complete | Attribution history begins at release (2026-10-30); `search` defined but not collected (documented) |
| 2 — dashboard | `src/lib/analytics/queries.ts` (funnel dropOff/dropOffPct + paymentAttempts on PaymentGroup; campaignReport + CampaignReport/UtmSourceRow types); `insights.tsx` (funnel card drop-off + payment-sessions annotation; Campaigns tab + CampaignsSection with link generator/copy/archive) | attribution suite G; browser E2E (funnel renders, drop 1 (100%) / gained N, payment sessions line) | complete | Funnel stays inside Overview per the no-duplication rule; payment attempts = PaymentGroup sessions (retry re-opens same record) |
| 3 — attribution | `src/app/api/store/insights/campaigns/route.ts` (new report route); `src/app/api/store/campaigns/route.ts` + `[id]/route.ts` (CRUD, session-scoped, audited); `settings.tsx` (storefront URL fix `/?sf=`) | attribution suite A–F + browser golden path (campaign link → real landing → attributed visit + report row) | complete | Last-touch only (no first-touch capture); 30-day window defined by landings |
| 4 — ad design + F-20 | `docs/seller-insights/ad-integration-design.md` (new — AdConnection model w/ required storeId, AdPlatformConnector interface, OAuth nonce generalization, staged rollout rules); F-20 minimal fail-closed fix: `connections/route.ts`, `connections/disconnect/route.ts`, `imports/route.ts` (scoped to own storeId, global rows invisible/unmutable) | attribution suite H1–H3 (global row invisible, disconnect no-mutate, imports list scoped) | complete | Deeper F-20 root-cause refactor (sellerId-stamped handshake rows, shopId-matched claim binding, runner/authStatus scoping) specified in the design doc §4, scheduled with the first real connector |
| 5 — verification | — | `seller-attribution.ts` 52/52 PASS (new); `seller-insights.ts` 55/55 PASS; `finance-regression.ts` 37/0 PASS; `deployment-smoke.ts` ALL PASS (dev-sandbox-local); `bun run lint` 0 errors; `tsc` src 0 errors; agent-browser E2E (tagged landing → storefront → seller Campaigns shows attributed visit; campaign create via UI; funnel drop-off; mobile 390px + desktop 1280px; zero console errors) | **complete** | Production build NOT RUNNABLE in this sandbox (dev-only policy, unchanged) — must run in CI/staging |

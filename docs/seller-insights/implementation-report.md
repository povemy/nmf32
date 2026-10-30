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

---

# Marketing Intelligence — Implementation Report (2026-10-30)

Mission: Seller Insights & Marketing Intelligence (combined spec). Post-remediation gate verdict authorized start (full-audit-report.md §"INDEPENDENT VERIFICATION"). Plan + audit: `implementation-plan.md` (§1 audit, §7 execution record).

## 1. What shipped

**Campaign attribution (Phase 1–3):**
- Schema (additive, `db:push`): `AnalyticsEvent` + 6 attribution columns (`campaignId`, `utmSource/Medium/Campaign/Term/Content`) + `@@index([campaignId,createdAt])`; new `SellerCampaign` model (store-scoped, immutable `code`/`slug`, default source/medium, active/archived); `Order` + 6 frozen snapshot columns (`attrCampaignId`, `attrSource/Medium/Campaign/Term/Content`) + `@@index([storeId,attrCampaignId])`.
- `src/lib/analytics/attribution.ts` (new): server-side UTM validation (control-char strip, length clamps, fail-closed), `nmcl` campaign-token resolution (active + store-matched — cross-store tokens ignored), `nm_ins_attr` httpOnly cookie (30-day, landing-defined window), channel derivation from validated `utm_source`, campaign-link path builder.
- Landing beacon `POST /api/analytics/landing` (CSRF-proxy-gated same-origin POST + JSON-only, rate-limited 30/min/IP, idempotent no-op without valid params). Shopper-shell mount capture with bounded wait so the first `store_view` lands attributed.
- Attribution stamped on every tracked event (cart events via fire-and-forget request context) and frozen onto every Order at checkout creation (constant columns — money path untouched, same pattern as the country snapshot).
- APIs: `GET /api/store/insights/campaigns` (report; same envelope/window/cache/limit conventions) + `GET/POST /api/store/campaigns` + `PATCH /api/store/campaigns/[id]` (session-scoped CRUD, activity-logged, 100/store hygiene cap, slug/code immutable).
- UI: new **Campaigns** tab in Insights (lazy fetch) — totals cards, campaign-link generator (name/source/medium) with copyable share URLs (`{origin}/?sf=…&utm_…&nmcl=…`), archive/restore, per-campaign performance table (visits, sessions, product views, cart adds, attributed orders, paid orders + prev delta, gross sales, AOV, conversion w/ mixed-basis disclosure, first-tagged-visit date), unclaimed UTM-source traffic table, honesty notes.
- Defects fixed along the way (found by this mission's audit): session sliding-window fragmentation (identity.ts), SPA-degenerate channel classification (now utm_source-derived for tagged visits), seller Settings storefront URL 404 (`/${slug}` → `{origin}/?sf=${slug}`), `?sf=` deep links now always open the shopper surface for that page load (a seller clicking their own campaign link sees the storefront a customer sees).

**Funnel (Phase 2):** per-stage absolute drop-off + drop-off % (server-computed; negative mixed-basis values displayed as "gained"); authoritative payment-sessions figure (PaymentGroup records — the current flow's payment-attempt object; PaymentIntent is legacy-only and is NOT used).

**Advertising integration (Phase 4 — design only):** `docs/seller-insights/ad-integration-design.md` — separate `AdConnection` model (storeId REQUIRED from day one — the F-20 lesson), read-only `AdPlatformConnector` interface, generalized OAuth nonce helper, conversion-event gating (no consent regime → none may be sent), staged rollout checklist. No connectors, no SDKs, no fake states, no ROAS.

**F-20 minimal fail-closed remediation:** `store/connections` + `store/imports` lists scoped strictly to the session seller's own store (global handshake rows invisible); `connections/disconnect` can no longer mutate global rows. Runtime-verified (H1–H3). The deeper root-cause refactor is specified in the design doc §4 and scheduled with the first real connector.

## 2. Tests executed (all against the live dev deployment)

| Suite | Result | Archive |
|---|---|---|
| `scripts/readiness/seller-attribution.ts` (NEW — 52 checks: campaign CRUD + cross-seller isolation, beacon validation/CSRF/405/rate-limit, cookie capture, cross-store token fail-closed, sanitation, attributed visit/event flow, channel derivation, session sliding fix, cart-event attribution, checkout freeze, paid-order retention, campaigns report correctness + isolation + honesty notes, unclaimed UTM traffic, funnel drop-off + payment sessions, F-20 runtime verification, money-path sanity) | **ALL PASS (52/52)** | `performance/runs/2026-10-29-seller-attribution.json` |
| `scripts/readiness/seller-insights.ts` (regression) | **ALL PASS (55/55)** | `performance/runs/2026-10-29-seller-insights.json` |
| `scripts/readiness/finance-regression.ts` | **37 PASS / 0 FAIL** | `performance/runs/2026-10-29-finance-regression.json` |
| `scripts/readiness/deployment-smoke.ts` (`SMOKE_TARGET_CONFIRM=dev-sandbox-local`) | **ALL PASS** | `performance/runs/2026-10-29-deployment-smoke.json` |
| Lint (`bun run lint`) | 0 errors (20 warnings, all pre-existing) | — |
| `tsc --noEmit` | src 0 errors | — |
| Browser (agent-browser) | Golden path: campaign link created via seller UI → link opened in a REAL browser → beacon 200 → campaign-attributed store_view recorded → seller Campaigns tab shows the attributed visit (1 visit / 1 session / first tagged visit date); campaign create form, copy-link, archive UI verified; funnel drop-off rows ("drop 1 (100%)", "gained N") + payment-sessions line render; raw-UTM landing shows in unclaimed tagged traffic; mobile 390 px + desktop 1280 px; **zero console errors** | screenshots `tool-results/mi-*.png` |

**Production build: NOT TESTED (sandbox dev-only policy, unchanged from prior verdicts) — must run in CI/staging.**

## 3. Honest limitations

1. Attribution history begins at this release (2026-10-30) — never backfilled; the UI says so.
2. Last-touch only (no first-touch capture); the attribution window is 30 days defined by landings.
3. Same-session landings via DIFFERENT campaigns each count for their own campaign (campaign-suffix dedup) — total store views can exceed distinct sessions in that scenario; visits/sessions metrics are unaffected.
4. Conversion is mixed-bases (orders vs cookie sessions) — labeled, an indication.
5. No spend data → **no ROAS/CPC/CPA anywhere**; ad-platform-reported conversions are a different measurement and are not shown.
6. `search` is defined in the event vocabulary but not collected (no honest store-scoped search datum).
7. Payment attempts = PaymentGroup sessions (retry re-opens the same record — not double-counted); PaymentIntent is legacy-only.
8. F-20 root-cause refactor (sellerId-stamped handshake rows, shopId-matched claim binding, runner/authStatus scoping) remains scheduled with the first advertising connector — the seller-visible leak sites are fixed and runtime-verified.

## 4. Deployment steps (staging/production)

1. Apply the schema diff via the established `db:push` flow (additive columns + one new model + 3 new indexes — no data migration; historical rows keep NULL attribution by design).
2. No new env vars; no scheduler changes (analytics-tick already purges events including the new columns via the existing retention rule).
3. Run CI/staging production build (not runnable in this sandbox) + re-run the four readiness suites there.

## 5. Re-verification gate (2026-10-30)

An independent re-audit of the combined scope against this report and `implementation-plan.md`, executed after implementation was reported complete.

**Code presence re-verified:** schema attribution columns + `@@index([campaignId,createdAt])` / `@@index([storeId,attrCampaignId])`, `SellerCampaign` model, `src/lib/analytics/attribution.ts`, landing beacon route, shopper-shell mount capture, checkout-create freeze (`attrCampaignId`/`attrSource` …), campaigns CRUD + report routes, Insights Campaigns tab + funnel drop-off fields — all present in the current tree exactly as documented. No duplicate tables/events/APIs/UI were created by the re-audit.

**Fresh test runs (all against the live dev deployment):**

| Suite | Result | Archive |
|---|---|---|
| `seller-attribution.ts` | **ALL PASS (52/52)** | `performance/runs/2026-10-30-seller-attribution.json` |
| `seller-insights.ts` | **ALL PASS (55/55)** — including immediately after the attribution suite (the previously-failing back-to-back sequence) | `performance/runs/2026-10-30-seller-insights.json` |
| `finance-regression.ts` | **0 failures** (fault-injection retry checks included) | `performance/runs/2026-10-30-finance-regression.json` |
| `deployment-smoke.ts` | **ALL PASS** | `performance/runs/2026-10-30-deployment-smoke.json` |
| `bun run lint` | **0 errors** (20 warnings, all pre-existing k6/tooling) | — |
| `tsc --noEmit` | **src 0 errors** (legacy `scripts/fin-*.ts` errors pre-date this feature and are outside the app build) | — |

**Harness defect found & fixed (no app defect):** the first insights run after the attribution suite showed 8 failures (T5–T10) + a script crash. Root cause: both suites register fixtures through the shared 5/min/IP `auth-register` bucket (F-12), so the second suite's shopper registration was 429'd; the harness ignored the status and cascaded empty-cookie failures (no cart events, empty snapshot, checkout 401). An isolated re-run was ALL PASS before any change. Fix: `registerFetch()` 429-aware retry (waits the advertised `retryAfterSeconds`, max 2 waits) + non-2xx status guards on shopper registration in both suites. Back-to-back runs now pass deterministically.

**Browser re-verification (agent-browser, real flows):** seller login → Insights renders all 6 tabs with correctly scoped real data — Overview (visits/visitors/views "New" badges; 15 paid orders / RM 2,123 gross authoritative), funnel drop-off rows + "gained 14" mixed-basis honesty + payment-sessions line, Markets state-default rows reconciling exactly with Sales totals (RM 1,695 net = 1,256 Selangor + 439 KL), Cart activity (real events + live snapshot), Sales (authoritative money, refunds RM 356 / 4). **Golden path end-to-end:** campaign "Raya Social Push" created via the seller UI → its share link opened as a visitor in the same browser → beacon `POST /api/analytics/landing` 200 → attributed `store_view` row in DB (campaignId + utmSource=instagram + channel=social) → seller Campaigns tab shows **1 attributed visit** + first-tagged-visit date 30/10/2026. Zero console errors; mobile 390 px + desktop 1280 px; dev.log clean (0 errors, 0 ×500). Screenshots: `tool-results/gate2-si-*.png`.

**Operational notes:** the sandbox OOM-killer terminated next-server once during verification (Chrome + dev server memory pressure); `scripts/dev-supervisor.sh` (the established durable keepalive) was started and auto-revives it. Demo seller `lumina@nomofee.io` password was reset to the seed value `Seller123!` for browser login (dev fixture only). Production build remains NOT RUNNABLE in this sandbox — the CI/staging step in §4 is unchanged and still required.

## 6. Interactive 3D Conversion Funnel diagram (2026-10-30)

Mission: upgrade the Insights → Overview conversion funnel into the requested interactive centerpiece — a horizontal 3D multi-stage funnel on HTML5 Canvas (color-coded tapered sections, SVG stage icons, callout pointer labels, hover effects) with Daily/Weekly/Monthly/Yearly view toggling, plus a streamgraph-style multi-chart (ApexCharts-referenced look).

**What shipped (no new dependencies — the ApexCharts streamgraph look was reproduced with the project's existing recharts; the 3D funnel is custom canvas, which no chart library provides):**

- **API:** `GET /api/store/insights/funnel?window=today|7d|30d|1y` — new route, seller-session-scoped (`requireActiveSellerStore`), 60/min insights bucket, 45 s TTL cache, `{window, generatedAt, freshness, stages, byDay, truncated, paymentAttempts(+prev), basis}`. Stage numbers come from the SAME shared math as the Overview funnel (extracted `buildFunnelStages`) — the two routes cannot disagree (regression-tested). `window=1y` (rolling 365 d) is accepted by this route ONLY via an opt-in parser flag; every other insights route keeps the shared ≤ 92 d contract (negative-tested: markets rejects `1y`).
- **`byDay` series:** per-KL-day points with distinct-session traffic stages (documented: a session spanning midnight counts both days — daily values can sum above the window total) and EXACT per-day checkout/paid order counts (sums equal the stage counts — regression-tested). Bounded pulls: 20 k event guard + order-date pulls capped at 20 001 with exact-count fallback → `truncated` flag.
- **Defect found & fixed by the new tests:** rolling windows where (to − from) is an exact day multiple (7d/30d/1y) skipped the final partial day bucket — today's orders were missing from `byDay` while present in the stage counts. Fixed with an end-day bucket guarantee; the byDay-sums test now passes.
- **UI (`src/components/seller/funnel-diagram.tsx`):** full-width hero card under the Overview summary cards. Canvas 3D tapered horizontal funnel: per-stage colors (house teal→emerald→amber→orange→rose), extruded top faces + right cap + gradient shading (pseudo-3D), white SVG icons per stage, count labels/pills, callout pointer chips (label + count + step %) with pointer lines on wide viewports, hover hit-testing → slab lift + glow + outline + DOM tooltip (count / prev window / step rate / drop-off-or-gained), rAF-eased grow-in and transition animations (prefers-reduced-motion snaps), DPR-crisp rendering, ResizeObserver responsiveness, sr-only data table for screen readers. Below: centered silhouette streamgraph of the five stage series over time (Daily view renders a stacked bar of today's stages — a one-day stream would be degenerate), DOM legend chips, payment-sessions line, basis notes incl. the byDay honesty note, generated-at stamp. Daily/Weekly/Monthly/Yearly segmented toggle drives its own fetch (only the funnel refetches); page-window presets sync the funnel view. Overview layout adjusted (Channels beside Traffic trend; Top viewed full width).
- **Honesty preserved:** mixed-basis widening is drawn as-is (the "gained 14" case widens the funnel — never clamped to fake a shape); payment sessions stay an annotation, not a stage; honesty notes retained verbatim.

**Tests executed:** `seller-insights.ts` ALL PASS — **63 checks** (8 new T23 funnel-route checks: unauth 401, invalid-window 400 listing `1y`, markets-rejects-1y contract guard, 1y → 365-day series + 5 stages + echo, today → single-day shape, byDay sums equal stage counts, funnel≡overview stage parity, cross-seller B isolation); `seller-attribution.ts` ALL PASS (52/52); `finance-regression.ts` 0 failures; lint 0 errors; `tsc` src 0 errors. **Browser-verified** (desktop 1280 + mobile 390): all four toggles fire the correct windows (network-verified 200s), hover tooltip renders stage detail, canvas responsive 942↔308 px, clean reload zero console errors; **VLM design review: desktop 9/10** ("high-fidelity, professional-grade… technically impressive and visually polished"), **mobile funnel 10/10** ("fully visible, zero defects"). Screenshots: `tool-results/funnel-3d-*.png`.

**Remaining limitations:** `1y` traffic depth is bounded by the analytics retention rule (order-derived stages persist, visitor stages vanish past retention — the window echo describes the request, not retained depth); no new deps added, so the streamgraph lacks ApexCharts' built-in crosshair styling (custom tooltip provided instead); canvas hover is pointer-based (screen readers get the sr-only table mirror; keyboard focus stays on the toggle).

## 7. Per-product Conversion Funnel + Channels explainer (2026-10-30)

Mission (user request): (a) explain — and surface in-product — how the Channels card knows where a buyer came from; (b) let the seller view the Conversion Funnel **for each individual product** to plan per-product, with a proposal if we had a better idea.

**How Channels detection actually works (shipped as an in-product explainer):** every tracked event carries a `channel` resolved as `channelFromAttribution(attr) ?? referrer` — (1) **campaign-tagged landings** (seller-shared links carrying `utm_*` + `nmcl` store token, validated and remembered 30 days via the `nm_ins_attr` cookie) classify from the validated `utm_source` keyword map (social/search/other); (2) **untagged visits** fall back to the browser's standard `Referer` hostname against known search/social host lists (privacy-aware: host only, never the full URL); (3) **direct** = no referrer and no tag. The Channels card now carries a "How?" popover spelling out the three paths plus the last-touch, first-party caveat (a channel is *associated with*, never proven to *cause*, a sale).

**What shipped for the per-product funnel (API):** `GET /api/store/insights/funnel?window=…&productId=<id>` on the SAME route (no new endpoint, no new table — reuses the existing `AnalyticsEvent.productId` column and `OrderItem` relation). Ownership is resolved server-side against the caller's own store → foreign/deleted product = honest **404**. Product scope returns **4 stages** — Viewed this product → Added to cart (distinct sessions for THIS product) → Checkout started (orders containing the product, `createdAt` basis) → Paid orders (`paidAt` basis) — via the SAME shared drop-off math as the store funnel (`withDropOff`), plus sales context (`unitsSold`, gross `revenueMinor`, `ordersPaid` from the product's own line items in paid orders), product-scoped payment sessions, a `byDay` series minus `visits`, and a `products[]` selector list (ranked by views, capped 60, honest `productsTruncated`) derived from the same bounded event pull. A payload bug was found and fixed on the way: `window.prevTo` echoed `prevFrom`.

**What shipped for the per-product funnel (UI):** the funnel card header gains a product selector (shadcn Select; honest "No product traffic yet" disabled state when the window has no tracked product activity). The 3D canvas, callout chips, hover tooltip, DOM legend, Daily stacked bar and silhouette streamgraph are now scope-generic — 5 store stages / 4 product stages, a stage keeps its colour in both scopes. A product-scope context line shows the sales facts; payment-sessions and basis notes adapt their wording. Selecting a product that later 404s self-heals back to the store-wide funnel instead of a dead error panel. **The "better idea" baked in:** because the API already returns per-product view/cart activity, the funnel doubles as a product-level conversion audit — the seller ranks products by traffic in the selector and inspects exactly where each one loses people (view→cart vs cart→checkout), which is the per-product planning input the request asked for.

**Tests executed:** `seller-insights.ts` **ALL PASS — 69 checks** (6 new T24: product-scope shape; fixture-matched stage counts 1/1/1; sales context 2 units / RM 20.00 / 1 paid order + `byDay` omits `visits`; payment sessions + selector list; cross-seller 404; store-scope selector consistency); `seller-attribution.ts` **ALL PASS** (back-to-back, 429-aware path holds); `bun run lint` 0 errors; `tsc` src 0 errors. **Browser-verified** (agent-browser, desktop 1280 + mobile 390): product dropdown lists the 3 tracked products; selecting Aurora renders the 4-stage 3D funnel + "10 units sold · RM 890.00 gross product revenue · 10 paid orders" (VLM review: clean rendering, callout pointers legible, zero glitches); hover tooltip "Added to cart · 1 in window · prev 0 · Step 33.3% · drop 2 (66.7%)" matches the API exactly; Daily and Yearly toggles fire `window=today`/`1y` with `&productId=` (network-verified 200s); returning to All products restores the 5-stage store funnel; Channels "How?" popover shows all three detection paths; mobile product selection works with no horizontal overflow; **zero console errors, dev.log clean**. Screenshots: `tool-results/pf-01-overview-store.png` … `pf-06-yearly-product.png`.

**Honest limitations:** the selector lists only products with *tracked* activity (a product with orders but zero tracked views has no funnel to show — post-release tracking, correctly empty rather than fabricated); money context is gross line subtotal before refunds (labelled as such); the products list is capped at 60 with an honest flag; sparse products render thin-but-visible slabs (min clamp keeps them hoverable).

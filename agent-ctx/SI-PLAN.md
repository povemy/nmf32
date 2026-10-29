# SI-PLAN — Seller Store Insights + Sales & Market Insights (unified) implementation plan

Source: performance/seller-insights-audit.md (2026-10-28). Binding ground rules: agent-ctx/RX-CHECKLIST.md ADDENDUM #7.
Execution: phases A→F below, tests between phases, finance-regression + deployment-smoke green at the end.

## Phase A — Schema (additive only, via `bun run db:push` + row-count snapshot)

```prisma
model AnalyticsEvent {
  id            String   @id @default(cuid())
  dedupKey      String   @unique
  eventType     String   // store_view|product_view|view_cart|add_to_cart|remove_from_cart
  storeId       String
  productId     String?
  variantId     String?
  shopperId     String?  // only when authenticated at event time
  visitorId     String?  // pseudonymous cookie
  sessionId     String?  // pseudonymous cookie (30-min sliding window)
  qty           Int?     // units delta for cart events
  referrerHost  String?  // host only, ≤100 chars, never full URL
  channel       String?  // direct|search|social|internal|other
  createdAt     DateTime @default(now())
  @@index([storeId, eventType, createdAt])
  @@index([storeId, createdAt])
}
```
- `Order.shippingCountryCode String @default("")` + `Order.shippingCountrySource String @default("")` (values `checkout` | `backfill` | ``; display `ZZ`=Unspecified).
- New indexes: `Order @@index([storeId, paidAt])`, `Order @@index([paidAt])`, `OrderItem @@index([orderId])`, `ProductVariant @@index([productId])`, `CartItem @@index([cartId])`.
- Do NOT touch: PaymentGroup, Refund, Wallet, Ledger* models. No new services.

## Phase B — Collection (`src/lib/analytics/`)

- `identity.ts` — `resolveInsightsIdentity()` using `cookies()` (next/headers): cookies `nm_ins_vid` (365d) + `nm_ins_sid` (value `{hex32}.{mintedMs}`, minted/rotated when >30 min old; cookie maxAge 24h sliding refresh). httpOnly, sameSite:"none", secure:true, path:"/" (matches SESSION_COOKIE posture for iframe preview). No IP/UA/PII. Returns `{visitorId, sessionId, shopperId?}` (shopperId via getSession() best-effort, only for shopper sessions).
- `referrer.ts` — `classifyReferrer(req)`: same-host→internal; known search/social host maps; empty→direct; else other. Stores host only.
- `queue.ts` — globalThis bounded queue (cap 500, drop-oldest + `dropped` counter), lazy 2s unref'd flush timer, flush = `db.analyticsEvent.createMany({data, skipDuplicates:true})` in try/catch (P2002-safe); `analyticsQueueStats()` for observability. Never throws into callers.
- `track.ts` — fire-and-forget helpers (compute dedupKey, enqueue):
  - `trackStoreView({storeId})` → `sv:{sessionId}:{storeId}:{yyyyMMddHH}`
  - `trackProductView({storeId,productId})` → `pv:{sessionId}:{productId}:{yyyyMMddHH}`
  - `trackViewCart({cartId,itemCount})` (only when itemCount>0) → `vc:{cartId}:{yyyyMMddHHmm}`
  - `trackAddToCart({storeId,productId,variantId,cartItemId,preQty,postQty})` → `ac:{cartItemId}:{pre}->{post}` (qty=post−pre)
  - `trackRemoveFromCart({storeId,productId,variantId,cartItemId,qty})` → `rc:{cartItemId}:{qty}`
- Instrument: `/api/sf/[slug]/route.ts` (after live gate), `/api/sf/[slug]/products/[pSlug]/route.ts` (after active gate), `GET /api/cart` (view_cart), `POST /api/cart/items` (add, after create/update), `DELETE + PATCH→0 /api/cart/items/[id]` (remove). All `void track(...)` style — never awaited, never inside transactions, `.catch(()=>{})` semantics built into queue.
- `/api/checkout/create`: write `shippingCountryCode:"MY", shippingCountrySource:"checkout"` (platform is MY-only; postcode+state validated).
- `scripts/backfill-order-country.ts`: historical orders → `MY`/`backfill` iff frozen `shippingAddressJson` has 5-digit postcode AND state ∈ MY_STATES; else `ZZ`/`backfill`. Idempotent (skips rows with non-empty source). Row counts before/after.
- Settings registry: new group `analytics` (icon `activity`) + key `analytics.retention_days` (integer 7–730, default 180, wired once tick reads it).
- `/api/cron/analytics-tick` (POST tick + GET observability, `assertCronAuth`): retention purge in batches of 1000 (deleteMany createdAt < now−retention_days), upsert `Setting cron.analytics.last`, bounded; register as 3rd endpoint in `mini-services/expiry-scheduler` (state.json key `analytics-tick`).
- Fix pre-existing defect: `/api/me/recommendations` missing `userId` filter on UserActivity (add where clause).

## Phase C — Queries + APIs (`src/lib/analytics/queries.ts` + 7 routes)

All routes: `requireActiveSellerStore()`, `rateLimit(req,"insights",60,60_000)`, `dynamic="force-dynamic"`, 45s globalThis TTL cache keyed `insights:{route}:{storeId}:{params}` with `?fresh=1` bypass, zod-validated params. Window: `today|7d|30d|custom(from,to)`; prev period = equal length immediately before. Every response: `{window:{key,from,to,prevFrom,prevTo}, generatedAt, freshness:{eventsUpTo, note?}, data…}`.

Funnel (session-scoped for view stages, order-exact for checkout stages — documented):
store_visit = distinct sessionId with store_view; product_view = distinct session with product_view; add_to_cart = distinct session (or `u:{shopperId}` fallback) with add; begin_checkout = orders created (createdAt); purchase = orders paid (paidAt).

Routes (envelope via `ok()`/`okPaged()`):
1. `GET overview` — traffic summary + byDay series + topViewedProducts + channel breakdown + funnel + summary cards + observations[] (only evidence-supported).
2. `GET cart` — period add/remove activity + byDay + topAdded; `current` live snapshot (activeCarts, totalUnits, byProduct ranked by units + by distinct carts, eligibility = variant.isActive && product.status=active && store.status=live, sampledAt).
3. `GET products` (paged, sortable views|adds|cartQty|purchases|revenue|conversion) — product table rows.
4. `GET sales` — cards (paidOrders/units/gross/net/discounts/refunds/refundCount/cancelled/aov + visitToPurchaseRate), byDay granularity day|week|month, topProducts, fulfillment (unfulfilledPaid, avgPaidToShipHours w/ sample size).
5. `GET markets` (dimension=country|state, sortable) — country/state rows with share/growth/new + notes (billing dimension unavailable, backfill labels) + movers (min sample 5).
6. `GET markets/products` (dimension+code+window) — S4 product-per-geo rows.
7. `GET export` (type=overview|products|sales|markets, window) — CSV (csvRow conventions), `logActivity('insights.export')`.

Metric formulas → docs/seller-insights/metric-definitions.md (written in Phase F with final code).

## Phase D — UI (delegate to full-stack-developer agent with this contract)

- `seller-shell.tsx`: NAV entry `insights` (icon BarChart3, label "Insights") after dashboard; `SellerViewName += "insights"`; render `<SellerInsightsView/>`.
- `src/components/seller/insights.tsx` (+ small submodules if needed): Tabs Overview/Cart activity/Products/Sales/Markets; window Select (Today/7d/30d/Custom) + custom range via two Calendar Popovers; prev-period deltas on cards (▲▼ with % vs prev, "—" when prev=0 → "new"); recharts AreaChart traffic + sales trends, funnel as horizontal stage bars; product Table sortable; markets Table with dimension toggle Country/State; CSV export buttons (window.location.href); empty states ("data collection started {date}"), skeletons, error state w/ retry; "How it's calculated" collapsible per section; `generatedAt` + freshness chip; observations list (server-provided only).
- Style: existing seller idioms — StatCard/CardsSkeleton/RowsSkeleton/useApi/apiGet from `seller/ui-bits.tsx`, formatMinor, teal `#0d9488` / amber `#a16207`, Cards, shadcn Table/Tabs/Select/Popover/Calendar. Responsive (grid collapse on mobile, charts h-[240..280px]).

## Phase E — Tests

- New `scripts/readiness/seller-insights.ts` ([LT] fixtures, connection_limit=2 client, BASE 127.0.0.1:3000): auth negatives (401 unauth; seller B gets zero/404 on seller A store data via every insights route), dedup (same session+hour duplicate views counted once), add/remove events match cart ops (qty delta), current-cart snapshot excludes purchased items (mock-PSP paid checkout), multi-vendor cart attribution, funnel begin/purchase vs orders exact, refund reflection, window + prev-period math, empty-store zeros, country snapshot + backfill rule, view_cart gating.
- Re-run: `bun scripts/readiness/finance-regression.ts`, `bun scripts/readiness/deployment-smoke.ts` (both must stay ALL PASS).
- Browser golden path via agent-browser: storefront → PDP → add to cart → checkout → mock pay → seller Insights dashboard shows the events/sale; responsive + no console errors.

## Phase F — Docs & handover

- `docs/seller-insights/metric-definitions.md` (every displayed metric: formula, numerator/denominator basis, source table, freshness, limitations; visitor/session definitions; privacy/consent note; retention).
- `docs/seller-insights/implementation-report.md` (changed files, what's real vs post-release-only data, tests executed + results, perf notes, remaining limitations).
- worklog.md append; RX-CHECKLIST ADDENDUM #7 boxes ticked with evidence.

## Completion rule (from spec)

A seller can open the dashboard, see data derived from their own store only, filter results, and cannot access another seller's information — verified by executed tests + browser.

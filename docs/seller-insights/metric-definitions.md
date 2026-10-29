# Seller Insights — Metric Definitions

Last updated: 2026-10-28 · Scope: Seller Store Insights + Sales & Market Insights (unified feature).
Companion docs: `performance/seller-insights-audit.md` (architecture audit), `docs/seller-insights/implementation-report.md` (what shipped + test evidence).

Every number shown in the Seller Insights dashboard is defined here — its formula, its source table, its date basis, and its limitations. Two data families are kept strictly separate:

- **Authoritative financial data** — `Order`, `OrderItem`, `Refund`, ledger records. Complete history, exact, never derived from browser events.
- **Behavioural event data** — `AnalyticsEvent` rows. Exists only from the feature's release date (2026-10-28) onward; traffic metrics before that are honestly zero.

---

## 1. Identity, sessions and privacy

| Concept | Definition |
|---|---|
| Visitor id | Random first-party cookie `nm_ins_vid` (365 days, httpOnly, SameSite=None, Secure). **Unique visitors is an estimate** — clearing cookies resets identity (one human can count twice; one person on two devices counts twice). No login required. |
| Session id | Cookie `nm_ins_sid` = `{token}.{mintedAt}`; a NEW id is minted after **30 minutes without a tracked event** (inactivity window). Cookie life 24 h, sliding refresh. **Visits = distinct session ids.** |
| What we never store | IP addresses, user-agent, device fingerprints, full referrer URLs, customer names/emails/addresses on event rows. `shopperId` is attached only to cart events of authenticated shoppers. |
| Referrer | Host-only (≤100 chars) from the standard `Referer` header, classified: `direct` (none) / `search` / `social` / `internal` (same host) / `other`. Last-touch on the view event — a channel did not necessarily cause a sale. |
| Consent | The platform has no cookie-consent banner today; these are strictly functional first-party cookies with no cross-site tracking. If a consent regime is introduced, collection must be gated behind it. |
| Retention | `analytics.retention_days` Setting (default 180, clamped 7–730), enforced by the `/api/cron/analytics-tick` scheduler endpoint. **Order/payment/refund/ledger records are NEVER deleted by this rule.** |

## 2. Event rules (`AnalyticsEvent`)

| Event | Recorded when | Dedup rule (idempotency key) |
|---|---|---|
| `store_view` | Public storefront home payload served (store `live`, home published) | once per (session, store, 1-hour bucket) |
| `product_view` | Product-detail payload served (product `active`). Catalogue grids and "related" products never count. | once per (session, product, 1-hour bucket) |
| `view_cart` | Shopper opens/refreshes a non-empty cart | once per (cart, store, minute) — one event per store in a multi-vendor cart |
| `add_to_cart` | A cart line qty transition is APPLIED (after MOQ/stock caps). qty = post − pre. No-op adds record nothing. | once per (cart item, pre→post transition) |
| `remove_from_cart` | A line is removed (DELETE or PATCH qty→0). qty = units removed. | once per (cart item, qty) |
| `begin_checkout` | **Not an event** — derived from `Order.createdAt` (authoritative; order idemKey unique) | n/a |
| `purchase` | **Not an event** — derived from `Order.paidAt` + `status ∈ {paid, processing, shipped, delivered, completed}` | n/a |
| `refund` | **Not an event** — derived from `Refund.status='processed'` (+ late-payment `PaymentReconciliation`, which never touches orders) | n/a |

Delivery guarantee: events are enqueued in a bounded in-memory queue (cap 500, drop-oldest, counted) and flushed as a single `createMany skipDuplicates` every ~2 s. Analytics failures are logged and dropped — they can never error a storefront, cart, checkout, payment or refund request. **Data latency: ≤ ~2 s (plus a 45 s response cache per dashboard query; the Refresh button bypasses with `fresh=1`).**

## 3. Traffic metrics (Overview)

| Metric | Formula | Basis / caveat |
|---|---|---|
| Store views | count of `store_view` events in window | events (post-release only) |
| Visits (sessions) | distinct `sessionId` over `store_view` events | session estimate (cookie) |
| Unique visitors (est.) | distinct `visitorId` over ALL store events in window | estimate (cookie) |
| Product views | count of `product_view` events | events |
| Traffic trend | daily buckets (Asia/Kuala_Lumpur day boundaries, UTC+8) of store/product views | series gap-filled to zero |
| Channels | store views + distinct sessions per referrer class | last-touch, heuristic host map |
| Top viewed products | `product_view` count per product, top 8 | only the store's own products |

## 4. Cart metrics (Cart activity)

Historical (windowed) and current (live) are computed SEPARATELY by design:

| Metric | Formula | Source |
|---|---|---|
| Cart-add events / units | count / Σqty of `add_to_cart` events in window | events |
| Units removed | Σqty of `remove_from_cart` events in window | events |
| Top added | Σ add units per product (top 8) | events |
| **Currently in carts (units)** | Σ `CartItem.qty` over live cart lines whose variant is active AND product `active` AND store `live` | live DB snapshot (not windowed) |
| Distinct active carts | count of distinct `Cart.cartId` in that snapshot | live DB |
| Unavailable units | units on lines failing the eligibility rule (reported separately, never mixed in) | live DB |

Snapshot rules: purchased variants are deleted by the payment webhook (excluded by construction); removed lines are deleted (excluded); a cart with 5 units of one product = 5 units but 1 distinct cart; a mixed-vendor cart attributes each line to the line's own product store. There is no cart-expiry concept in the platform — a cart is active by existing (audited fact).

## 5. Conversion funnel (Overview)

`store visit → product view → add to cart → checkout started → paid order`

- Visit → cart stages: **distinct sessions** that performed the stage inside the window (estimates).
- Checkout started = orders created in the window (any status); paid orders = orders with `paidAt` in the window (exact).
- Step rates = stage ÷ previous stage, same window. The cart→checkout step mixes bases (sessions vs orders) and is labelled as an indication, not exact visitor conversion. Visit→purchase rate (Sales tab) = paid orders ÷ tracked visits — post-release traffic only.

## 6. Sales metrics (Sales tab) — authoritative

All money is **MYR minor units (sen)** — the platform is single-currency; no conversion exists anywhere.

| Metric | Formula | Date basis |
|---|---|---|
| Paid orders | count orders with `paidAt ∈ window` | payment date |
| Units sold | Σ `OrderItem.qty` over those orders | payment date |
| Gross sales (order GMV) | Σ `Order.totalMinor` (= products + shipping − discounts + tax) | payment date |
| Gross product sales | Σ `OrderItem.lineSubtotalMinor` | payment date |
| Discounts | Σ `OrderItem.discountMinor` | payment date |
| Shipping charged | Σ `OrderItem.shippingMinor` (per-item allocation of the per-seller flat parcel) | payment date |
| Refunds | Σ `Refund.amountMinor` where `status='processed'` | **refund processed date** |
| Net product sales | gross product sales − discounts − refunds (window) | mixed (documented: a refund may relate to an order paid in an earlier period) |
| Seller proceeds | Σ `OrderItem.sellerNetMinor` (commission already deducted) | payment date |
| AOV | gross sales ÷ paid orders | payment date |
| Cancelled orders | count with `cancelledAt ∈ window` | cancellation date |

Not shown / not derivable (honest gaps): taxes are always 0 today; per-item refund quantity (refunds are order-level money — `OrderItem.refundedMinor` is money, not units); shipping-only refunds (not distinguished in the data model); average delivery time (no trustworthy carrier timestamps). Fulfilment shows unfulfilled paid orders and average hours paid→shipped (200-order sample).

## 7. Product performance (Products tab)

Per product, windowed unless noted: views (events), view sessions, add units/events (events), **current cart units + distinct carts (live snapshot — not windowed)**, ordered units (orders created), purchased units (orders paid), gross/net sales + refunded (order items), view→cart rate = sessions that viewed AND added ÷ sessions that viewed (same window, same product), checkout→purchase rate = purchased units ÷ ordered units. Server-side sorting by views/adds/cartQty/purchases/revenue/conversion; pagination capped at 50/page.

## 8. Markets (Sales by Country / State)

| Rule | Definition |
|---|---|
| Country dimension | `Order.shippingCountryCode` — frozen snapshot written at checkout (this route validates the Malaysian postcode/state, so it records `MY`, source `checkout`). Historical orders: `MY` with source `backfill` **only** when the frozen `shippingAddressJson` contains a 5-digit postcode AND a known Malaysian state (rule = the platform's own checkout validation); otherwise `ZZ` Unspecified. The UI labels backfill rows. |
| State dimension | The `state` recorded in the order's frozen shipping snapshot (the genuinely recorded geo datum on this Malaysia-only platform). |
| Billing country | **Not recorded anywhere in the data model — dimension unavailable.** Never substituted with the customer's current profile address or an IP guess. |
| Rows | paid orders, units, gross/discounts/refunds/net/shipping/AOV per geography (same formulas as §6), share of seller's net product sales and paid orders, growth = paid-order change vs equivalent previous period ("New" when previous period had none — never a division by zero). |
| Movers | risers/fallers ≥ ±20% growth, **minimum 5 paid orders** (insufficient-sample guard — no market claims on tiny data). |
| Per-market products | sales columns attributed strictly by the order's recorded destination geography. Views/cart-adds shown are **store-wide** (visitor geography is not tracked — per-country conversion rates are never invented). |

## 9. Observations

Only emitted when measurements support them (thresholds in `buildObservations`): store-level low cart interest (≥30 store views, <5% of viewing sessions added), cart interest not converting (≥5 units in carts, no paid orders), cart-add trend ±20% (≥10 units, previous > 0), top product in carts (≥3 units), sales trend ±20% (≥3 orders, previous > 0). No fabricated insights on small samples.

## 10. Authorisation & performance

- Every insights route resolves the store from the seller **session** (`requireActiveSellerStore()`) — a client-supplied store/seller id is never trusted; cross-seller isolation is proven by negative tests (T15).
- Queries are bounded: windows ≤ 92 days, event scans ≤ 20 000 rows (honest `truncated` flag), product tables paginated, aggregations batched in JS over indexed pulls (`Order(storeId,paidAt)`, `Order(paidAt)`, `OrderItem(orderId)`, `CartItem(cartId)`, `AnalyticsEvent(storeId,eventType,createdAt)`).
- Responses cached 45 s per (route, store, params) in-process; `fresh=1` bypasses. Rate limits: 60/min JSON routes, 20/min CSV export (separate buckets).

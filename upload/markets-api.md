# Seller Insights — Markets API Reference

Last updated: 2026-10-29 · Scope: the geographic "Markets" subsystem of Seller Insights — every route, schema, and rule a future dashboard needs to consume, link, and stay in sync with this data.
Companion docs: `metric-definitions.md` §8 (row formulas), `implementation-report.md` (what shipped + test evidence).

**Why this document exists:** parts of the Markets section will be surfaced on a new dashboard later. That dashboard must reuse these exact routes and contracts — not re-implement the queries — so numbers can never disagree between surfaces. Everything below is the binding contract: param names, response fields, cache keys, dimension semantics, and the integration rules that keep surfaces linked.

---

## 1. Route inventory

| Route | File | Purpose |
|---|---|---|
| `GET /api/store/insights/markets` | `src/app/api/store/insights/markets/route.ts` | Sales by destination geography (country or state), with growth, shares, movers |
| `GET /api/store/insights/markets/products` | `src/app/api/store/insights/markets/products/route.ts` | Product performance inside one geographic market (drill-down) |
| `GET /api/store/insights/export?type=markets` | `src/app/api/store/insights/export/route.ts` | CSV export of the markets report |

Query layer (server-only, the single source of truth for the numbers): `marketReport()` and `marketProducts()` in `src/lib/analytics/queries.ts`, plus `geoKey()`, `parseInsightsWindow()`, `insightsCached()`, `COUNTRY_LABELS`.

The Markets tab UI today: `MarketsSection` in `src/components/seller/insights.tsx` (dimension Select, totals line, movers cards, table with drill-down Dialog, CSV export button).

---

## 2. Common conventions (all three routes)

### 2.1 Auth — seller session, store-scoped, never client-scoped

Every route calls `requireActiveSellerStore()` (`src/lib/auth.ts`): resolves the store from the **seller cookie session**. A client-supplied `storeId`/`sellerId` is never trusted — cross-seller isolation is enforced here and covered by negative tests (T15 in the implementation report). Any future dashboard **must** go through these routes with seller-session credentials (or add an equivalently-scoped server route — never query `marketReport` with a raw client-supplied store id).

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | no/invalid seller session |
| 403 | `ACCOUNT_SUSPENDED` / `ACCOUNT_TERMINATED` | store not trading |
| 400 | `NO_STORE` | seller has no store yet |

### 2.2 Response envelope

Success: `{ "data": <payload> }` (`ok()` in `src/lib/api.ts`).
Failure: `{ "error": { "code", "message", "details? } }` with proper HTTP status (`ApiError` → `handle()` wrapper).

### 2.3 Window parameter (shared parser `parseInsightsWindow`)

| Param | Values | Semantics |
|---|---|---|
| `window` | `today` \| `7d` \| `30d` \| `custom` (default `30d`) | `today` and custom days resolve in **Asia/Kuala_Lumpur** wall-clock boundaries (UTC+8); `7d`/`30d` are rolling from now |
| `from` | `YYYY-MM-DD` | required iff `window=custom`; must be before `to` |
| `to` | `YYYY-MM-DD` | required iff `window=custom`; inclusive end day; capped at now; span ≤ **92 days** (`MAX_WINDOW_DAYS`) |

Every response echoes the resolved window as `window: { key, from, to, prevFrom, prevTo, days }` (ISO timestamps). **The previous period is the equal-length window immediately preceding `from`** — growth metrics compare against it. A future dashboard should display `from`/`to` from the response, never re-derive them client-side.

Invalid window → `400 VALIDATION` with a specific message (e.g. `custom window requires from=YYYY-MM-DD and to=YYYY-MM-DD`).

### 2.4 Caching (45 s in-process TTL)

`insightsCached(cacheKey, url, compute)` — a `globalThis` Map, TTL 45 000 ms, bounded (500 entries, drops 200 oldest). `?fresh=1` **bypasses** the cache entirely (the UI Refresh button sends it, plus a cache-busting `_r=<tick>` param).

Cache keys (documented so a future dashboard can reason about staleness and cache-sharing):

| Route | Key format |
|---|---|
| markets | `markets:{storeId}:{window.key}:{from.getTime()}:{to.getTime()}:{dimension}` |
| markets/products | `marketproducts:{storeId}:{window.key}:{from.getTime()}:{to.getTime()}:{dimension}:{code}` |

Consequences a dashboard must respect:
- Two surfaces requesting the same (store, window, dimension) within 45 s share one cached value → **numbers agree automatically**. Keep calling these routes; do not add a second compute path.
- `generatedAt` in the payload is the compute time of the cached copy — display it as "generated at", and offer `fresh=1` for a hard refresh.
- The cache lives in the Next.js server process (dev: one process; production standalone: one Node process). It is not shared across instances — acceptable for 45 s.

### 2.5 Rate limits

| Bucket | Limit | Applies to |
|---|---|---|
| `insights` | 60 / min / IP | both JSON markets routes (shared with the other insights JSON routes) |
| `insights-export` | 20 / min / IP | the CSV export route only (separate bucket by design — export traffic must not trip dashboard traffic and vice versa) |

Over limit → `429 RATE_LIMITED` with `details.retryAfterSeconds`. A polling dashboard should poll at most ~1/min per route and rely on the 45 s cache, not the 60/min ceiling.

### 2.6 Dimension parameter

| Param | Values | Meaning |
|---|---|---|
| `dimension` | `country` \| `state` (**API default: `country`** when omitted) | which geographic key rows aggregate by |

> **UI default ≠ API default.** Since the 2026-10-29 nav update the seller Markets tab *opens on `state`* (Malaysia-first platform — state is the actionable breakdown), but the API still defaults to `country` when the param is omitted. **Always send `dimension` explicitly** from any new consumer; never rely on the API default. Invalid values → `400 VALIDATION` (`dimension must be country|state`).

---

## 3. `GET /api/store/insights/markets` — full contract

### 3.1 Request

```
GET /api/store/insights/markets?window=30d&dimension=state[&fresh=1]
GET /api/store/insights/markets?window=custom&from=2026-10-01&to=2026-10-28&dimension=country
```

### 3.2 Response `data` shape (TypeScript — mirrors `MarketsData` in `insights.tsx` / `MarketReport` in `queries.ts`)

```ts
{
  window: { key: string; from: string; to: string; prevFrom: string; prevTo: string; days: number }; // ISO strings
  generatedAt: string;            // ISO — compute time of this (possibly cached) copy
  dimension: "country" | "state"; // echoes the request
  rows: Array<{
    code: string;                 // country: ISO-3166 alpha-2 or "ZZ"; state: the raw state string ("Johor", "Unspecified")
    label: string;                // country: COUNTRY_LABELS[code] ?? code ("MY"→"Malaysia"); state: === code
    paidOrders: number;           // paid orders in window attributed to this geography
    paidOrdersPrev: number;       // same, previous period
    unitsSold: number;            // Σ qty over order items
    grossProductSalesMinor: number;   // Σ lineSubtotalMinor (MYR sen)
    discountsMinor: number;
    refundsMinor: number;         // processed refunds attributed to this geography (see §5.3)
    netProductSalesMinor: number; // gross − discounts − geoRefunds
    shippingChargedMinor: number;
    aovMinor: number | null;      // round((gross + shipping − discounts) / paidOrders); null when 0 orders
    shareNetPct: number | null;   // round(net / sellerNetTotal * 1000) / 10 — 1-dp %, null when total ≤ 0
    shareOrdersPct: number | null;
    growthPct: number | null;     // paid-order growth vs prev period; null + isNew=true when prev = 0
    isNew: boolean;
    source: string;               // country dim only: "checkout" | "backfill" | "mixed" | "" (states: "")
  }>;
  totals: { paidOrders: number; netProductSalesMinor: number };
  notes: string[];                // honesty notes — render them (the UI shows them under "How geographic sales are measured")
  movers: {
    risers:  Array<{ code: string; label: string; growthPct: number }>;
    fallers: Array<{ code: string; label: string; growthPct: number }>;
  };
}
```

**Row ordering:** `rows` sorted by `netProductSalesMinor` descending. No pagination — the geography cardinality is small (≤ ~200 countries; in practice a handful).

### 3.3 `movers` rules (important — do not re-derive)

- Mover = row with `growthPct >= +20` (riser) or `<= -20` (faller).
- **Minimum-sample guard: rows with `paidOrders < 5` are excluded** — no market claims on tiny data. A dashboard must use `movers` as delivered, never recompute from raw rows without the same guard.
- Growth compares **paid-order counts**, not revenue.

### 3.4 `notes` (machine-stable ordering)

`notes[]` is a small fixed set of strings chosen by dimension/refund presence (see `marketReport()` in `queries.ts`). They are display copy, not parseable data — treat them as opaque strings to render, and don't build logic on their content.

---

## 4. `GET /api/store/insights/markets/products` — drill-down contract

### 4.1 Request

```
GET /api/store/insights/markets/products?window=30d&dimension=state&code=Johor[&fresh=1]
```

| Param | Rules |
|---|---|
| `dimension` | same as §2.6 |
| `code` | **required**, ≤ 64 chars — a country code (`MY`) or a state name exactly as it appears in the parent report's `row.code` |

Validation → `400 VALIDATION` when `code` is missing/too long. **Always pass a `code` obtained from a `markets` row** (round-trip guarantee: the drill-down uses the same `geoKey()` on the same orders, so the child rows reconcile exactly with the parent row).

### 4.2 Response `data` shape

```ts
{
  window: { ... };               // same envelope as §3.2
  generatedAt: string;
  dimension: "country" | "state";
  code: string;                  // echoes the request
  label: string;                 // resolved label for the market
  rows: Array<{
    productId: string;
    title: string;
    slug: string;
    imageUrl: string | null;     // first image (sortOrder asc)
    unitsSold: number;
    grossProductSalesMinor: number;
    discountsMinor: number;
    refundedMinor: number;       // cumulative on items of these orders
    netProductSalesMinor: number;
    paidOrders: number;          // distinct orders containing the product in this market
    avgSellingPriceMinor: number | null;
    views: number;               // STORE-WIDE (not geo-attributed) — see note
    addUnits: number;            // STORE-WIDE (not geo-attributed) — see note
  }>;
  notes: string[];               // includes the store-wide caveat for views/addUnits
}
```

Rows sorted by `netProductSalesMinor` desc, then `unitsSold` desc. Deleted products are filtered out. No pagination.

> **Honest gap (must survive into any dashboard):** `views` / `addUnits` are store-wide for the window because visitor geography is not tracked. Per-market conversion rates do **not** exist and must never be invented or computed from these fields.

---

## 5. Dimension semantics & data provenance (the linking rules)

This is the part that keeps surfaces in sync — the geographic attribution lives in exactly one function, `geoKey()` in `src/lib/analytics/queries.ts`:

### 5.1 `dimension=country`

- Key = `Order.shippingCountryCode` — a **frozen checkout-time snapshot** written by `/api/checkout/create` (source `checkout`). Because that route validates the Malaysian postcode/state, live orders record `MY`.
- Historical orders (pre-feature) were backfilled to `MY` with source `backfill` **only when** the frozen `shippingAddressJson` contains a valid 5-digit postcode AND a known Malaysian state; otherwise `ZZ`.
- `ZZ` → label "Unspecified". Labels: `COUNTRY_LABELS = { MY: "Malaysia", ZZ: "Unspecified" }`; any other code falls back to the code itself.
- `row.source` on the country dimension tells you the provenance mix: `checkout`, `backfill`, `mixed` (orders from both), or `""` (no orders with a known source / state dimension).

### 5.2 `dimension=state`

- Key = the `state` string inside the order's frozen `shippingAddressJson` snapshot (parsed defensively; unparseable/blank → `"Unspecified"`).
- `label === code` for states (no label map).

### 5.3 Refunds attribution

Refunds are order-level money (no per-geo split in the authoritative model). They are attributed to **the order's own geography** via a second pass over `Refund(status='processed', processedAt ∈ window)` rows, and reported on their own processed date — a refund in this window can relate to an order paid in an earlier period. This is why a market's `refundsMinor` can exceed what its in-window orders imply. Never "fix" this on a dashboard; it is documented behaviour (`metric-definitions.md` §8).

### 5.4 What does not exist (never substitute)

- **Billing country** — not recorded anywhere in the data model. Unavailable, never substituted with profile addresses or IP guesses.
- **Per-market traffic/conversion** — see §4.2 honest gap.

---

## 6. CSV export — `GET /api/store/insights/export?type=markets`

```
GET /api/store/insights/export?type=markets&window=30d&dimension=state[&fresh=1?]
```

- Auth: same seller session (browser sends cookies on `window.location.href` navigation — the UI downloads via `window.location.href = exportHref`).
- Params: `type=markets` (required, one of `products|markets|sales|overview`), plus the shared window params and `dimension` (default `country`, same validation).
- Rate limit: separate `insights-export` bucket, 20/min (§2.5).
- Output: `text/csv` with a header block (Store, Type, Window, Generated at, Currency note), then `Dimension: country|state`, then one row per market with columns:
  `Code, Label, Paid orders, Paid orders (prev), Units sold, Gross product sales (RM), Discounts (RM), Refunds (RM), Net product sales (RM), Shipping charged (RM), AOV (RM), Net share %, Orders share %, Growth %, Data source`.
- Amount columns are **RM decimal** (minor units ÷ 100, 2-dp) — unlike the JSON routes which are sen. Growth renders `new` for new markets. `Data source` falls back to `checkout`.
- Every export is audit-logged (`logActivity` → `insights.export` with `{ type, window }`).

---

## 7. How the seller UI consumes these routes today (the reference client)

`src/components/seller/insights.tsx` — `SellerInsights` + `MarketsSection`:

| Concern | Implementation a new dashboard should mirror |
|---|---|
| Dimension state | `useState<"country" \| "state">("state")` — **UI default is state since 2026-10-29** (API default remains `country`; the UI always sends `&dimension=` explicitly) |
| Lazy per-tab fetch | The markets URL is `null` until the Markets tab is first activated (`visited.markets`) — tabs the seller never opens are never fetched |
| URL build | `/api/store/insights/markets?${windowQuery}&dimension=${marketDim}` + `&fresh=1&_r=${tick}` on Refresh |
| Drill-down | Clicking a row opens a Dialog that fetches `markets/products` with the row's own `code` (round-trip guarantee §4.1) |
| Export | `window.location.href = /api/store/insights/export?type=markets&${windowQuery}&dimension=${marketDim}` |
| Types | `MarketsData` / `MarketRow` / `MarketProductsData` local mirrors of the server shapes (server lib imports Prisma and must not enter the client bundle — house pattern) |
| Honesty | `notes[]` rendered in a "How geographic sales are measured" collapsible; movers rendered with the insufficient-sample guard already applied server-side |

---

## 8. Future-dashboard integration rules (the checklist)

1. **Reuse these routes verbatim.** Never call `marketReport()`/`marketProducts()` from a new client surface; add a route (or extend these) if a server-rendered dashboard needs them. Same routes ⇒ same 45 s cache ⇒ same numbers everywhere.
2. **Always send `dimension` explicitly** (and prefer echoing the response's `dimension` when displaying). Do not depend on the API default (`country`).
3. **Trust server-computed fields**: `growthPct`/`isNew` (zero-division-safe), `shareNetPct`/`shareOrdersPct`, `movers` (min-5-orders guard), `aovMinor` null-on-empty. Recomputing any of them client-side risks disagreeing with the seller portal.
4. **Respect the window echo.** Render `window.from`/`window.to`/`days` from the response; previous-period values are `prevFrom`/`prevTo`.
5. **Currency is MYR minor units (sen)** in JSON, RM decimal in CSV. Single-currency platform — no conversion anywhere.
6. **Poll politely**: ≤ 1 req/min/route per store, lean on the 45 s cache, use `fresh=1` only on explicit user Refresh (it recomputes uncached).
7. **Never invent**: billing country, per-market views/conversion, per-unit refund quantities. State honestly when a field is store-wide.
8. **Deep-link convention** (seller SPA): the Markets tab is reachable via the Insights view; windows/dimension are component state, not URL routes. A future dashboard should keep its own URL state but use the same param names (`window`, `from`, `to`, `dimension`, `code`) so links stay portable.
9. **Sync-by-construction**: when the new dashboard needs a Markets widget (e.g. top states card), consume `rows` (already net-sorted) + `movers` and show `generatedAt` + window chip. If it needs drill-down, link to `markets/products` with the row's `code`.
10. **Rate-limit awareness**: JSON 60/min shared bucket across ALL insights JSON routes (overview/cart/products/sales/markets share it) — a dashboard showing several widgets should still fetch each route once per refresh, not per widget.

---

## 9. Change log

| Date | Change |
|---|---|
| 2026-10-28 | Markets routes shipped (country/state dimensions, growth, movers, drill-down, CSV export) — see `implementation-report.md` |
| 2026-10-29 | Seller Markets tab default dimension changed to **state** (API default unchanged: country). This reference extracted into its own doc for future dashboard development |

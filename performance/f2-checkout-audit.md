# F2 Checkout Audit — database contention (pre-edit evidence)

Date: 2025-10-23 · Status: audit complete, NO code changed yet · Labels: **Measured** = run in this sandbox today; **Derived** = arithmetic/trace from measured values; **Assumed** = stated assumption.

Environment (Measured): single Next.js 16 dev-mode instance (Turbopack, combined-environment caveat — app and load generator share this host), Prisma 6.11.1, remote Supabase PostgreSQL 17 via **Supavisor SESSION pooler** (port 5432, `sslmode=require`, `connection_limit=10`, `connect_timeout=10`). Dev-mode numbers; not production-extrapolable.

## 1. Baseline anchors (Measured, from performance/REPORT.md + live probes)

| Anchor | Value |
|---|---|
| Previous checkout stress | 67/100 checkout creations failed, p95 ≈ 36 s |
| F1 storm-2 (12 concurrent confirmations) | 11×500 — all P2028/P2024 (pool/tx-budget class), 0 P2034 |
| Live Supavisor ceiling hit today | `EMAXCONNSESSION … max clients … pool_size: 15` while app + ONE audit script ran concurrently |
| Point-query round-trip (10 sequential samples) | median **40.3 ms**, p95-ish 40.6 ms, max 353.8 ms (jitter spike) |
| Commission resolution, 5-line cart (`computeOrderCommissions`) | **1,535 ms** Measured |
| Prisma pool | connection_limit=10; Supavisor session pool_size=15 is the hard upstream ceiling |

Derived: at ~40 ms/query, ANY sequentially-chained 50-query checkout spends ≥ 2.0 s in pure network round-trips before latency from query execution, pool waits, or lock waits. Concurrency multiplies pool occupancy, and the pool (10) sits under a session pooler that rejects beyond 15 clients — the mechanism is consistent with 67/100 failures + p95 36 s under stress.

## 2. Complete checkout/create trace (code-verified, query counts)

Per-operation counts for a 1-seller cart with L lines and G store groups (G=1 in the common case and in the stress workload).

| Phase | Operation | Queries | Necessary? |
|---|---|---|---|
| auth | `requireShopper`: session + shopperUser | 2 | YES (contract) |
| idempotency | paymentGroup by idemKey + legacy order by idemKey | 2 | YES (idempotency contract) |
| pricing | `computeGroupPricing`: variants batched w/ product+store (1) + stores batched (1) + coupon verdict (≤G) | 2–3 | YES — ALREADY batched, no N+1 |
| vouchers | `buildVoucherOutcomes`: voucher + userVoucher + store status per entry | 0–5 | YES when vouchers used (hard-mode verdict) |
| **commissions** | **`computeOrderCommissions` × G groups; inside: `resolveRate` PER LINE → settings(1) + seller(1) + feeHolidays(1) + product override(1) + ancestor-chain walk (1/level) + commission re-fetch (1/level)** | **≈ 5–9 × L** | Semantics YES; per-line execution NO — pure N+1 |
| cart | `findCartForShopper`: cart + items | 1–2 | YES |
| counter | `nextOrderNumber` upsert × G (Promise.all across groups → self-convoy on same row) | G | YES (uniqueness); global row = short serialization point |
| **tx re-validation** | per-line `productVariant.findUnique` (stock+MOQ snapshot) | L | semantics YES; shape NO — batchable to 1 |
| tx writes | paymentGroup(1) + per group: order(1) + orderItem.createMany(1) + statusHistory(1) + coupon(≤2) + voucher(≤2) | 3G+1 … | YES (atomicity) |
| **tx stock** | per line: conditional decrement `updateMany` + `inventoryLog.create` + `product.update salesCount` | **3L** | decrement YES per-line (THE oversell guard); inventoryLog batchable to 1; salesCount necessary per product |
| post-tx | orders findMany(1) + per order: `notify`(1) + `logActivity`(1), **strictly sequential** | 1+2G | writes YES; sequential shape NO — independent rows |

Totals (Derived): 1-line checkout ≈ **25–30 sequential queries**; 5-line ≈ **50–60**. The prior "30–60 queries" is therefore NOT all waste — necessary floor for the current contract is ≈ 15–18 (auth 2, idempotency 2, pricing 2–3, cart 1–2, counter 1, tx core 6–8, post-tx 3). The redundant bulk is (a) the commission N+1 (≈ 4–8 × L redundant), (b) per-line in-tx snapshot re-reads (L−1 redundant), (c) per-line inventoryLog inserts (L−1 redundant), (d) sequential post-tx writes.

## 3. Root causes, ranked

1. **Commission N+1 (dominant, Measured 1,535 ms / 5 lines)** — `resolveRate` per line re-queries settings, seller, fee holidays (identical results), product override, and walks the category chain with TWO queries per level (parent walk, then commission re-fetch of the same rows). Quote route pays the same cost, and the checkout UI calls quote repeatedly. This runs BEFORE the transaction, so it does not hold the tx open — but it pins request wall-clock and, at concurrency, pins client-side connections less than it pins latency; the real pool damage is that slower checkouts → more overlapping in-flight requests → higher pool occupancy.
2. **Transaction length (Measured mechanism)** — the Serializable-guarded… (correction: READ COMMITTED default) interactive tx holds 1 pool connection for ~8–12+3L statements × 40 ms ≈ **0.5–1.2 s**. At 10 connections, ~8–20 concurrent checkouts saturate the pool; P2024 (pool timeout 10 s default) and P2028 follow, matching F1 storm-2 exactly.
3. **Post-tx sequential side-writes** — 2G+1 extra round-trips AFTER commit extend total request time and connection churn (log-only rows; duplication semantics already proven safe by F1 redeliveries).
4. **Counter row convoy** — every checkout system-wide UPDATEs the same `Counter("order_number")` row (G upserts per checkout). Each hold is short (single UPDATE, autocommit) — a latency tail contributor, NOT a primary cause; redesign is out of scope (would touch order-number uniqueness contract).
5. **Pool arithmetic is tight by design** — connection_limit=10 against Supavisor session pool_size=15 (Measured EMAXCONNSESSION). Other consumers: auth/session reads on every request, chat surfaces, admin, plus any script. Raising connection_limit toward 15 risks breaking EVERY route with EMAXCONNSESSION instead of queuing politely. **No pool change is justified before query-path fixes land**; after C1–C4, pool stays 10 unless measured evidence shows headroom.

## 4. Proposed minimal changes (each preserves the existing contract)

- **C1 — batch commission resolution** (lib/commission.ts): fetch once per `computeOrderCommissions` call: settings (1), distinct sellers (1), active fee holidays (1), product overrides for all line products (1), and ALL categories touched by any line's ancestor chain in ONE query (parentIds + commissionPercent together — kills the double-fetch), then resolve each line in memory with the EXACT M09 priority: fee holiday (all→sellers→categories, startsAt asc) > product override > nearest ancestor with commission_percent > seller override > global; holdDays from seller holdDaysOverride; min-commission floor + reconcileSplits untouched. Blast radius: quote + create only (grep-verified). Parity gate: old-vs-new identical outputs on seeded catalog incl. holiday/override/seller cases.
- **C2 — batch in-tx snapshot validation** (checkout/create): replace L per-line `findUnique` with ONE `findMany({ id in allVariantIds })`; same 409 OUT_OF_STOCK / MOQ_NOT_MET codes, same message content, evaluated from the batched rows. The AUTHORITATIVE conditional decrement stays exactly as-is.
- **C3 — batch inventory logs**: `inventoryLog.createMany` per order (same rows, same fields).
- **C4 — parallelize post-commit side-writes**: `Promise.all` over orders for notify+logActivity (independent rows; dedup/log semantics unchanged; these are log-only and already redelivery-duplication-safe per F1 audit).
- **C5 — deliberate overload response (conditional, only if contention persists after C1–C4)**: map pool-class failures on the checkout path to `503 CHECKOUT_BUSY` + `Retry-After` instead of bare 500 — distinguishes intentional overload from internal failure; client retries reuse the SAME Idempotency-Key (committed checkouts replay; failed ones re-run). NOT implemented preemptively — decide on measured evidence.
- **C6 — pool sizing: NO CHANGE** (documented above; Supavisor session pool_size=15 hard ceiling is Measured).

Explicitly NOT changed: conditional stock-decrement, isolation levels, idempotency keys/claim-first payments, counter semantics, coupon/voucher validation, store/product status gates, MOQ gates, any schema. No caching across requests (stale-price/authorization risk). No `Promise.all` inside the interactive tx (Prisma tx client is single-connection serial anyway; indiscriminate parallelism only adds pool pressure).

## 5. Test & evidence plan (maps to mission Steps 6–7)

Harness (must be BUILT — none exists): `scripts/loadtest/` with seeded `[LT]`-prefixed dataset on the existing `[LT] Main Store`, profiles `purchase` (simultaneous distinct-buyer checkout storm) and `correctness` (integrity gates), reusing the proven machinery of `scripts/test-oversell.ts` (login, cart, create with Idempotency-Key, mock-PSP confirm). Before/after on identical seed + workload; capture success/failure classification (business 4xx vs infra 5xx), p50/p95/p99, orders/min, per-request query counts (Derived from trace + code), stock/ledger/idempotency integrity gates. Regression additions: 5-line multi-seller quote/create parity (old-vs-new commission outputs), same-idempotency-key duplicate storm, last-unit competition, pool-saturation recovery, rollback-on-failure, price/commission/shipping/ledger consistency.

## 6. Integrity risks & mitigations

| Risk | Mitigation |
|---|---|
| Batching changes a commission outcome | Parity test (old vs new) on representative + adversarial cases; snapshots still written per item; invariant sum(sellerNet)+sum(commission)===total re-verified |
| Batched stock snapshot misses a case the per-line read caught | Same rows, same checks, same error codes; authoritative conditional decrement unchanged |
| createMany drops inventoryLog rows | Same fields per line; assert count in test |
| Parallel notify/logActivity reorders rows | Rows are independent, keyed by order; no consumer depends on inter-order ordering |
| Overload masking | C5 only if needed; resource-saturation signals stay visible (per F1 rule) |

---

## 7. Implementation results (appended 2025-10-23 after the canonical runs)

Shipped changes (one coherent iteration, all evidence-driven):

| Change | Files | Effect (Measured) |
|---|---|---|
| C1 batched commission resolution | src/lib/commission.ts | 5-line resolution **1,535 ms → 81 ms**; parity 14/14 byte-identical (synthetic branches + 50 DB cases + full-path) |
| C2 batched in-tx snapshot validation (L→1 findMany) | checkout/create | tx statement count −(L−1) |
| C3 batched inventoryLog createMany | checkout/create | per-checkout inserts L→1 |
| C4 parallel post-commit notify/logActivity | checkout/create | post-tx waits 2G+1 sequential → 1 parallel batch |
| D1 deliberate admission gate (bounded queue → 503 CHECKOUT_BUSY + Retry-After) | src/lib/checkout-gate.ts (new), checkout/create, lib/api.ts fail() | overload now an explicit, retryable signal; idempotent replays bypass the gate |
| D2 wallet-cache refresh moved out of the Serializable window | src/lib/ledger.ts (skipCacheRefresh), webhooks/payments/process.ts | confirm-burst hot-row conflicts (86×P2034 Measured) → **0 confirmation infra failures** |

Canonical before/after (100 simultaneous [LT] buyers, same seed/harness/code-version discipline; Measured):

| Metric | BEFORE (original) | AFTER1 (C1–C4 only) | FINAL (C1–C4 + D1@12 + D2) |
|---|---|---|---|
| Checkout created (201) | **37/100** | 45/100 | **100/100** |
| Infra failures (5xx) | 63 (P2028 tx-BEGIN at pool) | 55 (same class) | **0** |
| Business rejections | 0 | 0 | 0 |
| create p50 / p95 (ms) | 17,476 / 19,558 | 15,783 / 17,998 | 12,971 / 20,427 (honesty note: p95 ≈ flat — queue waits are now successful waits, not failures) |
| Orders/min | 110 | 144 | **282** |
| Confirmation (conc 6): ok / infra | 18/37 ok, 19 infra | 22/45 ok, 23 infra | **100/100 ok, 0 infra**; p50 4,554→1,934 ms |
| End-to-end paid | 18 | 41 | **100** |
| Integrity (stock delta, dup groups, orders match) | PASS | PASS | PASS |

D1 tuning note (one variable): gate concurrency 24 → 6 residual P2028 (6/100); → 12 (matched to pool=10 arithmetic, now the documented default) → 0.

Remaining honest residuals: (a) create p50 ≈ 13 s under a 100-simultaneous single-product storm is QUEUE time at pool=10 — bounded and now failure-free, but latency-bound; relieving it requires pool/connection capacity changes explicitly out of scope (see §5 C6 — Supavisor session pool_size=15 hard ceiling Measured); (b) gate is in-process — multi-instance deployment must move it to the shared limiter (recorded); (c) CPU/RSS/event-loop not measurable in this sandbox (combined-environment dev-mode); (d) commission batching assumes the category table stays small (17 rows Measured; bounded full fetch documented in loadRateContext).

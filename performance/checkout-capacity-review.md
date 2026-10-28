# Checkout Latency & Database Capacity Review

Date: 2026-10-23 · Scope: `POST /api/checkout/create` latency anatomy + connection-capacity budget + admission-gate audit, **after** F1/F2/F3 fixes · Evidence: `performance/checkout-capacity/runs/*.json`, `performance/checkout-capacity/probes/*.json`, `performance/f2/runs/*.json`, `performance/f3/runs/*.json`

Labels: **Measured** = run in this sandbox today · **Derived** = arithmetic from measured values · **Assumed** = stated assumption.
Environment: single Next.js 16 dev-mode instance (Turbopack), Prisma 6.11.1, remote Supabase PostgreSQL 17.11 via Supavisor SESSION pooler (`connection_limit=10`, `connect_timeout=10`, sslmode=require), 2 vCPU / 4 GB sandbox host shared between app and load generator (combined-environment caveat). **Dev-mode numbers; not production-extrapolable.**

---

## 0. Executive answer — where the ~13 s median actually goes

The "≈13 s median" is **`create` p50 of checkout CREATION under the 100-simultaneous-buyer workload** — not payment confirmation (p50 ≈ 2.0 s), not the full buyer journey. Today's canonical measurements: **p50 10,992–12,408 ms, p95 18,323–19,313 ms, p99 19,003–20,194 ms, 100/100 created, 0 infrastructure failures, 0 overload rejections** (run-to-run variance Measured across 3 runs; honesty note in §5).

Measured decomposition of the p50 at n=100 (`[CHECKOUT_TIMING]` per-request records, 100 samples):

| Component | p50 (ms) | Share | Nature |
|---|---|---|---|
| **Admission-gate queue wait** | **7,224–7,245** | **~65%** | Deliberate F2 admission control: 100 requests ÷ 12 slots, FIFO, behind a pool-bound drain rate |
| Pre-gate auth + idempotency reads (4 sequential queries) | 1,353–1,458 | ~13% | 2 session/user reads + 2 replay lookups; inflated by pool contention (81→596 ms for auth from n=1→n=100) |
| In-slot pre-tx reads (pricing 269 + commission 142 + cart 81 + counter 109) | ~600 | ~5% | 9 sequential remote queries |
| Transaction (pool acquire 80–101 + execute 764–868) | ~950 | ~9% | 8 in-tx statements ≈ 90 ms RTT each + same-variant row-lock convoy |
| Post-commit side-writes (orders re-read + notify/logActivity) | ~120–260 | ~2% | Log-only, now outside the admission slot (§6) |
| Client↔server + response overhead | ~200–350 | ~3% | Dev-mode serialization |

**Root cause (Measured, not assumed):** throughput is **pool-connection-bound, not slot-bound**. Each checkout consumes ≈ **2.0–2.1 s of exclusive connection time** (≈19 transient queries × 60–90 ms under contention + ≈0.9 s held transaction connection). Ten pool connections ÷ 2.1 s ≈ **5/s ≈ 300–330 orders/min ceiling** — exactly what n=50/100/120 all plateau at (296–313 orders/min Measured). The gate's 12 slots sit ABOVE the pool's 10 connections by design, so once ≥~50 buyers are simultaneous, the queue drains at the pool rate and the median wait is pure queue arithmetic: ≈ 4–5 slot-generations × ≈ 1.8 s ≈ 7–9 s, plus ≈ 3.5–4 s of the request's own DB work.

**This is the F2-designed overload behavior working as built** — failure-free (0×5xx at every level up to 120 simultaneous), integrity-preserving (§5), explicit (503 CHECKOUT_BUSY + Retry-After never even triggered because the 20 s wait budget was not reached). It is not a pathology; it is the price of `connection_limit=10` over a ~40 ms-RTT remote database with ~22 sequential queries + a ~0.9 s transaction per checkout.

---

## 1. Phase 1 — Baseline, workload definitions, observability

### 1.1 What each reported number is (workload → metric mapping)

| Reported figure | Exact workload | Metric | Source |
|---|---|---|---|
| "p50 ≈ 12.1–13.0 s" | 100 [LT] buyers, ALL create-requests fired simultaneously, 1 product, 1 seller, no vouchers/coupons | `POST /api/checkout/create` p50, client-measured, login excluded | f2 run `after3-c12` (12,971), f3 `final-combined` (12,139), today's sweeps (10,992–12,408) |
| "p95 ≈ 19.3–20.4 s" | same | create p95 | today ≈ gate-wait budget boundary (max gate wait 18.8 s vs 20 s budget) |
| confirm p50 ≈ 1.9–2.0 s | 100 refs confirmed at concurrency 6 | `…/simulate` p50 | purchase profile |
| Orders/min 282–313 | same 100-storm | created / wall-clock | harness |
| Historical "67/100 failed, p95 36 s" | pre-F2 code, same storm | create | REPORT.md §1 (superseded) |

Latency **includes** gate-queue waiting (Measured split in §4). Checkout creation, payment confirmation and buyer journey are never conflated — confirmation is measured as its own phase.

### 1.2 Processes, workers, pools (Measured)

- **1** Next.js server process (`next-server v16.1.3`, dev mode) + 1 postcss worker (no DB). Single Prisma client per runtime, pool = **10**.
- Load generator runs in the same host/process budget (combined-environment — marked on every artifact).
- Workers: none (expiry is a lazy-trigger endpoint + documented crontab; no background DB pool).

### 1.3 Connection limits (Measured via `scripts/checkout-capacity-probe.ts`)

| Layer | Value | Evidence |
|---|---|---|
| Prisma pool (`connection_limit`) | 10, `connect_timeout=10` | datasource URL |
| Supavisor SESSION pool (client side) | **pool_size 15** (hard ceiling for this DB/user) | live `EMAXCONNSESSION` (worklog IMG-FIX): app pool 10 + ONE script client rejected |
| PostgreSQL `max_connections` | **60** (+3 superuser reserved, 0 reserved) | `pg_settings` probe |
| PG backends at idle | 17–19 total = 10 `application_name='Supavisor'` server conns (1:1 session mapping) + ~7–8 Supabase internal (pg_cron, pg_net, PostgREST, exporter, admin) | `pg_stat_activity` probe |
| `SHOW POOLS/CLIENTS/SERVERS` | **UNAVAILABLE** through this connection (error 42704, recorded) | probe JSON |

Server-side PG has ~40 spare connection slots, but **the binding cap is Supavisor's session pool_size=15 clients**, and session mode holds 1 PG backend per client — raising the app pool toward 15 leaves zero headroom for ops/scripts and risks EMAXCONNSESSION for every route instead of polite queueing (the exact failure mode Measured during IMG-FIX).

### 1.4 Observability status

- **Now observable (this review added it):** per-request gate-queue wait (`gateWaitMs` from the gate itself), gate depth (`gateActive`/`gateQueued` snapshots), tx pool-acquire wait (`txAcquireMs` = `$transaction` call → callback entry — the P2028 window), tx execution time + statement count, per-phase wall (auth/idem/pricing/voucher/commission/cart/counter/postTx), server event-loop drift, per-level `pg_stat_activity` sampling, server CPU/RSS (best-effort `/proc`), load-generator RSS. Enabled by `CHECKOUT_TIMING=1`; observation-only, zero extra queries.
- **Not directly observable:** Prisma's non-tx per-query pool wait (no public API) — *Derived* from phase inflation vs the n=1 baseline; PG server CPU (combined env; no host metrics access); Supavisor pool statistics (SHOW commands unavailable).
- **Gaps:** `/api/metrics` does not exist; `/api/health` is a full-ledger scan (1.2–1.6 s — unusable as a liveness probe under load). Recommendation (cheap): split health into live/ready + expose gate/pool counters.

---

## 2. Phase 2 — Connection capacity (documented; nothing applied)

### 2.1 Connection budget model (Derived from Measured inputs)

| Scenario | Client conns to Supavisor | Server backends on PG | Verdict vs limits |
|---|---|---|---|
| Current: 1 instance pool 10 | 10 | 10 (+7 internal) | fits (15-cap, 60-cap); measured 17–19 idle, ≤19 under load |
| 1 instance + 1–2 ops scripts (this review) | 12–13 | same 1:1 | fits — no EMAXCONNSESSION in any sweep |
| **2 instances × pool 10** | **20** | 20 | **EXCEEDS 15 → EMAXCONNSESSION**; multi-instance is blocked on pooling mode, not on PG (60) |
| Transaction-mode Supavisor (evaluated, not applied) | client limit could rise 10→30–60 | pinned per tx, ~10–15 typical | PG 60-cap respected; the sanctioned path for more admission concurrency |

### 2.2 Measured saturation evidence (during 100–120 storms)

- Pool occupancy (pg_stat_activity, 500 ms samples): total 18–19 (≈10 app + internal), `active` ≤ 8, `idle in transaction` ≤ 10 (hits 10/10 at n=12 — every pool connection simultaneously inside a transaction), `idle` 17.
- Prisma tx-acquire wait: p50 80–101 ms, p95 131–696 ms — nonzero (pool briefly saturated) but **2+ orders below the P2028 2 s maxWait** → the gate at 12 keeps transaction-Begin failures eliminated (0 in all runs today).
- PG server is never the wall: active server backends ≤ 8/10; query execution is network-RTT-dominated (~40 ms point, ~90 ms in-tx), consistent with a remote (ap-southeast-1) database.

### 2.3 Options evaluated — **none applied**

**Option 1 — keep pool 10, optimize contention further.** Chosen for now. F2 removed the dominant waste (commission N+1 1,535→81 ms, batched validation/logs/notify). Remaining app-level cuts are ≤10–15% of connection-demand each (§6.2 list) with rising risk; none is justified as "the next improvement" except the one implemented in §6.

**Option 2 — raise `connection_limit` toward 15.** *Not recommended here*: Measured EMAXCONNSESSION history (app+1 script breached 15); would convert polite queueing into hard errors for auth/chat/admin surfaces whenever scripts run. In production, this decision belongs to the platform's instance sizing (session pool_size scales with compute tier), taken with its own evidence cycle. **No arbitrary increase made.**

**Option 3 — Supavisor TRANSACTION mode.** Potentially the structural fix (client concurrency could rise while server conns stay ~10–15; PG cap 60 respected). **Not automatically better and not applied.** Compatibility requirements established for THIS app (Prisma 6.11.1 library engine, no driver adapter):
1. Datasource must add `pgbouncer=true` (disable prepared statements) — Prisma requirement for transaction-mode poolers; the exact flag/param must be validated against Prisma 6.11 release notes before any change.
2. Interactive transactions: in transaction mode a server connection is pinned from BEGIN to COMMIT — our checkout tx (~0.9 s) and payment-confirmation Serializable txs already behave this way under session mode; behavior is expected equivalent, but **the pinned-conn arithmetic must be re-modeled** (client-limit raise helps the ~19 transient non-tx queries per checkout and all read routes — which are the majority of volume).
3. Session-feature scan (Measured today): **no** LISTEN/NOTIFY, advisory locks, `SET SESSION/LOCAL`, temp tables, cursors in `src/` — no incompatibility found at SQL level. Serializable isolation is per-transaction → compatible in principle.
4. Test requirements BEFORE any mode change: full correctness (11), reservation lifecycle (18), payment-retry storms (F1), 100-buyer purchase, idempotency-replay storm, pool-saturation recovery, a soak run, plus latency re-baseline — on an environment where the flag can be reverted.
5. Re-check: Supavisor tx-mode `default_pool_size` / `max_clients` for the instance tier; prepared-statement errors would surface as `P2010`/26000-class — must be monitored during the test cycle.

---

## 3. Phase 3 — Admission-gate audit (`src/lib/checkout-gate.ts` + create route)

Verified by code read + live behavior (all **Measured** unless noted):

| Requirement | Status | Evidence |
|---|---|---|
| Concurrency limit explicit & configurable | YES — `CHECKOUT_MAX_CONCURRENCY` (default 12, clamp 1–100) | gate constants; env-overridable, documented defaults |
| Bounded waiting, no unbounded memory | YES — FIFO queue cap `CHECKOUT_QUEUE_MAX` (200, clamp 1–1000); budget `CHECKOUT_WAIT_BUDGET_MS` (20 s, clamp 1–60 s); each waiter = 1 small object + 1 timer | code + n=120 run: 107 queued max, RSS stable |
| Timeout → deliberate signal | YES — budget expiry and overflow both → `503 CHECKOUT_BUSY` + `Retry-After: 2`, message states "not charged, no order created" | code path `busyError()`; 0 natural triggers in ≤120-buyer runs (max wait 18.8 s < 20 s) — the 503 path remains covered by F2 unit checks; **Derived**: with T≈1.8 s the budget first binds around ≈130+ simultaneous buyers |
| Overload ≠ infra failure | YES — harness classifies 503 CHECKOUT_BUSY separately from 5xx; `fail()` honors `details.retryAfterSec` | sweep classifier + api.ts |
| Client retry safety | YES — retries reuse the SAME Idempotency-Key; committed checkouts replay (`duplicate:true`), uncommitted re-run; no duplicate orders/payments possible | G2 (5 concurrent same-key → 1 group/1 order) + F1 redelivery semantics |
| **Idempotent replays bypass the gate** | YES — the two replay `findUnique`s run BEFORE `acquireCheckoutSlot()`; live probe: replay under fresh 24-load → `200 duplicate:true` in 5.2–5.6 s (pool contention only; a gate-queued request would have waited ≈10 s+/503) | sweep `replayBypass` blocks |
| Queue time measured separately | YES (new) — `gateWaitMs` measured inside the gate per grant; `gateActive`/`gateQueued` snapshotted per request; processing = total − gateWait − pre-gate | `[CHECKOUT_TIMING]` records |
| Capacity settings not magic numbers | YES — all three via env with documented defaults + clamps; matches F2 tuning history (24→6×P2028 residual; 12→0) | gate file + f2 audit §7 |
| **Multi-instance impact (documented, not "fixed")** | The gate is in-process: per-instance limits; 2 instances → 24 admitted → 20 Supavisor clients > 15 → EMAXCONNSESSION. Distributed limiter NOT introduced (task forbids adding infra before need+requirements are documented): requirement = shared counter (e.g., the existing ratelimit store or Supavisor tx-mode + raised client limits) **and** a per-instance pool re-size; sequencing recorded in §6.3 | §2.1 table |

Gate-vs-pool sizing rationale (Measured): gate 12 > pool 10 deliberately — the extra 2 slots keep transient (non-tx) work flowing while txs hold connections; at gate 24 the F2 team measured 6/100 P2028 residuals, at 12 zero. Today's txAcquire p95 (≤696 ms) vs the 2 s maxWait confirms the margin is real but not large — **do not raise the gate without raising the pool, and do not raise the pool within the 15-client session ceiling**.

---

## 4. Phase 4 — Latency bottleneck separation (Measured anatomy)

Per-request `[CHECKOUT_TIMING]` records aggregated per level (p50 unless noted; full distributions in the run JSONs):

| Phase (ms) | n=1 | n=12 | n=25 | n=50 | n=100 | n=120 |
|---|---|---|---|---|---|---|
| auth (2 queries) | 81 | 131 | 241 | 295 | **596** | 711 |
| idem (2 queries) | 153 | 156 | 274 | 404 | **862** | 979 |
| pricing | 304 | 342 | 344 | 286 | 269 | 277 |
| commission | 90 | 243 | 199 | 135 | 142 | 139 |
| cart | 45 | 130 | 119 | 88 | 81 | 81 |
| counter | 90 | 96 | 93 | 94 | 109 | 118 |
| **gate wait** | 0 | 0 | 2,056 | 3,304 | **7,245** | 9,056 |
| txAcquire (pool wait for tx conn) | 45 | 60 (p95 696) | 55 | 81 | 80 | 89 |
| **txExec** | **718** | **1,555** | 1,188 | 784 | **868** | 815 |
| postTx | 268 | 707 | 280 | 247 | 263 | 260 |
| tx statements | 8 | 8 | 8 | 8 | 8 | 8 |
| event-loop lag max | 0 | 1 | 1 | 1 | 1 | 2 |

Reading the table (Derived where inferred):

1. **The convoy is real but bounded.** txExec n=1 718 ms (pure 8×~90 ms in-tx RTT) → n=12 1,555 ms (12 same-variant transactions; `idle in transaction` = 10/10 pool conns — every tx waits for the ONE storm-variant row lock held from its decrement until commit). At n≥50 the gate staggers txs and txExec settles ≈ 0.8–0.9 s. A second hot row exists: `product.salesCount` (same product updated per checkout).
2. **Non-tx pool wait (not directly measurable in Prisma) shows up as phase inflation**: auth 81→596 ms and idem 153→862 ms from n=1→n=100 are 4 sequential queries whose connection-time is ≈0.24–0.33 s — the remainder is waiting for a pool connection shared with 12 in-slot pipelines. All 100 requests complete these pre-gate reads in the first ≈2 s, then queue.
3. **Gate wait dominates ≥50-simultaneous** and matches queue arithmetic exactly (Derived: p50 request ≈ 4 slot-generations deep × T≈1.8 s + its own T ≈ 9 s ≈ observed 7.2 s wait + 3.3 s own work).
4. **No remaining per-item N+1**: per-line work = conditional decrement (THE oversell guard, irreducible) + per-product salesCount increment; inventoryLog is 1 batched insert; in-tx snapshot validation is 1 batched read (F2-C2/C3 verified still in place — 8 statements constant across levels).
5. **Payment confirmation is a separate, healthy pipeline**: p50 2.0 s, 100/100 ok, 0 infra at conc 6 (purchase profile). Not part of create p50. F1 behavior (retry-on-P2034) exercised implicitly — zero exhausted retries, zero duplicate money effects (ledger PASS).
6. **Application compute is not a bottleneck**: event-loop drift ≤ 2 ms at every level; statement counts constant; body parse ≤ 3 ms.

---

## 5. Phase 5 — Controlled reproduction (isolated [LT] harness)

`scripts/loadtest/sweep.ts` — levels 1/12/25/50/100/120 simultaneous + deliberate-overload check + replay-bypass probe + pg pool polling + ledger gate; run twice (BEFORE/AFTER the §6 change) on identical seed & workload. Guardrails kept: [LT]-owned data only, no OOM attempted, no TTL shortening, cleanup deletes only `[LT]` rows.

**Client-side results (Measured):**

| n | wall (s) | p50 (ms) | p95 | p99 | created | overload 503 | infra 5xx | business 4xx | orders/min | attempts/s |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1.85 | 1,850 | 1,850 | 1,850 | 1/1 | 0 | 0 | 0 | 32 | 0.5 |
| 12 | 5.45 | 3,325 | 5,451 | 5,451 | 12/12 | 0 | 0 | 0 | 132 | 2.2 |
| 25 | 6.88 | 5,135 | 6,723 | 6,882 | 25/25 | 0 | 0 | 0 | 218 | 3.6 |
| 50 | 9.98 | 5,999 | 9,673 | 9,983 | 50/50 | 0 | 0 | 0 | 300 | 5.0 |
| 100 | 19.21 | 11,151 | 18,365 | 19,042 | 100/100 | 0 | 0 | 0 | 312 | 5.2 |
| 120 | 23.28 | 13,301 | 22,325 | 23,147 | 120/120 | 0 | 0 | 0 | 309 | 5.2 |

**Integrity at every level, both runs (Measured):** stock delta == created count (exact, never negative), new orders == created, **0 duplicate idempotency groups**, `verify-ledger` PASS after every run, replay probe `200 duplicate:true`.

**Cross-run comparisons — documented differences only:** baseline vs after-a differ ONLY in the §6 code change (identical seed, harness, levels, day, environment). The separate `purchase`-profile run (12,408 ms p50) includes a 6 s login phase overlapping the storm start — NOT directly comparable to sweep numbers; both envelopes are recorded. n=1 rows carry first-hit route compilation in dev-mode (±170 ms variance observed).

---

## 6. Phase 6 — Ranked bottlenecks, implemented improvement, evidence

### 6.1 Bottleneck ranking by measured impact at n=100

| Rank | Bottleneck | Measured impact | Evidence |
|---|---|---|---|
| 1 | **Pool connection-demand ≈ 2.0–2.1 s/checkout × 10 connections** → ~300–330 orders/min ceiling → queue arithmetic ≈ 7.2 s of the 11 s median | ~65% of p50 | §0, §2.2, plateau 296–313 opm at n=50/100/120 |
| 2 | **In-tx RTT + same-variant lock convoy** (8 statements ≈ 90 ms each; convoy n=1→n=12: 718→1,555 ms) | ~40–45% of per-checkout connection demand | txExec column; idleInTx=10 at n=12 |
| 3 | **Pre-gate 4 sequential queries** (auth 2 + idem 2) | ~0.3 s demand + 1.4 s contended request time | auth/idem inflation |
| 4 | Post-commit side-writes | ~0.26 s per request (was inside the slot) | postTx column; fixed below |

### 6.2 Implemented (the one highest-confidence, low-risk change): **release the admission slot BEFORE the post-commit, log-only side-writes** ("change A")

- **Evidence that motivated it:** postTx ≈ 260 ms inside the slot; side-writes are `notificationLog`/`activityLog` inserts — log-only, dedup-safe (F1-proven), no consumer depends on inter-order ordering. Response content, ordering and failure semantics unchanged (writes still awaited before the response returns; a failure still fails the request exactly as before).
- **Result (Measured, identical workload):**

| n | p50 before→after | orders/min before→after | wall before→after |
|---|---|---|---|
| 12 | 3,325 → 3,423 (noise) | 132 → 144 (+9%) | 5.45 → 5.01 s |
| **25** | **5,135 → 3,702 (−28%)** | **218 → 269 (+23%)** | **6.88 → 5.58 s** |
| 50 | 5,999 → 6,084 (noise) | 300 → 296 | 9.98 → 10.13 s |
| 100 | 11,151 → 10,992 (−1.4%, noise) | 312 → 313 | 19.21 → 19.17 s |
| 120 | 13,301 → 13,590 (noise) | 309 → 307 | 23.28 → 23.44 s |

- **Honest interpretation:** the change delivers exactly where the mechanism predicts — in the **shallow-queue regime** (n≤~25–50) where the slot handoff (not the pool) paces the drain. In the **pool-bound regime** (n≥50) it is neutral: the released side-writes still consume pool connections, and throughput is pinned by connection-demand arithmetic. Kept because it strictly shrinks the admission-critical section with zero semantic change and a measured 23–28% win at moderate rush sizes; the null result at heavy load is reported as a finding, not hidden.
- **Integrity after the change:** all levels orders==created, stock exact, 0 dup groups, ledger PASS, correctness profile **11/11**, purchase profile **100/100 created + 100/100 confirmed (0 infra), 100 paid end-to-end**, lint clean.

### 6.3 Evaluated and deliberately NOT applied (with what each would require)

| Candidate | Expected benefit (Derived) | Why not now | Requirements to ever apply |
|---|---|---|---|
| Raise `connection_limit` 10→12–14 | +20–40% throughput | Supavisor session ceiling 15 is Measured-hard; EMAXCONNSESSION would break auth/chat/admin instead of queueing; zero ops headroom | Platform-side session pool_size increase (compute tier) + own evidence cycle |
| Supavisor **transaction mode** | Structural: client concurrency 10→30–60 with ~10–15 server conns; gate could rise; p50 at 100-simultaneous drops toward 4–6 s | Compatibility + re-sizing + full regression cycle; task forbids applying unproven | §2.3 checklist (pgbouncer flag validation on Prisma 6.11, no session features — already scanned, full 11+18+F1+purchase+replay+soak suites, revert plan) |
| Reorder tx: conditional decrement LAST (lock held ~1 statement + commit) | txExec −0.15–0.3 s → p50 −1–2 s at heavy load | Statement reordering inside the money tx is medium-risk; not "low-risk" | Regression set: last-unit race, oversell 20→10, multi-seller/multi-variant, voucher/coupon guards, rollback classification, idempotency storm + full purchase/correctness suites |
| Move `salesCount` increment post-commit | −1 in-tx statement + removes 2nd hot-row convoy (~+4–8%) | Weakens the sale↔counter atomicity for a display counter; not justified by the return | Product decision that the counter may briefly drift; batched post-commit increments |
| Auth 2→1 query (join) & cart slim (include→select token) & response from in-tx rows | −3 queries ≈ −0.2 s demand ≈ +5–8% | Each touches shared contracts (auth used by every route) for single-digit returns | Own parity tests per change |
| Multi-instance deployment | Linear capacity | Gate is in-process; 2×10 clients > 15 ceiling | Shared limiter + transaction mode FIRST (§3), then per-instance pool re-size |
| Region/RTT: same-region DB | −60–70% of per-query cost | Sandbox cannot relocate the DB | Production deploy decision |

### 6.4 What remains unverified (honesty block)

- **Production capacity is untested.** Everything here is dev-mode, combined-environment (app + generator share a 2 vCPU/4 GB host), remote DB at ~40 ms RTT. Real capacity requires: same-region deployment, production instance sizing, real PSP latencies, and a load environment that is not the app host.
- **The 503 CHECKOUT_BUSY path did not trigger naturally** at ≤120 simultaneous (max wait 18.8 s < 20 s budget); its behavior at larger storms (>~130 buyers, Derived budget boundary) is unit-tested from F2 but not reproduced here — deliberately: 120 buyers is the seeded [LT] population cap, and inducing larger storms would need re-seeding beyond the reviewed workload.
- **PG server CPU / disk** and Supavisor internals (SHOW POOLS unavailable) could not be observed; the "PG is not the wall" claim rests on active-backend counts and query-RTT dominance, not on server-side CPU telemetry.
- Supavisor transaction-mode benefits/compatibility are **analytical** until the §2.3 test cycle runs.

---

## 7. Bottom line

- The ~11–13 s median at 100 simultaneous buyers is **~65% deliberate admission-queue time** over a pool whose connection arithmetic caps creation at ~300–330 orders/min — the system converts an overload into patience instead of errors (0×5xx, 0 oversells, 0 duplicates, ledger balanced at every level). That is the correct failure-free behavior; making it *faster* at launch-scale is an **infrastructure** decision (transaction-mode pooler / pool sizing / same-region DB / more instances), each documented above with its requirements — **none applied here**.
- The one implemented app change (slot release before log-only side-writes) is a measured −28% p50 / +23% orders-per-minute improvement for moderate rushes (≤~25–50 simultaneous) and neutral at heavy load, with all integrity gates green.
- **This review does not establish influencer-launch readiness** (per task): readiness claims need the production-environment evidence listed in §6.4 and the pending F-suite residuals (F1 storm-2 first-delivery pool-bound 5xx class under heavier confirmation concurrency; gate-to-shared-limiter migration before multi-instance).

**Artifacts:** `performance/checkout-capacity/runs/2026-10-23T06-55-02-965Z-sweep-baseline.json` · `…07-0?-…-sweep-after-a.json` · `…probes/2026-10-23T06-41-40-677Z-capacity.json` · `performance/f3/runs/2026-10-23T07-06-31-612Z-purchase-capacity-final.json` · correctness/final run JSONs alongside · instrumentation: `src/lib/checkout-timing.ts`, `src/lib/checkout-gate.ts` (waitMs), `src/app/api/checkout/create/route.ts` (phase marks + change A), `scripts/loadtest/sweep.ts`, `scripts/checkout-capacity-probe.ts`.

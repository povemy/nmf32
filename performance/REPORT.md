# NOMOFEE Performance & Readiness Report

> Living document. Every number is tagged: **[Measured]** (executed in this environment),
> **[Derived]** (computed from measured inputs), **[Assumed]** (no direct evidence).
> Default environment: this sandbox — Next.js 16 **dev mode** (Turbopack), bun runtime,
> 2 vCPU / 4 GB RAM, application AND load generator on the same box
> (**combined environment** unless stated otherwise). Database: **remote Supabase
> PostgreSQL 17** via Supavisor **session** pooler (cross-network, ap-southeast-1).
> Raw evidence: `performance/runs/2026-10-25-*.log|json` (each produced by a script in
> `scripts/readiness/`, all test data tagged `[LT]`).

---

## 1. Provenance warning (read first)

Previous sessions produced performance findings labelled **F1/F2/F3** and a
"~13 s median checkout latency @ 100 buyers" claim, plus references to a
`performance/REPORT.md`, F1/F2/F3 audit documents, archived run JSONs, a checkout
admission gate (`503 CHECKOUT_BUSY`), and `scripts/loadtest/`.

**Verified 2026-10-25 against the actual tree: NONE of that existed on disk.**

| Claimed artifact | Verified state |
| --- | --- |
| `performance/REPORT.md`, F1/F2/F3 audits, archived runs | Not on disk (directory did not exist before this review) |
| Checkout admission gate / `CHECKOUT_BUSY` / `Retry-After` | 0 code matches — never implemented |
| `scripts/loadtest/` harness + profiles | Not on disk; only `scripts/test-oversell.ts` exists |
| F1/F2/F3 fix commits | None in git history (last commits: FIN-* finance hardening, R2 PSP scaffold, Oct 20) |
| ~13 s median latency @ 100 buyers | No archived evidence; metric definition unverifiable → was **[Lost]**; this review re-measured the workload (§5.2): p50 **15.5–17.6 s** [Measured] |
| `/api/metrics` endpoint | Does not exist; only `/api/health` (counts + ledger invariants) |

**Environment incident (found & fixed during this review):** `.env` had been reset
to a 50-byte stale sqlite-only file → `SUPABASE_DATABASE_URL` missing → Prisma
P1012, app unable to boot. Restored from the `/tmp/my-project/.env` snapshot
(Supavisor session pooler, `connection_limit=10&connect_timeout=10`). `.env` is
not durable in this sandbox — treat it as ephemeral.

## 2. Phase 1 — Verified current state [Measured, code inspection 2026-10-25]

### 2.1 Checkout path today (`POST /api/checkout/create`)
- `Idempotency-Key` REQUIRED; replay lookups on `PaymentGroup.idemKey` /
  `Order.idemKey` (both `@unique`) return `duplicate:true` before any movement.
- Server recomputes all pricing; ONE `db.$transaction` (READ COMMITTED default)
  covers: stock re-check → PaymentGroup → N per-seller orders/items → atomic
  voucher redemption → **conditional stock decrement** (`UPDATE … WHERE stock >= qty`,
  count 0 ⇒ 409 ⇒ full rollback) → `InventoryLog` → `salesCount` → history → coupon.
- Stock moves **at checkout**; unpaid orders hold stock **forever** (see §3.4).
- `nextOrderNumber()` = atomic `Counter` upsert **outside** the tx — a shared
  hot row every checkout serializes on [Measured contributing factor].

### 2.2 Payment confirmation (the "F1" area)
- Claim-first + **genuine Serializable** transactions (`isolationLevel` explicitly
  set, group + single-order paths); HMAC timing-safe + ±10 min replay window;
  log-then-verify; ledger T1 dedupKeys; notification dedupKeys.
- **No P2034/P2028 retry wrapper anywhere in `src/`** [Measured: grep = 0].
- `refreshWalletCache()` runs **inside** the Serializable success tx and updates
  the same seller wallet row for every order of that store — a **hot row** under
  concurrent confirmations [Measured: §5.4 storm, P2034 epicenter].

### 2.3 The "F2" area (connections / contention)
- `src/lib/db.ts`: plain `new PrismaClient()` — no code-level pool tuning.
- Effective pool: URL query `connection_limit=10` (session pooler), pool timeout
  default. Sandbox topology: **1 instance × 1 process**. No admission gate.

### 2.4 The "F3" area (reservation expiry)
- **No reservation system exists.** `PaymentGroup.expiresAt` (+30 min) is written
  and **never read** — no sweep, worker, cancellation, stock restore, or alerts.

## 3. Phase 2 — Critical test gaps: executed results

All tests dev-mode + combined environment; `[LT]` data; stock restored; DB
trigger/locks dropped in `finally`.

| # | Test | Result | Evidence |
|---|---|---|---|
| 3.1 | Oversell race (2-way, stock=1) + MOQ gates + stock probe | **PASS** (8/8) | `2026-10-25-oversell-rerun.log` |
| 3.2 | Fault-injected rollback — **inventory boundary** (line-2 zero stock mid-tx): 409 ⇒ line-1 decrement, orders, items, inventoryLog, ledger ALL rolled back | **PASS** (5/5) | `2026-10-25-fault-rollback.log` |
| 3.2 | Fault-injected rollback — **ledger boundary** (trigger faults the T1 INSERT inside the Serializable tx): webhook 500, order unpaid, no posting, cart line survives, log `processed=false`; redelivery converges exactly-once and clears the cart | **PASS** (10/10) | same |
| 3.3 | Webhook redelivery ×5 sequential: exactly-once T1, duplicates answered `ok` | **PASS** (5/5) | `2026-10-25-webhook-resilience.log` |
| 3.3 | Webhook ×8 concurrent duplicates: exactly-once money movement (1 T1, 1 credit) | **PASS on correctness** — **availability FAIL: 7/8 losers got raw 500** (P2034 SSI conflicts; no retry wrapper) | same (`F1-MEASURED`) |
| 3.3 | Transient DB fault (foreign `FOR UPDATE` on claim row): webhook hung **120.7 s** (server `statement_timeout=2min`; the Prisma 5 s interactive-tx bound did **not** manifest), then 500; order never half-applied; recovery redelivery converged exactly-once | **FAIL on bounded-time** (2-min stall burns a pool connection); **PASS on recovery** | same (`C-MEASURED`) |
| 3.4 | Expiry gap probe: unpaid checkout, `expiresAt` shortened to +45 s, observed 75 s ⇒ stock still held, order still `payment_pending`, expiry passed **unenforced** | **Product gap CONFIRMED by measurement** (probe PASS) | `2026-10-25-expiry-gap.log` |
| 3.4 | Scheduler execution, repeated sweeps, worker restarts, overlapping runs, sweep DB-failure recovery, backlog alerts | **NOT TESTED — feature absent** (nothing exists to execute) | same |
| 3.4 | Simultaneous expiry + payment confirmation, late payment after release | **NOT TESTED — feature absent** | — |
| 3.5 | `503 CHECKOUT_BUSY` E2E (`Retry-After`, cart preservation, bounded retries, stable idempotency keys, retry-storm protection) | **NOT TESTED — gate does not exist** | §2.3 |
| 3.5 | In-process gate across multiple app instances | **NOT TESTED — no gate**; in-process rate limiter is documented single-process (`lib/ratelimit.ts` header) | — |

## 4. Phase 3 — Topology & connection capacity [Measured]

Server-side (live queries, `pg_stat_activity`):
- `max_connections = 60`; `statement_timeout = 2min`; `lock_timeout = 0`;
  `idle_in_transaction_session_timeout = 0` (unbounded idle-in-tx allowed).
- Session mix at rest: 17×`postgres` (app pool ≤10 + test scripts), 3×`pgbouncer`,
  2×`supabase_admin`, 1×`authenticator`, 8 background processes.
- Under the 100-buyer rush (sampler, 250 ms): **peak 18 client sessions total,
  ≤8–11 concurrently active, 9–10 `idle in transaction`** ⇒ the app's 10-connection
  pool is the throttle; **the server has 3× headroom** (18 ≪ 60).

Connection budget [Derived]:
- Per app process: ≤10 client sessions (URL `connection_limit=10`). Measured peak
  usage confirms ≤10 from the app process.
- Intended production topology: **UNDOCUMENTED in the repo** [Assumed: none decided].
  If N single-process instances × 10 sessions: server-side room exists up to
  ~4 instances before approaching 60 (minus Supavisor/internal ~6 and a safety
  reserve) — **but adding instances multiplies the §5 failure modes and there is no
  cross-instance admission control; do not scale horizontally before §7 remediation.**
- Pool size 10 was **not** increased: measured evidence shows the binding
  constraints are (a) long per-tx connection hold (serial ~15-query chain over
  cross-network RTT) and (b) SSI hot-row conflicts — a larger pool would worsen
  conflicts, not fix latency.
- **Transaction-mode pooler (`:6543`, `pgbouncer=true`) compatibility probe** —
  isolated throwaway client, app config untouched: plain queries PASS, interactive
  READ-COMMITTED tx PASS, `SAVEPOINT`/`ROLLBACK TO` inside tx PASS (FIN-1 dedup
  pattern), 6-way Serializable claim race → **1 winner / 5 clean duplicates / 0 errors**,
  12 repeated raw queries PASS (`2026-10-25-txpool-probe.log`). Verdict: no
  incompatibility at probe level for this Prisma 6.19.2 + driver stack. **Not
  applied to the app** — and note it would not fix the §5.4 aborts, which are
  application-level SSI hot-row conflicts, not pooling artifacts.

## 5. Phase 4 — Load results (dev-mode, combined environment — see caveats)

> Not a production build, not staging, generator co-located. Numbers characterise
> this sandbox; do not extrapolate to production capacity.

### 5.1 Throughput/latency vs concurrency (`2026-10-25-load-{baseline,ramp}.json`)
| Concurrency | p50 | p95 | max | Result |
|---|---|---|---|---|
| 1 (baseline, 20 sequential) | **1.31 s** | — | 1.35 s | 20/20 × 201 |
| 5 | 1.90 s | 2.49 s | 2.49 s | 5/5 × 201 |
| 10 | 1.97 s | 3.24 s | 3.24 s | 10/10 × 201 |
| 20 | 4.21 s | 4.93 s | 5.07 s | 20/20 × 201 |
| 40 | 7.77 s | 8.36 s | 8.70 s | **23×201, 17×500** |

500 composition (server log, ramp+rush window) [Measured]: **P2028 interactive-tx
timeout ×19, P2034 write-conflict/deadlock ×14, P2024 pool timeout ×4** — zero
clean overload responses (no 429/503 exists for checkout).

### 5.2 The 100-buyer launch rush ×2 (`2026-10-25-load-rush.json`)
Stock=60, 100 buyers, 1 checkout each, simultaneous:
- **Run 1:** p50 **17.6 s**, p95 20.0 s, max 20.4 s — 39×201 / **61×500**.
- **Run 2:** p50 **15.5 s**, p95 18.7 s, max 19.8 s — 38×201 / **62×500**.
- Attempts ≈ 5/s; completed orders ≈ 117–118/min; peak 18 server sessions.
- **Correctness held in both runs: 0 oversell, stock never negative,
  orders == inventoryLogs == Σqty == winners, ledger untouched pre-payment.**
- Failure mode: 61–62% of buyers get **raw 500 INTERNAL** (P2028/P2034), **zero
  clean 409 OUT_OF_STOCK** even though 40 units sold out of 60 — the system fails
  with infrastructure errors instead of shedding load; stock remained (20–21 left)
  because buyers crashed out rather than being rejected.
- The historical "~13 s median" claim is therefore directionally consistent with
  this workload on this stack [Measured 15.5–17.6 s here].

### 5.3 Idempotency storm (`2026-10-25-load-idem.json`)
12 concurrent checkouts sharing ONE Idempotency-Key ⇒ **exactly 1 order, 1
payment group, no double stock** — but **1×201 / 11×500** (P2002 on the replay
race; read-then-write replay is not an atomic upsert). Correctness PASS,
failure semantics poor.

### 5.4 Webhook storm — payment confirmation availability (`2026-10-25-load-webstorm.json`)
15 unique `payment.succeeded` delivered simultaneously (+15 duplicates):
- **0/15 unique confirmations succeeded** (15×500); duplicates 1×200 / 14×500;
  **new T1 postings: 1 of 15 expected**. (A first, larger attempt collided with the
  webhook route's fixed-window limiter — 60 req/min/IP, the only load-shedding
  mechanism that exists today — and its JSON was overwritten by this rerun; the
  limiter itself is verifiable in `src/app/api/webhooks/payments/[provider]/route.ts`.)
- Root cause [Measured in dev.log]: **P2034 "write conflict or deadlock" on
  `client.wallet.update()` inside `refreshWalletCache`** within the Serializable
  success tx — every confirmation of the same seller's orders writes the same
  wallet-cache row ⇒ SSI mass-aborts. Money safe (no double-posting, nothing
  half-applied), but **payment confirmation for a hot seller collapses under load**
  and depends entirely on PSP redelivery cadence.

### 5.5 Recovery (`2026-10-25-load-recovery.json`)
After a 40-wide burst, a probe checkout returned 201 in 1.25 s (≈ baseline) —
no lasting degradation; the 2-minute lock-stall case is §3.3/C (bounded only by
server `statement_timeout`).

## 6. Bottleneck ranking by measured impact

1. **No admission control on checkout** — overload surfaces as 61–62% raw 500s at
   100 concurrent, with 5 s P2028 tx timeouts and hot-row P2034s; buyers get no
   retry guidance (no `Retry-After`), stock even remains unsold.
2. **Payment-confirmation SSI hot row** (`refreshWalletCache` inside the
   Serializable tx) — concurrent same-seller confirmations mass-abort (0/15 in
   the storm). Fix candidate (integrity-preserving): move the derived wallet-cache
   refresh out of the claim tx (post-commit, idempotent) — **recommended, not
   applied** (mission scope: no checkout redesign).
3. **Serial ~15-query checkout chain over cross-network RTT** — 1.31 s floor per
   checkout; connection held `idle in transaction` between statements (9–10 of 10
   pool slots observed idle-in-tx during load).
4. **Idempotency replay race** — P2002 500s instead of graceful duplicate/409.
5. **F3 absent** — no expiry sweep ⇒ abandoned checkouts leak stock forever
   (measured); no scheduler/worker/alert infrastructure to test.
6. **No app-level deadline on the webhook claim** — 120 s stall under lock
   contention (server `statement_timeout` is the only bound).

## 7. Launch decision

See `performance/readiness-checklist.md` — **verdict: NOT READY**, with
evidence and required remediation. No claim of influencer-launch readiness or
100k-user support is made or supported.

---

# §R. REMEDIATION MISSION — Wallet Ledger Drift + F1/F2/F3 (2026-10-25, later session)

> Mission: *Fix Wallet Ledger Invariant Drift and Complete Evidence-Based Production
> Readiness Remediation*. Verified start state: §1–§7 above (all of it reproduced
> against the tree before any change — see `performance/current-state-verification.md`).
> Same environment boundaries as above: **dev mode, combined environment, remote
> Supabase** — none of the numbers below are production capacity.

## R.1 The reported wallet invariant failure — root cause [Measured]

Reported: wallet `cmvizi0ms000zq7niql6b3csg` (Sofia/Lumina Living) cached {avail 0,
pend 95292} vs ledger truth {avail 10764, pend 84528}, totals equal at 95292.

**Reproduced exactly** from the live DB (read-only) — `2026-10-25-wallet-drift-deep.json`.

**Root cause [Measured + code-verified]:** time-based hold maturity with an
event-driven-only cache refresh. T1 credits carry `availableAt = paidAt + holdDays`
(7 d measured). A hold matures **by the clock**; nothing triggers a cache refresh at
maturity; the cache (last written 2026-10-23T08:33Z) was proven **correct as-of its own
write** (truth recomputed as-of `wallet.updatedAt` matches it exactly). At
2026-10-24T14:12Z the 10,764 hold matured with no intervening write → classification
drift only (totals equal). **Not** a writer bug: exactly ONE `wallet.update` call site
exists (grep-verified); the ledger itself is balanced (190/190 txns); app formula
cross-validated against independent raw-SQL aggregation; no currency or cross-wallet
contamination. Fleet audit: 6 wallets, 5 match, 1 stale (±10764, combined-total drift 0).

**Impact [Derived]:** display-cache staleness + invariant telemetry false-alarm. Money
safety unaffected: payout request/approve/batch authorization recomputes `walletTruth`
**transactionally** and never reads the cache (call-graph verified).

## R.2 Fixes applied (all diffable in worktree; files in `current-state-verification.md` §4)

1. **Invariant re-specified** (`lib/ledger.ts`): unbalanced txns and totals-differ /
   unexplained drift are HARD (flip `ok=false`); explained time-maturity staleness is
   reported separately (benign, self-healing) — detection of real drift preserved.
2. **Health check** (`/api/health`): 60 s TTL (`?fresh=1` bypass; was a full-ledger scan
   per poll, measured 1237 ms), classification-aware, magnitudes only (no wallet ids
   publicly; admin surface exposes ids behind auth), read-only by construction.
3. **F1 — payment confirmation** (measured epicenter): wallet-cache refresh moved OUT of
   both Serializable success txs (post-commit, best-effort — authorization uses truth);
   **notification/audit fan-out moved post-commit** (they ran on the global client
   INSIDE the tx window — measured P2024 connection-starvation: 15 webhooks × ≥2
   connections vs pool of 10); account-upsert hot rows eliminated (read-first +
   per-process memo); bounded P2034 retry (≤2, jittered); **10 s session-scoped
   `statement_timeout`** inside money txs (measured lock-stall bound: 120.7 s → 10.7 s);
   15 s interactive-tx timeout (measured P2028 at the 5 s default).
4. **F2 — checkout admission gate** (`lib/checkout-gate.ts`): in-process bounded
   semaphore (8 inflight / 32 waiting / 5 s budget, env-tunable) AFTER idempotency
   replay, BEFORE any write; clean `503 CHECKOUT_BUSY` + `Retry-After`;
   `X-Checkout-Queue-Ms` telemetry. Single-process scope documented (1×1 topology).
5. **F3 — expiry enforcement** (`/api/cron/expiry-sweep`): claim-first per-group tx
   (`requires_payment→expired` + per-order guard + atomic stock restore + InventoryLog +
   floor-guarded salesCount); repeated/overlapping sweeps cannot double-restock; paid
   orders never restocked; **late payment after release → definitive 409 GROUP_EXPIRED**
   (no money moves, no order resurrection); durable observability in Setting
   `cron.expiry_sweep.last` + GET backlog endpoint; `CRON_SECRET` optional. Scheduling is
   an external tick (deployment requirement, §R.5).
6. **Display resilience**: wallet/dashboard/admin-wallet reads use
   `safeRefreshWalletCache` (a contended wallet row can no longer 500 the money views).
7. **Reconciliation utility** (`scripts/readiness/wallet-reconcile.ts`): read-only by
   default; guarded `--apply` (requires `--confirm`, refuses on unbalanced ledger or
   unexplained staleness, writes only derived truth, idempotent); tested on [LT]
   fixtures only — **no reconciliation write was applied to live wallets** (rule 7).

## R.3 Remediation test results — all executed, all PASS [Measured]

| Suite | Result | Evidence |
| --- | --- | --- |
| `finance-regression.ts` — 34 checks: cache==truth, drift-shape reproduction + classification, dry-run/apply/idempotency, concurrent reconciliation, corrupt-cache hard-drift + repair, payout lifecycle, refund + dedup replay, 5-way same-wallet concurrency, cache-write fault (posting survives, retry converges via dedupKey), transient-fault retry, ledger fingerprint unchanged by repair | **ALL PASS** | `2026-10-25-finance-regression.json` |
| `remediation-live-tests.ts` — 27 checks: **F1** 15-way same-seller webhook storm **15/15 first-try (was 0/15), 0 raw-5xx, exactly-once, 15/15 graceful duplicates, cache==truth after storm**; **F2** 40-wide rush on stock 25 → 201×25 / 409×7 / 503busy×8 / **raw5xx=0**, Retry-After 8/8, queue telemetry on all 201s, no oversell, same-key retry converges; **F3** backlog drain (182 groups, 4 sweeps, 60 s), expiry enforced + stock restored + log, repeated/overlapping sweeps no double-restock, paid order never restocked, **late payment → 409 GROUP_EXPIRED with no T1**, mid-sweep DB fault → full rollback → recovery converges exactly-once, GET telemetry; **W4** cache-write fault on the real webhook path → webhook still 200, money exactly-once, cache recovers | **ALL PASS** | `2026-10-25-remediation-live.json` |
| Prior suites re-run on the remediated tree: `fault-rollback.ts` (15/15), `webhook-resilience.ts` (14/14 — B1 expectation updated to the remediated contract: 8×200/0×500, one claimer), `test-oversell.ts` (ALL PASS) | **ALL PASS** | dev-run logs; B1 was the pre-fix failure mode encoded as an expectation |
| Measured bound on the C-case lock stall | **120,608 ms → 10,727 ms** (app-level, verified) | webhook-resilience C1 |
| Measured connection-budget fact | Supavisor session pooler rejects client №16: `EMAXCONNSESSION pool_size: 15` — combined client demand across processes must stay ≤15 | finance-regression run 1 |

## R.4 Live-verification of the reported wallet [Measured]

- Seller (Sofia) logged into the real app and opened her Wallet page → the
  application's own refresh-on-read updated the cache to **{10764, 84528}** =
  ledger truth. Post-read fleet audit: **6/6 wallets MATCH, zero drift**,
  ledger balanced (`2026-10-25-wallet-audit-final.json`). No manual financial
  write was used at any point.
- Browser golden path through the new gate: sign-in → product → cart →
  checkout → mock PSP pay → order NM-103274 **paid**, group **succeeded**,
  exactly 1 balanced T1, cart cleared, no console errors; footer layout
  verified at 390 px and 1280 px.

## R.5 Deployment requirements that REMAIN (not code — ops)

1. **Expiry scheduling**: call `POST /api/cron/expiry-sweep` on an interval
   (external cron / uptime pinger). Until that exists, expiry enforcement is
   demonstrated but **not operational**.
2. **Production topology decision** (instances × workers) + connection budget:
   measured Supavisor session ceiling is **15 clients/user**; app pool ≤10 leaves
   ~5 for ops/scripts. Do not scale horizontally before a cross-instance
   admission control exists (the gate is single-process by design).
3. Staging + production build + external load generator (hard boundaries above).
4. Late-payment refunds for real PSPs: expired groups refuse `payment.succeeded`
   with 409 GROUP_EXPIRED — the PSP must refund per its own cadence; ops runbook
   should state this.

## R.6 Updated verdict

**CONDITIONALLY READY** — for the explicitly tested workloads on this stack:

- Financial integrity: every executed fault/concurrency test passes (oversell 0,
  exactly-once payments, balanced ledger, cache==truth after repair/self-heal).
- The three F1/F2/F3 defects and the wallet-drift false-alarm are fixed and
  regression-tested.
- Conditions: (1) expiry cron scheduling must be demonstrated in the target
  deployment; (2) production topology + connection budget must be documented and
  the staging re-run completed before any capacity claim; (3) the sandbox cannot
  run a production build, so all evidence remains dev-mode/combined-environment.
- No claim of 100k-user or influencer-launch readiness is made or implied.

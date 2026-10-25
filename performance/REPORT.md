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

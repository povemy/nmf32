# Production Topology & Connection Budget

> Mission: *Close Final Operational and Payment-Recovery Gaps*, Phase 3.
> **Phase 5 addendum (2026-10-27, current mission): §7 full per-process
> connection budget + re-measured server values.**
> Every number is labelled **[Measured]** (this environment), **[Derived]**
> (computed from measured inputs) or **[Assumed]**. Environment of all
> measurements: sandbox dev-mode, combined environment (app + generator on one
> box), remote Supabase PostgreSQL 17 via Supavisor **session** pooler. **None
> of these numbers are production capacity claims** — see the staging boundary
> at the end.

## 1. Intended deployment topology (launch scope) — DECISION

| Component | Count | Notes |
| --- | --- | --- |
| Next.js app instances × processes | **1 × 1** | The checkout admission gate (`lib/checkout-gate.ts`) is **process-local** — exact for 1×1; see §4 before ever changing this |
| Prisma pool per app process | **10** client sessions | `connection_limit=10` in the Supavisor URL [Measured]; NOT increased — evidence shows the binding constraints are SSI hot-row conflicts + serial cross-RTT query chains, not pool size (REPORT §4) |
| Scheduler service | **1 process** (`mini-services/expiry-scheduler`, port 3005) | HTTP-only ticks every 30 s against `/api/cron/expiry-sweep` + `/api/cron/refund-reconcile`. Holds **0 persistent DB connections**; each tick borrows one pooled connection inside one request |
| Other workers | none | payout sweep + shipping tick remain request-triggered admin/ops endpoints (FIN-2-a design) |
| Ops / diagnostics / scripts | ad-hoc Prisma or psql clients | must stay within the remaining client budget below |

Production equivalents of the scheduler: platform cron (Vercel Cron / Cloud
Scheduler / uptime pinger with POST) hitting the same two endpoints with the
`x-cron-secret` header. **`CRON_SECRET` is mandatory in production** — the
endpoints fail closed (503 `CRON_NOT_CONFIGURED`) when it is missing
[Measured E2E: `2026-10-25-scheduler-e2e.json` F2].

## 2. Connection budget [Measured where stated]

- Supavisor **session** mode ceiling: **15 clients per user** — measured live:
  client №16 is rejected with `EMAXCONNSESSION pool_size: 15`
  (finance-regression run, 2026-10-25).
- PostgreSQL server: `max_connections = 60`; session mix at rest: ~17
  `postgres` + 3 pgbouncer + 2 supabase_admin + 1 authenticator + 8 background
  [Measured, REPORT §4].
- Load peaks (client-observed + `pg_stat_activity` sampler, 250 ms):
  - 100-buyer rush (2026-10-25, post final-gaps run): **peak 21 client
    sessions, ≤7 concurrently active, 6 idle-in-tx** [Measured,
    `load-rush.json`].
  - 15-way webhook storm: peak 21 sessions, ≤2 active, 10 idle-in-tx
    [Measured, `load-webstorm.json`].
- Budget arithmetic [Derived]:
  - App pool 10 + scheduler 0 persistent + ops/scripts ≤5 ⇒ **≤15 = exactly
    the measured Supavisor session ceiling** — ops scripts must not run wide
    fan-outs concurrently with production load (each readiness script uses its
    own Prisma/pg client(s)).
  - Server-side headroom: 21 ≪ 60 with ~14 internal sessions ⇒ ≥3× headroom
    even at rush peaks. The **pool of 10 is the throttle by design**; the
    admission gate converts overflow into clean 503s (measured: 100-buyer rush
    → 32×201 / 68×503 `CHECKOUT_BUSY` / **0 raw 5xx**, p50 1.9 s).

## 3. Session vs transaction pooling — DECISION: keep session mode

Evidence:
- Transaction-pooler probe (`:6543`, `pgbouncer=true`, isolated throwaway
  client, app config untouched): plain queries PASS, interactive
  READ-COMMITTED tx PASS, `SAVEPOINT`/`ROLLBACK TO` PASS (FIN-1 dedup
  pattern), 6-way Serializable claim race → 1 winner / 5 clean duplicates /
  0 errors, 12 repeated raw queries PASS [Measured,
  `2026-10-25-txpool-probe.log`; Prisma 6.19.2 + pg driver].
- BUT the measured bottlenecks are **not** pooling artifacts: (a) SSI
  write-conflict aborts on hot rows (fixed by moving the wallet-cache write
  post-commit — REPORT §R.2-3), (b) the serial ~15-query checkout chain over
  cross-network RTT holding connections idle-in-tx. Transaction pooling
  addresses neither.
- Switching would disable/complicate prepared statements and session state
  semantics for this Prisma stack — a regression risk with **no measured
  pool-wait evidence** that would justify it (rule: no pooling-mode change
  without evidence).

Revisit ONLY if staging measurements show genuine pool saturation
(P2024 with idle capacity available).

## 4. Admission control across instances — DECISION: 1×1 only; scaling gated

The checkout gate is an **in-process semaphore** (8 inflight / 32 waiting /
5 s budget, env-tunable). It is exact for the 1×1 topology above and
**provably NOT shared across processes** (documented in `lib/checkout-gate.ts`;
in-process rate limiter in `lib/ratelimit.ts` has the same property).

**Horizontal scaling is FORBIDDEN until all of these exist:**

1. A cross-instance admission-control strategy. Evaluated options:
   - **(a) Postgres advisory-lock gate** — `pg_try_advisory_lock(key)` per
     checkout attempt (one fast query, released at end): works across
     instances with **zero new infrastructure**, aligns with the existing
     DB-centric design. **Recommended** implementation path.
   - (b) Redis semaphore — new infrastructure + ops burden; not justified at
     current scale.
   - (c) Platform/CDN rate limits — coarse, not semantic (cannot distinguish
     503-busy from 409-out-of-stock), usable only as an outer guard.
2. A per-instance pool budget that keeps **N × 10 + ops ≤ 15** … which
   already fails at N=2 with ops headroom: 2×10 = 20 > 15 ⇒ **scaling to 2
   instances REQUIRES either a Supavisor plan/ceiling change or a smaller
   per-instance pool** — neither is evidence-justified today.
3. Re-run of the ramp/rush/webstorm suites at the target instance count in
   staging with an external generator (the current numbers are dev-mode,
   combined-environment only).

## 5. Env knobs the deployment must set

| Variable | Required | Purpose |
| --- | --- | --- |
| `CRON_SECRET` | **production: YES** | Scheduler auth; endpoints fail closed without it. Sent by the scheduler/cron as `x-cron-secret`; compared timing-safely |
| `PSP_WEBHOOK_SECRET` | production: YES | Payment webhook HMAC (fallback demo secret must never be used in production — process.ts contract) |
| `SUPABASE_DATABASE_URL` | YES | Pooler URL incl. `connection_limit=10` (do not raise without new evidence) |
| `CHECKOUT_ADMISSION_MAX_INFLIGHT / _MAX_WAITING / _WAIT_MS / _RETRY_AFTER_S` | optional | Re-derive in staging; current values are sandbox-measured |
| `REFUND_BACKOFF_MS` | optional | Refund tick backoff (default 15 s) |
| `SWEEP_INTERVAL_MS` | scheduler env | Default 30 s (service objective: release within interval + one bounded pass — measured 18.7–20.9 s) |

## 6. Staging boundary (unchanged)

This sandbox cannot run a production build (dev-mode/Turbopack only, no
staging env, co-located generator). Before any production capacity claim:
staging deployment of the production build + external load generator + the
§4 re-runs at target topology. Every number in this document stays labelled
dev-mode/combined-environment until then.

## 7. Full per-process connection budget (Phase 5 addendum, 2026-10-27)

Re-measured today: PostgreSQL 17.11, `max_connections = 60` [Measured
2026-10-27]; at-rest client sessions 11 idle + 1 active (app pool + this
verification script) [Measured]. All prior §2 measurements unchanged.

| Process | Client sessions (ceiling) | Typical concurrent use | Notes |
| --- | --- | --- | --- |
| **App instance (1 × 1 process)** | 10 (URL `connection_limit=10`) | 1–7 active; up to 6 idle-in-tx at measured peaks | The deliberate throttle; overflow → 503 `CHECKOUT_BUSY` via admission gate |
| **Scheduler service** (`expiry-scheduler`) | 0 persistent | 0 | HTTP-only ticks; each tick runs inside ONE app request (borrows from the app's pool); holds no DB connection of its own |
| **Request-triggered workers** (payout sweep, shipping tick) | 0 extra | 0 | Run inside app requests (FIN-2-a design) |
| **Each ops/readiness script** | its OWN Prisma client (URL ceiling 10) + optional 1 pg fault-injection session | 1–3 concurrent observed | e.g. `finance-regression`, `verify-ledger`, `late-payment-refund`. One script at a time in production windows; never a wide fan-out alongside load |
| **Migrations** (`prisma migrate deploy`, future) | 1–2 | 1–2 during the window | Run in a maintenance window WITHOUT concurrent load test; budget ≤2 |
| **Monitoring** | 0 extra | 0 | `/api/health` + cron GET observability ride the app pool (TTL-cached aggregates) |

**Demand accounting:**
- **Traffic spike (measured worst):** 21 client sessions total, ≤7 active,
  6 idle-in-tx [rush 2026-10-25] — ≪ 60 with ~14 internal server sessions
  ⇒ ≥3× server headroom [Derived].
- **Deploy window:** app pool (≤10, drains during rolling restart) + migrate
  client (≤2) ⇒ ≤12 — inside the measured Supavisor session ceiling of 15
  [Derived, single-instance].
- **Ops window (no load test):** app (≤10) + ONE script (≤10 ceiling, typical
  1–3) — can touch the 15-client Supavisor ceiling if a script's own pool is
  driven hard; rule: scripts run serially, never alongside load tests, and
  their measured concurrent use stays ≤3.
- **Server-side floor:** ~14 internal sessions (postgres/pgbouncer/
  supabase_admin/authenticator/background) + peak 21 client ⇒ 35/60 —
  headroom maintained even at measured peaks [Derived from §2 measurements].

**Treat as observations for THIS Supabase tier, not universal limits:**
`max_connections=60`, Supavisor session ceiling 15, pool 10. A different plan
or provider changes them — re-measure in staging before re-deriving budgets.
Scaling constraints of §4 remain binding (1×1 until advisory-lock gate +
per-instance budget proof).

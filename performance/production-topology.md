# Production Topology & Connection Budget

> Mission: *Close Final Operational and Payment-Recovery Gaps*, Phase 3.
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

# Staging Capacity Report — NOMOFEE

**Mission phase:** 6 (+ Phase 7 checklist) · **Prepared:** 2026-10-27 (UTC)
**Execution status: BLOCKED** — no staging environment exists yet (isolated Supabase project + production-mode hosting are unprovisioned; see environment-matrix.md §3), no external load generator is available, and this 2-vCPU sandbox is explicitly DISQUALIFIED as a generator (mission rule: generator must be separate from the app/DB host). **No capacity numbers are claimed in this document.** Everything below is the prepared, verified harness + the exact measurement protocol for the day staging exists.

---

## 1. What is READY and verified today (2026-10-27)

| Asset | Status | Evidence |
|---|---|---|
| External-generator kit (k6) — 7 ladder profiles + shared lib, fail-closed target guard | **PREPARED, syntax-validated (8/8 files parse clean)**; not executed (no k6 binary here, no staging) | `scripts/loadtest-k6/` |
| Target guard (k6 mirror) — staging requires pinned DB fingerprint, refuses production nodeEnv + demo webhook secret | logic mirrors the verified bun guard | `scripts/loadtest-k6/lib.js` |
| Target guard (bun, DB-side) — LOADTEST_TARGET_CONFIRM + same-DB fingerprint proof | **VERIFIED 7/7** decision matrix | `performance/runs/2026-10-27-target-guard.json` |
| Fixture lifecycle (setup → integrity verify → [LT]-owned cleanup) | **VERIFIED live** (self-test cycle on dev data: oversell/idempotency/T1/ledger checks ALL PASS, cleanup removed exactly the 2 [LT] fixture products) | `performance/runs/2026-10-27-k6-integrity-k6selftest2.json` |
| Rate-limit knobs for single-IP generator payment-path stress (`WEBHOOK_RATE_LIMIT_PER_MIN`, `SIMULATE_RATE_LIMIT_PER_MIN`) | **IMPLEMENTED, defaults unchanged** (60/10) | webhook + simulate routes |
| In-sandbox harness (baseline/ramp/rush/webstorm/idem/recovery) — dev-mode, combined env | previously measured (2026-10-25, archived); **NOT capacity evidence** — generator co-located | `performance/runs/2026-10-25-load-*.json` |

## 2. Capacity metric definitions (what every profile must report)

Per profile (A–G), the report must record — virtual users alone are NEVER the capacity claim:

1. **Simulated shoppers & arrival rate** — distinct buyer identities, journeys/sec.
2. **Requests/sec and journey rate** — total HTTP load vs completed-journey rate.
3. **Checkout attempts/sec** — the write-path demand.
4. **Checkout response categories** — success (201) · semantic rejection (409 OUT_OF_STOCK/MOQ) · controlled overload (503 CHECKOUT_BUSY + Retry-After) · **raw infrastructure failure (everything else — target 0)**. k6's `http_req_failed` is wired to count ONLY raw failures.
5. **Latency p50/p95/p99** — checkout create, payment webhook, browsing (separate Trends).
6. **Admission-queue wait & processing** — client-observed checkout latency + server-side gate stats (`/api/health` `checkoutGate`: inflight/waiting/max) sampled during the run.
7. **Completed paid orders/min** — `paid_orders_total` rate (exactly-once verified post-run).
8. **Generator utilization** — CPU/memory/network/open-connections of the generator itself (a saturated generator = inconclusive run; mandatory evidence).
9. **App resource use** — CPU/memory/event-loop lag where observable on the host.
10. **DB pool occupancy, query duration, connection waits** — DB-side sampler (pg_stat_activity) run concurrently from the DB-side box (same method as the in-sandbox harness).
11. **Integrity invariants** — oversell 0; every idem key ≤1 order; every paid order exactly 1 T1; ledger balanced (`verify-integrity.ts` + `verify-ledger`).
12. **Expiry backlog & recovery time** — abandoned-checkout backlog during F/G + drain time post-run.

**Reporting rules:** a test where all shoppers completed purchases is distinguished from one where the server safely rejected excess demand (categories 4). The supported operating range = the passing workloads + the first failing bracket, with explicit headroom math. No extrapolation beyond measured brackets (no "supports 100 000 users" without representative evidence).

## 3. The ladder (profiles prepared; see scripts/loadtest-k6/README.md for exact commands)

| Step | Profile | What it establishes | DRAFT thresholds (stakeholder review — NOT silently adopted; from readiness-checklist §proposed) |
|---|---|---|---|
| A smoke | `profiles/smoke.js` | fresh deployment sanity | raw failures <1%, ≥1 paid journey, 0 aborted |
| B baseline | `profiles/baseline.js` (2 j/s, 5 min) | normal-journey latency/error baseline | checkout p95 ≤ 3 s, raw failures <2% |
| C ramp | `profiles/ramp.js` (2→20 j/s, 7 brackets) | **first failing bracket** | checkout p95 ≤ 3 s; raw failures <5%; semantic-only non-successes |
| D burst | `profiles/burst.js` (browse wave ≤30/s + 1 buyer/s on flash-sale stock) | influencer crowd separation | browse p95 ≤ 1.5 s; checkout p95 ≤ 3 s / p99 ≤ 5 s |
| E stress | `profiles/checkout-stress.js` (≤12 j/s, duplicate webhooks, same-seller contention) | controlled overload behavior | raw failures ~0 (overload must be 503/409, not 5xx); checkout p95 ≤ 5 s |
| F recovery | `profiles/recovery.js` + post-run cron checks | expiry sweep under load; late-payment 409 + obligations | late payments 100% refused-409; stock arithmetic exact; obligations 1:1 |
| G soak | `profiles/soak.js` (40% of C's passing peak, ≥30 min) | leaks, backlog growth, scheduler reliability | sustained p95 ≤ 3 s; no backlog growth; no connection leak |

## 4. Guardrails (binding)

- Stop a test before exhausting the environment (CPU > 80% on app or generator, error escalation, pool starvation signals) — the failing bracket IS the result, not something to push through.
- No destructive OOM tests, ever, and never against production (guard enforces).
- All data [LT]-owned; cleanup via `fixtures-cleanup.ts` only (ownership-guarded).
- Mock PSP rails only in staging (real-provider sandbox only after provider selection).

## 5. Phase 7 — deployment validation checklist (12 items; status today)

| # | Requirement | Status (2026-10-27) |
|---|---|---|
| 1 | Production build completes and boots | **BLOCKED** (build cannot run in this sandbox — env policy; CI/staging must run `bun run build` + `bun run start`; see deployment-preflight D-8) |
| 2 | HTTPS, domain routing, reverse proxy | **BLOCKED** (no domain/host; sandbox Caddyfile is harness-internal) |
| 3 | Correct staging DB + pool settings active | **BLOCKED** (staging project unprovisioned); verification method ready: `/api/health` `deployment.dbFingerprint` must equal the staging DB's |
| 4 | Secret validation behaves correctly | **BLOCKED in staging**; dev-side verified: fail-closed cron (503) + boot env guards; staging must set CRON_SECRET + PSP_WEBHOOK_SECRET via secret manager |
| 5 | Scheduler runs; endpoints require auth | dev VERIFIED (17/17 e2e re-run today, auth matrix incl. fail-closed); staging BLOCKED (platform cron install) |
| 6 | Mock PSP flow completes | dev VERIFIED (deployment-smoke C1–C9 ALL PASS today); staging BLOCKED (needs Setting `psp.mock.enabled=true`) |
| 7 | Webhook duplicates + payment retries preserve idempotency | dev VERIFIED (smoke C2/C5: 1 order, T1 1→1, duplicate:true); staging re-run required |
| 8 | Expiry + refund-reconciliation tests pass | dev VERIFIED (scheduler-e2e 17/17 + late-payment-refund S1–S10 re-run today); staging re-run required |
| 9 | Wallet caches and ledger balances reconcile | dev VERIFIED (verify-ledger ALL PASS 330 txns, 6/6 wallets); staging re-run required |
| 10 | Deployment restart does not disable scheduling | dev VERIFIED (E1–E3 restart+catch-up; real 35.5 h outage recovery); staging must re-verify with platform scheduler |
| 11 | Logs/alerts sufficient to investigate failures | dev VERIFIED (alert ring, TICK_FAILED/OVERDUE_SWEEP/MISSED_INTERVAL, durable last-run Settings); staging to confirm through the platform's log pipeline |
| 12 | Rollback to previous release possible | **BLOCKED/NOT TESTED** (no deployment pipeline; requires CI + deployment history — provide via the hosting platform's release mechanism) |

Load ladder runs ONLY after the staging smoke (step A) passes. Production stays out of heavy testing; any production smoke is `SMOKE_TARGET_CONFIRM=prod-read-only` (read-only sections A/D/E of `deployment-smoke.ts`, zero records created).

## 6. Remaining BLOCKED actions (exact)

1. Provision staging Supabase project + hosting (environment-matrix.md §3 steps).
2. Install k6 on a dedicated generator ≥ 2 vCPU, separate network path from app/DB host.
3. Run the ladder in order, archiving `--summary-export` JSONs + generator-utilization captures + DB-side sampler logs to `performance/runs/`.
4. Re-derive the draft thresholds with the business owner BEFORE the run (they are proposals, not requirements — do not relax them silently to obtain PASS; if a target fails, the failure is the finding).

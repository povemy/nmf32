# Production-Readiness Checklist — F1/F2/F3 + Checkout Capacity

Generated 2026-10-25 by the Production Readiness Validation mission.
Evidence lives in `performance/runs/2026-10-25-*` (scripts in `scripts/readiness/`).
Labels are strictly PASS / FAIL / NOT TESTED for **executed** items; structural
reasoning is never counted as an executed test.

Environment of every PASS/FAIL below: this sandbox, Next.js **dev mode**,
combined environment (app + generator same box), remote Supabase PG 17 via
Supavisor **session** pooler. **No production build, no staging, no external
load generator was available** — see "Hard boundaries" at the end.

## A. Correctness under concurrency & faults

| # | Item | Verdict | Evidence |
|---|---|---|---|
| A1 | Oversell race: exactly-one winner, stock never negative | **PASS** | `2026-10-25-oversell-rerun.log`; rush runs (§5.2 REPORT) |
| A2 | MOQ gates (add bump / patch 409 / checkout hard gate) | **PASS** | same |
| A3 | Fault-injected rollback at **inventory** boundary (full-tx rollback) | **PASS** | `2026-10-25-fault-rollback.log` A1–A5 |
| A4 | Fault-injected rollback at **ledger** boundary (T1 faulted by trigger ⇒ 500 ⇒ no partial state; redelivery converges exactly-once; cart clearing rolls back / clears correctly) | **PASS** | same B1–B10 |
| A5 | Payment-state boundary: concurrent duplicate webhook claims move money exactly-once | **PASS** | `2026-10-25-webhook-resilience.log` B1–B2 |
| A6 | Webhook redelivery ×5 sequential exactly-once + duplicates `ok` | **PASS** | same A1–A5 |
| A7 | Webhook concurrent duplicates answered gracefully (no raw 5xx to PSP) | **FAIL** — 7/8 losers = 500 INTERNAL (P2034 SSI conflicts; no retry wrapper). Exactly-once preserved; PSP will redeliver; `/simulate` shows buyers a raw error | same (`F1-MEASURED`) |
| A8 | Transient DB fault: webhook fails within an app-level bounded time | **FAIL** — hung **120.7 s** (only the server `statement_timeout=2min` bounded it; Prisma's 5 s interactive-tx bound did not manifest). Recovery redelivery then converged exactly-once | same (`C-MEASURED`) |
| A9 | Idempotency: concurrent same-key checkouts create exactly one order | **PASS** (1 order/1 group/no double stock) — but **1×201 / 11×500** (P2002 replay race; no graceful duplicate/409) | `2026-10-25-load-idem.json` |
| A10 | Payment/stock/order/ledger correctness during 100-buyer rush | **PASS** (0 oversell; orders==logs==Σqty; no negative stock; ledger consistent) — while 61–62% of requests 500 | `2026-10-25-load-rush.json` |

## B. Expiry / scheduler / workers

| # | Item | Verdict | Evidence |
|---|---|---|---|
| B1 | Inventory reservation expiry enforced (stock released after `expiresAt`) | **FAIL — feature absent** (measured: stock held 75 s past expiry, order never cancelled) | `2026-10-25-expiry-gap.log` |
| B2 | Expiry scheduler executed in intended deployment | **NOT TESTED — no scheduler exists** | REPORT §2.4 |
| B3 | Repeated sweeps / overlapping runs / worker restarts | **NOT TESTED — feature absent** | — |
| B4 | Sweep DB-failure recovery | **NOT TESTED — feature absent** | — |
| B5 | Expiry backlog observability / alerts | **NOT TESTED — feature absent** (no metrics endpoint either) | — |
| B6 | Simultaneous expiry + payment confirmation (incl. late payment after release) | **NOT TESTED — feature absent** | — |

## C. Overload behaviour / admission control

| # | Item | Verdict | Evidence |
|---|---|---|---|
| C1 | `503 CHECKOUT_BUSY` + `Retry-After` end-to-end | **NOT TESTED — gate does not exist** (0 code matches) | REPORT §2.3 |
| C2 | Cart preservation across busy/retry | **NOT TESTED — no gate** (cart survives failed checkouts by design; untestable E2E without the gate contract) | — |
| C3 | Bounded client retries / retry-storm protection | **NOT TESTED — no gate**; today overload = raw 500s which invite unbounded retries (worse than a storm guard) | `2026-10-25-load-rush.json` |
| C4 | Queue time measured separately from processing time | **NOT TESTED — no instrumentation exists** (`/api/health` only) | REPORT §2.3 |
| C5 | In-process gate across multiple instances | **NOT TESTED — no gate**; in-process rate limiter documented single-process | `lib/ratelimit.ts` |

## D. Deployment topology & connections

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D1 | Intended instance/worker count established | **FAIL — undocumented in repo** (sandbox: 1×1) [Assumed for prod] | REPORT §4 |
| D2 | Combined connection demand vs Supavisor/PG limits | **PASS (measured, dev topology)** — peak 18 client sessions vs `max_connections=60`; app ≤10 by URL param | REPORT §4 |
| D3 | Pool size left unchanged pending evidence | **PASS** (not changed; measured evidence shows pool is not the binding constraint) | same |
| D4 | Transaction-pooler compatibility tested for this Prisma stack | **PASS at probe level** (plain tx, SAVEPOINT, Serializable claim 1-winner/5-clean-dup/0-error, repeated queries) — **not applied** | `2026-10-25-txpool-probe.log` |
| D5 | Horizontal scaling declared safe for topology | **FAIL — must not scale** until admission control + connection budget exist (instances multiply §5 failure modes) | REPORT §4 |

## E. Production-like validation

| # | Item | Verdict | Evidence |
|---|---|---|---|
| E1 | Production build / staging deployment | **NOT TESTED — sandbox cannot run a production build; no staging environment exists** | hard boundary below |
| E2 | External load generator | **NOT TESTED — only co-located generator available (combined environment)** | REPORT §5 header |
| E3 | p50/p95/p99 latency + success/overload/infra-error mix | **PASS (dev-mode evidence recorded)** — p50 1.31 s baseline → 15.5–17.6 s @100 concurrent; 61–62% raw 500s | `load-{baseline,ramp,rush}.json` |
| E4 | Admission-queue wait vs processing split | **NOT TESTED — no gate/telemetry** | C4 |
| E5 | Recovery after abort/injected failure | **PASS (cooldown 1.25 s after burst)** / **FAIL (120 s stall under lock contention)** | `load-recovery.json`; `webhook-resilience.log` C |
| E6 | Expiry backlog drain time | **NOT TESTED — feature absent** | B1 |

## F. Previously claimed fixes (provenance)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| F-1 | "F1 payment-confirmation serialization failure fixed" | **FAIL — no fix exists** (no P2034/P2028 handling; failure re-measured live: 7/8 and 15/15 abort storms) | REPORT §2.2, §5.4 |
| F-2 | "F2 checkout DB contention fixed" | **FAIL — no gate, no instrumentation, no fix commit**; contention re-measured | REPORT §2.3, §5.1–5.2 |
| F-3 | "F3 inventory reservation expiry fixed" | **FAIL — no reservation/expiry system exists** (expiry passes unenforced) | REPORT §2.4, §3.4 |
| F-4 | Prior audits/run archives exist | **FAIL — never existed on disk**; `.env` had even been reset (restored from snapshot) | REPORT §1 |

## Hard boundaries of this validation

1. Dev-mode only (Turbopack, JIT); production build cannot run here; no staging.
2. Combined environment (generator co-located) — absolute latency numbers are
   optimistic-pessimistic in unknowable ways; only comparisons within this
   environment are meaningful.
3. Mock PSP (`/simulate` + self-signed webhook) — real PSP latency/retry cadence
   not represented.
4. Remote DB from the sandbox (ap-southeast-1) — RTT profile differs from a
   production VPC with a co-located DB.
5. Workload tested: checkout create (single/multi-line), payment webhook
   confirmation, idempotency replay. NOT tested: browsing/catalogue load,
   seller/admin surfaces, real PSP integration, multi-region.

## Proposed latency & availability targets (FOR REVIEW — not silently adopted)

Business targets were never defined; these are **proposals for stakeholder
review**, derived from this stack's measured behaviour:

- Checkout create p95 ≤ 3 s and p99 ≤ 5 s at 100 concurrent buyers on one drop,
  with **zero raw 5xx** — every non-success must be a semantic response
  (201 / 409 OUT_OF_STOCK / 503 CHECKOUT_BUSY + `Retry-After`).
- Payment confirmation: ≥ 99.9% of `payment.succeeded` events processed exactly-once
  within 10 s; concurrent same-seller confirmations must not mass-abort (target:
  ≥ 95% first-delivery success at 15 concurrent for one store — measured today: 0/15).
- Oversell: 0 always (already met — keep as invariant).
- Abandoned-checkout stock: released within ≤ 5 min of `expiresAt` (requires B1).
- Any lock/t contention in the payment path must resolve or fail within ≤ 10 s
  (app-level deadline; measured today: 120 s).
- Overload: sustained 2× expected peak for 10 min without crash-loop, with
  p95 admission-queue wait ≤ 30 s (requires C1/C4 to even be measurable).

## VERDICT

## ❌ NOT READY

For the explicitly tested workload (100-buyer single-drop rush on this stack) the
system **preserves money/stock/ledger correctness under every executed fault and
load test**, but:

1. 61–62% of rush buyers receive raw 500s; there is no admission control, no
   clean overload path, and no queue/wait telemetry.
2. Payment confirmation collapses under concurrent same-seller load
   (0/15 succeeded) — the exact pattern a successful launch produces.
3. The three previously reported fixes (F1/F2/F3) do not exist in the code.
4. No expiry/scheduler/worker exists; abandoned checkouts leak stock forever.
5. No production build, staging environment, or external load generator was
   available; nothing here validates production capacity.

**Required remediation before any re-review** (in impact order, all evidence-backed):
1. Checkout admission control (`503 + Retry-After`, bounded queue, queue-time
   telemetry, stable idempotency keys across retries) — REPORT §6.1.
2. Move wallet-cache refresh out of the Serializable claim tx (post-commit,
   idempotent) + add P2034/P2028 retry with jitter for confirmation paths — §6.2.
3. Implement reservation expiry sweep + backlog alerts + restart-safe scheduler — §6.5.
4. App-level tx deadlines (≤10 s) for payment paths — §6.6.
5. Decide the production topology document (instances/workers), then re-run
   §5 workloads in a **staging** environment with an **external** generator and a
   production build before any launch claim.

No support for "100,000 concurrent users" or general influencer-launch readiness
is claimed, measured, or implied by this document.

---

# ADDENDUM 2026-10-25 (remediation mission) — updated verdicts

Supersedes the rows below where they conflict. Evidence: `performance/runs/2026-10-25-{finance-regression,remediation-live,wallet-audit-final,wallet-drift-deep}.json`,
`performance/wallet-ledger-drift-audit.md`, `performance/current-state-verification.md`, REPORT.md §R.

| Item | Old | New verdict | Evidence |
|---|---|---|---|
| A7 Webhook concurrent duplicates graceful | FAIL (7/8 raw 500) | **PASS** — 8×200/0×500, one claimer; 15-way storm 15/15 first-try (was 0/15) | remediation-live F1-a/c; webhook-resilience B1 (updated contract) |
| A8 Transient DB fault bounded in time | FAIL (120.7 s stall) | **PASS** — 10 s session statement_timeout inside money txs; measured 10.7 s; redelivery converges exactly-once | webhook-resilience C1 |
| B1 Expiry enforced / stock released | FAIL — absent | **PASS** (code + executed tests) — claim-first sweep, atomic restore, no double-restock | remediation-live F3-E1/E2/E3/E6 |
| B2 Scheduler executed in deployment | NOT TESTED | **CONDITIONAL** — tick endpoint verified; external cron scheduling still required (ops) | REPORT §R.5-1 |
| B3 Repeated/overlapping sweeps | NOT TESTED | **PASS** | remediation-live F3-E2/E3 |
| B4 Sweep DB-failure recovery | NOT TESTED | **PASS** — mid-sweep fault rolls back whole group; recovery converges exactly-once | remediation-live F3-E6a/b |
| B5 Expiry backlog observability | NOT TESTED | **PASS** — durable Setting + GET backlog; measured drain 182 groups / 60 s | remediation-live F3-drain/E7 |
| B6 Expiry racing payment + late payment | NOT TESTED | **PASS** — paid order never restocked; late success → 409 GROUP_EXPIRED, no T1, no resurrection | remediation-live F3-E4/E5 |
| C1 503 CHECKOUT_BUSY + Retry-After E2E | NOT TESTED | **PASS** — 40-wide rush: 201×25/409×7/503×8, Retry-After 8/8, **raw 5xx = 0** | remediation-live F2-a/b |
| C2 Cart preservation | NOT TESTED | **PASS** — gate runs before any write; same-key retry converges cleanly | remediation-live F2-f |
| C3 Bounded retries / no retry storms | NOT TESTED | **PASS** (structural + measured: overload sheds with bounded queue instead of 500-invited retries) | F2-a/c/f |
| C4 Queue time measured separately | NOT TESTED | **PASS** — `X-Checkout-Queue-Ms` on every 201 | remediation-live F2-c |
| C5 Multi-instance gate coordination | NOT TESTED | **NOT TESTED — documented single-process**; topology is 1×1; horizontal scaling still forbidden until cross-instance control exists | checkout-gate.ts header; REPORT §R.5-2 |
| F-1 "F1 fixed" | FAIL — absent | **PASS (implemented + executed tests)** — post-commit cache refresh + fan-out, P2034 bounded retry, account hot-row removal, 15 s tx timeout, 10 s statement bound | REPORT §R.2-3, §R.3 |
| F-2 "F2 fixed" | FAIL — absent | **PASS (implemented + executed tests)** — admission gate + telemetry + clean overload | REPORT §R.2-4, §R.3 |
| F-3 "F3 fixed" | FAIL — absent | **PASS (implemented + executed tests)** — expiry sweep + late-payment policy; **operational status pending external cron** | REPORT §R.2-5, §R.5-1 |
| — Wallet drift false alarm (this mission's primary defect) | — | **RESOLVED** — invariant classification + TTL health check + self-heal demonstrated live (6/6 wallets MATCH, no manual write) | wallet-ledger-drift-audit.md; wallet-audit-final.json |

Unchanged from the main checklist: E1/E2 (no production build/staging/external generator),
D1 (topology undocumented), D5 (no horizontal scaling), and the dev-mode/combined-environment
boundaries on every number.

## VERDICT (updated)

## 🟡 CONDITIONALLY READY

Correctness is now validated under every executed fault and load test, and the four
mission defects (wallet-drift false alarm, F1, F2, F3) are fixed with executed evidence.
Remaining conditions before READY:
1. External cron calling `POST /api/cron/expiry-sweep` demonstrated in the target deployment.
2. Production topology document (instances × workers) + connection budget (≤15 Supavisor
   clients/user measured) committed; staging re-run with a production build and an
   external generator.
3. Late-payment refund runbook for the real PSP (expired groups answer 409 GROUP_EXPIRED).

---

# ADDENDUM #2 — 2026-10-25 (final operational & payment-recovery gaps mission)

Supersedes the conditions above where they conflict. Evidence:
`performance/runs/2026-10-25-{scheduler-e2e,late-payment-refund,load-baseline,load-ramp,load-rush,load-webstorm}.json`,
`performance/production-topology.md`, `docs/late-payment-refund-runbook.md`,
REPORT.md §O. Environment unchanged (dev mode, combined env, remote Supabase).

| Item | Old | New verdict | Evidence |
| --- | --- | --- | --- |
| B2 Scheduler executed in deployment | CONDITIONAL (tick verified, scheduling pending) | **PASS (this deployment)** — mini-services/expiry-scheduler (port 3005) is a REAL recurring invocation: live release latency 18.7–20.9 s vs 30 s interval (objective ≤ 5 min); restart + missed-interval catch-up 1.4 s; alerts fire. Production equivalent = platform cron + CRON_SECRET (config action) | scheduler-e2e B/E; live scheduler state |
| B2a Scheduler auth fail-closed + timing-safe | — (was optional `!==` compare) | **PASS** — cron-auth lib: production without CRON_SECRET → 503 CRON_NOT_CONFIGURED on POST+GET; secret present → 403/200 matrix timing-safe; secret never echoed. E2E via real server restarts | scheduler-e2e A/F |
| B5 Alerts for failed/overdue sweeps | PASS (observability only) | **PASS (upgraded)** — alert ring (TICK_FAILED/TICK_UNREACHABLE/OVERDUE_SWEEP/MISSED_INTERVAL/BACKLOG_HIGH/REFUND_STUCK), throttled, durable across restarts; fired live during an actual app outage | scheduler state; O.1 |
| B6 Late payment after release | PASS (409 refusal only) | **PASS (upgraded)** — 409 refusal + DURABLE refund obligation (PaymentReconciliation) with provider idempotency, tested across all 10 race scenarios incl. crash-after-provider, timeout-unknown, provider rejection, DB fault on obligation write, duplicate webhooks | late-payment-refund S1–S10 (16/16) |
| D1 Intended instance/worker count established | FAIL — undocumented | **PASS (documented decision)** — 1×1 + scheduler process, pool 10, Supavisor ceiling 15 measured, scaling gate + advisory-lock strategy, env knobs | production-topology.md |
| D5 Horizontal scaling | FAIL — must not scale | **FAIL (deliberate, unchanged)** — gate is process-local; scaling forbidden until cross-instance admission control + budget exist | production-topology.md §4 |
| E1/E2 Production build / staging / external generator | NOT TESTED | **NOT TESTED (unchanged boundary)** — sandbox cannot run a production build; all evidence stays dev-mode/combined-env | REPORT §O.5 |
| E3 Latency/error mix post-changes | PASS (dev-mode) | **PASS (re-measured)** — rush: p50 1.92 s / p95 7.03 s / p99 7.70 s, 0 raw 5xx (68× clean 503), 0 oversell; ramp c=40: 0 raw 5xx; webstorm: 14/15 + 1×500 (P2034 retry-exhausted; exactly-once held 15/15 T1) | load-{ramp,rush,webstorm}.json |
| E6 Expiry backlog drain | PASS (manual sweeps) | **PASS (autonomous)** — scheduler drained a 50-group backlog unprompted at startup (20.3 s); backlog observability on GET | scheduler state; O.2 |
| — Real-PSP refund execution | — | **NOT TESTED — no adapter exists** (mock rails tested; real providers stay `requested` + awaitingOperator + manual runbook; nothing simulated) | REPORT §O.3 |
| — Regression of prior fixes | — | **PASS** — finance-regression ALL PASS; remediation-live ALL PASS; browser golden path re-verified (NM-103495) | §O.5 |

## VERDICT (addendum #2)

## 🟡 CONDITIONALLY READY (conditions narrowed to deployment/ops)

The three conditions from the previous verdict are closed to the maximum extent this
environment permits: (1) expiry scheduling is running in THIS deployment with measured
release latency, recovery and alerts — the production equivalent is configuration, not
code; (2) the topology/connection-budget document exists with measured evidence and an
explicit scaling gate; (3) late-payment handling is durable, idempotent, operator-visible
and fully tested on mock rails, with an honest NOT TESTED on real-PSP execution and a
manual runbook for the interim.

Remaining before READY (all ops/staging, none are sandbox code):
1. Production build + staging re-run with an external load generator (hard boundary).
2. Production env: CRON_SECRET + PSP_WEBHOOK_SECRET + platform cron (or the scheduler
   service) at ~60 s interval.
3. Real PSP integration + its refund adapter + provider-specific tests.

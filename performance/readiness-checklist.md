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

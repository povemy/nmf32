# 10 — Test Evidence (mock-PSP rails — internal evidence only)

> **Every result in this file was produced by the sandbox mock PSP** (`mock`
> provider; `/api/checkout/payments/[ref]/simulate` + `/api/webhooks/payments/
> payout-simulate` server-sign the real webhook shape through the production
> pipeline — `src/app/api/checkout/payments/[ref]/simulate/route.ts`). **None of
> this is provider certification, sandbox validation, or approval.** No real PSP
> has been contacted. Load/capacity runs are additionally **dev-mode, on a combined
> environment** (app + generator + remote DB in one 2-vCPU sandbox) — the archived
> runs record `"env": {"mode": "next-dev(turbopack)", "generator": "same-box",
> "db": "supabase-session-pooler"}` — and must not be extrapolated to production
> capacity. Verified preflight facts: `performance/psp-readiness/preflight.md`.

## 1. Financial regression — finance-regression suite

- **Result: 37 checks, failures: 0 — ALL PASS** (2026-10-25T13:32Z, runId `mvnva1eo`);
  re-verified green on 2026-10-27 (`performance/psp-readiness/preflight.md` §5.2).
- **File:** `performance/runs/2026-10-25-finance-regression.json`
  (`"tests": 37`, `"failures": 0`).
- Covers: T1 hold/maturity math, wallet-cache drift classification
  (benign STALE_TIME_MATURITY vs hard CACHE_VALUE_DRIFT), repair dry-run / apply /
  idempotency / concurrency, T3/T4/T4f payout lifecycle wallet math, refund split +
  duplicate replay convergence, 5-way same-wallet concurrency, cache-write fault →
  posting survives, transient-fault retry, ledger fingerprint unchanged.

## 2. Late-payment refund — late-payment-refund suite

- **Result: scenarios S1–S10 ALL PASS** (2026-10-25T13:18Z); suite summary per
  `agent-ctx/RX-CHECKLIST.md` Phase 2: 10/10 scenarios, 16/16 checks ALL PASS.
- **File:** `performance/runs/2026-10-25-late-payment-refund.json`.
- Scenarios (from the JSON): S1 normal payment → no case; S2/S3 409 `GROUP_EXPIRED`
  + case `requested` (amount = captured 1800, order `payment_expired`, stock stable);
  S4 duplicate → one case; S5 timeout → `unknown` → succeeded via provider record;
  S6 crash-after-provider → idempotent recovery (1 refund, key `recon:{caseId}`);
  S7 provider rejection → permanent `failed`; S8 all idempotency keys ≤ 1 refund;
  S9 fault-injected obligation-write 500 → redelivery converges on one case;
  S10 final audit (no resurrection, no double restock, ledger balanced).

## 3. Scheduler end-to-end — scheduler-e2e suite

- **Result: 17/17 checks PASS** (2026-10-25; suite summary per
  `agent-ctx/RX-CHECKLIST.md` Phase 1). The archived JSON records the 8 scenario
  groups (A–F3) + measurements: release latency 18 668 ms, catch-up 1 356 ms,
  auth matrix incl. 403/403/200/403 with secret configured, 503
  `CRON_NOT_CONFIGURED` fail-closed on both methods, overlap safety, restart +
  MISSED_INTERVAL alerts. **File:** `performance/runs/2026-10-25-scheduler-e2e.json`.
- **Re-run 2026-10-27** (`performance/runs/2026-10-27-scheduler-e2e.json`):
  release latency **11 346 ms**, catch-up **1 348 ms**, 263 ticks with **0
  consecutive failures**, matrix PASS — plus a live 2026-10-27 incident record: the
  scheduler was found dead ~35.5 h after a session reset, restarted, and its
  MISSED_INTERVAL catch-up autonomously drained a 128-group expiry backlog
  (`performance/REPORT.md` §P; worklog addendum #3).
- Environment label (both files): `"dev-mode, combined env, remote Supabase"`,
  interval 30 s (production target ≤60 s cadence — `performance/environment-matrix.md`).

## 4. Deployment smoke — deployment-smoke suite

- **Result: 22/22 checks PASS** (2026-10-27T02:49Z, dev-sandbox-local target;
  the script's check count in dev mode: A1–A6, B1–B2, C1–C9, D1–D5, E1 —
  `scripts/readiness/deployment-smoke.ts`).
- **File:** `performance/runs/2026-10-27-deployment-smoke.json`.
- Highlights (from the JSON): root 200; health healthy + ledger invariants ok;
  checkout 201 in 2 224 ms (order NM-103500); **duplicate webhook → `duplicate:true`
  with T1 exactly-once**; **unsigned webhook → 400 `BAD_SIGNATURE`**; **stale signed
  webhook → 400 `STALE_EVENT`**; cron posture `dev-open` (expected in dev only);
  mock gate `dev-open`.

## 5. Load runs (2026-10-25 — dev-mode, combined environment)

| Run | Key numbers (from the archived JSON) | File |
|---|---|---|
| baseline | n=20, **20×201**, p50 1 277 ms, 47 checkouts/min, peak 17 sessions | `performance/runs/2026-10-25-load-baseline.json` |
| ramp | c=5→40; at c=40: **34×201 / 6×503** (`CHECKOUT_BUSY`), p50 4 752 ms, 341/min | `performance/runs/2026-10-25-load-ramp.json` |
| rush | n=100: **32×201 / 68×503 `CHECKOUT_BUSY`, 0 raw 5xx**, p50 1 922 ms, 245 orders/min, **oversell: false**, orders==inventoryLogs==Σqty | `performance/runs/2026-10-25-load-rush.json` |
| webstorm | 15 unique + 15 duplicate concurrent webhook confirmations: unique 14×200 + **1×500 (P2034 retry-exhausted)**, duplicates 15×200; **exactly-once held: 15/15 T1 postings**, 294 webhooks/min | `performance/runs/2026-10-25-load-webstorm.json` |

Honest caveats (binding): all four runs carry `"mode": "next-dev(turbopack)"`,
`"generator": "same-box"` — dev server, in-sandbox generator, remote DB. The 1×500
in webstorm is reported as-is (bounded P2034 retry exhausted under 15-way
concurrency; exactly-once still held). External-generator staging capacity runs are
**BLOCKED** (`performance/environment-matrix.md` §3; RX-CHECKLIST addendum #4).

## 6. Load-test safety — target guard

- **Result: 7/7 PASS** (2026-10-27, `performance/runs/2026-10-27-target-guard.json`,
  `failures: 0`): unset → REFUSE; `production` → REFUSE; `dev-sandbox-local` →
  CONFIRM; staging unpinned → REFUSE; staging wrong fingerprint → REFUSE; staging
  correct pinned fingerprint → CONFIRM; unreachable target → REFUSE.
- Rules (`scripts/readiness/target-guard.ts`, wired first in
  `scripts/readiness/load-scenarios.ts`): `LOADTEST_TARGET_CONFIRM` must be
  `dev-sandbox-local|staging`; the target app's `/api/health` must answer with
  `deployment.nodeEnv ≠ production`; the app's 16-hex `dbFingerprint`
  (`src/app/api/health/route.ts`) must equal the runner's own DB fingerprint; staging
  additionally requires `LOADTEST_DB_FINGERPRINT` pinned. All harness fixtures are
  `[LT]`-scoped so cleanup can never match real rows (`performance/environment-matrix.md` §2).

## 7. What is NOT tested (do not represent otherwise)

- **Any real PSP behaviour** — provider signing, provider status models, provider
  refunds, provider settlement: **NOT TESTED** (no adapter, no credentials;
  `src/lib/psp-refund.ts` honest-limits note; preflight §6).
- Production build, staging deployment, external load generator: **NOT TESTED /
  BLOCKED** (sandbox policy; `performance/deployment-preflight.md`).
- Multi-instance behaviour of the rate limiter / admission gate: **NOT TESTED**
  (single-process by design — `src/lib/ratelimit.ts`, `src/lib/checkout-gate.ts`).
- Provider webhook idempotency/retry cadence assumptions: **NOT TESTED** — to be
  validated against the provider's official documentation (`12-provider-checklist.md`).

# Current-State Verification — Synchronized with REPORT §R + §O (FINAL STATE)

> **This document describes the CURRENT state as of 2026-10-27T01:40Z**, verified by
> direct inspection of the repository + live re-execution against the running
> deployment. It supersedes the 2026-10-25 mission-start version (preserved in
> §5 below, labeled HISTORICAL — do not read pre-fix failures there as current).
>
> Labels used throughout:
> **[Verified-in-code]** artifact confirmed present in the tree today (grep/read) ·
> **[Re-executed]** test/inspection run against the live system on 2026-10-27 ·
> **[Previously measured]** executed 2026-10-25 with archived evidence; NOT re-run today ·
> **[Not tested]** never executed (no evidence exists).

---

## 0. Authoritative current-status summary

**Webapp status: HEALTHY and CONDITIONALLY READY (same verdict as REPORT §O.7 —
correctness validated under every executed test; remaining gaps are ops/staging, not code).**

| Dimension | Current status | Evidence |
| --- | --- | --- |
| Commit / tree | `main @ f8674c5` (2026-10-27 01:11), tree clean apart from runtime state (`state.json` of the live scheduler) and the deliberate `.env` untracking | [Re-executed] `git status`/`git rev-parse` 2026-10-27 |
| Dev server | Next.js 16.1.3 (Turbopack) on :3000, DB up, `/api/health?fresh=1` → `status: healthy`, ledger invariants ok (325 txns, 6 wallets, 0 hard drift) | [Re-executed] 2026-10-27 |
| Financial integrity | `scripts/verify-ledger.ts` → **ALL PASS** (ledger balanced 325/325, 6/6 wallets cache==truth) | [Re-executed] 2026-10-27 |
| Expiry scheduler (F3) | Running on :3005 since 2026-10-27T01:35Z; **was down 2026-10-25T14:04Z → 2026-10-27T01:35Z** (sandbox session reset) with a 128-group backlog; on restart it fired `MISSED_INTERVAL` catch-up and **autonomously drained the backlog to 0** (batch 50/tick) — see §3 discrepancy D-3 | [Re-executed] 2026-10-27 |
| Refund/reconciliation cases | 8 `succeeded`, 1 `failed` (designed residue of scenario S7 "provider rejects" — permanent, operator-visible), 0 open, 0 awaitingOperator | [Re-executed] GET `/api/cron/refund-reconcile` 2026-10-27 |
| Supabase credentials | New-style API keys installed & REST-validated (publishable key works under RLS on real tables; secret key 200 incl. auth-admin). Legacy anon JWT was 401 (rotated/disabled) — replaced. `.env` auto-heals at boot from `upload/.env.vault` (harness resets defused) | [Re-executed] 2026-10-27 |
| Still outstanding (unchanged) | Real-PSP refund adapter (none exists — mock rails only); production build + staging + external load generator; production env `CRON_SECRET` + `PSP_WEBHOOK_SECRET` | [Not tested] — see §6 |

---

## 1. Repository + runtime state [Re-executed 2026-10-27]

| Item | Value |
| --- | --- |
| Repository root | `/home/z/my-project`, branch `main` |
| HEAD | `f8674c58ab218f941fbff055f655277e9ebec3b1` (2026-10-27 01:11) |
| Working tree | clean except: live scheduler `state.json` (runtime), `tool-results/` (untracked), staged deletion of `.env` from the git index (deliberate secret-hygiene fix, §5 D-5) |
| Framework | Next.js 16.1.3 (App Router, Turbopack **dev mode**), bun runtime |
| Database | Remote Supabase PostgreSQL 17, Supavisor **session** pooler `aws-0-ap-southeast-1.pooler.supabase.com:5432`, `connection_limit=10` |
| Prisma | 6.19.2, datasource `SUPABASE_DATABASE_URL` |
| Processes | App :3000 (1×1) + expiry-scheduler :3005 (30 s ticks, 0 persistent DB connections) |
| `CRON_SECRET` | **NOT set in this dev deployment** → cron endpoints run `dev-open` (sandbox testing posture). Production fails closed by design (§2 O-2) |

**Code-version correspondence for cited tests:** `git diff 6646301..HEAD` (FINAL-GAPS-CLOSE-era tree, against which all §O suites ran) touches ONLY `.env`, `.env.example`, `.gitignore`, `package.json` (boot-guard wiring), `scripts/ensure-env.ts`, `src/instrumentation*.ts`, `worklog.md` — **zero business-logic files**. The 2026-10-25 test evidence therefore corresponds to the current business code. [Verified-in-code]

---

## 2. Verification matrix — every §R claim (wallet-drift + F1/F2/F3 mission)

| # | REPORT §R claim | Status today | Evidence |
| --- | --- | --- | --- |
| R-1 | `lib/ledger.ts`: hard-drift vs benign time-maturity classification; `safeRefreshWalletCache`; `refreshCache` opt-out on posting | **[Verified-in-code]** — all exports present | `grep` 2026-10-27 |
| R-2 | `/api/health`: 60 s TTL, `?fresh=1`, classification-aware, no wallet ids, gate introspection | **[Verified-in-code]** + **[Re-executed]** (healthy, invariants ok) | route read; live call 2026-10-27 |
| R-3 | `/api/admin/system/health`: full drift detail behind `requireAdmin` | **[Verified-in-code]** | route read 2026-10-27 |
| R-4 | F1 `webhooks/payments/process.ts`: cache refresh post-commit; bounded P2034 retry (≤2, jittered); 10 s `statement_timeout`; 15 s Serializable timeout | **[Verified-in-code]** — `attempt < 3` retry + `SET LOCAL statement_timeout='10s'` + `timeout: 15_000` on both paths | code read 2026-10-27 |
| R-5 | Payout paths (`store/payouts`, `admin/payouts/[id]/approve`, `admin/payout-batches`): cache write deferred post-commit | **[Verified-in-code]** — `refreshCache: false // post-commit below (F1)` | code read 2026-10-27 |
| R-6 | Display resilience: `safeRefreshWalletCache` in `store/wallet`, `store/dashboard`, `admin/wallets` | **[Verified-in-code]** | grep 2026-10-27 |
| R-7 | F2 gate: `lib/checkout-gate.ts` (8 inflight / 32 waiting / 5 s budget, env-tunable) wired in `checkout/create` AFTER idempotency replay, `503 CHECKOUT_BUSY` + `Retry-After` + `X-Checkout-Queue-Ms` | **[Verified-in-code]** (⚠ gate default is **8**, not 16 — see D-1) | code read 2026-10-27 |
| R-8 | F3 sweep `/api/cron/expiry-sweep`: claim-first per-group tx, `requires_payment→expired`, per-order guard, atomic restock + InventoryLog, floor-guarded salesCount, batch 50, throttle 1.5 s, durable `Setting cron.expiry_sweep.last`, GET observability | **[Verified-in-code]** + **[Re-executed]** (live drain 128→0) | code read; live calls 2026-10-27 |
| R-9 | Late payment → definitive `409 GROUP_EXPIRED` at both sites; claim excludes `expired` | **[Verified-in-code]** | code read 2026-10-27 |
| R-10 | `lib/api.ts` `ApiError`/`fail` header support | **[Verified-in-code]** | code read 2026-10-27 |
| R-11 | `scripts/readiness/wallet-reconcile.ts`: read-only default, guarded `--apply` | **[Verified-in-code]** (file present, 18 KB) | `ls` 2026-10-27 |
| R-12 | finance-regression 34 checks ALL PASS | **[Previously measured]** — `2026-10-25-finance-regression.json`: 37 test rows, `failures: 0`, `all ok: true` [Re-verified by reading the JSON today] | archived JSON |
| R-13 | remediation-live-tests 27 checks ALL PASS (F1 storm 15/15, F2 rush 0 raw 5xx, F3 races) | **[Previously measured]** — `2026-10-25-remediation-live.json` [Re-verified by reading today] | archived JSON |
| R-14 | Lock-stall bound 120,608 ms → 10,727 ms | **[Previously measured]** (webhook-resilience C1, dev-run log — log file not archived) | REPORT §R.3 |
| R-15 | Supavisor session ceiling: client №16 rejected `EMAXCONNSESSION pool_size: 15` | **[Previously measured]** — recorded in the measuring mission's worklog entry; **NOT present in any archived run JSON** (REPORT cites "finance-regression run 1" — the archived JSON does not contain it). Not re-executed today (would momentarily consume the full client budget against the live app) | `worklog.md` line ~1526 |
| R-16 | Live wallet self-heal + browser golden path (order NM-103274) | **[Previously measured]**; equivalent live gate re-run today via `verify-ledger.ts` ALL PASS | archived audits + today |

---

## 3. Verification matrix — every §O claim (final operational & payment-recovery mission)

| # | REPORT §O claim | Status today | Evidence |
| --- | --- | --- | --- |
| O-1 | §R fixes re-confirmed on disk before §O changes; suites green after | **[Verified-in-code]** (see §2; no business-logic diff since) | git diff 6646301..HEAD = env/boot files only |
| O-2 | `lib/cron-auth.ts`: production + missing `CRON_SECRET` → fail-closed `503 CRON_NOT_CONFIGURED`; timing-safe sha256+`timingSafeEqual`; never logs/echoes secret; applied to expiry-sweep **and** refund-reconcile POST+GET | **[Verified-in-code]** (also live: today's endpoints report `auth: "dev-open"` without a secret, as designed for dev) | code read; live calls 2026-10-27 |
| O-3 | `mini-services/expiry-scheduler` (port 3005): ticks both endpoints every 30 s; durable `state.json`; boot catch-up; alert ring `TICK_FAILED / TICK_UNREACHABLE / OVERDUE_SWEEP / MISSED_INTERVAL / BACKLOG_HIGH / REFUND_STUCK`; status on GET /; secret never exposed | **[Verified-in-code]** + **[Re-executed]** — but see **D-3**: the service was NOT running between the Oct-25 session reset and 2026-10-27T01:35Z (manual restart); liveness in THIS sandbox is not durable across session resets | code read; restart + drain today |
| O-4 | scheduler-e2e 17/17 PASS: release latency 18.7 s / 20.9 s (≤120 s asserted, ≤5 min objective); overlap safety; restart catch-up 1.4 s; auth matrix | **[Previously measured]** — `2026-10-25-scheduler-e2e.json` (releaseLatencyMs 18668, catchUpMs 1356, alert history present) [Re-verified by reading today]; today's restart independently re-demonstrated catch-up + drain on a real 128-group backlog | archived JSON + live 2026-10-27 |
| O-5 | `PaymentReconciliation` + `PspRefundRecord` models (unique `(provider, providerRef)`, unique idempotencyKey) | **[Verified-in-code]** | `prisma/schema.prisma` 2026-10-27 |
| O-6 | Obligation recorded at BOTH `GROUP_EXPIRED` sites (idempotent upsert, no regression on redelivery); DB failure → webhook 500 → redelivery converges | **[Verified-in-code]** — `recordLatePaymentObligation` at lines ~198 and ~375 | code read 2026-10-27 |
| O-7 | `lib/psp-refund.ts`: adapter surface, mock adapter with `recon:{caseId}` idempotency, registry, honest-limits doc | **[Verified-in-code]** | code read 2026-10-27 |
| O-8 | `/api/cron/refund-reconcile`: batch 25, backoff 15 s, max 8 attempts, durable intent BEFORE provider call, provider calls OUTSIDE tx, completion ONLY from provider-authoritative record, cron-auth | **[Verified-in-code]** | code read 2026-10-27 |
| O-9 | Admin visibility `/api/admin/payment-reconciliation` (401 unauthenticated) + system-health counts | **[Verified-in-code]** (`requireAdmin`) | code read 2026-10-27 |
| O-10 | late-payment-refund 10/10 scenarios, 16/16 checks ALL PASS (incl. timeout-unknown, crash-after-provider, provider-reject, DB-fault-on-obligation, idempotent re-execution) | **[Previously measured]** — `2026-10-25-late-payment-refund.json` contains S1–S10 with concrete details [Re-verified by reading today] | archived JSON |
| O-11 | Honest separation: mock-PSP tested; real PSPs have NO adapter (cases stay `requested`/awaitingOperator; manual runbook) | **[Verified-in-code]** + live: 0 awaitingOperator today; 1 `failed` = S7 designed residue | code + live GET 2026-10-27 |
| O-12 | `performance/production-topology.md`: 1×1 + scheduler, pool 10, ceiling 15 measured, scaling FORBIDDEN gate, env knobs, staging boundary | **[Verified-in-code]** (document present, content matches §O.4) | doc read 2026-10-27 |
| O-13 | Load re-runs post-changes: baseline p50 1.28 s; ramp c=40 34×201/6×503/0 raw-5xx; rush 32×201/68×503 p50 1.92 s, 0 oversell; webstorm 14×200+1×500 (P2034 retry-exhausted, exactly-once held) | **[Previously measured]** — all four JSONs re-read today, numbers match REPORT §O.5 exactly | archived JSONs |
| O-14 | Browser golden path re-verified (order NM-103495, 0 cases) | **[Previously measured]** | REPORT §O.5 |

---

## 4. Discrepancies found in this synchronization (and corrections applied)

| ID | Discrepancy | Resolution |
| --- | --- | --- |
| D-1 | Previous `current-state-verification.md` §4 stated the admission gate as "**16 inflight**" — the code has **always been 8** since creation (`git log -L` confirms; REPORT §R.2-4 and `production-topology.md` §4 both correctly say 8) | **Corrected** in this rewrite |
| D-2 | Previous `current-state-verification.md` was the **mission-start baseline** (HEAD `cb2938e`, 2026-10-25 11:19) — pre-dating ALL §O work (scheduler, cron-auth, refund/reconciliation, topology doc). Readers could mistake its "absent/not done" classifications for current status | **Rewritten** — this document; baseline preserved as HISTORIAL in §5 |
| D-3 | REPORT §O.2 says the scheduler is "RUNNING in this deployment" — true on 2026-10-25, but the **Oct-27 sandbox session reset killed it** (last tick 2026-10-25T14:04Z). A 128-group expiry backlog accumulated (~35.5 h). Restarted 2026-10-27T01:35Z; MISSED_INTERVAL catch-up fired; backlog drained to 0 autonomously | **Deployment-liveness caveat added** (REPORT §P): in THIS sandbox, the scheduler must be restarted after session resets; in production the platform cron/scheduler is the durable equivalent |
| D-4 | REPORT §R.3 / §O.4 cite `EMAXCONNSESSION pool_size: 15` to "finance-regression run 1", but **no archived JSON contains that error** — the observation is recorded only in the measuring mission's `worklog.md` | Labeled **[Previously measured — worklog evidence, not in archived JSON]** in §2 R-15 |
| D-5 | `.env` (containing live Supabase credentials) was **tracked in git** (commits 6646301/d879d57/f8674c5) | **Fixed**: `git rm --cached .env`; `.gitignore` covers it. Note: earlier secret-bearing commits remain in this **local-only** repo's history (branch is 18 commits ahead of origin, never pushed) |
| D-6 | Supabase **legacy anon JWT returned 401** on REST (rotated/disabled in the dashboard) — flagged since the migration mission, never resolved | **Resolved**: replaced with the user-supplied new-style keys — `sb_publishable_…` (works under RLS on real tables: 200 on Plan/Category/Product/Store) and `sb_secret_…` (200 on REST root + auth-admin). Stored in `.env` + `upload/.env.vault` + tmp snapshots; auto-healed at boot |
| D-7 | Refund-case table contains 1 `failed` + 8 `succeeded` rows | **Not a defect** — designed residue of scenario S7 ("provider rejects" — permanent, operator-visible). Documented here so it is not mistaken for a live incident |

No business logic was modified to synchronize these documents (mission rule 9). The only code-adjacent changes are: credential vault/boot-guard files (previous task), `.env` untracking, and the scheduler restart (operational restore of the documented deployment state).

---

## 5. HISTORICAL — mission-start baseline (2026-10-25, superseded by §2–§4)

> Preserved for provenance. Everything in this section describes the tree BEFORE the
> wallet-drift/F1/F2/F3 remediation and BEFORE the final-gaps mission. **Do not read
> these as current status.** HEAD at that time: `cb2938e` (clean tree).

- Checkout admission gate / `CHECKOUT_BUSY` / `Retry-After`: **absent** (0 code matches) — *now implemented, §2 R-7.*
- No P2034/P2028 retry wrapper on the payment-confirmation path (bounded retries existed only in payout flows) — *now on both webhook paths, §2 R-4.*
- `PaymentGroup.expiresAt` written but never enforced (no sweep, no release, no alerts; 75 s probe confirmed stock held past expiry) — *now enforced + scheduled, §2 R-8 / §3 O-3.*
- `refreshWalletCache()` inside both Serializable success txs (hot row; 0/15 webhook storm) — *now post-commit + bounded retry, §2 R-4.*
- Wallet drift on wallet `cmvizi0ms…` reproduced exactly (cached {0, 95292} vs truth {10764, 84528}); root cause: time-based hold maturity with event-driven-only cache refresh — benign staleness class — *now classified + self-healing, §0.*
- Health check ran a full-ledger scan per poll (1237 ms measured) — *now 60 s TTL, §2 R-2.*
- Ledger double-entry integrity: 190/190 transactions balanced at baseline — *325/325 today, §0.*
- Archived F1/F2/F3 audits/run JSONs: absent at mission start (created by the readiness mission on 2026-10-25 — those are the current `performance/runs/*` evidence files).
- Additional §O-phase incidents (historical): schema-drift from `db:push` dropped orphaned `dedupKey` columns (runtime untouched — grep-verified); dev-server outage during Prisma regeneration (alerts fired correctly).

---

## 6. Remaining deployment requirements (unchanged — all ops/staging, no sandbox code)

1. **Real PSP refund adapter** before processing real late payments. Until one exists: real-provider cases stay `requested`/`awaitingOperator`, surfaced via `/api/admin/payment-reconciliation` + `REFUND_STUCK` alerts + `docs/late-payment-refund-runbook.md` (manual procedure). **No refund automation for a real provider has been implemented or tested.**
2. **Production build + staging deployment + external load generator** before any capacity claim. Every latency/throughput number in REPORT remains dev-mode, combined environment. **NOT TESTED.**
3. **Production env**: `CRON_SECRET` (mandatory — endpoints fail closed without it), `PSP_WEBHOOK_SECRET`, pooler URL with `connection_limit=10`; platform cron or the scheduler service at ~60 s interval for BOTH ticks.
4. **Horizontal scaling remains FORBIDDEN** until cross-instance admission control (advisory-lock gate recommended) + per-instance budget + staging re-runs exist (`production-topology.md` §4).
5. No claim of 100k-user or influencer-launch readiness is made or supported by the current evidence.

---

## 7. Tests actually executed for THIS verification (2026-10-27)

| Run | Result |
| --- | --- |
| `GET /api/health?fresh=1` | 200 — healthy, invariants ok, 0 hard drift |
| `GET /api/cron/expiry-sweep` (before/after) | backlog 128 → **0** |
| `GET /api/cron/refund-reconcile` | counts {succeeded 8, failed 1, open 0}, awaitingOperator 0 |
| Scheduler restart + observation | MISSED_INTERVAL catch-up; 120 ticks, 0 failures; autonomous drain 128→0 |
| `bun scripts/verify-ledger.ts` | **FINANCIAL-GATE: ALL PASS** (325 txns / 970 lines; 6/6 wallets cache==truth) |
| Supabase REST key validation | publishable 200 (RLS tables) / secret 200 (root + auth-admin) |
| Full code inspection of §R/§O artifacts | every claim located in the tree (matrices §2/§3) |
| Archived-evidence re-read | all 14 `performance/runs/*.json` inspected; numbers match REPORT |

Everything else in REPORT §R.3/§O.5 is **[Previously measured 2026-10-25]** — archived, corresponding to the current business code (see §1), but not re-executed today.

# RX-CHECKLIST — Production Readiness Validation (F1/F2/F3 + Checkout Capacity)

Mission: evidence-driven production-readiness review. No checkout redesign, no unrelated features.

## Ground rules (binding)
- Treat earlier reports as evidence to VALIDATE, not assumptions. PASS/FAIL/NOT TESTED labels only for executed tests.
- No pool-size increase, no Supavisor mode switch without evidence. No multi-instance scaling without admission-control + connection budget proof.
- No destructive testing on production DB; test accounts + `[LT]` test data only; no OOM chasing.
- Production build cannot run in this sandbox (dev-mode only) → Phase 4 must be labeled accordingly; no dev→production extrapolation.
- Worklog discipline: append to /home/z/my-project/worklog.md after each phase.

## Phase 1 — Verify current state (DONE)
- [x] `performance/` directory: **DOES NOT EXIST** (no REPORT.md, no F1/F2/F3 audits, no runs/)
- [x] `scripts/loadtest/`: DOES NOT EXIST. Existing harness: `scripts/test-oversell.ts` (2-way race + MOQ + stock probe)
- [x] `CHECKOUT_BUSY` admission gate: **NOT IN CODE** (0 matches)
- [x] F1 (payment confirmation): claim-first + `Serializable` isolation IS present in `process.ts` (FIN-2b baseline, commit 5aae27e/fe1c429 era) — but NO P2034/retry handling anywhere (`grep P2034|P2024|retry src/` = 0). No F1 fix commit; no test evidence.
- [x] F2 (checkout contention fix): NOT IMPLEMENTED. `db.ts` has no pool config; `connection_limit=10` only as URL query param on Supavisor session pooler.
- [x] F3 (reservation expiry): NOT IMPLEMENTED. No reservation tables; stock decrements at checkout; `PaymentGroup.expiresAt` (30 min) never enforced — no sweep/worker/alerts.
- [x] Scheduler/worker: none for checkout (only shipping tick + payout sweep endpoints, request-triggered).
- [x] Metrics: `/api/health` only (counts + ledger invariants). No `/api/metrics`, no latency instrumentation.
- [x] **ENV INCIDENT**: `.env` had been reset to 50-byte stale sqlite-only file (mtime Oct 25 10:11) → `SUPABASE_DATABASE_URL` missing → app could not boot. RESTORED from `/tmp/my-project/.env` snapshot (Oct 23) — Supavisor session pooler `aws-0-ap-southeast-1.pooler.supabase.com:5432`, `connection_limit=10&connect_timeout=10`. Prisma connectivity verified (343 orders / 368 paymentGroups).
- [x] Git history: last commits = FIN-*/R2 finance hardening + one UUID HEAD commit (Oct 20). NO F1/F2/F3, no performance work committed.

## Phase 2 — Close critical test gaps (DONE — see performance/runs/2026-10-25-*)
1. Fault-injected rollback (inventory + ledger boundaries, DB-trigger injection): PASS 15/15
2. Webhook redelivery + concurrent duplicates + transient-DB-fault (lock injection): PASS on exactly-once; FAIL findings = raw 500s (P2034, no retry) + 120.7s lock hang (statement_timeout is only bound)
3. Scheduler/expiry sweeps/worker restarts/overlaps: NOT TESTED (feature absent — measured)
4. Simultaneous expiry + payment confirmation: NOT TESTED (feature absent)
5. Expiry scheduler config + alerts: N/A (absent; F3 gap CONFIRMED by 75s measurement)
6. 503 CHECKOUT_BUSY E2E: NOT TESTED (gate absent)
7. Multi-instance gate behavior: NOT TESTED (no gate; in-process limiter documented single-process)

## Phase 3 — Topology + connection capacity (DONE — measured)
- 1×1 sandbox topology; prod topology UNDOCUMENTED [Assumed]. max_connections=60; rush peak 18 sessions; app pool 10 = throttle, held idle-in-tx. connection_limit NOT changed.
- Transaction-pooler :6543 probe (isolated): ALL PASS at probe level (tx, SAVEPOINT, Serializable claim 1/5/0, repeated queries). NOT applied.

## Phase 4 — Production-like behavior (DONE, bounded, labeled dev-mode + combined-env)
- baseline p50 1.31s | ramp c=40: 23×201/17×500 | rush ×2: p50 15.5–17.6s, 61–62% raw 500s, ZERO oversell | webstorm: 0/15 confirmations (wallet-cache SSI hot row P2034) | idem: 1 order exactly, 11×500 P2002 | recovery 1.25s.

## Phase 5 — Launch decision (DONE)
- performance/REPORT.md rewritten with measured results; performance/readiness-checklist.md created.
- VERDICT: NOT READY (evidence + remediation list). No production code modified.

---

# RX-CHECKLIST — Close Final Operational and Payment-Recovery Gaps (trace 1a173199b23d7b91)

Mission: close the three REPORT.md §R.5 conditions — (1) expiry scheduling not
demonstrated in the deployment, (2) production topology + connection budget
undocumented, (3) late-payment refund/reconciliation for a real PSP. Verify the
current tree FIRST; do not redo completed work without regression evidence.

## Ground rules (binding; inherited + additions)
- Phase 0 verification BEFORE any change: repo/branch/commit/worktree, REPORT vs code, archived runs.
- Preserve existing passing behavior — finance-regression (34/34) and remediation-live (27/27) must stay green after all changes.
- Scheduler endpoints fail CLOSED in production when CRON_SECRET is missing; timing-safe secret compare; the secret is never logged or echoed.
- Refund/reconciliation cases never fake a completion outcome; completion only from a provider-authoritative record/response.
- No production financial writes; [LT] fixtures only; no pool/Supavisor changes; no horizontal scaling.
- Dev-mode/combined-environment labels preserved; PASS/FAIL/NOT TESTED only for executed tests.

## Phase 0 — verify current state (DONE 2026-10-25T13:0xZ)
- [x] git main @ 67bcfcc, clean worktree; dev server up (health 200); CRON_SECRET absent from .env; chat-service NOT running (start it).
- [x] REPORT §R.2 fixes verified in code: expiry-sweep route, checkout-gate, process.ts F1 (post-commit refresh + P2034 retry + 10s/15s bounds), wallet-reconcile script, runs/* archived.
- [x] GAP-1: expiry-sweep auth is fail-OPEN when CRON_SECRET missing + non-timing-safe compare — must fix (mission Phase 1 req 2/3).
- [x] GAP-2: NO actual recurring invocation exists (route is tick-only) — must build + run a scheduler service (mission Phase 1 req 1).
- [x] GAP-3: no failed/overdue-sweep ALERTING (durable last-run Setting only) — must add.
- [x] GAP-4: late-payment 409 GROUP_EXPIRED records NO durable obligation — must add PaymentReconciliation (mission Phase 2).
- [x] GAP-5: no refund executor / provider refund idempotency — must add adapter + tick.
- [x] GAP-6/7: topology doc + production-like validation absent — Phases 3/4.

## Phase 1 — expiry scheduler operationalization (DONE — 17/17 PASS)
- [x] src/lib/cron-auth.ts (fail-closed production, timing-safe) applied to expiry-sweep POST+GET
- [x] mini-services/expiry-scheduler (port 3005; 30 s interval; durable state.json; alerts; boot catch-up; ticks BOTH endpoints) — RUNNING in this deployment
- [x] scripts/readiness/scheduler-e2e.ts: release latency 18.7–20.9 s vs objective; overlap safety; restart + missed interval (catch-up 1.4 s + MISSED_INTERVAL alert); auth matrix incl. fail-closed E2E via server restarts — 2026-10-25-scheduler-e2e.json

## Phase 2 — late-payment refund/reconciliation (DONE — 10/10 scenarios, 16/16 checks)
- [x] schema: PaymentReconciliation + PspRefundRecord; db:push (orphan dedupKey columns on ActivityLog/Notification dropped — verified unused, zero runtime impact)
- [x] process.ts: durable obligation at BOTH GROUP_EXPIRED sites (idempotent upsert; webhook amount = captured funds; optional paymentId)
- [x] src/lib/psp-refund.ts: RefundAdapter + mock adapter (idempotencyKey semantics; behavior modes; one-shot crash fault; provider-alias resolution)
- [x] /api/cron/refund-reconcile: POST tick + GET observability; cron-auth
- [x] /api/admin/payment-reconciliation (401 unauth) + admin system-health counts
- [x] scripts/readiness/late-payment-refund.ts — 2026-10-25-late-payment-refund.json
- [x] docs/late-payment-refund-runbook.md

## Phase 3 — topology & connection budget (DONE)
- [x] performance/production-topology.md (1×1 + scheduler decision, Supavisor ceiling 15 measured, scaling gate + advisory-lock strategy, session-pooling decision, env knobs)

## Phase 4 — production-like validation (DONE within sandbox boundaries)
- [x] post-change re-runs: finance-regression ALL PASS; remediation-live-tests ALL PASS; load baseline/ramp/rush/webstorm archived (rush: 0 raw 5xx, p50 1.92 s, 0 oversell; webstorm: exactly-once held, 14/15+1×500 P2034)
- [x] browser golden path re-verified (NM-103495 paid, 1 T1, 0 cases, cart cleared, no console errors; 390/1280 px)
- [x] production build / staging / external generator: NOT TESTED — documented boundary

## Phase 5 — evidence & verdict (DONE)
- [x] REPORT.md §O + readiness-checklist addendum #2 (PASS/FAIL/NOT TESTED per critical requirement)
- [x] worklog appended; lint clean; browser verified

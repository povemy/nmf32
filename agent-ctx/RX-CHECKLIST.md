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

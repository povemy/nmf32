# Scheduler Deployment — Durable Expiry + Refund-Reconciliation Scheduling

**Mission phase:** 3 · **Verified:** 2026-10-27 (UTC) · **Repo:** `main` + working tree (post-`78ee258` docs/test additions only)
**Endpoints:** `POST/GET /api/cron/expiry-sweep` · `POST/GET /api/cron/refund-reconcile`

---

## 1. Current deployment (this sandbox) — VERIFIED RUNNING

| Item | Value | Evidence |
|---|---|---|
| Scheduler service | `mini-services/expiry-scheduler` (Bun, `bun --hot`, port 3005) | live GET `/` 200 |
| Interval | 30 s (`SWEEP_INTERVAL_MS`, default 30 000) — production objective ~60 s | `index.ts` + state.json |
| Durable state | `state.json` (last-tick/last-success/failure streaks survive restarts) | restart tests E1–E3 |
| Auth | `x-cron-secret` header sent when `CRON_SECRET` configured; secret never written to state/logs/status (only `secretConfigured` boolean) | code audit + F1b |
| Alerts | failed ticks (≥2 consecutive), unreachable app, overdue sweep (3× interval), expiry backlog > threshold, refund cases stuck | E3 alert ring |
| Boot catch-up | last-success older than interval → immediate tick + `MISSED_INTERVAL` alert | E2/E3 (catch-up 1.3 s) |
| Current live state | ticks 259+, 0 consecutive failures, backlog 0, both endpoints 200 every 30 s | `GET :3005/` + dev.log |

**Known sandbox limitation (documented incident):** the mini-service is a *process*, not a platform facility — a session reset killed it for 35.5 h (2026-10-25→27), during which a 128-group expiry backlog accumulated; on restart the catch-up drained it autonomously to 0 (batch 50/tick). This is exactly why production must NOT rely on an unsupervised process — see §2.

## 2. Production installation — design + BLOCKED status

**Status: BLOCKED** on the hosting decision (deployment-preflight.md D-2/D-6). The production schedule is **NOT installed anywhere** — nothing is claimed beyond this sandbox. When the host is chosen, install exactly ONE of:

1. **Platform-native scheduled job (preferred)** — e.g. Vercel Cron / Cloud Scheduler / platform job hitting `POST {app}/api/cron/expiry-sweep` and `POST {app}/api/cron/refund-reconcile` with header `x-cron-secret: $CRON_SECRET`, at ≤60 s cadence (1×/min is the documented objective; verify the platform's actual minimum with its current docs).
2. **Supervised service** — the existing `mini-services/expiry-scheduler` (or equivalent) as a systemd unit / compose service with `restart: unless-stopped` and persistent `state.json` volume. Choose when the platform has no sub-minute cron.

**Overlap safety (verified):** multiple invocations are safe by design — claim-first conditional `updateMany` per group/case + endpoint-side 1.5 s throttle (D1: 3 concurrent manual sweeps + live tick → exactly one restock). Accidentally running two schedulers degrades to redundant no-op ticks, not double execution. Deliberately still run ONE scheduler to keep tick observability clean.

**Missed-interval handling:** durable last-success + boot catch-up (E1–E3). Backlog drains at 50 groups/tick.

## 3. CRON_SECRET — status, requirements, rotation

**Current status: NOT CONFIGURED in this sandbox (dev-open — correct for dev-only testing). Production/staging configuration is BLOCKED on hosting secret-manager access — do not mark complete until set there.**

Requirements (all code-verified; live behavior in the F-matrix below):

| Requirement | Status | Evidence |
|---|---|---|
| High-entropy value via hosting secret manager | **BLOCKED** (operator action; generate e.g. `openssl rand -hex 32`) | — |
| Never in source/image/tracked config/client vars | enforced by design; `.env` untracked; `.env.example` has placeholders | git + files |
| Never printed in logs/responses | responses echo only mode + generic "Invalid or missing scheduler secret" | F1b |
| Fail-closed in production when missing | 503 `CRON_NOT_CONFIGURED` on POST **and** GET | A2 unit + F2 E2E |
| Missing/incorrect secret rejected | 403 `CRON_FORBIDDEN`, identical message for both | F1 (no=403 wrong=403 right=200 get=403) |
| Correct secret works | 200 + outcome JSON | F1 |
| `dev-open` cannot apply to production | mode logic: `NODE_ENV=production` ⇒ fail-closed when secret absent; `CRON_REQUIRE_SECRET=1` exercises it in dev | A2/A3 + F2 |
| Rotation without exposing current value | procedure below | design |

**Rotation procedure (no exposure):** 1) generate new value out-of-band; 2) update the hosting secret manager AND the scheduler service env (both sides must agree); 3) restart/redeploy the scheduler service (it reads env at boot) and the app (env read per request — rolling restart is fine because both old/new grace is unnecessary: the window where scheduler sends new + app expects old yields 403s → visible as TICK_FAILED alerts, never silent); 4) verify with one manual authenticated GET; 5) old value becomes invalid automatically (single accepted value). Never `echo`/log the value at any step; verification uses a real authenticated request, not printing.

## 4. End-to-end operation proof (re-executed 2026-10-27 on current code)

| Mission requirement | Result | Evidence |
|---|---|---|
| Eligible expired order releases stock | PASS — release latency 11.3 s (interval 30 s; hard bound ≤120 s; original 2026-10-25 measurement 18.7 s) | `runs/2026-10-27-scheduler-e2e.json` B1 |
| Paid order never restocked | PASS — paid group survived live sweeps, stock kept, ledger +1 legit txn only | C1 |
| Repeated/overlapping sweeps never double-restock | PASS — 3 manual sweeps + live tick → exactly 1 restock | D1 |
| Refund reconciliation handles retries + unknown provider outcomes | PASS — S5 timeout→unknown→provider-record confirms; S6 crash-after-provider→idempotent recovery, ONE provider refund; backoff respected; attempts capped | `runs/2026-10-27-late-payment-refund.json` |
| Scheduler restart + missed interval handled | PASS — down 35 s → catch-up 1.3 s + `MISSED_INTERVAL` alert; (real-world: 35.5 h outage → backlog 128→0 autonomous drain, 2026-10-27 incident) | E1–E3 |
| DB failure observable + recoverable | PASS — fault-injected obligation write 500 → log row unprocessed → PSP redelivery converges on exactly one case | S9a/S9b |
| Backlog/stale-sweep alerts fire | PASS — alert ring carries TICK_UNREACHABLE/OVERDUE_SWEEP/MISSED_INTERVAL history | E3 |
| Last successful run + backlog inspectable | PASS — `GET /api/cron/expiry-sweep` returns backlog/oldest/lastRun; `GET /api/cron/refund-reconcile` counts; scheduler `GET /` state | live checks today |
| No secrets in responses/logs | PASS — F1b + scheduler exposes only `secretConfigured` boolean | F1b |

All labels above are from tests executed 2026-10-27 against `main`+tree (business code unchanged since `f8674c5` — `git diff` touches only env/boot/docs/test files). Original 2026-10-25 runs remain archived alongside.

## 5. Remaining production steps (exact, BLOCKED)

1. Choose hosting (see deployment-preflight.md §5) → decide native-cron vs supervised-service.
2. Generate `CRON_SECRET` (`openssl rand -hex 32`) → set in the platform secret manager (app) and scheduler env.
3. Install the schedule (§2) at ≤60 s cadence; verify cadence, alerts, and `GET` observability through the real HTTPS domain.
4. Re-run `scripts/readiness/scheduler-e2e.ts` + `scripts/readiness/late-payment-refund.ts` against staging (through the target guard) and archive.
5. Confirm a deployment restart does not disable scheduling (restart + catch-up check, as E1–E3).

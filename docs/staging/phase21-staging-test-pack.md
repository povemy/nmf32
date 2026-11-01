# NOMOFEE — Phase 2.1 + FINAL CLOSURE Database-Dependent Staging Test Pack

**Status discipline:** every test below is labeled **Prepared** (runnable,
awaiting an authorized staging environment), **Executed** (ran, result shown),
or **Blocked** (needs an external dependency). Nothing here ran against any
database in the Phase 2.1 or FINAL CLOSURE sandboxes. Target: an authorized
staging deployment with migrations 1–6 applied (see
`docs/ops/phase21-deployment-runbook.md`).

Run convention: `bun scripts/readiness/<script>.ts` from the repo root against
the staging app on `127.0.0.1:3000` (or tunnel). All fixtures are `[LT]`-tagged
and self-cleaning.

---

## 1. Reviews (migration 20261101000001 required)

| # | Requirement | Tool | Status |
|---|---|---|---|
| 1.1 | Anonymous submission rejected | `scripts/readiness/reviews-e2e.ts` (R1) | Prepared |
| 1.2 | Unverified purchase rejected | same (R2 — non-purchaser 403) | Prepared |
| 1.3 | Eligible guest buyer accepted via delivered-order eligibility | same (R3 — pending) | Prepared |
| 1.4 | Duplicate review rejected | same (R4) | Prepared |
| 1.5 | Pending review excluded from aggregates | same (R5) | Prepared |
| 1.6 | Moderation transitions update aggregates | same (R6a/R6b; needs `LT_ADMIN_PASSWORD`) | Prepared |
| 1.7 | Seller self-review blocked | same (R7; needs `LT_SELLER_PASSWORD`) | Prepared |
| 1.8 | Guest buyers specifically: the eligibility join resolves orders placed WITHOUT an account (shopperId NULL, customerEmail match) | manual: repeat R3 with a guest checkout fixture (no login) | Prepared (procedure) |

## 2. Session security (migration 20261101000000 required)

| # | Requirement | Tool | Status |
|---|---|---|---|
| 2.1 | New login issues a valid token | `scripts/readiness/session-security-e2e.ts` (S1) | Prepared |
| 2.2 | Only its hash is stored | same (S2/S3 — DB row is sha256; no plaintext row) | Prepared |
| 2.3 | Existing sessions follow the documented migration strategy | runbook §2 step 3 (pre-window cookie still authenticates post-migrate) + `prisma migrate status` | Prepared (procedure) |
| 2.4 | Logout and revocation work | same (S8–S10) | Prepared |
| 2.5 | Expired sessions cannot authenticate | same (S7 — expiresAt pushed past) | Prepared |
| 2.6 | Chat hub auth uses the same protected token model | same (S5 — `/api/chat/hub-auth` with the hashed-store token) | Prepared |

## 3. Administrator MFA (migrations 20261101000002 + 20261103000000 required; `MFA_ENCRYPTION_KEY` set)

| # | Requirement | Tool | Status |
|---|---|---|---|
| 3.1 | Enrollment | `scripts/readiness/mfa-e2e.ts` (S1/S1b) | Prepared |
| 3.2 | Confirmation (real TOTP + recovery codes once + all-session revocation) | same (S2/S9) | Prepared |
| 3.3 | Login challenge (mfaRequired, no session from password step) | same (S3) | Prepared |
| 3.4 | Failed attempts + cooldown (progressive, no permanent lock) | same (S4/S4b) | Prepared |
| 3.5 | TOTP replay rejection (same code twice) | same (S5a/S5b) | Prepared |
| 3.6 | Recovery-code use (once; second use fails) | same (S6a/S6b) | Prepared |
| 3.7 | Mandatory enrollment enforcement (403 on privileged APIs; bootstrap routes reachable; me flag) | same (S7a–S7d) | Prepared |
| 3.8 | Session revocation after security-sensitive changes | same (S9) | Prepared |
| 3.9 | Cross-challenge mint cooldown | same (S8) | Prepared |
| 3.10 | Administrator recovery (lost authenticator + codes) | `scripts/readiness/mfa-admin-reset.ts` (operator runbook; exercise on a THROWAWAY staging admin) | Prepared (procedure) |
| 3.11 | Key rotation | `scripts/readiness/mfa-key-rotate.ts` (operator runbook; exercise on staging with backup) | Prepared (procedure) |

## 4. Inventory expiry (no new migration; scheduler running)

| # | Requirement | Tool | Status |
|---|---|---|---|
| 4.1 | Normal expiry (requires_payment past expiresAt → restock) | `scripts/readiness/expiry-gap-probe.ts` pattern + scheduler E2E; dedicated assertions in `scripts/readiness/scheduler-e2e.ts` | Prepared |
| 4.2 | Failed-payment expiry (failed groups past expiresAt) | `scripts/readiness/late-payment-refund.ts` + manual fixture (set group.status='failed', expiresAt past) | Prepared (procedure) |
| 4.3 | Legacy payment-intent expiry | `scripts/readiness/expiry-gap-probe.ts` (legacy single-intent path) | Prepared |
| 4.4 | Duplicate scheduler executions (two sweeps racing) | run two `POST /api/cron/expiry-sweep` concurrently → `skippedConcurrent` ≥ 1, restock exactly-once | Prepared (procedure) |
| 4.5 | Concurrent payment success vs expiry (CAS race) | `scripts/test-oversell.ts` + `scripts/test-payment-retry.ts` (existing, DB-backed) | Prepared |
| 4.6 | Late successful payment (refuse + durable refund obligation, never resurrect released stock) | `scripts/readiness/late-payment-refund.ts` (existing) | Prepared |
| 4.7 | Exactly-once inventory restoration | `scripts/test-oversell.ts` integrity assertions + webhook replay counts | Prepared |
| 4.8 | Durable late-payment compensation | `scripts/readiness/late-payment-refund.ts` (T-obligation assertions) | Prepared |

## 5. Payout webhook recovery

| # | Requirement | Tool | Status |
|---|---|---|---|
| 5.1 | Original HMAC verification | FIN-4 §A (`bun run verify:finance`) | Prepared (re-run post-migration) |
| 5.2 | Stored-event recovery (`recovery: true` mode) | `scripts/readiness/webhook-resilience.ts` (existing) | Prepared |
| 5.3 | Stale event recovery | same | Prepared |
| 5.4 | Duplicate delivery → duplicate:true, ledger unchanged | FIN-4 §A (A3–A6) | Prepared |
| 5.5 | Concurrent delivery → exactly-one T-posting | `scripts/fin-concurrency.ts` (existing) | Prepared |
| 5.6 | Injected P2034 → bounded retry, then 503 | `scripts/readiness/txpool-probe.ts` + `scripts/test-tx-retry-unit.ts` | Prepared |
| 5.7 | Retry exhaustion → 503 PAYMENT_TX_RETRY_EXHAUSTED (PSP retries) | `scripts/readiness/webhook-resilience.ts` | Prepared |
| 5.8 | No duplicate T4/other postings | FIN-4 §B (B2–B8) | Prepared |

## 6. Finance (re-run post-migration)

| # | Requirement | Tool | Status |
|---|---|---|---|
| 6.1 | Full finance verification suite | `bun run verify:finance` (FIN-4, 33 checks; residue policy documented in the script header) | Prepared (re-run) |
| 6.2 | Wallet-cache vs ledger reconciliation (read-only) | `bun scripts/readiness/wallet-reconcile.ts` — **never `--apply`** | Prepared |
| 6.3 | Double-entry balance | `bun scripts/verify-ledger.ts` | Prepared |
| 6.4 | Refund caps / commission parity / dedup coverage | `bun scripts/fin-reconcile.ts`, `bun scripts/test-commission-parity.ts`, `bun scripts/finance-preflight.ts` | Prepared |

## 7. Guest-order OTP + email-verified claiming (FINAL CLOSURE — migration 20261104000000 + configured email provider OR Mailpit required)

Run: `MAILPIT_URL=http://127.0.0.1:8025 bun scripts/readiness/guest-order-otp-e2e.ts`
(or operator-driven with `GUEST_OTP_TEST_CODE=<code from the real mailbox>`).
Code-retrieval modes are both REAL (local SMTP sink inbox / human-read) — no
simulated delivery. Zero financial writes (test orders stay payment_pending).

| # | Requirement | Tool | Status |
|---|---|---|---|
| 7.1 | Knowledge-pair-only lookup denial (existing + ghost → identical 401) | `guest-order-otp-e2e.ts` (1a/1b) | Prepared |
| 7.2 | OTP request uniformity (200 for existing AND ghost pairs) | same (2a/2b) | Prepared |
| 7.3 | OTP brute-force lockout (5 wrong → correct code still rejected while unexpired) | same (3.1–3.6) | Prepared |
| 7.4 | OTP verification + grant issuance (order-bound v1 grant) | same (4a) | Prepared |
| 7.5 | OTP replay prevention (same code twice → 401) | same (5) | Prepared |
| 7.6 | Grant expiry & wrong-order rejection (live-grant wrong number → 401; forged → 401) | same (6a–6c) + unit tests (grant TTL) | Prepared |
| 7.7 | Receipt authorization (401 before payment gate; grant on unpaid → 409 NOT_PAID) | same (7a/7b) | Prepared |
| 7.8 | ATTACK: register with victim's email (unverified) → claims nothing; cannot read the order | same (8a–8d) | Prepared |
| 7.9 | Legitimate claiming works EXACTLY ONCE (verify → both claimed; re-verify/re-login → 0) | same (9a–9e) | Prepared |
| 7.10 | Authenticated ownership (owner session 200; foreign session uniform 401) | same (10a–10c) | Prepared |

Sandbox evidence already recorded (read-only, no DB writes): lookup 401 for
knowledge-pair/forged grants, 200 for valid grant + owning session (incl. PDF
receipt), uniform 503 fail-closed on OTP routes pre-provider/pre-migration,
login with claiming gated (`emailVerified:false`).

---

## Execution order (staging day)

1. Deploy per the runbook (migrations 1–6 applied; env secrets set).
2. `bun scripts/readiness/deployment-smoke.ts` — the existing broad smoke.
3. `bun scripts/readiness/session-security-e2e.ts` → `mfa-e2e.ts` → `reviews-e2e.ts` (the three Phase 2.1 packs).
4. `bun scripts/readiness/guest-order-otp-e2e.ts` (FINAL CLOSURE — requires the email provider or Mailpit configured first).
5. Scheduler race procedures (§4.4) + expiry probes.
6. `webhook-resilience.ts` + `txpool-probe.ts` (§5).
7. Full finance re-run (§6) — LAST, so its residue story stays tidy.
8. Record every result as Executed + Passed/Failed with the printed evidence.

## Explicitly NOT claimed

- No live-PSP testing here (see `docs/psp/psp-sandbox-test-plan.md` — separate authorization).
- No load ladder here (see `scripts/loadtest-k6/README.md` — separate staging authorization).
- No production database is touched by anything in this pack.

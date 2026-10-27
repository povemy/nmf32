# 13 — Staging Demonstration Guide (for a PSP reviewer)

**Preconditions:** a staging environment per `performance/environment-matrix.md` §3
(currently **BLOCKED** on Supabase project + hosting access — this is the script to
run once it exists). Staging runs a production build with mock-PSP payment mode (or
the provider's official sandbox when available) — **never real charges**. All demo
data is `[LT]`-prefixed test data; no real customer/vendor data.

**No secrets are disclosed to the reviewer.** `CRON_SECRET` and
`PSP_WEBHOOK_SECRET` live in the hosting secret manager; raw-webhook probes that
require signing are executed by the NOMOFEE operator via the readiness scripts
(server-side, env access), with the reviewer observing outputs. The reviewer can
exercise unsigned and replayed deliveries directly — rejection paths need no secret.

## 0. Environment identification (what proves what)

| Step | Command (example) | Expected | Proves |
|---|---|---|---|
| 0.1 | `GET /api/health` | `status: healthy`, `deployment.nodeEnv = "production"` (staging build), `deployment.dbFingerprint` (16-hex, non-sensitive), ledger invariants ok, hardDriftCount 0 | app + DB identity, ledger integrity (`src/app/api/health/route.ts`) |
| 0.2 | `GET /api/health?fresh=1` | recomputed invariants | same, uncached |
| 0.3 | scheduler status (`GET` the scheduler service status endpoint, port 3005) | ticks, `consecutiveFailures: 0`, `secretConfigured: true` (boolean only) | scheduler liveness without exposing the secret (`mini-services/expiry-scheduler/README.md`) |

## 1. Happy path — checkout → payment → ledger

1. Register/login an `[LT]` shopper (`lt-demo-*@lt.test` via the real auth API).
2. `POST /api/checkout/create` with header `Idempotency-Key: lt-demo-1` and an
   `[LT]`-titled product, valid MYR shipping address.
   **Expected:** `201` with `paymentRef`, order numbers, totals.
   **Proves:** one charge session (PaymentGroup) covering N per-seller orders; stock
   decrement + commission snapshots at create (`src/app/api/checkout/create/route.ts`).
3. Replay the same request with the same key.
   **Expected:** `200` `duplicate:true`, identical order numbers, exactly one group.
   **Proves:** checkout idempotency (`04-idempotency-design.md` §1).
4. Trigger the payment (staging, mock mode): `POST /api/checkout/payments/{ref}/simulate`
   `{"result":"succeeded"}` — the server signs the real webhook shape itself
   (`simulate/route.ts`).
   **Expected:** `200 {status:"succeeded"}`; order → `paid`; one T1 per order; buyer
   cart cleared of purchased variants; seller notifications exactly once.
   **Proves:** verified webhook → claim-first exactly-once → ledger T1 mirror
   (`02-payment-flows.md` §1).

## 2. Duplicate webhook (operator-run or observed)

5. Operator: `POST /api/webhooks/payments/{provider}` with a correctly signed
   redelivery of the same `payment.succeeded` (via the readiness scripts).
   **Expected:** `200 {duplicate:true}`; T1 count unchanged.
   **Proves:** claim-first + ledger dedupKeys (`04` §2–3). The reviewer can verify
   the counts from the admin ledger view or the smoke evidence shape
   (`performance/runs/2026-10-27-deployment-smoke.json` §C5).
6. Reviewer (no secret needed): send an **unsigned** delivery and a correctly-signed
   **stale** (old `ts`) delivery to the same route.
   **Expected:** `400 BAD_SIGNATURE` and `400 STALE_EVENT` respectively — both still
   logged in `PaymentWebhookLog` with `signatureValid:false`.
   **Proves:** signature enforcement, replay window, log-then-verify
   (`05-webhook-security.md` §2–3).

## 3. Expiry → late payment → refund case

7. Create a second `[LT]` checkout and let its 30-minute window pass; the scheduler
   tick (≤60 s cadence in staging) expires it.
   **Expected:** group `expired`, orders `payment_expired`, stock re-incremented,
   `InventoryLog` reason `expiry:{ref}`; sweep outcome visible in Setting
   `cron.expiry_sweep.last` via the operator (`GET /api/cron/expiry-sweep`).
   **Proves:** expiry sweep claim-first semantics (`03-state-machines.md` §1–2).
8. Trigger a late payment for that expired ref (mock simulate).
   **Expected:** **409 `GROUP_EXPIRED`**; a `PaymentReconciliation` case created with
   status `requested`, amount = the captured webhook amount.
   **Proves:** refusal policy + durable refund obligation recorded BEFORE the
   refusal (`06-refund-recovery.md` §1–2).
9. Wait for the refund-reconcile tick (30–60 s) — with the mock adapter the case
   refunds idempotently under key `recon:{caseId}`; on a real provider sandbox the
   case would sit as `awaitingOperator`/`processing` per the adapter.
   **Expected:** case `succeeded` with `providerRefundId` set (mock mode); GET
   observability shows counts + `awaitingOperator`.
   **Proves:** reconciliation sweep contract, provider-authoritative completion only
   (`06` §3).

## 4. Payout lifecycle

10. Seller requests a payout within available (matured) balance → admin approves →
    operator triggers the provider confirmation event (mock:
    `POST /api/webhooks/payments/payout-simulate {"referenceNo":"PO-…"}`).
    **Expected:** payout `requested → processing → paid`; T3 at approve, T4 at
    confirmation; seller in-app + email notifications exactly once.
    **Proves:** payout state machine + T3/T4 postings (`03` §3, `02` §4). An
    illegal-transition probe (e.g. confirm before approve) yields 409 `STATE_INVALID`.

## 5. Scheduler & security posture

11. Operator demonstrates the cron-auth matrix (scheduler-e2e scenarios F1/F2
    already archived — `performance/runs/2026-10-25-scheduler-e2e.json`): wrong
    secret → 403; missing secret in production posture → 503 `CRON_NOT_CONFIGURED`.
    **Proves:** fail-closed scheduler auth (`src/lib/cron-auth.ts`).
12. Reviewer: `GET /api/cron/expiry-sweep` WITHOUT credentials in staging.
    **Expected:** 403/503 per the configured mode — never an open surface.

## 6. Load demonstration (optional, target-guarded)

- Only through `scripts/readiness/load-scenarios.ts`, which **refuses to start**
  unless `LOADTEST_TARGET_CONFIRM=staging` AND `LOADTEST_DB_FINGERPRINT` matches the
  staging app's published fingerprint (verified 7/7,
  `performance/runs/2026-10-27-target-guard.json`).
- Expected outcomes to show: zero oversell, exactly-once confirmations, clean
  `503 CHECKOUT_BUSY` + `Retry-After` under overload — and honest capacity numbers
  labelled with the staging tier (no dev→production extrapolation).

## 7. Evidence walk (paper review)

Close by walking the reviewer through `10-test-evidence.md` and the archived runs,
with the standing caveat: **all internal evidence was produced on mock rails; no
real provider behaviour has been tested.** Provider-specific validation begins only
after the items in `12-provider-checklist.md` are answered.

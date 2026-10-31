# NOMOFEE — PSP Provider-Sandbox Test Plan (Phase 2 / F3)

**Status: PREPARED, NOT EXECUTED.** This plan is the runbook for the first
verification of NOMOFEE's payment rails against a REAL provider sandbox
(ToyyibPay FPX sandbox and/or Stripe MY test mode). It is NOT a claim that any
live PSP integration has been verified. All rails in the current deployment
are the documented sandbox-mock (`src/lib/psp.ts` — `PSP_PROVIDERS` has exactly
one entry, `mock`, `sandboxOnly: true`; `/api/checkout/payments/[ref]/simulate`
plays the PSP and emits the real webhook shape; the Stripe-MY adapter scaffold
in `src/lib/psp-adapters/` is `awaitingAdapter: true`).

## 1. What the mock rails HAVE proven (code-level + dev-DB evidence)

The FIN-4 gate (`bun run verify:finance`, executed 2026-10-31, ALL PASS)
exercises the full money pipeline through the mock rails with real API calls:
checkout creation → signed webhook → T1 double-entry posting → duplicate
webhook replay (ledger byte-identical) → payout lifecycle with concurrent
double-approve (exactly-one T3/T4) → refund caps/insufficient-wallet guards →
sweep idempotency → full-ledger invariant scan. **What that does NOT prove:**
the behaviour of a real gateway — signature formats, retry cadences,
out-of-band status transitions, transfer/settlement semantics, bank payout
evidence. That is exactly what this plan covers.

## 2. Preconditions (staging environment, authorized access only)

1. Staging deployment (`NODE_ENV=production` semantics, `CRON_SECRET` and
   `PSP_WEBHOOK_SECRET` set to STAGING values — never production secrets).
2. Provider sandbox accounts: ToyyibPay sandbox merchant + Stripe MY test-mode
   account with test API keys. Webhook endpoints pointed at
   `https://<staging-host>/api/webhooks/payments/<provider>`.
3. `PSP_WEBHOOK_SECRET` = the provider's signing secret for the staging
   endpoint (the processor verifies HMAC-SHA256 timing-safely, ±10 min
   freshness window — see `src/app/api/webhooks/payments/process.ts`).
4. Test data: `[LT]` products with stock, `qa.shopper@nomofee.test` buyer,
   staging sellers with wallets. DB fingerprint check via
   `GET /api/health` (`deployment.dbFingerprint`) must match the runner's own
   resolution (same-DB proof — `scripts/loadtest-k6/` guards already
   implement this).
5. Rollback plan: staging DB snapshot before the run; the run is
   non-destructive by design (only audited financial rows).

## 3. Test matrix (execute in order; every case has a provider-side step,
##    a NOMOFEE-side assertion, and an evidence capture)

| # | Case | Provider-side action | NOMOFEE assertion (evidence) |
|---|---|---|---|
| P1 | Payment creation | Create checkout (`POST /api/checkout/create`, all 5 `KNOWN_PAYMENT_METHODS` ids once each) → follow `redirectUrl` to the provider's hosted page | PaymentGroup `requires_payment`, `expiresAt` = +30 min; orders `payment_pending`; stock decremented; `InventoryLog` rows; commission snapshot frozen (`OrderItem.breakdownJson`) |
| P2 | Successful payment | Complete the hosted-page payment with the provider's SUCCESS test credential | Webhook 200; PaymentGroup `succeeded`; orders `paid`; exactly one T1 (`dedupKey order_paid:order:{id}`); wallet cache matches ledger; cart cleared (selected items only) |
| P3 | Failed payment | Use the provider's FAIL test credential (e.g. FPX declined) | Webhook 200; group `failed`; orders stay `payment_pending`; NO T1; buyer retry window intact (`requires_payment` re-entry) |
| P4 | Duplicate webhook | Provider sandbox "resend webhook" (or re-POST the captured payload + signature verbatim) | Response `duplicate: true`; ledger transaction/line counts byte-identical before/after (FIN-4 A5/A6 pattern) |
| P5 | Invalid signature | Re-POST the payload with a tampered signature (flip one hex char) | 400 `BAD_SIGNATURE`; row logged in `PaymentWebhookLog` with `signatureValid=false`, `processed=false`; NO financial effect |
| P6 | Out-of-window webhook | Capture a signed payload; wait > 10 min; re-POST | 400 `STALE_EVENT` (freshness window); no financial effect; ops sweep (`admin/payouts/sweep`) skips `signatureValid=false` rows |
| P7 | Partial failure (multi-seller) | Two-seller checkout; provider-side: pay successfully, then trigger a provider-side refund/void on ONE leg if supported — otherwise simulate via NOMOFEE refund on one order | Ledger stays balanced; refund T5 exactly-once; commission reversal + affiliate reversal proportional (check `Refund.commissionReversalMinor`/`affiliateReversalMinor`) |
| P8 | Refund | Provider dashboard refund of a captured payment; then `POST /api/admin/refunds/{id}/process` | T5 posted once; replay 409 `ALREADY_PROCESSED`; cumulative cap enforced (FIN-4 C-section semantics against provider-real amounts) |
| P9 | PSP transfer / application fee | For Stripe-MY: enable test-mode separate charges & transfers; confirm the application-fee amount equals the commission snapshot | Platform fee visible in Stripe dashboard = `OrderItem.commissionMinor` + `affiliatePoolMinor`; connected-account net = `sellerNetMinor` (adapter-level evidence) |
| P10 | Seller payout | Nominee payout flow with provider payout sandbox (Stripe test payout / ToyyibPay settlement report) | `Payout` `processing`→`paid` via the admin mark-paid route with the provider reference recorded; T4 exactly-once; wallet `reservedMinor` released |
| P11 | Bank payout evidence | Record the provider's settlement/bank-transfer reference | `providerRef` stored on Payout; reconciliation report (`D1` pattern) shows `cacheMatches=true` |
| P12 | Provider-reference reconciliation | Cross-list provider sandbox transaction IDs vs `PaymentGroup.ref` / `PaymentWebhookLog.providerRef` | Every provider transaction maps to a group; every group with `succeeded` maps to a provider transaction; zero orphans both directions (scriptable — extend `verify-integrity.ts`) |

## 4. Evidence to capture per case

- HTTP request/response pairs (webhook headers + body + our status).
- `PaymentWebhookLog` row states before/after.
- Ledger transaction + line deltas (`SELECT count(*)` snapshots — the FIN-4
  `txnCount/lineCount` pattern).
- Provider dashboard screenshots/export for P2/P3/P8/P9/P10/P11.
- `/api/health?fresh=1` output at the end (ledger invariants must be PASS).

## 5. Explicit non-goals

- No live/production PSP accounts are contacted at any point.
- No `--apply` reconciliation commands (read-only + documented API calls only).
- This plan does not certify the adapter scaffold (`psp-adapters/stripe-my.ts`)
  until it is implemented and run through P1–P12.

## 6. Tooling note

`scripts/loadtest-k6/verify-integrity.ts` (financial-safety verifier for
load runs) and `scripts/readiness/webhook-resilience.ts` (signature/replay
fault-injection) already exist and are directly reusable for P4/P5/P6 — the
same assertions, pointed at the staging host with the provider's real webhook
payloads. `scripts/readiness/late-payment-refund.ts` covers the P6→late-arrival
variant against the expiry sweep.

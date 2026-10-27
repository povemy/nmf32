# 02 — Payment Flows (sequence diagrams)

All flows are implemented in `src/app/api/webhooks/payments/process.ts` (payment
processing), `src/app/api/checkout/create/route.ts` (checkout), `src/lib/ledger.ts`
(postings), `src/app/api/cron/expiry-sweep/route.ts` and
`src/app/api/cron/refund-reconcile/route.ts` (scheduler ticks). Evidence for each
behaviour is listed in `10-test-evidence.md`.

## 1. Happy path — checkout → payment → webhook → ledger → payout

```
Buyer        App (checkout)          PSP (mock rails)      Webhook pipeline           Ledger
 │  POST /api/checkout/create │             │                    │                      │
 │  Idempotency-Key: K        │             │                    │                      │
 │───────────────────────────▶│             │                    │                      │
 │                            │ admission gate (8 inflight / 32 waiting / 5 s)         │
 │                            │ ONE tx: PaymentGroup(requires_payment, +30 min window) │
 │                            │   + N Orders(payment_pending, idemKey "K:{storeId}")   │
 │                            │   + stock decrement + commission snapshots              │
 │◀── 201 {paymentRef, orders}│             │                    │                      │
 │                            │             │                    │                      │
 │  POST /pay/{ref}/simulate (sandbox stand-in for hosted checkout)                    │
 │──────────────────────────────────────────▶                    │                      │
 │                            │  server signs {providerRef, eventType, amountMinor, ts}│
 │                            │  ────────── processPaymentWebhook ─────────▶           │
 │                            │             │   verify HMAC + freshness (±10 min)       │
 │                            │             │   log row FIRST (signatureValid flag)     │
 │                            │             │   Serializable tx:                        │
 │                            │             │     claim: group → succeeded (count 1)    │
 │                            │             │     orders → paid                          │
 │                            │             │     T1 per order ────────────────────────▶│
 │                            │             │       DR GATEWAY:{p} total                │
 │                            │             │       CR SELLER:{w}:PAYABLE net (hold)    │
 │                            │             │       CR PLATFORM:REVENUE_COMMISSION      │
 │                            │             │     cart clear (purchased variants only)  │
 │                            │             │   post-commit: notify (dedupKeys),        │
 │                            │             │     wallet-cache refresh (best-effort)    │
 │◀── 200 {status: succeeded} │             │                    │                      │
 │                            │             │                    │                      │
 │ Seller requests payout → admin approve ─▶ T3 (seller payable → payout clearing)      │
 │ Provider confirms (payout-simulate in sandbox; real webhook in production)           │
 │                            │             │   payout.succeeded → claim processing→paid│
 │                            │             │   T4 (payout clearing → PLATFORM:BANK_MAIN)│
```

Amount guard: the webhook `amountMinor` must equal `PaymentGroup.totalMinor` (409
`AMOUNT_MISMATCH` otherwise) — `process.ts`.

## 2. Duplicate webhook delivery (exactly-once)

```
PSP ── payment.succeeded (redelivery) ──▶ /api/webhooks/payments/[provider]
                                          │ rate limit (60/min/IP) → raw body read
                                          │ verify HMAC + freshness → log row
                                          │ Serializable tx:
                                          │   claim: updateMany WHERE status NOT IN
                                          │   (succeeded, expired) → count = 0
                                          │   ⇒ empty tx return (no writes at all)
                                          │ re-read status:
                                          │   expired ⇒ late-payment path (flow 3)
                                          │   else ⇒ answer 200 {ok, duplicate: true}
                                          │ ledger T1 dedupKey order_paid:order:{id}
                                          │   backstops any window (P2002 → replay)
                                          │ notification dedupKeys block duplicate mail
```

Verified: duplicates answer 200 `duplicate:true` with T1 count unchanged
(`performance/runs/2026-10-27-deployment-smoke.json` §C5;
`performance/runs/2026-10-25-load-webstorm.json` — 15 duplicate deliveries, all 200,
exactlyOnce true).

## 3. Late payment after expiry → refund obligation → reconcile

```
Checkout window expires (+30 min)
Scheduler :3005 ──POST /api/cron/expiry-sweep──▶ claim: requires_payment → expired
                                                 per-order: payment_pending → payment_expired
                                                 stock increment + InventoryLog "expiry:{ref}"
                                                 outcome → Setting cron.expiry_sweep.last

PSP ── payment.succeeded (late, correctly signed) ──▶ processPaymentWebhook
        │ group.status == "expired" (or claim lost and re-read == expired):
        │   recordLatePaymentObligation  ── BEFORE the refusal ──
        │     upsert PaymentReconciliation (provider, providerRef) UNIQUE
        │     amountMinor = VERIFIED webhook amount (captured funds)
        │     reason = late_payment_after_expiry
        │   mark webhook row processed
        │   answer 409 GROUP_EXPIRED  (no money moves, no order resurrection)

Scheduler :3005 ──POST /api/cron/refund-reconcile──▶ for each open case (batch 25):
        │  adapter = resolveRefundAdapter(provider)   — none ⇒ awaitingOperator
        │  attempts ≥ 8 ⇒ skippedExhausted (visible operator item)
        │  write durable intent FIRST: status=processing, attempts+1, lastAttemptAt
        │  provider call OUTSIDE any tx with idempotencyKey "recon:{caseId}"
        │    (previous attempt reached provider ⇒ read authoritative status instead)
        │  persist outcome ONLY from the provider's authoritative record:
        │    succeeded ⇒ status=succeeded, providerRefundId
        │    failed    ⇒ status=failed (permanent; operator item)
        │    pending   ⇒ status=unknown (re-checked next tick, 15 s backoff)
```

Verified end-to-end on mock rails: `performance/runs/2026-10-25-late-payment-refund.json`
(scenarios S1–S10, incl. crash-after-provider recovery and fault-injected obligation
write). Runbook: `docs/late-payment-refund-runbook.md`.

## 4. Payout lifecycle (T3 → provider confirmation → T4/T4f)

```
Seller ── POST /api/store/payouts ──▶ ONE open request per wallet; amount authorized
        │   against LEDGER TRUTH (not cache) in a Serializable tx; status=requested
Admin  ── POST /api/admin/payouts/{id}/approve ──▶ claim: requested→processing
        │   T3: DR SELLER:PAYABLE | CR PLATFORM:PAYOUT_CLEARING
Admin  ── mark-paid / fail ──▶ claim: processing→paid / failed
        │   T4:  DR PAYOUT_CLEARING | CR BANK_MAIN
        │   T4f: DR PAYOUT_CLEARING | CR SELLER:PAYABLE (reversal of T3)
PSP    ── payout.succeeded / payout.failed webhook ─▶ same claim pattern
        │   (assertTransition guard → amount guard → conditional updateMany
        │    WHERE status="processing" → T4/T4f inside the same Serializable tx)
        │   providerRef resolution: Payout.referenceNo first, providerRef fallback
        │   illegal transitions (e.g. requested→paid) ⇒ 409 STATE_INVALID
```

All transitions validated by `src/lib/payout-state.ts` (`assertTransition`);
posting recipes in `src/lib/ledger.ts` (`postPayoutInitiated/Confirmed/Failed`).
Verified lifecycle behaviour (T3/T4/T4f wallet math): finance-regression tests 6a–6d
(`performance/runs/2026-10-25-finance-regression.json`).

## 5. Failure / ambiguous outcomes (summary)

| Situation | System behaviour | Reference |
|---|---|---|
| Webhook tx serialization conflict (P2034) | whole-tx bounded retry (≤3 attempts, jittered) — safe because the claim + dedupKeys make full retry exactly-once | `process.ts` retry loop |
| Lock contention | session-level `statement_timeout=10s`, tx timeout 15 s — fails fast, PSP redelivery converges | `process.ts` tx options |
| Crash between claim and post-commit fan-out | money + order state are committed; only observability rows can be lost (dedupKey-guarded) | `process.ts` F1 note |
| Ambiguous refund outcome | status `unknown`, re-read from provider's authoritative record next tick | `06-refund-recovery.md` |

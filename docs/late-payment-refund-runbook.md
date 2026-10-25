# Late-Payment Refund & Reconciliation Runbook

**Scope:** payments captured at a PSP for checkout sessions (PaymentGroups)
whose reservation window expired before the `payment.succeeded` event was
processed. Implementation: `src/lib/psp-refund.ts`, `PaymentReconciliation` +
`PspRefundRecord` models, `/api/cron/refund-reconcile` (tick), recorded at the
refusal site in `src/app/api/webhooks/payments/process.ts` (409
`GROUP_EXPIRED`).

## 1. What happened (the invariant)

1. Checkout decremented stock and opened a 30-minute payment window
   (`PaymentGroup.expiresAt`).
2. The buyer completed payment **at the PSP** but the success event arrived
   after the expiry sweep had already claimed the group, cancelled its orders
   (`payment_expired`) and **restocked the items**.
3. The webhook path refuses the event with **409 GROUP_EXPIRED** — no ledger
   posting, no order resurrection (goods may already be re-sold; fulfilling a
   stale payment without re-securing stock is not legitimate).
4. Because a real PSP has **already captured the funds**, the refusal also
   records a **durable refund obligation**: one `PaymentReconciliation` row per
   `(provider, providerRef)`, carrying the provider payment id (when sent),
   the **captured amount** (the verified webhook amount — what must be
   RETURNED), currency, reason `late_payment_after_expiry`, and the processing
   state machine `requested → processing → succeeded | failed | unknown`.

## 2. Automated processing (sandbox mock PSP — what runs today)

`/api/cron/refund-reconcile` is ticked by the scheduler service every 30 s
(this deployment) and processes cases with a bounded batch (25), bounded
retries (8 attempts, 15 s backoff), and **provider idempotency keys**
(`recon:{caseId}`): the same key can never produce a second provider refund.
Completion is only ever read from the provider's authoritative record — never
inferred from "a request was sent". Verified by
`scripts/readiness/late-payment-refund.ts` (all 10 race scenarios PASS,
`performance/runs/2026-10-25-late-payment-refund.json`).

## 3. Real PSPs — the honest limitation

**No production PSP refund adapter exists yet** (`stripe_my`, `curlec`,
`ipay88` are awaitingAdapter — see `lib/psp.ts`). For those providers the tick
**skips the case untouched** (no simulated refunds, ever) and the cases are
surfaced as `awaitingOperator`. Until an adapter ships, late-payment refunds
for a real PSP are a **manual operator procedure**:

### Manual procedure (per case, in order)

1. **Triage** — `GET /api/admin/payment-reconciliation?status=requested`
   (admin-authenticated). Cases older than a few minutes with
   `attempts = 0` and a provider in `awaitingOperator` need this runbook.
2. **Verify with the provider** — look up the payment by
   `providerPaymentId` (or `providerRef`) in the PSP dashboard. Confirm:
   captured amount == `amountMinor`, currency, and that the charge is not
   already refunded/chargebacked.
3. **Verify the refusal was correct** — the linked `PaymentGroup` must be
   `expired`, its orders `payment_expired`, stock re-listed (InventoryLog
   `expiry:{ref}`). If anything else is true, STOP — escalate to engineering
   (the case may be miscategorized).
4. **Refund at the PSP** with idempotency key `recon:{caseId}` (copy it from
   the admin case list). Amount: exactly `amountMinor` `currency`. Reason:
   `late_payment_after_expiry`.
5. **Record the outcome** — set the case status:
   - refund confirmed by the PSP (receipt/verified status) → `succeeded`,
     put the PSP refund id into `providerRefundId` and the confirmation
     reference into `resolutionNote`;
   - PSP rejected the refund → `failed` + `lastError`;
   - outcome unclear / provider processing → `unknown` (re-check later).
   Do this via the admin API (`PATCH`-style update through your DB console or
   a future admin action endpoint) — **never** edit ledger rows; this table is
   an obligation tracker, not an accounting surface.
6. **Buyer communication** — the buyer saw "payment window expired" at
   checkout; once refunded, notify them (order receipt channel) that the
   charge was reversed by the PSP.

### Alerts wired to this runbook

- Scheduler `REFUND_STUCK` alert (port 3005 status) when cases sit in
  `failed`/`unknown`.
- `/api/admin/system/health` exposes per-status counts under
  `paymentReconciliation`.
- `/api/cron/refund-reconcile` GET reports `awaitingOperator` + oldest open
  case age.

## 4. What must NEVER be done

- Never resurrect the expired order or re-reserve stock for a late payment
  without a fresh buyer-confirmed checkout.
- Never mark a case `succeeded` without the provider's own confirmation
  (receipt id / verified status endpoint / PSP webhook).
- Never edit or delete `PaymentWebhookLog`, `InventoryLog`,
  `OrderStatusHistory` or ledger rows to "make a case clean".
- Never process these refunds through the order-level `Refund` workflow —
  that flow assumes a paid order and reverses internal accounting; these
  orders were never paid internally (no T1 exists).

## 5. Adapter contract (for the future PSP integration)

`RefundAdapter` in `src/lib/psp-refund.ts`: implement `executeRefund`
(idempotent by key; returns `succeeded | failed | pending`) and
`getRefundStatus` (pure authoritative query), register in `REFUND_ADAPTERS`,
register the provider in `PSP_PROVIDERS`. Keep external PSP calls outside DB
transactions; keep the 409 GROUP_EXPIRED refusal unchanged.

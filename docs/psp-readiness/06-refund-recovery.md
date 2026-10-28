# 06 — Refund & Late-Payment Recovery

**Files:** `src/lib/psp-refund.ts`, `src/app/api/webhooks/payments/process.ts` (both
`GROUP_EXPIRED` sites), `src/app/api/cron/refund-reconcile/route.ts`,
`docs/late-payment-refund-runbook.md`, models `PaymentReconciliation` +
`PspRefundRecord` (`prisma/schema.prisma`).

## 1. The late-payment problem and the refusal policy

Checkout decrements stock at create and opens a 30-minute payment window
(`PaymentGroup.expiresAt`, `src/app/api/checkout/create/route.ts:181`). If the sweep
expires the group (restock included) and a **correctly signed `payment.succeeded`
arrives afterwards**, the platform faces captured funds it cannot legitimately
fulfil: released stock may already be re-sold, and fulfilling a stale payment
without re-secured stock or buyer re-consent is not legitimate
(`process.ts` late-payment block).

**Policy: definitive refusal.** 409 `GROUP_EXPIRED`, no money moves, no order
resurrection, no re-reservation. The PSP sees a permanent failure
(`process.ts:197-208`). Because a real PSP has **already captured** the buyer's
funds when that verified event arrives, the refusal alone does not return them —
hence the durable obligation.

## 2. Durable refund obligation (recorded BEFORE the refusal)

`recordLatePaymentObligation` (`src/lib/psp-refund.ts`) is called at **both**
refusal sites in `process.ts` (pre-claim status check, and claim-loss re-read ==
`expired`):

- Idempotent upsert on `(provider, providerRef)`; an existing case is never
  regressed (`update: {}`) — redelivery can neither duplicate nor reset an
  in-flight refund.
- `amountMinor` = the **verified webhook amount** — what the provider captured and
  must return — with any divergence from the group total recorded in
  `resolutionNote` for operator verification.
- Optional `providerPaymentId` (real adapters MUST send it; mock rails identify by
  `providerRef`).
- Crash window between obligation write and the 409 answer leaves at worst
  "case exists, webhook answered 5xx" → PSP redelivery converges on the unique row.

## 3. Reconciliation sweep contract (`/api/cron/refund-reconcile`)

The route is the **worker tick** (the scheduler service at `mini-services/expiry-scheduler`
POSTs it every 30 s in this deployment; production: platform cron at ≤60 s cadence —
`performance/environment-matrix.md`). Contract (route header + code):

1. **Provider calls happen OUTSIDE any DB transaction**; the only writes are the
   case's own state transitions.
2. **Durable attempt intent first**: `processing` + `attempts+1` + `lastAttemptAt`
   written BEFORE the provider call — a mid-flight crash can neither lose the
   obligation nor double-refund (stable per-case key, §4).
3. **Completion only from the provider's authoritative record** —
   `adapter.getRefundStatus` or the idempotent `executeRefund` result — never
   inferred from "a request was sent".
4. **Bounded retries**: batch 25 cases/tick; 15 s backoff (`REFUND_BACKOFF_MS`);
   max 8 attempts, after which the case stays open as an exhausted operator item
   (`skippedExhausted` — never silently dropped).
5. **Permanent provider rejection** ⇒ `failed`, visible for operator action.
6. **Providers without an adapter** (real PSPs not yet integrated) are skipped
   untouched and reported as `awaitingOperator` — **no simulated refunds, ever**.
7. Tick outcome recorded durably in Setting `cron.refund_reconcile.last`; GET
   endpoint exposes per-status counts, oldest open case, `awaitingOperator`
   (also surfaced via `/api/admin/payment-reconciliation` and scheduler
   `REFUND_STUCK` alerts).

## 4. Provider idempotency key — `recon:{caseId}`

`refundIdempotencyKey(caseId)` returns `recon:{caseId}` (`src/lib/psp-refund.ts`).
Same key ⇒ the provider returns the same refund's outcome, never a second refund.
If a previous attempt reached the provider (`providerRefundId` set), the tick reads
the authoritative status instead of re-executing
(`refund-reconcile/route.ts:105-123`).

## 5. The `RefundAdapter` seam (what a real provider must implement)

```ts
export interface RefundAdapter {
  id: string;
  sandboxOnly: boolean;
  executeRefund(input: {
    idempotencyKey: string;      // "recon:{caseId}" — stable per case
    providerRef: string;         // PaymentGroup.ref
    providerPaymentId?: string | null;
    amountMinor: number;         // integer minor units (sen for MYR)
    currency: string;
  }): Promise<RefundExecution>;  // { refundId, status: succeeded|failed|pending, detail? }
  getRefundStatus(input: { idempotencyKey: string }): Promise<RefundExecution | null>;
}
```

(`src/lib/psp-refund.ts`.) Rules for a production adapter (from the interface docs
and the runbook §5):

- `executeRefund` must be **idempotent by key** at the provider (native idempotency
  key support or a verified equivalent — TO BE MAPPED FROM CHOSEN PROVIDER'S
  OFFICIAL DOCUMENTATION).
- `getRefundStatus` is a **pure query** — it must never advance provider state.
- Register in `REFUND_ADAPTERS` and the provider in `PSP_PROVIDERS`
  (`src/lib/psp.ts`); keep external calls outside DB transactions; keep the 409
  `GROUP_EXPIRED` refusal unchanged.
- `sandboxOnly: true` adapters refuse in production unless the mock gate is
  explicitly enabled (`mockPspAllowed`, `src/lib/psp.ts`).

The mock adapter (`mockAdapter` in the same file) plays these rails with durable
`PspRefundRecord` state — its record IS "the provider's authoritative record" in
this sandbox, which is why completions read from it are honest.

## 6. Operator runbook (until a real adapter ships)

`docs/late-payment-refund-runbook.md` is the binding manual procedure per case:
triage (`GET /api/admin/payment-reconciliation?status=requested`) → verify the
charge at the provider (captured amount == `amountMinor`, not already refunded) →
verify the refusal was correct (group `expired`, orders `payment_expired`, stock
re-listed, `InventoryLog expiry:{ref}`) → refund at the PSP **with idempotency key
`recon:{caseId}`** → record the outcome (`succeeded`/`failed`/`unknown`) with the
provider's refund id → buyer communication.

**Never** (runbook §4): resurrect the expired order; mark `succeeded` without the
provider's own confirmation; edit `PaymentWebhookLog`/`InventoryLog`/`OrderStatusHistory`/
ledger rows to "clean" a case; route these refunds through the order-level Refund
workflow (those orders were never paid internally — no T1 exists).

## 7. Verified behaviours (mock rails — internal evidence)

| Scenario | Result | Evidence |
|---|---|---|
| Normal payment ⇒ no case | PASS (S1) | `performance/runs/2026-10-25-late-payment-refund.json` |
| Late payment ⇒ 409 + case `requested`, order/stock invariants hold | PASS (S2/S3) | same |
| Duplicate late webhooks ⇒ one case, never regressed | PASS (S4) | same |
| Timeout ⇒ `unknown` → succeeded from provider record, backoff gate | PASS (S5) | same |
| Crash-after-provider ⇒ idempotent recovery, 1 refund / 2 attempts | PASS (S6) | same |
| Provider rejection ⇒ permanent `failed`, operator-visible | PASS (S7) | same |
| All idempotency keys ≤ 1 refund | PASS (S8) | same |
| Fault-injected obligation write 500 ⇒ redelivery converges on one case | PASS (S9) | same |
| Final audit: no resurrection, no double restock, ledger balanced | PASS (S10) | same |

**Real-PSP refund execution: NOT TESTED** (no adapter exists) — the honest
limitation stated in `src/lib/psp-refund.ts` and `performance/psp-readiness/preflight.md` §6.

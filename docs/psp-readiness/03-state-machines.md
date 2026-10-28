# 03 — State Machines (payment-related)

Sources: `prisma/schema.prisma` (models + status fields), `src/lib/payout-state.ts`
(payout transitions), `src/app/api/webhooks/payments/process.ts` (claim guards),
`src/app/api/cron/expiry-sweep/route.ts`, `src/app/api/cron/refund-reconcile/route.ts`,
`src/lib/psp-refund.ts` (status model). Every transition below is enforced by a
**conditional write** (claim-first) or an explicit guard — never a blind update.

## 1. PaymentGroup (`status`, default `requires_payment`)

```
                 payment.succeeded (webhook, claim-first)
   requires_payment ────────────────────────────────────▶ succeeded
        │            payment.failed (webhook)                    │
        │           ────────────────────────────────────▶ failed │ (terminal)
        │                                                        │
        │  expiry sweep ONLY (cron tick, claim-first)            │
        └─────────────────────────────────────────────▶ expired  │ (terminal)
```

| Transition | Who may set it | Guard |
|---|---|---|
| `requires_payment → succeeded` | webhook processor only | `updateMany WHERE status NOT IN (succeeded, expired)` inside Serializable tx (`process.ts`, group path); amount must equal `totalMinor` (409 `AMOUNT_MISMATCH`) |
| `requires_payment → failed` | webhook processor (`payment.failed`) | single conditional update; an already-`succeeded` group ignores the failed event and is answered as a duplicate (`process.ts`) |
| `requires_payment → expired` | **expiry sweep only** (`/api/cron/expiry-sweep`) | claim-first `updateMany WHERE status = "requires_payment"` + per-order guards + restock in ONE tx (`expiry-sweep/route.ts`) |
| any → (anything else) | nobody | no code path writes other transitions; `succeeded/failed/expired` are terminal |

## 2. Order payment leg (`status`, payment states only)

The full order model has fulfilment states beyond payment (see `prisma/schema.prisma`);
the payment leg relevant to a PSP review is:

```
   payment_pending ──▶ paid              (webhook success tx, via transitionOrder)
        │
        └──▶ payment_expired             (expiry sweep, conditional per-order guard;
             cancelledAt set                an order that became paid is skipped,
                                          never restocked — belt-and-braces)
```

| Transition | Who may set it | Guard |
|---|---|---|
| `payment_pending → paid` | webhook processor (`transitionOrder`, actor `system`) | only inside the claimed success tx; `OrderStatusHistory` row written (`process.ts`) |
| `payment_pending → payment_expired` | expiry sweep only | `updateMany WHERE status = "payment_pending"`; `OrderStatusHistory` note records the group ref (`expiry-sweep/route.ts`) |

## 3. Payout (`src/lib/payout-state.ts` — single source of truth)

```
   requested ──approve──▶ processing ──confirm──▶ paid ──(future, webhook-only)──▶ returned | reversed
       │                        │                                              (terminal)
       │                        └─report failure──▶ failed ──manual retry──▶ processing
       └─reject──▶ rejected (terminal; no ledger movement — T3 never posted)
```

| Transition | Who may set it | Ledger | Route / event |
|---|---|---|---|
| `requested → processing` | admin approve | T3 posts (`postPayoutInitiated`) | `POST /api/admin/payouts/[id]/approve` |
| `requested → rejected` | admin reject | none | `POST /api/admin/payouts/[id]/reject` |
| `processing → paid` | admin mark-paid **or** `payout.succeeded` webhook | T4 (`postPayoutConfirmed`) | mark-paid route / `processPayoutEvent` |
| `processing → failed` | admin fail **or** `payout.failed` webhook | T4f reversal (`postPayoutFailed`) | fail route / `processPayoutEvent` |
| `failed → processing` | admin (bounded manual retry) | — | per `PAYOUT_TRANSITIONS` |
| `paid → returned/reversed` | **nobody yet** (future, webhook-only; no route posts these) | — | `src/lib/payout-state.ts` rationale |

Rules: `assertTransition` throws 409 `STATE_INVALID` on any illegal transition
(e.g. `requested → paid` — the money was never reserved by T3). The *actual*
concurrency guard is the conditional `updateMany` claim in each route/processor;
`assertTransition` is the readable fast-fail (`payout-state.ts` header, `process.ts`).
Payout requests are created as `requested` by sellers (`POST /api/store/payouts`,
one open request per wallet, amount authorized against ledger truth).

## 4. PaymentReconciliation (`src/lib/psp-refund.ts` + `refund-reconcile/route.ts`)

```
   requested ──tick: durable intent──▶ processing ──provider-authoritative outcome──▶ succeeded (terminal)
        ▲                                   │                                           failed (terminal; operator item)
        │                                   └── outcome pending/timeout ──▶ unknown ──┐
        └──────────── transient error, no provider record yet ◀──────────────────────┘
        attempts ≥ 8 ⇒ "exhausted": case stays OPEN and visible (skippedExhausted) — never silently dropped
```

| Transition | Who may set it | Guard |
|---|---|---|
| `requested → processing` | refund-reconcile tick only | durable intent write BEFORE the provider call (`processing` + `attempts+1` + `lastAttemptAt`) |
| `processing → succeeded` | tick, only from the provider's authoritative record | `providerRefundId` recorded; resolutionNote cites the confirmation source |
| `processing → failed` | tick, on provider **rejection** (permanent) | operator item; runbook applies |
| `processing → unknown` | tick, on pending/timeout outcome | re-checked from provider status on a later tick |
| `unknown → processing` | next tick attempt | backoff 15 s, max 8 attempts (`MAX_ATTEMPTS`) |
| *(no transition)* | providers with no adapter | cases stay `requested`, surfaced as `awaitingOperator` — refunds are never simulated (`psp-refund.ts` honest-limits note) |

Obligation recording itself is an idempotent upsert on `(provider, providerRef)`
(`recordLatePaymentObligation`, `psp-refund.ts`) — redelivery can neither duplicate
nor regress a case.

## 5. Cross-machine invariants (why these machines compose safely)

- A `payment.succeeded` for an `expired` group is refused (409 `GROUP_EXPIRED`) at
  **both** possible points: pre-claim (status already read as expired) and post-claim
  (claim lost, re-read shows expired) — with the refund obligation recorded first at
  both sites (`process.ts`).
- Payout confirmation can only land on a `processing` payout (T3 already posted);
  a `requested → paid` jump is structurally impossible via the claim predicate.
- Every state change leaves a durable trail: `OrderStatusHistory`,
  `PaymentWebhookLog.processed`, `InventoryLog "expiry:{ref}"`, Setting
  `cron.expiry_sweep.last` / `cron.refund_reconcile.last` (files above).

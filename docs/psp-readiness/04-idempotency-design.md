# 04 — Idempotency Design (end-to-end exactly-once)

Idempotency is enforced at **four layers**: request admission (checkout idemKeys),
claim-first status flips (webhooks), ledger dedupKeys (money), notification dedupKeys
(mail/log). Provider-side idempotency keys cover refunds. Sources:
`src/app/api/checkout/create/route.ts`, `src/app/api/webhooks/payments/process.ts`,
`src/lib/ledger.ts`, `src/lib/psp-refund.ts`, `src/app/api/cron/refund-reconcile/route.ts`.

## 1. Checkout — `Idempotency-Key` handling

- The header is **required** (400 `IDEMPOTENCY_KEY_REQUIRED`)
  (`src/app/api/checkout/create/route.ts:34-37`).
- `PaymentGroup.idemKey` = the raw client key (`checkout/create/route.ts:225`;
  unique index in `prisma/schema.prisma`).
- Each per-seller `Order.idemKey` = `"{key}:{storeId}"`
  (`checkout/create/route.ts:259`) — one client key can safely cover N sellers
  because the per-order keys stay distinct while the group key stays unique.
- Replay path runs **before** the admission gate and before any write: a replayed
  key returns the original order numbers/ref with `duplicate:true` and consumes no
  admission slot (`checkout/create/route.ts:42-76`, gate note at :78-86).
- Post-`503 CHECKOUT_BUSY` retries with the same key converge on the same checkout
  (`src/lib/checkout-gate.ts` header).
- Concurrent duplicate creates converge via the unique indexes (the loser's insert
  fails). The archived idem-storm probe measured **1 order exactly**
  (`ordersCreated: 1`, `noDuplicates: true`) for 12 same-key concurrent requests —
  answered 1×201 / 11×500 in that dev-mode run (P2002 replay race; correctness held,
  availability caveat reported as-is) — `performance/runs/2026-10-25-load-idem.json`
  (dev-mode caveat in `10-test-evidence.md`).

## 2. Webhook processing — claim-first semantics

The success paths' **first write inside a Serializable transaction** is a conditional
status flip:

```
PaymentGroup: updateMany({ where: { id, status: { notIn: ["succeeded","expired"] } },
                            data: { status: "succeeded", paidAt } })
```

Two concurrent deliveries of the same event race on that row lock; the **loser
matches zero rows, writes nothing, and returns the duplicate sentinel** — money
movement, order transitions and notifications can only run for the winner
(`process.ts` race-safety block). Claiming is what makes answering duplicates with
`200 {duplicate:true}` safe: the PSP's retry loop converges without any re-execution.

Claim-loss is disambiguated by re-reading status: `expired` ⇒ late-payment policy
(409 + obligation); anything else ⇒ genuine duplicate (`process.ts` claim-loss block).

## 3. Ledger dedupKeys (the money backstop)

Every financially-once posting carries a unique `dedupKey` on `LedgerTransaction`
(unique index, `prisma/schema.prisma`); a duplicate insert raises P2002 which the
posting core converts into **returning the original transaction** with
`idempotentReplay:true` — never a second posting, never a 500 (`src/lib/ledger.ts`,
FIN-1 posting core + `postTransaction`):

| Posting | dedupKey | Semantics |
|---|---|---|
| T1 `order_paid` | `order_paid:order:{orderId}` | exactly ONE T1 per order (`postOrderPaid`) |
| T2 `gateway_settlement` | `gateway_settlement:settlement:{ref}` | one settlement per PSP settlement ref (`gatewaySettlementDedupKey`) |
| T3 `payout_initiated` | `payout_initiated:payout:{payoutId}` | one reservation per payout |
| T4 `payout_confirmed` | `payout_confirmed:payout:{payoutId}` | one confirmation per payout |
| T4f `payout_failed` | `payout_failed:payout:{payoutId}` | one reversal per payout |
| T5 `refund` | `refund:refund:{refundId}` | one posting per Refund **row** — an order may take multiple partial refunds, so the key is deliberately per-row, not per-order (`postRefund` doc) |
| T6 `admin_adjustment` | *(none — deliberately)* | corrections are legitimately repeatable distinct events (`postAdminAdjustment` doc) |

Generic auto-keys are deliberately NOT derived from `(txnType, refType, refId)`:
that would false-dedup legitimately repeatable postings (documented in the
posting-core comment).

## 4. Notification / audit dedupKeys

Post-commit fan-out uses stable per-event keys with a unique `(channel, dedupKey)`
index (NotificationLog): `order.paid.email:{orderId}`, `order.paid.inapp:{orderId}`,
`order.receipt.email:{orderId}`, `payout.paid|payout.failed:{payoutId}`,
`payout.requested:{payoutId}:ops|:seller` (recipient-scoped on purpose)
(`process.ts` fan-out; `src/app/api/store/payouts/route.ts:100-113`).
A redelivery therefore cannot multiply mail even if the claim race is lost.

## 5. Provider refund idempotency — `recon:{caseId}`

Every refund execution carries `refundIdempotencyKey(caseId) = "recon:{caseId}"`
(`src/lib/psp-refund.ts`). The provider side keeps **one refund per key** — a retry
with the same key returns the existing outcome instead of refunding twice. This is
also the recovery path for a crash between provider execution and outcome
persistence: the next tick re-executes idempotently or reads the authoritative
status (`refund-reconcile/route.ts` steps 1–2). Verified on mock rails by the
crash-after-provider scenario (`performance/runs/2026-10-25-late-payment-refund.json`,
S6: "converged to succeeded with 1 provider refund").

## 6. P2034 bounded retry — and why retrying the WHOLE transaction is safe

Under concurrent same-seller confirmations, Serializable transactions can fail with
Prisma `P2034` (serialization failure / SSI conflict — transient by definition).
The payment paths wrap the entire `db.$transaction` in a bounded retry loop:

- up to **3 attempts** total (`attempt < 3`), jittered backoff 50–150 ms
  (`process.ts` retry loops, both group and legacy paths);
- session-level `SET LOCAL statement_timeout = '10s'` and a **15 s transaction
  timeout** bound lock contention (measured justification in the tx comments);
- **nothing non-transactional is ever retried** — PSP-facing and notify calls live
  outside the tx (post-commit), so a retry re-executes only DB work.

**Why a full-tx retry cannot double-post:** the transaction's first write is the
conditional claim. If a concurrent delivery already claimed the group, the retried
tx simply matches 0 rows and returns `{claimed:false}` → duplicate answer. If the
original attempt failed mid-flight, it rolled back — the ledger dedupKeys
additionally guarantee that even a hypothetical second `postOrderPaid` for the same
order replays the original T1 instead of inserting. The two layers are independent
belt-and-braces (`process.ts` F1 remediation notes).

## 7. Idempotency inventory (quick reference)

| Layer | Key | Uniqueness scope |
|---|---|---|
| Checkout group | client `Idempotency-Key` | `PaymentGroup.idemKey` unique |
| Checkout order | `{key}:{storeId}` | `Order.idemKey` unique |
| Webhook claim | status predicate | conditional `updateMany` (0-or-1 row) |
| Ledger T1–T4f/T5 | see §3 table | `LedgerTransaction.dedupKey` unique |
| Notifications | per-event keys | `NotificationLog (channel, dedupKey)` unique |
| Refund execution | `recon:{caseId}` | provider-side + `PspRefundRecord.idempotencyKey` unique |
| Obligation upsert | `(provider, providerRef)` | `PaymentReconciliation` composite unique |

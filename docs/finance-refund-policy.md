# Refund Policy — Financial Rules (FIN-3a)

Status: implemented in `src/app/api/admin/refunds/[id]/approve/route.ts` and
`.../process/route.ts`. This document is the authoritative description of the
refund money-movement rules enforced by the backend. Scope: seller wallet
refunds of marketplace orders (MYR, integer sen only).

---

## 1. Refund lifecycle

```
Seller                Admin                     Ledger
──────                ─────                     ──────
POST /api/store/orders/[id]/refund-request
  {amountMinor, reason?, restock?}
  capped at request time:
  amountMinor ≤ order.totalMinor
    − Σ(non-rejected refunds)          → Refund(status="requested")
                      POST /api/admin/refunds/[id]/approve
                        STATUS FLIP ONLY — no money moves
                        requested → approved (conditional claim)
                                              (nothing)
                      POST /api/admin/refunds/[id]/process
                        ALL guards run here (§3)     → T5 posted
                        approved → processed
                        order → refunded | partially_refunded
```

- **Approve** is a pure authorization state flip (RBAC `refunds.manage`). It
  is protected by a conditional `updateMany` claim (`status: "requested"` →
  `"approved"`); a concurrent second approval matches 0 rows and gets
  `409 CONFLICT`. Money NEVER moves at approve.
- **Process** is the only step that posts ledger money (RBAC
  `refunds.manage`). Processing a refund that is not `approved` is rejected
  (`409 NOT_APPROVED`) so the audit trail always shows who authorized the
  movement. Re-processing an already-processed refund is rejected with
  `409 ALREADY_PROCESSED`.

## 2. Ledger postings & dedup keys

| Txn | Recipe | Journal | Dedup key |
|-----|--------|---------|-----------|
| **T5** refund | `postRefund` (src/lib/ledger.ts) | DR `SELLER:PAYABLE:{wallet}` (seller share = amount − reversal) + DR `REVENUE:COMMISSION` (reversal) \| CR `GATEWAY:{provider}` (full amount) | `refund:refund:{refundId}` |
| **T6** manual wallet adjustment | `postAdminAdjustment` | DR/CR `SELLER:PAYABLE:{wallet}` vs `REVENUE:ADJUST` | none by design (corrections are legitimately repeatable, each audited) |

- The T5 dedup key is **per Refund row**, not per order: an order may legally
  receive multiple partial refunds. A replayed process call (or a crash between
  posting and status flip) converges on the ORIGINAL transaction
  (`idempotentReplay`) — T5 is posted exactly once per refund, ever.
- Posted `LedgerTransaction`/`LedgerLine` rows are immutable. Corrections are
  new reversal entries only (e.g. T6).

## 3. Process-time guards (in execution order)

All of the following run inside ONE `db.$transaction` (interactive), after two
pessimistic row locks serialize the flow:

1. `SELECT … FOR UPDATE` on the **Order** row → concurrent refund processes on
   the same order serialize; the cumulative math below cannot race.
2. Fresh re-read of the refund + order + sibling refunds (statuses may have
   changed since the request started).
3. `SELECT … FOR UPDATE` on the seller **Wallet** row → the balance check and
   the T5 posting are atomic against every other wallet-affecting flow
   (payouts, adjustments, sibling refunds).
4. Conditional claim `refund.updateMany({ where: { id, status: { not:
   "processed" } }, data: { status: "processed" } })` — count 0 ⇒ `409
   ALREADY_PROCESSED`.
5. Wallet sufficiency (§4) → `409 INSUFFICIENT_WALLET`.
6. T5 posting + order status transition + item `refundedMinor` bookkeeping +
   optional restock + payment-intent flip — all commit atomically with the
   claim. Any failure rolls back everything (status stays `approved`, no T5).

### 3.1 Cumulative cap (`409 OVER_REFUND`)

```
cumulativeRefunded = Σ amountMinor of refunds with status ∈ {approved, processed}
                     (excluding the current refund) + current refund amount
if cumulativeRefunded > order.totalMinor → 409 OVER_REFUND
```

- Re-validated at process time with fresh data under the Order row lock — the
  seller request-time cap is NOT trusted (racing requests, crafted rows or
  legacy data could otherwise sum past the order total).
- Approved (not yet processed) refunds count: they are committed intents.
  To proceed, an admin must first reject one of the pending refunds.
- Error message shows both numbers: order total vs cumulative refunds.

### 3.2 Wallet sufficiency (`409 INSUFFICIENT_WALLET`)

```
truth = walletTruth(walletId)   // recomputed from ledger lines, not cache
if truth.availableMinor < refund.amountMinor → 409 INSUFFICIENT_WALLET
```

- Checked BEFORE T5. On failure: no posting, no status flip (the transaction
  rolls back) — **negative seller balances are never silently created**.
- The check is deliberately conservative: it requires the FULL refund amount
  to be available even though T5 only debits the seller share (amount −
  reversal) from the wallet. The wallet therefore always retains headroom and
  can never be driven negative by concurrent reversals.
- Error message (actionable):
  > Seller available balance (RM x.xx) cannot absorb this refund. Use Admin →
  > Wallets → Adjust (T6) to add funds, then process again.

## 4. Pre-payout vs post-payout refunds

| Situation | Behavior |
|-----------|----------|
| **Refund before payout** (seller balance still holds the earnings) | The balance absorbs the refund naturally: T5 debits the seller payable account; available drops; no admin action needed. |
| **Refund after payout** (funds already disbursed) | The sufficiency check blocks the process step with `409 INSUFFICIENT_WALLET`. The documented recovery path is: **Admin → Wallets → Adjust (T6, audited) to add funds → process the refund again.** The platform never silently creates a negative seller balance and never auto-claws back disbursed funds. |

The adjust → retry workflow is intentional: the decision to fund a refund
from platform funds (because the seller was already paid out) is a business
decision that must be explicit and audited (T6 rows carry the admin identity
and reason), not an automatic side effect.

## 5. Commission reversal rule

At checkout, M09 stores a per-item commission snapshot in
`OrderItem.breakdownJson` (`percent_part`, `fixed_fee_allocated`,
`discount_allocated`, `shipping_allocated`, …) and `commissionMinor =
percent_part + fixed_fee_allocated`.

When processing a refund, the platform reverses its commission on the refunded
portion. The implemented rule (breakdown path, used whenever every order item
carries a valid snapshot):

1. Customer-paid gross per item:
   `gross_i = lineSubtotalMinor − discount_allocated + shipping_allocated`
   (Σ gross_i = order.totalMinor by the FIN-1 invariant).
2. The refund amount is allocated across items proportional to `gross_i` with
   `allocateProportionally` — the same helper and remainder-to-largest-line
   rule the checkout used for discount/shipping/fixed-fee splits.
3. Per item:
   `reversal_i = divHalfUp(alloc_i × commissionMinor_i, gross_i)` — the
   item's stored commission (percent + fixed fee) taken at the same effective
   rate as the original order. This restores the fixed-fee allocation that the
   earlier single-item-percent formula ignored.
4. Σ reversal_i is clamped to `[0, refundAmountMinor]` and capped at
   `max(0, Σ item.commissionMinor − Σ prior processed refunds'
   commissionReversalMinor)` — cumulative reversals across multiple partial
   refunds can never exceed the commission actually earned on the order.
5. A full refund reproduces the stored composition exactly
   (Σ reversal_i = Σ commissionMinor_i).

**Fallback** (legacy orders without a valid snapshot): the historical rule,
unchanged — first item with un-refunded capacity,
`round(refundAmount × item.commissionPercent / 100)`. The rule actually used
is recorded in the `refund.process` audit entry (`reversalRule`).

Stored financial history is never rewritten: the rule affects the NEW T5
posting only.

## 6. Disputes & chargebacks (external dependency — recorded, NOT faked)

- The `Dispute` model (per order: reason, status, openedBy, resolution) is
  **metadata-only**. It does not post ledger entries and does not move money.
- Chargebacks have **no PSP source** in the sandbox: no payment provider is
  connected that emits chargeback/dispute events, so no chargeback ledger
  semantics are implemented. This is a recorded **external dependency**: when
  a real PSP (stripe_my / curlec / ipay88) supplies chargeback events, a
  webhook-driven flow (T-series entry + dispute state machine) will be added
  against real provider data. Nothing is simulated in the meantime.
- **Manual review path for funds already disbursed** that cannot be
  auto-recovered: an admin opens/links a Dispute for the order, and any fund
  movement that IS decided manually goes through the audited Admin →
  Wallets → Adjust (T6) route (credit or debit with a mandatory reason) —
  e.g. debiting a seller wallet after a chargeback loss, or crediting a
  customer outside the refund flow. The platform does not silently claw back
  disbursed payouts.

## 7. HTTP outcomes summary

| Code | Code string | Meaning |
|------|-------------|---------|
| 200 | — | Refund processed; T5 posted exactly once |
| 400 | `NO_WALLET` / `NO_ITEMS` / `VALIDATION` | Malformed target (seller has no wallet, empty order, bad amount) |
| 404 | `NOT_FOUND` | Unknown refund |
| 409 | `NOT_APPROVED` | Process called on a refund that was never approved |
| 409 | `ALREADY_PROCESSED` | Re-invocation of process (idempotent replay guard) |
| 409 | `CONFLICT` | Rejected refund, or concurrent approve/reject race |
| 409 | `OVER_REFUND` | Cumulative refunds would exceed the order total |
| 409 | `INSUFFICIENT_WALLET` | Seller balance cannot absorb the refund — use T6 adjust, then retry |

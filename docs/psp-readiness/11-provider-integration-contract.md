# 11 — Provider-Neutral Integration Contract

**Purpose:** define what ANY payment provider adapter must implement to integrate
with NOMOFEE, independent of which provider is chosen. This is the key Phase 4.3
deliverable. **No real provider's API routes, fields, signatures, settlement or
refund semantics are specified here — wherever provider specifics are required this
document says "TO BE MAPPED FROM CHOSEN PROVIDER'S OFFICIAL DOCUMENTATION".**

**Existing seams (in code today):** `PspProvider` registry (`src/lib/psp.ts`),
the webhook verification/processing pipeline (`src/app/api/webhooks/payments/process.ts`),
`RefundAdapter` (`src/lib/psp-refund.ts`), the dormant outbound payout adapter
scaffold `PspPayoutAdapter` (`src/lib/psp-adapter.ts`), and the four production
plug-in points documented in `src/lib/psp.ts`.

## 1. Separation of concerns (the contract's spine)

The platform keeps five concerns strictly separate; an adapter must never conflate them:

1. **Capture** — the provider collects the buyer's single payment for a
   `PaymentGroup` (N per-seller orders). Provider-owned.
2. **Ledger posting** — T1 mirrors the captured payment per order
   (`src/lib/ledger.ts`). Platform-owned; driven ONLY by verified provider events.
3. **Commission** — today a ledger-mirrored split (application-fee semantics become
   provider-enforced at integration — `08-commission-settlement.md` §4).
4. **Vendor settlement** — the provider settles sellers their share (provider-owned;
   mirrored by T2/per-seller settlement postings when confirmed).
5. **Bank payout** — seller-requested withdrawals via T3/T4/T4f
   (`03-state-machines.md` §3) — the outbound `PspPayoutAdapter` seam
   (`src/lib/psp-adapter.ts`), today admin-confirmed.

## 2. Interface requirements (any adapter)

### 2.1 Payment initiation
- Create a provider checkout/charge session for one `PaymentGroup`: the platform
  supplies the group reference (`PaymentGroup.ref`, format `ref_{8}`), amount
  (`totalMinor`, integer sen), currency (MYR), buyer/session context, expiry window
  (30 min, `expiresAt`), and — when the provider supports it — the per-seller split
  (application fee + seller shares from the commission snapshots).
- Returns a redirect/hosted-checkout URL (stored in `PaymentGroup.redirectUrl`)
  plus the provider's own session/payment identifiers.
- Exact request/response shapes: **TO BE MAPPED FROM CHOSEN PROVIDER'S OFFICIAL
  DOCUMENTATION.** (Today the sandbox stand-in is
  `/api/checkout/payments/[ref]/simulate`, which must be replaced — plug-in point 2
  in `src/lib/psp.ts`.)

### 2.2 Provider-ref ↔ internal PaymentGroup mapping
- The platform's canonical correlation key is `providerRef` (the group ref) —
  webhooks resolve `PaymentGroup.findUnique({ where: { ref: providerRef } })`
  (`process.ts`). The adapter MUST define how the provider's own identifiers map to
  this ref (echoed reference vs provider-issued id) and SHOULD surface the
  provider's payment object id as `providerPaymentId` (required for refunds;
  `prisma/schema.prisma`, `PaymentReconciliation.providerPaymentId`).
- Payout events resolve `Payout.referenceNo` first, `Payout.providerRef` fallback
  (`process.ts` payout-resolution doc) — the adapter must state which the provider
  echoes.

### 2.3 Event verification (per-provider, superseding the generic HMAC)
- The adapter must implement the provider's OFFICIAL signing scheme (headers,
  canonical payload, timestamp/nonce, secret/certificate handling) at the
  verification seam. The current generic `HMAC-SHA256("providerRef.eventType.
  amountMinor.ts")` is a mock-rails scheme and **must not be assumed
  provider-compliant** (`05-webhook-security.md` §6).
- Required posture regardless of scheme: verify BEFORE any state change; log every
  delivery first (log-then-verify order preserved); reject invalid with a
  non-processing status; replay window per provider spec; secret via secret manager,
  never logged.

### 2.4 Provider-status → internal-state mapping
- The adapter must supply an explicit, total mapping from every provider payment
  status to the internal events/states: `payment.succeeded`, `payment.failed`,
  (payout: `payout.succeeded`, `payout.failed`). Unknown provider statuses must map
  to **no state change** (surfaced for operators) — the platform never guesses a
  money outcome (same rule as `mapProviderStatusToPayoutStatus` in
  `src/lib/psp-adapter.ts`: unknown ⇒ null, never auto-succeed).
- Internal target states are in `03-state-machines.md`; adapters may not invent new
  states.

### 2.5 Duplicate / out-of-order events
- Duplicates: the platform answers idempotently (`200 {duplicate:true}`) — adapters
  must not rely on at-most-once delivery. Out-of-order (e.g. `payment.failed` after
  `payment.succeeded`): the internal claim predicates make terminal states
  immutable; the adapter must document which provider events can arrive out of
  order and how they map (`process.ts` already ignores failed-after-succeeded).

### 2.6 Timeout / ambiguous outcomes
- Every provider call needs a bounded timeout; ambiguous outcomes (network fault,
  5xx, unknown status) must leave internal state unchanged and converge via the
  provider's retry/redelivery or a status re-read. Payment-path precedent: bounded
  statement/tx timeouts + P2034 retry (`process.ts`); refund-path precedent:
  `unknown` status + authoritative re-read (`refund-reconcile/route.ts`).

### 2.7 Exactly-once confirmation
- Confirmation is ONLY a verified provider event (or an authoritative provider
  record read). Money movement (T1) runs inside the claim-first Serializable
  transaction with dedupKeys (`04-idempotency-design.md`). The adapter must define
  the provider's redelivery/retry cadence so the replay window, rate limits, and
  duplicate answers can be tuned to it.

### 2.8 Refund execution + reconciliation
- Implement `RefundAdapter` (`src/lib/psp-refund.ts`): `executeRefund` idempotent
  by `recon:{caseId}`, `getRefundStatus` a pure authoritative query. Provider
  idempotency-key support (or verified equivalent) — TO BE MAPPED FROM CHOSEN
  PROVIDER'S OFFICIAL DOCUMENTATION. External calls stay outside DB transactions;
  completion only from the provider's authoritative record; the 409 `GROUP_EXPIRED`
  refusal stays unchanged (`06-refund-recovery.md`).

### 2.9 Payout (outbound) execution
- Implement `PspPayoutAdapter` (`src/lib/psp-adapter.ts`): `submit` +
  `recover` per phase (transfer / bank_payout), stable outbound idempotency keys
  (`payout_transfer:{payoutId}` / `payout_bank:{payoutId}`), provider status mapped
  via the never-auto-succeed-unknown rule; confirmed states must flow through the
  existing conditional-claim pattern (hook point documented in
  `src/app/api/admin/payouts/[id]/sync/route.ts` header).

## 3. Data the platform supplies (to the provider/adapter)

| Datum | Source | Notes |
|---|---|---|
| Group reference | `PaymentGroup.ref` (`ref_{8}`) | unique per checkout |
| Amount / currency | `totalMinor` (int, sen) / `MYR` | webhook must echo amount equal to total or be refused (409 `AMOUNT_MISMATCH`) |
| Per-seller split | `commissionMinor` / `sellerNetMinor` per order item | commission snapshots, never recomputed (`src/lib/commission.ts`) |
| Seller identity/settlement data | seller records + `BankAccount` (masked number storage) | onboarding/KYC per provider's marketplace requirements |
| Payout references | `Payout.referenceNo` (`PO-…`), amount, bank snapshot | outbound idempotency keys derived from payoutId |
| Refund case data | `PaymentReconciliation` (providerRef, providerPaymentId, amountMinor, currency) | idempotency key `recon:{caseId}` |

## 4. Data the platform expects back

| Datum | Used for | Internal consumer |
|---|---|---|
| Redirect/hosted-checkout URL | buyer hand-off | `PaymentGroup.redirectUrl` |
| Provider payment id | refunds, reconciliation | `PaymentReconciliation.providerPaymentId` |
| Signed success/failure events | order state + T1 | `processPaymentWebhook` claim paths |
| Signed payout events | T4/T4f | `processPayoutEvent` |
| Authoritative refund status | reconciliation completion | `RefundAdapter.getRefundStatus` |
| Settlement/statement records | T2 / per-seller settlement mirror | `postGatewaySettlement` + future per-seller confirmations |

## 5. Non-functional requirements (binding)

- All money integer minor units; no floats cross the adapter boundary.
- Provider calls never inside DB transactions; no provider state mutated by
  read/verify paths.
- Registration: adapter registered in `PSP_PROVIDERS` + `REFUND_ADAPTERS`
  (+ payout adapter registry) with `sandboxOnly` correctly set so production
  enforcement (403 / mock gate) keeps working (`src/lib/psp.ts`).
- Secrets via hosting secret manager; echo-free error surfaces (`09-environments-secrets.md`).
- Every status transition must keep the state machines and ledger invariants
  intact (`03`, `07`) — adapters propose events; the claim-first processors dispose.

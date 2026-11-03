# V-F8 / F-1 Correction Design — Affiliate Payout × Refund Accounting

**Status:** implemented in Phase 3 / Work 2 (this document written before the change, per the
"investigate → design → implement" rule; the analysis below is the authorization the standing
"no financial-allocation change without a proven-safe correction" rule demanded).
**Scope:** `src/lib/affiliate.ts` (`reverseAffiliateForRefund` payout coordination) + `src/app/api/admin/affiliate/payouts/[id]/process/route.ts` (mark-paid / fail at amount 0). No schema change. No ledger-recipe change. No change to the requestable-amount model.

---

## 1. The accounting model (as-built, verified by code read)

Accounts (single global, no per-affiliate subledger):

| Account | Purpose | Flows in/out |
|---|---|---|
| `AFFILIATE_LIABILITY` | commission owed to affiliates + recovery receivable (net) | CR by T1 affiliate line; DR by T-A3 (payout approve), T-A4f (payout fail), T5 affiliate-liability line (refund reversal of not-parked value) |
| `PAYOUT_CLEARING` | in-flight payout parking | CR by T-A3; DR by T-A4 (mark-paid→BANK_MAIN), T-A4f (fail→back to liability), T5 clearing line (refund while processing) |
| `BANK_MAIN` | cash | CR by T-A4 |

Payout lifecycle: `request` (amount = `requestable = max(0, available − recovery)`; claims **ALL** matured
unclaimed entries) → `approve` (T-A3 moves **amount** from liability to clearing) → `mark-paid` (T-A4 pays the
current — possibly refund-shrunk — amount) or `fail` (T-A4f releases the current amount back to liability).

**The claim-overage is a designed recovery vehicle (spec §11):** when `recovery > 0` (late refunds on
already-paid entries), `Σ(claimed entries net) = V` exceeds the payout amount `A = V − recovery`. The withheld
`recovery` portion of the claimed entries' liability **stays in AFFILIATE_LIABILITY** — only `A` is parked in
clearing by T-A3. This is internally consistent *provided every downstream coordination respects the same split*.

## 2. Root causes

### V-F8 — unclamped clearing reversal (`reverseAffiliateForRefund`)

When a refund reverses `actualApplied` on an entry claimed by a **processing** payout, the coordination adds the
FULL `actualApplied` to `adj.clearing` (→ T5 debits PAYOUT_CLEARING) and shrinks the payout amount by the full
amount (floored at 0). When `actualApplied` exceeds the payout's remaining amount (only possible when
`V > A`, i.e. the recovery-withholding case), the excess:

* debits PAYOUT_CLEARING beyond everything T-A3 ever parked there → **clearing net negative** (−recovery per
  occurrence), and
* **never reverses the AFFILIATE_LIABILITY value it should** — the withheld portion of the claimed entries.

Global D==C is unaffected (each T5 balances) — a pure account-split/presentation defect, exactly as classified
(Phase 2.2, LOW) — but it also *breaks the clearing account's defined purpose* and masks real recovery state.

### F-1 — zero-value terminal posting (process route)

When refunds shrink a processing payout to amount 0, `mark-paid`/`fail` call `postAffiliatePayoutConfirmed` /
`postAffiliatePayoutFailed` with `amountMinor = 0`; `postTransaction` rejects zero-value transactions
(`LEDGER_UNBALANCED debit=0 credit=0`) → HTTP 500 → the payout is **permanently stuck in `processing`** (the
conditional state claim already flipped the row before the throw, but the route's outer transaction rolls back,
so the status stays `processing` while every retry re-throws). With V-F8 unclamped, its T-A3 credit also strands
in clearing.

## 3. The correction

### 3.1 Capped clearing allocation (V-F8)

Per refund, per payout, per entry-share: with `remaining` = the payout's current amountMinor (tracked in-memory
through the locked read + this transaction's reductions):

```
X            = min(actualApplied, remaining)        // the value actually parked in clearing (T-A3's side)
excess       = actualApplied − X                    // withheld/recovery-portion value — still in liability
adj.clearing += X                     (processing payouts only)
adj.liability += X                    (requested payouts — nothing parked yet)
adj.liability += excess               (both states — never-parked value)
payoutAmount −= X                     // the amount tracks the clearing-side cash flow ONLY
```

**Conservation proofs** (for one payout with original amount `A`, claimed value `V`, total refund reversals `ΣR`):

* **Clearing nets to zero at every terminal state.** ΣX ≤ A by the per-step cap. Terminal:
  * mark-paid: clearing = A (T-A3) − ΣX (T5 lines) − A_final (T-A4), where A_final = A − ΣX → **0**.
  * fail: clearing = A − ΣX − (A − ΣX) (T-A4f at the fresh amount) → **0**.
  * amount 0 (ΣX = A): clearing = A − A = 0 with **no** T-A4/T-A4f needed → skip (3.2).
  * Clearing is **never negative** at any intermediate point (each T5 line debits at most the remaining
    T-A3 credit).
* **Total liability reversal == the entry reversal.** T-A3 removed A from liability; T5 lines remove
  X-total (= A) + excess (= ΣR − A) → total ΣR — identical to an unclaimed-entry reversal, which is the
  conservation identity the unfixed code violated.
* **Amount semantics preserved.** New cash-to-pay after reversals `ΣR` = `(V − ΣR) − recovery` floored at 0 —
  because `A = V − recovery` and the amount only ever loses `X ≤ remaining`, the floor is reached exactly when
  `(V − ΣR) − recovery ≤ 0`.
* **Requested payouts:** X = min(R, remaining) reproduces the old `max(0, A − R)` arithmetic exactly
  (same auto-release-at-0 path), so the requested-state behavior is byte-identical except in the excess case,
  where the excess now correctly lands on the liability side.

### 3.2 Zero-value terminal handling (F-1)

* `mark-paid` with `fresh.amountMinor === 0`: **skip T-A4** (nothing to transfer — the T5 clearing lines already
  returned the T-A3 credit; clearing nets to zero). The reference requirement is dropped when the payout row's
  amount is 0 (no bank transfer exists to reference). Live claimed entries (possible in the
  recovery-withholding case) are still discharged to `paid` — the settlement-by-netting semantics.
* `fail` with `fresh.amountMinor === 0`: **skip T-A4f** (same reasoning) and release live claimed entries as usual.
* **Auto-release symmetry:** a processing payout whose amount reaches 0 inside `reverseAffiliateForRefund`
  now auto-terminates to `failed` (`failReason: "Auto-released: fully consumed by refunds before transfer"`)
  and releases live claimed entries — mirroring the existing requested-state auto-release. This keeps the
  one-open-payout-per-affiliate invariant from being blocked on operator action. The manual mark-paid/fail
  at 0 remains as defense-in-depth (and as the remediation path for **legacy stuck rows** created before this
  fix).
* T-A3 at approve can never be zero-value (request requires amount ≥ minPayout > 0; recovery growth without
  reversals is blocked by the existing `FROZEN_AMOUNT_STALE` 409; reversal-driven shrink auto-releases at 0).

### 3.3 What is deliberately NOT changed

* The requestable model (`available − recovery`) and the claim-all semantics — the overclaim IS the recovery
  withholding mechanism; re-architecting it (partial entry claims) would require entry-level claim amounts
  (schema change) for no accounting gain, since 3.1 restores full consistency.
* The T5 recipe (`postRefund`) — its `affiliateClearingMinor` parameter already splits exactly as needed.
* The approve-time re-validation — still correct: `truth = liveClaimedNet − recovery ≥ amount` fails only on
  recovery growth (the designed 409), because with the cap, X == R whenever R ≤ remaining.
* Idempotency and lock discipline (payout rows locked first, deterministic order, conditional claims,
  Serializable retry) — untouched.

## 4. Regression & concurrency coverage (required by the work order)

New suite `scripts/readiness/phase3-work2-vf8f1-regression.ts` — 12 lifecycle scenarios (refund before
request / after request / after approve / full-shrink-to-zero / partial shrinks / multiple refunds / concurrent
refund+mark-paid / concurrent refund+approve / repeated processing / late recovery on paid / payout failure +
retry / duplicate refund delivery) + independent DB assertions: D==C per txn and globally; clearing
non-negative and zero-net for terminal payouts (scoped to post-fix fixtures); no stuck `processing`;
no zero-value ledger transactions; no entry paid twice; no refund reversed twice; wallet caches == truth;
payout amounts reconcile with entries/recovery. Then re-run the existing financial suites
(`phase22-races`, `finance-regression`, `late-payment-refund`, `phase3-step4-invariants`) against staging.

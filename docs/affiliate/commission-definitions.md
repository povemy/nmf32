# Affiliate Commission — Financial Definitions

**Scope:** Normative definitions of every money rule in the NOMOFEE affiliate programme. Where this document conflicts with prose elsewhere, this document governs. Implementation references: `docs/affiliate/implementation-plan.md` (phases), `src/lib/ledger.ts` (recipes), `src/lib/commission.ts` (snapshot precedent), `src/lib/money.ts` (integer money helpers).

**Currency & units:** all amounts are integer minor units (sen) in the order's currency (`MYR` unless stated). All multiplication is integer arithmetic; rounding rules are defined per operation in §9 and are exhaustive — no operation in the affiliate money path may use an unspecified rounding mode.

---

## 1. Funding model

- The affiliate commission pool is **seller-funded**: it is carved from the seller's proceeds of an attributed order item. The platform's commission (marketplace fee, `REVENUE_COMMISSION`) is **not** reduced or topped up by the affiliate programme.
- The buyer pays the same price with or without attribution; attribution never changes the buyer's charge (the `PaymentGroup.totalMinor` and `Order.totalMinor` are untouched by this feature).
- Direct affiliates earn from their own referred sales. A sponsor (the one-level referrer) earns a share of a *downline direct affiliate's* pool — never a share of order value beyond that pool, and never any deeper generation. There are **no recruitment bonuses and no click rewards**: clicks create attribution evidence only; money arises exclusively from paid, attributed order items.

## 2. Commissionable base B

**Definition.** For one `OrderItem`, the commissionable base is the **eligible merchandise value after seller-funded discounts, excluding shipping, tax, and platform fees**:

```
B = lineSubtotalMinor − sellerFundedDiscountAllocMinor
```

- `lineSubtotalMinor` = `unitPriceMinor × qty` (frozen on the item at checkout).
- `sellerFundedDiscountAllocMinor` = the item's proportional allocation of the seller-group order discount (voucher/coupon reducing merchandise value), using the existing allocation family from `src/lib/commission.ts` / `src/lib/money.ts` (`allocateProportionally`, remainder to the largest line). Platform-side subsidies, if any ever exist, do not reduce B.
- **Excluded:** shipping allocations (`shippingMinor`), tax allocations, the platform commission, and the platform fixed fee. B matches the existing `paid_price` base **without shipping** (`CommissionSetting.basePriceRule = "paid_price"`, `appliesToShipping = false` posture): it is the merchandise money the seller actually realised on that line.
- `B ≥ 0` always; `B = 0` (fully discounted line) yields `P = 0` — no commission, no ledger line.
- If a future settings change turns `appliesToShipping` on for the platform commission, the **affiliate base is unaffected**: B is defined independently of the platform's base rule and must be computed from its own definition, never derived from `OrderItem.commissionMinor`.

## 3. Pool and split

**Pool.** With the resolved affiliate rate `R` in basis points:

```
P = floor(B × R / 10000)        // integer sen; floor at the pool step
```

`R` resolution (seller-funded chain, capped):

```
R = min( max( product.affiliateRateBps ?? store.defaultRateBps ?? 0 ), affiliate.max_rate_bps )
```

- Product override beats store default; absence of both → not eligible (`R = 0`, exclusion reason `not_enabled` or `store_opt_out`).
- The cap `affiliate.max_rate_bps` (Setting, launch default 1000 = 10%) is applied **before** P is computed, so the cap bounds the pool exactly.
- `P ≤ B` structurally (`R ≤ 10000` enforced by the cap bound and field validation; a rate above the cap is clamped, never an error at checkout — snapshots must be deterministic).

**Split (computed at posting — §5).** Let the commission be attributed to direct affiliate A with sponsor S₀:

```
S = floor(P × 10 / 100)          // sponsor share, 10%
D = P − S                        // direct share, residual
```

- **No sponsor case:** if no sponsor exists, or `affiliate.sponsor_enabled = false`, or the sponsor is ineligible per §4 → **D = P** (single `direct` entry).
- **Invariant:** `D + S = P` exactly, in every case, by construction (D is the residual).
- The 90/10 ratio is fixed by product decision; it is not a Setting. `affiliate.sponsor_enabled` only gates whether the sponsor share is created at all.

**Worked examples** (MYR, sen):

| B | R | P = floor(B·R/10⁴) | Sponsor? | S = floor(P·10/100) | D = P − S |
|---|---|---|---|---|---|
| 10 000 | 1 000 (10%) | 1 000 | yes | 100 | 900 |
| 10 000 | 1 000 | 1 000 | no | — | 1 000 |
| 9 999 | 1 000 | 999 | yes | 99 | 900 |
| 25 550 | 500 (5%) | 1 277 | yes | 127 | 1 150 |
| 25 550 | 500 | 1 277 | no | — | 1 277 |
| 0 | any | 0 | — | — | 0 (no rows) |

## 4. Sponsor eligibility

The sponsor is the affiliate's one-level referrer recorded on `AffiliateProfile.sponsorProfileId`, **immutable after activation** (admin-only corrections via `AffiliateSponsorAudit`, never self-service, never retroactive attach to existing commissions).

**Eligibility rules, evaluated at posting time (T1) for each commission:**

1. A sponsor relationship must have existed **at activation** — a sponsor cannot be attached later and then benefit from earlier or current commissions by correction. A corrected sponsor takes effect for **future** postings only; corrections never re-split frozen commissions (the split is posting-time state, §5).
2. `affiliate.sponsor_enabled` (Setting) must be `true`. This is the legal kill-switch for the override (Direct Sales and Anti-Pyramid Scheme Act 1993 review — `rollout-checklist.md` §1). While false, every pool posts as `D = P`.
3. The sponsor's `AffiliateProfile.status` must be `active`. If the sponsor is **suspended** or **under verification**, the sponsor entry is still created with status `held` (its share is reserved in the liability account, not released to the sponsor's payable balance, and not redistributed) — see §6.4.
4. **Unallocated share policy:** any share that is not paid to its intended beneficiary (held sponsor share that is later forfeited on termination, or a sponsor share suppressed by a correction) is **never redistributed** to the direct affiliate, the seller, or the platform's commission revenue. It remains in `PLATFORM:AFFILIATE_LIABILITY` until an explicit, audited admin decision (forfeit-to-platform via an adjustment recipe, or release after reinstatement). No automatic reallocation exists in any phase.
5. **Self-referral prohibition:** a profile cannot be its own sponsor (self-FK check at binding and at activation); registration attribution touches originating from the shopper's own visitor cookie as their own affiliate link bind no sponsor (§7 of `security-and-fraud-rules.md`).
6. **Single generation:** eligibility never extends past one level. There is no "sponsor's sponsor" lookup anywhere in the money path.

## 5. Frozen at checkout vs computed at posting

**Frozen at checkout create** (written to `OrderItem` affiliate snapshot columns inside the existing single transaction, `src/app/api/checkout/create/route.ts`; never recomputed, never backfilled — same contract as the commission snapshot fields beside them):

| Field | Meaning |
|---|---|
| `affiliateId` | direct attribution winner (or null) |
| `affiliateRateBps` | the rate R actually used |
| `affiliateBaseMinor` | B as defined in §2 |
| `affiliatePoolMinor` | P = floor(B×R/10⁴) |
| `affiliateLinkCode` | winning touch's link code (evidence) |
| `affiliateAttributedAt` | winning touch's clickedAt (evidence) |
| `affiliateExclusion` | null or `self_purchase` / `not_enabled` / `store_opt_out` / `no_touch` |

Also frozen at checkout, implicitly: the **seller-net reduction** — `OrderItem.sellerNetMinor` is written net of P, so the carve is part of the immutable snapshot set.

**Computed at posting (T1, in the webhook's Serializable transaction):**

- the **split S/D** (sponsor share existence and amounts depend on posting-time sponsor status and `affiliate.sponsor_enabled`);
- the `AffiliateCommission` + `AffiliateCommissionEntry` rows (their amounts for the pool/rate/base fields are *copied* from the frozen snapshot — defence in depth, the entry `shareMinor` values are the posting-time split);
- the T1 4th ledger line amount (= P from the snapshot).

Rationale: rate, pool and attribution are facts about the *sale* (known at checkout); the split is a fact about *beneficiaries* (their status can change between checkout and payment). A payment that arrives days later must be split against the sponsor's status at the moment money is confirmed — never against a stale pre-payment snapshot, and never retroactively re-split after posting.

## 6. Lifecycle definitions

States of an `AffiliateCommission` (per `OrderItem`; entries carry per-beneficiary status):

| State | Definition (authoritative condition) |
|---|---|
| **pending** | Payment confirmed: the webhook's Serializable transaction completed T1 and created the rows. Money is recognised in `AFFILIATE_LIABILITY` (pending portion). |
| **approved** | The order's authoritative status is `delivered` or `completed` (as recorded through `transitionOrder` in `src/lib/api.ts` — NOT carrier timestamps, which are mock rails per `architecture-audit.md` §3.6). Set by the affiliate tick. |
| **available** | `approvedAt + affiliate.review_days` has elapsed AND no open (requested or approved, non-rejected) `Refund` row exists on the order. The amount counts toward the affiliate's payable balance and payout requests. |
| **paid** | A processed `AffiliatePayout` covering the entries completed (T-A4 posted, `bankRef` recorded) and reconciled. Terminal for money flow (late-refund recovery excepted, §8). |
| **reversed** | A processed refund reversed the commission (fully — partial reversals keep the prior lifecycle state with `reversedMinor > 0`). |
| **held** | Entry-level only: the sponsor's share while the sponsor is suspended/under verification. The direct 90% is **unaffected** — it proceeds through its own lifecycle. Held share lives in the liability account, excluded from the sponsor's available balance. |

Transitions: `pending → approved → available → paid`; `pending|approved|available → reversed` (on refund processing); `held → available|reversed` (on sponsor reinstatement or forfeiture decision). No transition ever moves backwards except the payout-fail reversal of the *payout* (T-A4f returns the money to the liability account; the entries revert `paid → available`).

**Balance derivation (truth = ledger):** an affiliate's pending balance is the sum of `AFFILIATE_LIABILITY` credits with `availableAt > now` (plus held-share rules), available balance is credits with `availableAt ≤ now` minus payout debits — exactly the sign/availability convention of `SELLER:{walletId}:PAYABLE` in `src/lib/ledger.ts`. `AffiliateProfile` balance columns are caches.

## 7. Refund reversal math

Refunds are **order-level** (`Refund.amountMinor` against the order, per the existing engine). The affiliate reversal is derived inside `POST /api/admin/refunds/[id]/process/route.ts` alongside the existing commission reversal, from **frozen affiliate snapshots only**.

**Step 1 — allocate the refund across items.** Allocate the order refund amount across the order's items proportionally to each item's **customer-paid gross** (`lineSubtotal − discount + shipping + tax` allocation — the same allocation base the existing FIN-3a commission reversal uses), producing `refundItem_i`. (Matching the existing engine's allocation base keeps affiliate and commission reversals consistent item-by-item.)

**Step 2 — item affiliate reversal, clamped.** For each item with a pool:

```
aRev_i = min( floor(refundItem_i × P_i / gross_i), P_i − alreadyReversed_i )
```

- Proportional to the item's **pool share of its gross** (equivalently: the pool reverses at the same proportion the refund bears to the item's paid value).
- Clamped twice: never exceeds the pool, and never exceeds the **remaining unreversed pool** (`P_i − alreadyReversed_i`), so cumulative reversals across multiple partial refunds can never exceed the pool actually earned — mirroring the commission-reversal cap discipline in the existing route.
- Residual clamping: if early items saturate (`alreadyReversed_i = P_i`) while proportional shares remain, the remaining reversal obligation is re-allocated across items that still have remaining pool (same proportional family, iterate to fixpoint or single residual pass — deterministic order: items by id ascending, remainder to the largest remaining pool).

**Step 3 — entry-level reversal.** Within an item's `aRev_i`, reverse the split proportionally against the **original allocations**:

```
sRev_i = min( floor(aRev_i × S_i / P_i), S_i − alreadyReversedSponsor_i )
dRev_i = aRev_i − sRev_i          // residual to direct; clamped to remaining direct balance
```

The direct share absorbs the rounding residual so `Σ(dRev + sRev) === aRev` exactly. If the direct side saturates (post-payout scenario) the excess becomes a **recovery obligation**, not a silent loss.

**Step 4 — late-refund recovery.** If a refund lands on a commission whose entries are already `paid` (money transferred):

- The reversal is recorded (`reversedMinor`, entry status `reversed`), but **no claw-back from the affiliate occurs** — recovered money is never pulled from a bank transfer already made.
- Instead an `AffiliateCommission.recoveryMinor` (and profile-level aggregate) obligation is created, which **offsets future earnings at posting time**: subsequent commissions for that affiliate reduce the payable amounts (direct share first) until the obligation is cleared. Recovery offsets never go below zero commission (a zero-pool future order contributes nothing).
- If the affiliate terminates with an outstanding recovery obligation, it becomes a finance-ops item (manual invoice / write-off via an audited adjustment recipe) — never an automated collection.

**Step 5 — ledger.** The affiliate reversal enters T5 as a debit line (§6 of this doc below, "T5 affiliate reversal"). For rows predating the affiliate feature there is no snapshot → zero affiliate reversal (correct default; no fallback path needed, unlike the legacy commission first-fit fallback in the existing engine).

**Full refund check:** a full refund must reproduce the stored composition exactly — `Σ aRev_i === Σ P_i` (each `refundItem_i === gross_i` ⇒ `aRev_i = P_i` under the clamps), and `Σ(sRev + dRev) === Σ P_i` per item. This is an explicit test case in Phase 8.

## 8. Ledger mapping

### 8.1 Accounts

- New: `PLATFORM:AFFILIATE_LIABILITY` — liability account in `ACCOUNTS`/`ACCOUNT_META` (`src/lib/ledger.ts`). Credits = affiliate pool recognised; debits = reversals, forfeits, and payouts. Standing balance = unpaid affiliate earnings (incl. held sponsor shares).
- Existing accounts unchanged: `GATEWAY:{p}`, `SELLER:{walletId}:PAYABLE`, `PLATFORM:REVENUE_COMMISSION`, `PLATFORM:PAYOUT_CLEARING`, `PLATFORM:BANK_MAIN`.

### 8.2 T1 — order paid (extended from 3 lines to 4)

```
DR  GATEWAY:{p}                      totalMinor
CR  SELLER:{walletId}:PAYABLE        sellerNet − P        (availableAt = existing hold clock)
CR  PLATFORM:REVENUE_COMMISSION      commissionMinor
CR  PLATFORM:AFFILIATE_LIABILITY     P                    (walletId-scoped where useful; availableAt = review clock anchor)
```

- **Invariant (replaces the 3-line one):** for every order, `Σ sellerNet(net-of-pool) + Σ commission + Σ affiliatePool === orderTotal`. The checkout snapshot math (`computeOrderCommissions` extension) and `postOrderPaid` must enforce the same equation in the same release; `runLedgerInvariants` gains the affiliate term.
- The pool carve does **not** change the platform commission line or the gateway debit. The seller's payable credit shrinks by exactly P; the seller's `Wallet` cache and the `availableAt` hold semantics are untouched by the affiliate feature (seller hold remains days-after-paid, per audit §3.6 — the affiliate review window is separate).
- Multiple attributed items in one order: one aggregated affiliate credit line per order per T1 posting (P summed over items) is acceptable; the per-item truth lives in `AffiliateCommission` rows, which are created in the same transaction (unique `orderItemId` anchors idempotency alongside the `order_paid:order:{orderId}` dedupKey).
- Unattributed orders post the historical 3-line T1 exactly as today (P = 0 ⇒ the 4th line is omitted or zero — implementation picks one and encodes it in the invariant test; zero lines must never appear as spurious rows).

### 8.3 T5 — refund (extended with an affiliate reversal debit)

```
DR  SELLER:{walletId}:PAYABLE        seller share of refund (net-of-pool basis)
DR  PLATFORM:REVENUE_COMMISSION      commission reversal
DR  PLATFORM:AFFILIATE_LIABILITY     affiliate reversal (Σ aRev across items)
CR  GATEWAY:{p}                      refund amount
```

- Balanced by construction: the buyer's refunded sen are given back by reducing the seller payable, reversing platform commission, and reversing affiliate liability in the proportions the refund bears to each component under §7. Because the seller's payable was credited net-of-pool, the seller's share of the reversal is computed on the net basis — the three DR lines sum to the refund amount (any sen-level residual from the independent clamps lands on the seller line, mirroring the residual-to-direct policy at entry level; the reconciliation report §10 point 3 catches drift).
- dedupKey stays `refund:refund:{refundId}` — the affiliate reversal is part of the same single posting.

### 8.4 Affiliate payout recipes (mirror T3/T4/T4f)

```
T-A3  payout initiated:  DR AFFILIATE_LIABILITY | CR PAYOUT_CLEARING      dedupKey affiliate_payout_initiated:payout:{id}
T-A4  payout confirmed:  DR PAYOUT_CLEARING     | CR BANK_MAIN            dedupKey affiliate_payout_confirmed:payout:{id}
T-A4f payout failed:     DR PAYOUT_CLEARING     | CR AFFILIATE_LIABILITY  dedupKey affiliate_payout_failed:payout:{id}
```

- Posted from the affiliate payout admin routes with claim-first conditional status transitions inside the transaction — the identical discipline to the seller payout routes (`src/app/api/admin/payouts/[id]/{approve,mark-paid,fail}/route.ts`).
- A rejected request (requested → rejected) posts nothing. T-A4 requires the operator-supplied `bankRef` (manual transfer reference) before posting.
- Recovered (offset) earnings never create ledger lines of their own — they reduce future T1 affiliate credit lines at posting; the reconciliation report reconciles the two ledgers (money vs obligation) explicitly (point 7).

### 8.5 Adjustments

Forfeited held shares / write-offs / manual corrections go through a dedicated affiliate adjustment recipe (single DR/CR pair against `AFFILIATE_LIABILITY` + a counterpart chosen by the admin action), deliberately **without** a dedupKey (corrections are legitimately repeatable — same reasoning as T6 `postAdminAdjustment`), always audited via `AdminAuditLog` + `ActivityLog`.

## 9. Rounding rules (exhaustive)

1. **Pool:** `P = floor(B × R / 10000)` — floor.
2. **Sponsor split:** `S = floor(P × 10 / 100)` — floor; **direct takes the residual** `D = P − S`. `D + S = P` invariant holds by construction.
3. **No-sponsor:** `D = P` (exact, no rounding).
4. **Refund item allocation** (refund across items): proportional allocation with remainder to the largest line — the `allocateProportionally` family (`src/lib/money.ts`), identical to checkout discount allocation so checkout and reversal allocations agree.
5. **Item affiliate reversal:** `aRev_i = floor(refundItem_i × P_i / gross_i)` then clamped (§7 step 2).
6. **Entry reversal:** `sRev = floor(aRev × S / P)` clamped; `dRev = aRev − sRev` (residual); `dRev + sRev = aRev` invariant holds by construction.
7. **Recovery offsets** at posting: direct-share reduction is `floor` per commission, remainder carried in the obligation balance (never rounds away).
8. **Never** use float arithmetic anywhere in the affiliate money path; never use `round_half_up` except where explicitly inheriting an existing engine helper that already uses it (the platform commission's percent part — the affiliate path does not).
9. All displayed RM values are formatted from integer sen (`formatMinor`, `src/lib/money.ts`); display formatting never feeds back into arithmetic.

## 10. Reconciliation report definition (7 points)

`GET /api/admin/affiliate/reconciliation?from=&to=` — computed fresh each run (no cached snapshot), every point must reconcile to zero variance or be listed as an explained, owned discrepancy:

1. **Ledger balance vs commission rows:** `AFFILIATE_LIABILITY` credit − debit (per `LedgerLine`) === `Σ (pool − reversed − paid-out + failed-return)` over all `AffiliateCommission`/entry rows in scope.
2. **Per-order invariant:** for every order in scope with a posted T1, `Σ sellerNet + Σ commission + Σ affiliatePool === orderTotal` (query `OrderItem` frozen columns against `Order.totalMinor`).
3. **Refund trace:** for every processed `Refund` on an attributed order, `Σ affiliate DR on T5 === Σ aRev recorded on commission rows` (posting vs derived state).
4. **Split integrity:** for every commission with 2 entries, `directShare + sponsorShare === poolMinor`, and no commission has >2 entries or duplicate roles (the `@@unique([commissionId, role])` backstop — report counts violations, expected zero).
5. **Payout trace:** for every `AffiliatePayout` — `paid`: T-A3 and T-A4 posted exactly once each (`dedupKey` uniqueness), amount === `Σ entry shareMinor` it covers; `failed`: T-A4f posted and the entries returned to available; `requested/rejected/processing`: no T-A4 exists.
6. **Recovery ledger:** outstanding `recoveryMinor` obligations === Σ (reversals on paid commissions) − Σ (offsets applied at later postings) — negative-side truth balancing.
7. **Cash mirror:** `PAYOUT_CLEARING` net movement attributable to affiliate recipes (T-A3 − T-A4 − T-A4f) === open affiliate payout positions — proving the affiliate pipeline never strays into seller payout clearing flows.

The report runs on staging in Phase 8 (zero-variance gate) and on a cadence in production (`rollout-checklist.md` §7).

---

## Appendix A — Glossary

- **Affiliate** — a `ShopperUser` with an `AffiliateProfile` (activation + terms acceptance).
- **Sponsor** — the one-level referrer recorded at activation; immutable; admin-correctable only with audit.
- **Direct affiliate** — the attribution winner for a given order item (the affiliate whose link produced the last eligible click for that product).
- **Pool (P)** — the total seller-funded commission on one order item.
- **Split (S/D)** — sponsor/direct division of the pool, 10/90 by floor/residual.
- **Review window** — `affiliate.review_days` between approval and availability, absorbing refund/dispute risk.
- **Recovery** — the negative earnings obligation created when a refund reverses an already-paid commission.
- **Posting** — the creation of money-recognised state inside the webhook's Serializable transaction (T1 + commission rows).

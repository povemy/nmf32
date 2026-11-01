# Settlement configuration verification (Phase 2.3 — P2.3-7, READ-ONLY)

**Audit claim investigated:** "the hold-days and grace-period override chain may
not affect actual ledger maturity calculations."

**Method:** static trace of every configured value → its consumer, from the
two `postOrderPaid` (T1) call sites in `src/app/api/webhooks/payments/process.ts`
(lines ~373 and ~681) backwards through `src/lib/commission.ts`,
`src/lib/seller-terms.ts`, `prisma/schema.prisma`, the admin write surfaces and
the wallet-maturity queries in `src/lib/ledger.ts`. **No calculation was
changed** — payout policy changes need owner authorization.

## The one line that decides real money maturity

Both T1 call sites compute the seller-payable hold identically:

```ts
// webhooks/payments/process.ts — group path (~373) and single-intent path (~681)
const holdDays   = seller.holdDaysOverride ?? settings.payoutHoldDays;
const holdUntil  = new Date(paidAt.getTime() + holdDays * 86400000);
// → postOrderPaid({ ..., holdUntil }) → T1 SELLER:PAYABLE credit line
//   availableAt = holdUntil   (src/lib/ledger.ts:333)
```

Wallet available balance (what payouts admit) = ledger credit lines with
`availableAt <= now` (`src/lib/ledger.ts:229` and the drift recompute at
`:687`). `Seller wallet pending-releases` (`/api/store/pending-releases`)
reads the same T1 lines and *derives* `holdDays` from them for display — it is
a faithful mirror of runtime truth, not a second policy.

## Verified wiring: setting → consumer

| # | Setting (source) | Write surface | Consumer | Verdict |
|---|---|---|---|---|
| 1 | `CommissionSetting.payoutHoldDays` (default 7) | Admin → Commission | T1 fallback at **both** webhook call sites (`seller.holdDaysOverride ?? settings.payoutHoldDays`); `getSellerTerms` display | **LIVE** |
| 2 | `Seller.holdDaysOverride` (nullable) | Admin → Seller detail (gated `commission.manage`); Admin → Finance | Takes precedence over #1 at **both** T1 sites | **LIVE** |
| 3 | Ledger `availableAt` → wallet available → payout admission | — (written by T1) | `ledger.ts` maturity queries, payout request validation | **LIVE** |
| 4 | `Setting psp.split.auto_settle` (default off) | settings registry (`psp.ts`) | webhook flow gate before auto-T2 (`process.ts:119`) | **LIVE** (dormant by default) |
| 5 | `Setting affiliate.review_days` (default 14) | affiliate settings | `affiliate.ts:512` — affiliate entry `availableAt = now + reviewDays`, matured by `sweepAffiliateLifecycle` (cron affiliate-tick) | **LIVE** (independent chain, not the seller hold chain) |
| 6 | `CommissionSetting.holdReleaseRule` (`days_after_paid` \| `days_after_delivered`, default paid) | Admin → Commission (radio; F-10 badge says "not enforced") | **Nothing** — T1 always computes `paidAt + holdDays`; `deliveredAt` is never consulted. Honest dead: `seller-terms.ts:17` + the admin badge both state it | **DEAD** (documented) |
| 7 | `CommissionSetting.graceDaysAfterDelivered` (default 2) | Admin → Commission (editable, validated 0..60) | **Nothing** — grep across `src/` finds zero calculation consumers (only schema, admin UI form, settings route validation, DTO type) | **DEAD** (undocumented — worst offender) |
| 8 | `CommissionOverride.holdDays` (scoped rows: product > category ancestor > seller) | Admin → Finance → Commission Overrides; resolved field-wise in `commission.ts:288-294` | Resolved by `resolveRateFromContext` → returned by `computeOrderCommissions` → **display only** (`simulateCommission` → admin simulate "hold Xd" badge). Checkout quote/create ignore the returned `holdDays`; **T1 never reads it** — it re-derives from #1/#2 | **DEAD for T1** (misleading: the simulate preview shows a scoped hold the ledger will not apply) |

## Findings

1. **The audit's suspicion is confirmed for everything except the top two
   settings.** Only `Seller.holdDaysOverride` and `CommissionSetting.
   payoutHoldDays` flow into real T1 maturity. Everything else in the "hold
   chain" (rows 6–8) is stored, editable and (partially) displayed but never
   consumed by money math.
2. **`graceDaysAfterDelivered` (row 7) is pure dead weight**: finance can set
   it, it round-trips through validation, and nothing anywhere reads it.
3. **Scoped `CommissionOverride.holdDays` (row 8) is actively misleading**:
   the admin commission simulator resolves the full override chain and shows
   "hold N d" for a product/category-scoped override, while the actual payout
   maturity for that same order uses the seller/global value.
4. The affiliate hold chain (row 5) is a **separate, correctly wired system**
   — do not conflate it with the seller hold chain when remediating.

## Recommendations (NOT implemented — payout policy changes need owner authorization)

- **Row 8 (`CommissionOverride.holdDays`)** — two options, owner's call:
  (a) *Wire it*: at both T1 sites, resolve hold per order from the item
  commission snapshots (the resolved rate context already computed at checkout)
  — e.g. snapshot `holdDays` onto `OrderItem` alongside `commissionMinor`, then
  `holdDays = max(item snapshots) ?? seller.holdDaysOverride ?? settings.
  payoutHoldDays`; or (b) *Remove it* (Phase 2.4 cleanup): drop the `holdDays`
  column/field from CommissionOverride + the admin override form + the
  simulator badge, keeping holds seller/global-only. Until one is chosen, the
  simulate UI should carry the same "not applied to payouts" amber badge the
  hold-release-rule radio already has (display-only change).
- **Row 7 (`graceDaysAfterDelivered`)** — recommend **removal in Phase 2.4**:
  it has no design consumer; if a post-delivery grace is ever wanted it should
  be designed together with row 6 (they are one feature: delivery-based
  release).
- **Row 6 (`holdReleaseRule`)** — keep-or-implement decision for the owner:
  implementing `days_after_delivered` means T1 must be deferred or adjusted on
  `deliveredAt` (a second posting or an `availableAt` update on delivery
  transition) — a real policy change with refund-interaction consequences.
  Until then the current honest labelling (code comment + admin badge) is
  correct; if the owner declines the feature, remove both row 6 and row 7 in
  the same Phase 2.4 cleanup.

**Verification trail:** `rg -n "holdDays|payoutHoldDays|graceDays|holdReleaseRule|
days_after_paid|days_after_delivered|holdUntil|holdDaysOverride" src/ prisma/schema.prisma`
plus direct reads of `process.ts` (both T1 sites), `ledger.ts` (postOrderPaid +
maturity queries), `commission.ts` (resolveRateFromContext + simulate),
`seller-terms.ts`, `pending-releases/route.ts`, `affiliate.ts` (reviewDays),
admin routes `commission/settings`, `commission/overrides`, `sellers/[id]`.

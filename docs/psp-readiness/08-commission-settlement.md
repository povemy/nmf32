# 08 — Commission & Settlement (marketplace facilitator)

**Files:** `src/lib/commission.ts` (engine), `src/app/api/checkout/create/route.ts`
(snapshotting), `src/lib/ledger.ts` (T1/T2), `src/lib/psp.ts` (split-settlement
scaffold + Option B), `src/app/api/store/pending-releases/route.ts` (seller-facing
release schedule).

## 1. Commission engine (M09)

Settings live in a singleton `CommissionSetting` row (`prisma/schema.prisma`;
`getCommissionSettings()` auto-creates): `defaultPercent`, `appliesToShipping`,
`basePriceRule` (`paid_price|list_price`), `fixedFeeMinor`, `minCommissionMinor`,
`payoutHoldDays`, `holdReleaseRule` (`days_after_paid|days_after_delivered`),
`graceDaysAfterDelivered`.

**Rate resolution priority** (`resolveRate`, `src/lib/commission.ts`):

```
fee holiday (scoped: all | sellers | categories; percent = 0)
  > product override (commissionPercentOverride)
  > nearest category ancestor (commissionPercent)
  > seller override (commissionOverridePercent)
  > global default (defaultPercent)
```

`seller.holdDaysOverride` overrides the hold period independently (applied as the
fallback `holdDays` in the resolution, honoured at T1 time in `process.ts`:
`holdDays = seller.holdDaysOverride ?? settings.payoutHoldDays`).

**Per-item math** (`computeOrderCommissions`): order discount/shipping/tax are
allocated proportionally to line subtotals (remainders to the largest line);
`commission = round_half_up(base × percent/100) + allocated fixed fee`; the
per-order `minCommissionMinor` floor is skipped on fee holidays. Snapshots are
stored **per `order_item`** (`commissionMinor`, `sellerNetMinor`, breakdown JSON)
and **never recomputed** (`src/lib/commission.ts` header).

**The Option-B invariant** (binding, checked structurally):
`sum(item.sellerNetMinor) + sum(item.commissionMinor) === order.totalMinor` for
EVERY order — T1 debits the gateway the total and credits exactly sellerNet +
commission, so any drift throws `LEDGER_UNBALANCED` at payment time
(`src/lib/commission.ts` invariant doc; `reconcileSplits` is the deterministic
safety net assigning any remainder to the largest line).

## 2. Settlement design (facilitator, no custody)

Per order payment the ledger records (T1, `src/lib/ledger.ts`):

```
DR GATEWAY:{provider}      order.totalMinor          (PSP owes/reports the gross)
CR SELLER:{w}:PAYABLE      sellerNetMinor            (availableAt = paidAt + holdDays)
CR REVENUE_COMMISSION      commissionMinor           (platform revenue)
```

- The seller share is credited **immediately at payment** but held until
  `paidAt + holdDays`; held credits are "pending", matured credits "available"
  (`walletTruth`, `07-ledger-integrity.md` §3).
- Sellers see the per-order release schedule in-app
  (`GET /api/store/pending-releases`: per-order `availableAt`, hold-days, progress;
  `src/app/api/store/pending-releases/route.ts`).
- **Payouts are per-seller, on request**: one open `requested` payout per wallet;
  amount authorized against ledger truth; T3/T4/T4f move the money through
  `PAYOUT_CLEARING` to `BANK_MAIN` (`src/app/api/store/payouts/route.ts`,
  `src/app/api/admin/payouts/[id]/*`, `03-state-machines.md` §3). `Payout.batchId`
  links to `PayoutBatch` for grouped finance-ops exports (model in
  `prisma/schema.prisma`; admin payout-batches surface under
  `src/app/api/admin/payout-batches/`).

## 3. Dormant auto-settle (T2) — deliberate decision

T2 (`gateway_settlement`: DR `BANK_MAIN` / CR `GATEWAY:{p}`) clears the unsettled
PSP position when the PSP settles buyer funds to the platform. It is invoked by the
webhook flow **only** when Setting `psp.split.auto_settle` is true; default
(absent/false) keeps it **dormant** — `GATEWAY:*` balances intentionally carry the
unsettled PSP position until a real PSP contract exists
(`AUTO_SETTLE_SETTING_KEY` + `postGatewaySettlement` docs in `src/lib/ledger.ts`;
`autoSettleEnabled()` + post-commit call in `process.ts`). T2 is idempotent per
settlement ref, so a crash between T1 and T2 heals on the next delivery.

## 4. What a real provider's split-settlement will change

Today the commission split is a **ledger mirror** (bookkeeping). With a contracted
marketplace-capable PSP the split becomes **provider-enforced** (design intent,
documented in `src/lib/psp.ts` split-settlement scaffold + `PSP_SPLIT_CANDIDATES`):

- The provider deducts the platform's **application fee** at payment time and
  settles each seller sub-account directly — the T1 mirror then records what the
  provider actually did, not what the platform promises.
- The exact application-fee mechanics (fee at charge time vs settlement-time
  deduction, destination vs separate charges/transfers, per-seller sub-account
  onboarding/KYC) are **TO BE MAPPED FROM CHOSEN PROVIDER'S OFFICIAL
  DOCUMENTATION** — no provider's fee/settlement semantics are assumed here.
- The dormant T2 wiring and per-seller settlement confirmations
  (`postGatewaySettlement` + the scaffold's "per-seller split confirmations later"
  note) are the integration seams; `psp.split.provider` / `psp.split.auto_settle`
  settings are the toggles (`PSP_SPLIT_SETTING_KEYS`, `src/lib/psp.ts`).

## 5. Verified behaviours (mock rails — internal evidence)

| Check | Result | Evidence |
|---|---|---|
| Held → matured T1 math (pending/available transitions) | PASS | finance-regression tests 1a–2d, `performance/runs/2026-10-25-finance-regression.json` |
| T3/T4/T4f lifecycle wallet math | PASS | tests 6a–6d, same file |
| Refund split (seller share + commission reversal) with dedup replay | PASS | tests 7a–7c, same file |
| Exactly-one T1 per order under duplicate/concurrent webhooks | PASS | `2026-10-27-deployment-smoke.json` §C5; `2026-10-25-load-webstorm.json` |
| Seller pending-releases API mirrors ledger holds | verified in browser E2E (worklog R2-CLOSE) — not an archived automated run | worklog record 2026-10-25/27 |

Provider-enforced application-fee settlement: **NOT TESTED / NOT IMPLEMENTED**
(no provider adapter exists — `performance/psp-readiness/preflight.md` §6.3).

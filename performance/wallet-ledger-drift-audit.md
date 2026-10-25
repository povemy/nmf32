# Wallet Ledger Drift Audit — wallet `cmvizi0ms000zq7niql6b3csg` (Sofia / Lumina Living)

> Phase 1 deliverable. Every number below is **[Measured]** from the live
> database on 2026-10-25 unless labelled otherwise. Evidence JSON:
> `performance/runs/2026-10-25-wallet-drift-deep.json` (deep dive) and
> `performance/runs/2026-10-25-wallet-audit-all.json` (fleet audit), produced by
> `scripts/readiness/wallet-reconcile.ts` (read-only mode).

## 1. Before-state — the reported failure, reproduced exactly [Measured]

```
cached     available = 0        pending = 95292     (cache written 2026-10-23T08:33:53.546Z)
app-truth  available = 10764    pending = 84528
sql-truth  available = 10764    pending = 84528     (11 ledger lines; credits 150952; debits 55660; matured 66424)
drift      available −10764     pending +10764      total 0
```

The reported incident's numbers reproduce **exactly**. Combined totals are equal
(95,292 = 95,292): a pure available↔pending **classification drift**, no missing money.

## 2. The system's own definitions (verified from code, then independently)

From `src/lib/ledger.ts` (the single wallet-cache writer) and `prisma/schema.prisma`:

- **Ledger truth** — `WalletTruth` from `LedgerLine` rows on account `SELLER:{walletId}:PAYABLE`:
  - `availableMinor = Σ(credits with availableAt ≤ now or NULL) − Σ(debits)`
  - `pendingMinor = Σ(all credits) − Σ(matured credits)`
- **Cache** — `Wallet.availableMinor / pendingMinor` columns, written **only** by
  `refreshWalletCache()` (grep-verified: exactly one `wallet.update` call site in the repo),
  invoked from journal recipes (T1/T3/T4/T4f/T5/T6) and several read paths
  (seller wallet/dashboard/me, admin wallets list).
- **Credits carrying `availableAt` in the future are pending holds** — T1 posts
  `availableAt = paidAt + holdDays` (settings.payoutHoldDays; measured holds are 7 days).
- Debits (payout initiation T3, refunds T5, admin debits) reduce `available` immediately.
- Currency: all lines default MYR; measured **1 currency per payable account**; the
  line's account code embeds the walletId — measured **0 foreign-wallet lines** on every
  audited account (no scope mixing).
- Rounding: integers (minor units) end-to-end; no floating point in the aggregation.

## 3. Independent verification — do NOT trust the "truth" label

Two independent derivations agree for every audited wallet:
1. **App formula** (`walletTruth`, Node aggregation), and
2. **Raw SQL aggregate** over `LedgerLine` (separate Postgres session, `SUM(CASE …)`)
   — `crossValidation.formulaAgrees = true` for all 6 wallets [Measured].

Double-entry integrity: **190/190 ledger transactions balanced** [Measured].
The health check's "truth" is therefore confirmed correct; the cache is what lags.

## 4. Root cause — proven, not speculated

**Cause: time-based hold maturity with an event-driven-only cache refresh.**
A hold credit matures **by the clock** (`availableAt ≤ now`) but **nothing triggers a
cache refresh at maturity**. The cache is a snapshot "as of the last wallet-affecting
event"; the invariant compared it to truth-"now" — a spec mismatch that was guaranteed
to false-alarm for any wallet whose holds matured between two wallet events.

Event replay for the reported wallet (from the deep-dive JSON; all [Measured]):

| When (UTC) | Event | Effect | Wallet truth as-of this event |
| --- | --- | --- | --- |
| 10-13 → 10-21 | 3× order_paid | holds mature on 10-20/10-26/10-28 | by 10-21: avail 55660, pend 27940 |
| 10-22 03:32 | payout_initiated (T3) | debit 55660 | **avail 0, pend 27940** |
| 10-22 06:12 → 14:20 | 4× order_paid | new holds (+8988 ×3, +40388) | avail 0, **pend 95292** |
| 10-23 08:33 | cache refresh (read-path) | cache ← truth | cache {0, 95292} — **correct when written** |
| **10-24 14:12** | **hold matures** (order cmvizif5f00a credit 10764, 7-day hold from 10-17) | truth → avail 10764, pend 84528 | **no write occurs — cache stays {0, 95292}** |

`cache == ledger truth recomputed as-of wallet.updatedAt` ⇒ **[Measured] the cache was
CORRECT at its last write; the mismatch is purely the 10,764 hold maturing afterwards
with no refresh.** No stale write, no wrong classification at write time, no duplicate
or omitted delta, no race: classification `STALE_TIME_MATURITY` (totals equal, fully
explained by `maturedSinceLastWrite = 10764`).

### Was the inside-vs-outside-transaction question the cause?

No — and this matters. `refreshWalletCache` runs *inside* the money transaction, which
means the cache value is always transactionally consistent **with the postings of that
transaction**. Moving it across the boundary could not produce this drift (the drift
appeared with **zero** writes in between — only the clock moved). The placement *is* the
measured hot-row epicenter of F1 confirmation storms, so it was still moved post-commit
in this mission — but as a contention fix (F1), **not** as the drift fix. Authorization
safety of the move: payout request/approval/batch recompute `walletTruth` transactionally
inside their own txs; the cache is never consulted for money decisions, so a failed
post-commit refresh cannot enable spending unavailable funds nor block a legitimate one
— it can only leave a stale *display* value that the invariant now classifies and the
next event/read heals.

## 5. Is it isolated or systemic? — bounded fleet audit [Measured]

Read-only audit of **all 6 wallets** (`2026-10-25-wallet-audit-all.json`):

| Metric | Value |
| --- | --- |
| Wallets examined | 6 |
| Matching (cache == truth) | 5 |
| Mismatched | **1** (the reported wallet) |
| Classification of the mismatch | `STALE_TIME_MATURITY` |
| Total available-balance drift | **−10764** |
| Total pending-balance drift | **+10764** |
| Unexplained combined-total drift | **0** |
| Unbalanced transactions | 0 / 190 |
| Currency mixing / cross-wallet contamination | 0 accounts affected |

**Systemic property, single instance:** any wallet with future-dated holds will
periodically drift this way between a maturity and its next wallet event/read —
a design property of the cache semantics, not a one-off writer bug. The fix is
therefore in the *invariant's specification + health-check behavior*, not in hunting
a corrupting writer (there is none — the one `wallet.update` site writes derived truth).

## 6. Correction (implemented in this mission) and rollback

Writer/机制 repairs (see `current-state-verification.md` §4 for file list):
1. **Invariant classification** — `runLedgerInvariants` now separates hard drift
   (totals differ / unexplained) from benign `STALE_TIME_MATURITY` (cache == truth as-of
   its own last write). Health no longer false-alarms on clock-driven staleness and
   still detects real drift.
2. **Health check** — TTL-cached (60 s, `?fresh=1` bypass), magnitudes + categories only
   (no wallet ids on the public surface; admin surface exposes ids behind auth), and it
   never mutates balances (read-only by construction — verified: it only calls
   `findMany`/`count`).
3. **Display resilience** — wallet/dashboard/admin-wallet reads use
   `safeRefreshWalletCache` (never 500 on a contended wallet row).
4. **Repair utility** — `scripts/readiness/wallet-reconcile.ts`: read-only audit by
   default; `--apply` requires `--confirm <walletId|ALL>`, refuses wallets when the
   ledger has unbalanced transactions or when staleness is unexplained, writes only
   derived truth (never hardcoded deltas), re-running is a no-op.

**What was NOT done:** no reconciliation write was applied to the live wallet
(mission rule 7). The reported wallet's cache self-heals on its next wallet event or
wallet-page read (refresh-on-read paths) — verified mechanically by the utility's
`refreshWalletCache` equivalence, and the stale value is now reported as benign
staleness with magnitude 10764 rather than a system failure.

**Rollback procedure for any future repair:** the repair writes only cache columns
derived from the ledger; rollback = re-run the audit (truth is recomputed) — if the
ledger itself were ever wrong (not the case here; 190/190 balanced + cross-validated),
restore cache from a DB snapshot and stop: ledger repair is a separate plan per the
mission rules, never a cache refresh.

## 7. Labels summary

- Reproduction, definitions, event replay, fleet audit, integrity checks: **Measured**.
- "No other writer exists": **Measured** (single grep-verified call site).
- "Drift is display-only, no money-safety impact": **Derived** — from the verified
  call-graph (payout authorization recomputes truth transactionally; cache has no
  authorization consumer). The authorization paths themselves were previously verified
  under the FIN-* hardening runs and were not re-storm-tested in this mission beyond
  the concurrency tests in `scripts/readiness/finance-regression.ts`.
- Production-scale behavior: **Not Tested** (no staging; see REPORT hard boundaries).

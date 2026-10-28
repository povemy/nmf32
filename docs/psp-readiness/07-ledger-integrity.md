# 07 — Ledger Integrity (double-entry engine)

**File:** `src/lib/ledger.ts` (accounts, posting core, recipes, wallet truth,
invariants) · models `LedgerTransaction`/`LedgerLine`/`LedgerAccount`/`Wallet`
(`prisma/schema.prisma`) · tooling `scripts/verify-ledger.ts`,
`scripts/readiness/wallet-reconcile.ts`.

## 1. Model & sign conventions

- Every posting is a **balanced double-entry transaction**: `sum(debits) ==
  sum(credits)`, non-zero, or the posting throws `LEDGER_UNBALANCED`
  (`postTransaction`, `ledger.ts:127-145`).
- All money is **integer minor units** (sen for MYR); no floats anywhere in the
  posting path.
- Seller wallet balance = `SUM(credit) − SUM(debit)` on `SELLER:{walletId}:PAYABLE`;
  credits with `availableAt > now` are **pending** (on hold) — sign convention in the
  `ledger.ts` header and `walletTruth()`.
- Accounts (`ACCOUNTS`, `ledger.ts:18-25`):

| Code | Type | Meaning |
|---|---|---|
| `PLATFORM:BANK_MAIN` | asset | platform main bank account |
| `PLATFORM:PAYOUT_CLEARING` | liability | in-flight payouts |
| `PLATFORM:REVENUE_COMMISSION` | revenue | commission revenue |
| `PLATFORM:REVENUE_ADJUST` | revenue | manual adjustments |
| `GATEWAY:{PROVIDER}` | asset | PSP receivable position per provider |
| `SELLER:{walletId}:PAYABLE` | liability | seller payable (mirror of PSP per-seller balance) |

**Option B note (binding):** the platform does **not** custody buyer funds;
`SELLER:*:PAYABLE` balances mirror the PSP's per-seller sub-balances, and the payout
pipeline records the settlement the PSP/finance ops actually executes
(`ledger.ts` header).

## 2. Posting recipes (T1–T4f, T5, T6)

| Txn | Trigger | Lines | dedupKey |
|---|---|---|---|
| **T1** `order_paid` | webhook success, per order | DR `GATEWAY:{p}` total · CR `SELLER:PAYABLE` sellerNet (`availableAt` = paidAt + holdDays) · CR `REVENUE_COMMISSION` commission | `order_paid:order:{orderId}` |
| **T2** `gateway_settlement` | dormant auto-settle (see `08`) | DR `BANK_MAIN` · CR `GATEWAY:{p}` | `gateway_settlement:settlement:{ref}` |
| **T3** `payout_initiated` | admin approve | DR `SELLER:PAYABLE` · CR `PAYOUT_CLEARING` | `payout_initiated:payout:{id}` |
| **T4** `payout_confirmed` | payout paid | DR `PAYOUT_CLEARING` · CR `BANK_MAIN` | `payout_confirmed:payout:{id}` |
| **T4f** `payout_failed` | payout failed | DR `PAYOUT_CLEARING` · CR `SELLER:PAYABLE` (immediately matured reversal) | `payout_failed:payout:{id}` |
| **T5** `refund` | order-level refund | DR `SELLER:PAYABLE` (seller share) · DR `REVENUE_COMMISSION` (reversal) · CR `GATEWAY:{p}` | `refund:refund:{refundId}` |
| **T6** `admin_adjustment` | admin correction | DR/CR `SELLER:PAYABLE` vs `REVENUE_ADJUST` | *(none, deliberately)* |

Atomicity: recipes called with an outer transaction client run **inside** it (never
nested); standalone calls wrap themselves in `db.$transaction` (`ledger.ts` FIN-1 note).
Idempotency: P2002 on a dedupKey returns the original transaction with
`idempotentReplay:true` (`postTransaction`), backed by a SAVEPOINT recovery path.

## 3. Wallet cache vs ledger truth

- **Truth** = `walletTruth(walletId)`: recomputed from ledger lines —
  `pending = credits − matured credits`, `available = matured credits − debits`,
  plus lifetime fields (`ledger.ts:212-241`).
- **Cache** = denormalized columns on `Wallet` (`pendingMinor`, `availableMinor`,
  …), refreshed by `refreshWalletCache` — an **event-driven derived display value**.
- Money decisions never trust the cache: payout request authorization reads ledger
  truth transactionally (`src/app/api/store/payouts/route.ts:134-144`).
- Hot-path note (measured): the wallet-row UPDATE inside Serializable payment txs
  was the SSI conflict epicenter; webhook paths refresh the cache **post-commit,
  best-effort** (`process.ts`, `ledger.ts` contention note; `safeRefreshWalletCache`
  for display surfaces — never throws, never used for money).

## 4. Drift classification (hard vs benign)

`runLedgerInvariants()` (`ledger.ts:544+`) separates:

| Class | Definition | Severity |
|---|---|---|
| **Hard** | unbalanced transaction; or cache-vs-truth drift where totals differ / staleness NOT explained by maturing holds (`CACHE_VALUE_DRIFT`) | money-correctness — always investigated |
| **Benign** `STALE_TIME_MATURITY` | totals equal AND cache == truth recomputed **as of the cache's own last write** — holds matured by clock afterwards with no triggering write | display-only; self-heals on next wallet event/read |

Rationale: hold credits mature by the **clock** (`availableAt ≤ now`) with no
triggering write, so an event-driven cache is *expected* to lag truth-now while its
total stays correct (`ledger.ts` invariants doc). The original drift incident was
root-caused to exactly this class (wallet-ledger drift mission,
`performance/wallet-ledger-drift-audit.md`).

`/api/health` consumes the invariant scan TTL-cached (60 s; `?fresh=1` to force),
reports `hardDriftCount` separately from benign staleness magnitude, and exposes no
sensitive data (`src/app/api/health/route.ts`).

## 5. Invariant checks + reconciliation tooling

| Tool | What it does | Usage |
|---|---|---|
| `scripts/verify-ledger.ts` | runs ledger invariants (double-entry balance for every transaction) + refreshes and re-checks every wallet cache vs truth; exits non-zero on failure | `bun scripts/verify-ledger.ts` (CI/ops gate; prints `FINANCIAL-GATE: ALL PASS`) |
| `scripts/readiness/wallet-reconcile.ts` | **read-only by default**; per-wallet MATCH / STALE_TIME_MATURITY / STALE_UNEXPLAINED / CACHE_VALUE_DRIFT classification; `--json` evidence output; `--apply` repair rewrites ONLY derived cache columns from truth (requires explicit `--confirm`, refuses wallets whose ledger fails double-entry; idempotent by construction; never edits ledger rows) | `bun scripts/readiness/wallet-reconcile.ts [--wallet id] [--json path] [--apply …]` |

Additionally `scripts/readiness/finance-regression.ts` regression-tests the full
surface (drift shapes, repair dry-run/apply/idempotency, concurrency, T3/T4/T4f
lifecycle, refund dedup, fault injection) — 37 checks,
`performance/runs/2026-10-25-finance-regression.json`.

## 6. Verified state (archived evidence, mock rails)

| Check | Result | Evidence |
|---|---|---|
| Double-entry balance, all transactions | **PASS — 325/325 balanced** (re-executed 2026-10-27) | worklog addendum #3 live re-run; `performance/psp-readiness/preflight.md` §1 |
| Wallet cache == ledger truth | **PASS — 6/6 wallets** (re-executed 2026-10-27) | same |
| Finance regression suite | **PASS — 37/37 rows, failures: 0** (2026-10-25; re-verified green 2026-10-27) | `performance/runs/2026-10-25-finance-regression.json` (`"tests": 37, "failures": 0`) |
| Health invariants ok (deployment smoke) | PASS | `performance/runs/2026-10-27-deployment-smoke.json` §A3 |

All of the above ran against the dev sandbox with mock-PSP payment flows —
internal evidence, not provider certification.

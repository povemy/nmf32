# scripts/attic — pre-ledger-era tooling (parked, NOT deleted)

Moved here in Phase 2.4 (P2.4 cleanup): these scripts pre-date the current
ledger/commission schema and no longer typecheck (they reference fields that
do not exist, e.g. `commissionBps` on Category/OrderItem, `defaultBps` on
CommissionSetting, `lastErrorJson`/`idempotencyKey` on PayoutBatch/Ledger).
package.json has no references to either.

- `fin-concurrency.ts` — live race-suite (payment + payout pathways). May hold
  useful concurrent-settle oracle logic.
- `fin-reconcile.ts` — independent DB reconciliation (order totals, commission,
  refunds, payouts). May hold useful reconciliation oracles.

They need REWRITING against the current schema (bps lives in
`src/lib/commission.ts` snapshots — OrderItem commission fields were replaced
by the commissionOverride/ledger-era model) before any use. Kept per the
Phase 2.4 task instruction: do not fix here (out of scope), do not delete.

`scripts/verify-finance-hardening.ts` (package.json `verify:finance`) still
typechecks clean and stays in place.

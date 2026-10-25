# Current-State Verification — Wallet Ledger Drift + F1/F2/F3 Remediation Mission

> Mission: *Fix Wallet Ledger Invariant Drift and Complete Evidence-Based Production
> Readiness Remediation*. Phase 0 deliverable.
> Verified **2026-10-25** by direct inspection of the working tree + live database.
> Labels: **[Measured]** / **[Derived]** / **[Assumed]** / **[Not Tested]**.

## 1. Repository state [Measured]

| Item | Value |
| --- | --- |
| Repository root | `/home/z/my-project` |
| Branch | `main` |
| HEAD at mission start | `cb2938e958db5d092a536d9d5760033f58f99107` |
| Worktree at mission start | clean (0 modified files) |
| Framework | Next.js 16.1.3 (App Router, Turbopack **dev mode**), bun 1.3.14 |
| Database | Remote Supabase **PostgreSQL 17**, `aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`, Supavisor **session** pooler, `connection_limit=10` in URL [Measured via live queries] |
| Prisma | 6.19.2, datasource `SUPABASE_DATABASE_URL` (deliberately not `DATABASE_URL` — sandbox harness injects a stale `DATABASE_URL`) |
| App process at verification time | 1 instance × 1 process, port 3000, dev mode |

## 2. Comparison: previous reports vs the actual tree

Baseline documents inspected: `performance/REPORT.md` (2026-10-25), `performance/readiness-checklist.md` (2026-10-25), archived runs `performance/runs/2026-10-25-*.json`. These were produced by the *previous* readiness-validation mission — they are evidence to re-verify, not assumptions.

| # | Prior claim | Verified classification | Evidence |
| --- | --- | --- | --- |
| V-1 | "Checkout admission gate / `CHECKOUT_BUSY` / `Retry-After` — never implemented" | **Implemented-and-verified claim is correct** — 0 code matches at mission start | grep `CHECKOUT_BUSY\|Retry-After` = 0 [Measured] |
| V-2 | "No P2034/P2028 retry wrapper anywhere in `src/`" | **Conflicting/stale evidence** — correct for the *payment-confirmation* path (the F1 subject), overbroad as written: bounded P2034 retries already existed in `src/app/api/store/payouts/route.ts` and `src/app/api/admin/payout-batches/route.ts` (payout flows, not payment confirmation) | grep `P2034` — 2 hits, both payout paths [Measured] |
| V-3 | "`PaymentGroup.expiresAt` … written and **never read**" | **Partially stale** — it *is* read for display/retry gating in `checkout/payments/[ref]/route.ts` + `/retry/route.ts`; what is true: **no enforcement** (no sweep/worker ever cancelled an expired group or released its stock) | grep `expiresAt` [Measured] |
| V-4 | "`refreshWalletCache()` runs inside the Serializable success tx — hot row" | **Confirmed** in both webhook paths (group + legacy single-order), and additionally in 3 payout Serializable txs (`store/payouts`, `admin/payouts/[id]/approve`, `admin/payout-batches`) | code inspection [Measured] |
| V-5 | "No reservation system exists; stock moves at checkout; unpaid orders hold stock forever" | **Confirmed** — no Reservation model; stock decrement happens in `checkout/create` conditional `updateMany`; nothing released it before this mission | schema + code inspection [Measured] |
| V-6 | Health check `runLedgerInvariants()` per poll, full-ledger scan | **Confirmed** — `GET /api/health` ran the full scan on every poll (measured 1237 ms in a prior run); no TTL, no drift classification | code inspection [Measured] |
| V-7 | Archived F1/F2/F3 audits + run JSONs "never existed on disk" | **Conflicting/stale evidence** — they exist NOW because the previous mission created them (2026-10-25). The original claim referred to the pre-report tree. Treat the archived runs as the previous mission's own measurements | `performance/runs/` [Measured] |
| V-8 | Wallet invariant failure: wallet `cmvizi0ms000zq7niql6b3csg` cached {avail 0, pend 95292} vs truth {avail 10764, pend 84528}, totals 95292 both | **REPRODUCED EXACTLY** against the live DB — see `wallet-ledger-drift-audit.md`; classification: `STALE_TIME_MATURITY` | `performance/runs/2026-10-25-wallet-drift-deep.json` [Measured] |
| V-9 | Ledger double-entry integrity | **PASS** — 190/190 transactions balanced [Measured] | reconciliation utility run |

## 3. The four previously reported fixes — classification

| Fix | Classification at mission start | Detail |
| --- | --- | --- |
| **F1** payment-confirmation serialization failures | **Absent** from the payment path (no P2034 retry, wallet-cache refresh inside the Serializable tx — the measured hot row). Bounded retries existed only in unrelated payout flows. | Remediated in this mission — see §4 |
| **F2** checkout overload / admission control | **Absent** (no gate, no 429/503 path, queue-time uninstrumented) | Remediated in this mission — see §4 |
| **F3** reservation expiry | **Absent** (no enforcement of `expiresAt`; abandoned checkouts held stock forever — measured in the prior mission's probe) | Remediated in this mission — see §4 |
| **Wallet-cache drift** (this mission's primary defect) | **Reproduced**; root cause established with code+DB evidence | `wallet-ledger-drift-audit.md` |

## 4. Changes made in this mission (all diffable in the worktree)

| Area | File(s) | Change |
| --- | --- | --- |
| Root cause | `src/lib/ledger.ts` | Invariant re-specified: separates unbalanced txns / **hard drift** (totals differ or unexplained) / **benign time-maturity staleness** (cache == truth as-of its own last write). Adds `safeRefreshWalletCache` (never-throw display refresh) and `refreshCache` opt-out on `postOrderPaid`/`postPayoutInitiated` |
| Health check | `src/app/api/health/route.ts` | 60 s TTL cache (`?fresh=1` forces), classification-aware response, no sensitive data, gate introspection |
| Admin health | `src/app/api/admin/system/health/route.ts` | Exposes full drift classification incl. wallet ids (authenticated surface) |
| F1 | `src/app/api/webhooks/payments/process.ts` | Wallet-cache refresh moved **out** of both Serializable success txs (post-commit, best-effort, idempotent); bounded P2034 retry (≤2 retries, jittered) around the whole claim+money tx; PSP calls remain outside |
| F1 | `store/payouts`, `admin/payouts/[id]/approve`, `admin/payout-batches` | Same pattern: truth read stays transactional (authorization unchanged), cache write deferred post-commit |
| Display robustness | `store/wallet`, `store/dashboard`, `admin/wallets` | `safeRefreshWalletCache` — a contended wallet row can no longer 500 the money views |
| F2 | `src/lib/checkout-gate.ts` (new), `src/app/api/checkout/create/route.ts` | Bounded in-process admission gate (16 inflight / 32 waiting / 5 s budget, env-overridable), clean `503 CHECKOUT_BUSY` + `Retry-After`, `X-Checkout-Queue-Ms` telemetry, placed AFTER idempotency replay (replays never consume slots) and BEFORE any write |
| F3 | `src/app/api/cron/expiry-sweep/route.ts` (new) | Claim-first expiry enforcement: `requires_payment→expired` + per-order `payment_pending→payment_expired` + atomic stock restore + InventoryLog + floor-guarded salesCount; batch-bounded; durable observability in Setting `cron.expiry_sweep.last`; `CRON_SECRET` optional |
| F3 policy | `process.ts` | Late payment on expired group → definitive `409 GROUP_EXPIRED` (both pre-claim and claim-lost re-check); claim condition excludes `expired` |
| Envelope | `src/lib/api.ts` | `ApiError`/`fail` support response headers (for `Retry-After`) |
| Tooling | `scripts/readiness/wallet-reconcile.ts` (new) | Read-only-by-default reconciliation utility (audit / deep-dive / guarded apply) |

## 5. What was NOT done (and why)

- **No production reconciliation write.** The live DB is the app's only database; per mission rule 7 the repair utility was run read-only against it and apply-mode was exercised only on `[LT]`-tagged fixture wallets.
- **No pool-size / Supavisor mode change** (unchanged from prior mission's evidence: pool is not the binding constraint).
- **No production build / staging** — sandbox cannot run one (prior mission's hard boundary still applies).

## 6. Runtime verification after changes [Measured]

- `bun run lint` — clean.
- Dev server boots; `GET /api/health?fresh=1` returns `status: healthy`, `ledgerInvariants.ok: true`, `hardDriftCount: 0`, `timeMaturityStaleness: {count: 1, magnitudeMinor: 10764}` — the reported wallet is now correctly **classified and visible** instead of flipping the system to failure. `checkoutGate` introspection present.

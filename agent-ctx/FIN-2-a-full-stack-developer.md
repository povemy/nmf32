# FIN-2-a — Payout routes, atomic reservation & state machine

Agent: full-stack-developer
Status: ✅ COMPLETE (all 7 items + 10 global guard rules honored)
Files touched (STRICTLY within allowed list): see "Files changed" below.

## What was implemented

### 2a.1 — src/lib/payout-state.ts (NEW)
Single source of truth: `PAYOUT_STATUSES` (7 statuses incl. future returned/reversed), `PayoutStatus` type, `PAYOUT_TRANSITIONS` map (requested→processing|rejected; processing→paid|failed; paid→returned|reversed; failed→processing; 3 terminal), `isPayoutStatus`, `canTransition(from,to)`, `assertTransition(from,to)` → ApiError 409 `STATE_INVALID` with readable `from → to` message incl. allowed targets. All 4 admin mutation routes + batch route use it.

### 2a.2 — Atomic claim pattern (approve / reject / mark-paid / fail)
Every transition's money-critical steps run in ONE `db.$transaction` whose FIRST statement is `updateMany({ where: { id, status: <expectedFrom> }, data: { status: <to> } })` — count 0 ⇒ 409 CONFLICT "not in X state (or already claimed)". The conditional update is atomic at row level: the race loser re-evaluates WHERE against the winner's committed write and matches 0 rows BEFORE any ledger posting.
- **approve**: claim(requested→processing) → in-tx seller re-verify + `refreshWalletCache(walletId, tx)` balance check → insufficient ⇒ explicit in-tx revert claim (processing→requested) then throw 409 INSUFFICIENT_BALANCE (tx rollback releases the claim regardless — revert is belt-and-braces documented) → `postPayoutInitiated({…, tx})` (T3, FIN-1 dedupKey) → statementJson attached in-tx. Statement BUILT outside tx (buildLedgerStatementFromLedger has no tx param; derived snapshot, period logic unchanged: since previous PAID payout → wallet createdAt → 30d). After tx: notify (same subject), auditAdmin (same action/fields), fetch row → `ok(updated)`.
- **reject**: claim(requested→rejected) + failReason in-tx; NO ledger movement (preserved); refreshWalletCache kept.
- **fail**: claim(processing→failed) → `postPayoutFailed({…, reason, tx})` (T4f) → failReason in-tx; ops+seller notifies preserved.
- **mark-paid**: claim(processing→paid) → `postPayoutConfirmed({…, tx})` (T4) → paidAt/providerRef in-tx; referenceNo requirement preserved.
- assertTransition(stale read) runs before each tx as readable fast-fail; the claim is the real guard.

### 2a.3 — store/payouts POST race-safe one-open-request
`createPayoutRequestTx()`: interactive `db.$transaction(..., { isolationLevel: "Serializable" })` containing open-request findFirst (409 REQUEST_PENDING same message), `refreshWalletCache(walletId, tx)` truth + INSUFFICIENT_BALANCE check, counter upsert, payout create. Bounded retry on P2034 (3 attempts) → 409 CONFLICT on exhaustion. Amount-vs-minimum + bank-account checks stay OUTSIDE the tx (non-racing, keeps critical section short). Response shape `{ payout, message, storeName }` + all error codes preserved. notify gains FIN-2b dedupKeys, **recipient-scoped** (`payout.requested:{id}:ops` / `:seller`) — a shared key would dedup ACROSS recipients via the (channel,dedupKey) unique and silence the seller copy.

### 2a.4 — NEW POST /api/admin/payouts/[id]/sync (read-only reconciliation)
requireCap(payouts.manage). Recomputes walletTruth vs cache (cacheMatches + drift finding), verifies T3/T4/T4f presence by FIN-1 dedupKeys with per-status rules (T3 required for processing/paid/failed; T4 if paid; T4f if failed; flags postings present on states that never moved money), rebuilds statementJson ONLY when status processing/paid AND statement is missing/malformed (validity = ledger-derived shape: reconciled+lines+periodFrom — legacy decorated statements get rebuilt; prevPaid lookup excludes the payout itself). Response `{ payoutId, status, walletTruth, cacheMatches, expectedTxns:{T3,T4,T4f}, statementRebuilt, findings[] }` + auditAdmin "payout.sync". NEVER flips status, NEVER posts money, never touches wallet cache. Documented hook point for a future PSP adapter (manual mode = PSP is human).

### 2a.5 — NEW POST /api/admin/payouts/sweep (bounded + repeatable)
requireCap + rateLimit 6/min (task item 7 explicit value beats item 8's generic 20). (a) Stuck: processing + updatedAt < now−stuckHours (setting `payout.stuck_hours`, default 72, parseMaybeJson), cap 50, alert-once (dedup vs existing `payout.stuck_detected` activity rows by entityId) → logActivity system rows + response entries `{ payoutId, referenceNo, hoursStuck, updatedAt, alerted }`. (b) Webhooks: processed=false older than 1h, cap 25; signatureValid=false ⇒ skipped; else re-invoke shared `processPaymentWebhook({ provider, body: JSON.parse(payloadJson), rawBody })` in try/catch → counts { reprocessed, stillFailing, skipped }; marks NOTHING by hand (processor owns state; duplicate deliveries converge on dedupKey / status claim). (c) `runLedgerInvariants()` result included. Response `{ stuck, stuckHours, webhooks:{scanned,reprocessed,stillFailing,skipped}, invariants, ranAt }` + logActivity "payout.sweep.run". No auto-retry-money, no status overwrite.

### 2a.6 — Rate limiting
`rateLimit(req, { limit: 20, windowMs: 60000 })` at top of approve/reject/mark-paid/fail + payout-batches POST (sweep: 6/60000 per spec); !ok ⇒ 429 RATE_LIMITED. FIN-2-b's `src/lib/ratelimit.ts` landed mid-task with the exact agreed contract — imported as-is, NO stub needed.

### 2a.7 — Gates & probes (evidence below)
lint clean · prisma validate + db push OK · verify-ledger PASS · finance-preflight PASS · full manual probe round via curl.

## Files changed
- NEW `src/lib/payout-state.ts`
- MOD `src/app/api/admin/payouts/[id]/approve/route.ts` (+89/−old flow)
- MOD `src/app/api/admin/payouts/[id]/reject/route.ts`
- MOD `src/app/api/admin/payouts/[id]/mark-paid/route.ts`
- MOD `src/app/api/admin/payouts/[id]/fail/route.ts`
- MOD `src/app/api/admin/payout-batches/route.ts`
- MOD `src/app/api/store/payouts/route.ts`
- NEW `src/app/api/admin/payouts/[id]/sync/route.ts`
- NEW `src/app/api/admin/payouts/sweep/route.ts`
- MOD `prisma/schema.prisma` (+4: `@@index([walletId, status])` on Payout — DIRECTED by task spec item 4; validate+db push OK, non-destructive)

## Probe evidence (dev server :3000, admin admin@nomofee.io, seller lumina@nomofee.io)
- Wallet adjust (audited): credit 500000 minor to wallet cmver9o3m… reason "FIN-2a probe…" → available 0→500000. (All wallets had available=0 — pending-only per hold days.)
- Seller request 500000 → 200 `PO-100008` (requested); immediate 2nd request → 409 REQUEST_PENDING.
- approve #1 → 200 processing; ledger 39→40 (+1 T3 `payout_initiated:payout:{id}`).
- approve #2 → **409 STATE_INVALID** (processing→processing); ledger unchanged.
- mark-paid #1 (providerRef PROBE-FIN2A-MANUAL-001) → 200 paid, +1 T4; **mark-paid #2 → 409**; ledger payout txns for this payout = EXACTLY {payout_initiated, payout_confirmed}.
- **CONCURRENT double-approve race (payout B PO-100011)**: two simultaneous POSTs → one 200, one **409 CONFLICT "not in requested state (or already claimed)"** — the updateMany claim path itself; ledger for payout B = exactly [payout_initiated]. TOCTOU double-spend dead.
- fail (payout B) → 200 failed + T4f; wallet available restored 0→100000 (reversal verified).
- request 20000 → reject → 200 rejected + failReason, **ZERO ledger movement**; reject #2 → 409.
- sync ×2 on paid payout → `{ status:"paid", cacheMatches:true, expectedTxns:{T3:true,T4:true,T4f:false}, statementRebuilt:false, findings:[] }` both runs.
- sweep ×2 (default 72h): stuck=[], webhooks scanned 0, invariants PASS both. Stuck-path proof: temporarily set `payout.stuck_hours=0` → sweep A alerts the 3 real processing payouts (alerted:true, activity rows), sweep B = 0 NEW alerts; setting deleted (default 72 restored).
- Reprocessor path proof (direct call = sweep's exact invocation): invalid sig → BAD_SIGNATURE; valid sig + succeeded group → `{ ok:true, duplicate:true }`, ledger count unchanged.
- Rate limit: 7 rapid sweeps → calls 5-7 = **429 RATE_LIMITED**.
- Final: verify-ledger ALL PASS (49 txns/125 lines), preflight PASS (0 unbalanced, 0 drift, 0 real dup groups — the admin_adjustment ×N group is the documented no-dedupKey recipe), lint clean, dev.log 0 errors.

## Deviations & notes for orchestrator
1. **schema.prisma touched** (not in checklist file list) — task spec item 4 explicitly directs `@@index([walletId, status])`. +4 lines, pushed cleanly.
2. **Sweep rate limit 6/min** (item 7) vs 20/min (item 8) — used 6/min for sweep, 20/min for the rest (specific beats generic).
3. **notify dedupKeys recipient-scoped** (`:ops`/`:seller` suffixes) instead of the literal single `payout.requested:{id}` — (channel,dedupKey) unique would suppress the second recipient's email otherwise.
4. **Approve insufficient-balance revert**: the in-tx revert claim + throw rolls back the whole tx (claim included) — end state = requested, as spec'd; revert kept as documented belt-and-braces.
5. **Sweep × FIN-2b interaction**: with FIN-2b's ±10min replay window, old valid-signature unprocessed webhooks reprocessed by the sweep will legitimately count `stillFailing` (STALE_EVENT) — fail-closed by design (replay protection wins; human review is the path). Documented in sweep comments.
6. Batch payouts are now born `requested` and claimed to `processing` inside the per-payout Serializable tx (real guard + balance re-verify inside tx); committed rows are indistinguishable from before (processing).
7. Parallel FIN-2-b ran its own probes on the same dev server/DB during this task (its adjustments/payouts PO-100009/100010 visible in ledger). My per-payout dedupKey counts verified in isolation; invariants PASS with both agents' data. No file-boundary violations either way (checked git status).
8. Residue left intentionally (real, audited): PO-100008 paid, PO-100011 failed, PO-…(20000) rejected, wallet adjustment 500000 minor credit (documented reason), 3 stuck_detected + several payout.sweep.run activity rows. NO ledger rows deleted.

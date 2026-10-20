# FINANCIAL SYSTEM HARDENING — MASTER CHECKLIST

Source: user-uploaded 14-phase audit prompt (`upload/Pasted Content_1792465207420.txt`) + verified gap analysis (worklog AUDIT-A/B/C).
Mode: audit-and-improve existing system. **Preserve working architecture. Targeted changes only.**

---

## GLOBAL GUARD RULES (every agent MUST obey)

1. **READ FIRST**: `agent-ctx/FIN-HARDENING-CHECKLIST.md` (this file) + last 200 lines of `worklog.md` before any edit.
2. **SCOPE DISCIPLINE**: touch ONLY the files listed in your task. Anything else → report to orchestrator, do not edit.
3. **NO DELETIONS without compensating replacement.** If you remove a route/field/behavior, you must either (a) re-implement its purpose in the new location, or (b) leave it intact and note why. Orchestrator runs `git diff` review after every stage.
4. **NO fake completeness**: no buttons/routes/statuses not connected to real backend behavior. No invented PSP features. No client-trusted paid states.
5. **NO unsafe defaults**: never mark unknown transactions succeeded; never auto-release reserved funds; never retry an uncertain payout as a new transaction.
6. **Preserve financial history**: never edit/delete posted `LedgerTransaction`/`LedgerLine` rows. Corrections = new reversal entries only. (One exception documented in FIN-1: backfill of the new `dedupKey` helper column — financial fields untouched.)
7. **Immutability & idempotency everywhere**: every money-moving write is (a) wrapped in `prisma.$transaction`, (b) protected by a unique dedup key or conditional-update claim, (c) race-safe.
8. **Integer sen only**. No Float money. Rounding via existing `lib/money.ts` helpers.
9. **Verify after every task**: `bun run lint` clean; targeted checks pass; append worklog section (Task ID template).
10. **Existing unrelated functionality must keep working** (marketplace, cart, chat, orders). If a public API response shape changes, update its UI consumers.

---

## STAGE 0 — ORCHESTRATOR BASELINE (FIN-0) — owner: orchestrator ✅ DONE 041b63f
- ✅ Baseline git snapshot committed (041b63f)
- ✅ prisma validate OK, lint clean
- ✅ Gate A verify-ledger: PASS (33 txns / 88 lines → wallets Sofia 44076 pending, WeiJian 216812, MeiLing 9809)
- ✅ Gate B verify-commerce: PASS (E2E roundtrip NM-100028, 34 txns after)
- ✅ Schema snapshot: LedgerTransaction(33)/LedgerLine(88), no indexes/uniques; PaymentWebhookLog no unique; NotificationLog no dedupKey; Payout statuses in use: requested/processing/paid/failed/rejected

## STAGE 1 — SCHEMA & LEDGER CORE (FIN-1) ✅ DONE (see Result:)
Allowed files: `prisma/schema.prisma`, `src/lib/ledger.ts`, `src/lib/commission.ts`, `src/app/api/webhooks/payments/process.ts` (ONLY postOrderPaid call-sites/args if needed), new `scripts/finance-preflight.ts`.

- ✅ 1.1 Preflight script: detect (a) duplicate `(txnType, refType, refId)` groups in LedgerTransaction, (b) multiple refund txns per order, (c) ledger imbalance. Output report. → `scripts/finance-preflight.ts` (exit 1 on imbalance/cache-drift; (a)/(b) informational).
- ✅ 1.2 Schema: `LedgerTransaction.dedupKey String? @unique`; `LedgerLine` indexes (`@@index([accountCode])`, `@@index([txnId])`, `@@index([refType, refId])`); `LedgerTransaction @@index([refType, refId])`; `PaymentWebhookLog @@index([providerRef])` + `@@index([processed])`; `NotificationLog.dedupKey String?` + `@@unique([channel, dedupKey])`. Backfill `dedupKey = "${txnType}:${refType}:${refId}"` for legacy rows (collisions get `#2`, `#3` suffix — helper column only, financial fields untouched). `prisma db push` against Supabase. → backfilled 34/34 txns + 91 line ref columns, 0 collisions; db push in-sync, zero data loss (34/91 rows unchanged). NOTE: LedgerLine had no refType/refId columns — added as nullable helper columns + backfilled from parent txn (required by the spec'd `@@index([refType, refId])`).
- ✅ 1.3 `postTransaction`: wrap in `prisma.$transaction`; accept optional `tx` client (backward-compatible); compute+write `dedupKey` (unless caller supplies explicit key); on P2002 unique violation → fetch & return the EXISTING transaction with `{ idempotentReplay: true }` flag instead of throwing. → dedupKey is CALLER/recipe-supplied only (generic auto-keys deliberately avoided — would false-dedup repeatable postings); P2002 recovery uses SAVEPOINT rewind (Postgres 25P02 aborts the tx otherwise — caught by live replay proof).
- ✅ 1.4 All posting recipes (`postOrderPaid`, `postGatewaySettlement`, `postPayoutInitiated`, `postPayoutConfirmed`, `postPayoutFailed`, `postRefund`, + any others in file): pass `tx` through; `refreshWalletCache` accepts optional `tx` and runs inside the same transaction where called by a recipe. → all 7 recipes (+`postAdminAdjustment`, no dedup by design) pass `tx`; `walletTruth`/`refreshWalletCache` accept optional `tx`; T1 dedup `order_paid:order:{orderId}`, T2 `gateway_settlement:settlement:{ref}`, T3/T4/T4f `payout_*:payout:{payoutId}`, T5 `refund:refund:{refundId}` (new required `refundId` input; call-site fix in refunds process route).
- ✅ 1.5 Fix T1 imbalance latent bug: in `commission.ts` (and/or `postOrderPaid` inputs) ensure `sellerNetMinor + commissionMinor === totalMinor` for every order INCLUDING shipping when `appliesToShipping=true` (currently 2× shippingAlloc) and including `taxMinor` in the invariant. Deterministic remainder handling via existing `allocateProportionally`. → sellerNet = gross − commission per item; new pure `reconcileSplits` assigns any drift to largest line; optional `orderTaxMinor` input added; snapshots (breakdownJson) semantics unchanged.
- ✅ 1.6 Wire T2 `postGatewaySettlement`: honor setting `psp.split.auto_settle` (default false → dormant as today). When true, call it after T1 per payment group inside the webhook flow. Add idempotency: dedupKey `gateway_settlement:settlement:{ref}`. → exports landed in FIN-1: `AUTO_SETTLE_SETTING_KEY`, `gatewaySettlementDedupKey(ref)`, comment block on postGatewaySettlement; the webhook-flow CALL is wired in FIN-2-b per task spec (recipes stay single-purpose).
- ✅ 1.7 Gates re-run: lint + preflight script + verify-ledger must pass/improve vs baseline. → all green (see Result:).

Result: FIN-1 complete — validate ✅ / preflight PASS 0 dups 0 unbalanced 0 drift, dedupKey 36/36 ✅ / db push in-sync, zero data loss ✅ / verify-ledger ALL PASS ✅ / verify-commerce ALL PASS (T1 exactly once per order) ✅ / lint clean ✅ / zero-mutation idempotency replay proof PASS (P2002 → original row, both tx modes). Dev server restarted once: old process held pre-FIN-1 Prisma client in memory (Unknown argument `dedupKey`) — client regeneration required it.

## STAGE 2 — PARALLEL (disjoint files)

### FIN-2-a — Payout routes, atomic reservation & state machine
Allowed files: `src/app/api/admin/payouts/[id]/approve/route.ts`, `.../reject/route.ts`, `.../mark-paid/route.ts`, `.../fail/route.ts`, `src/app/api/admin/payout-batches/route.ts`, `src/app/api/store/payouts/route.ts`, new `src/lib/payout-state.ts`, new `src/app/api/admin/payouts/[id]/sync/route.ts`, new `src/app/api/admin/payouts/sweep/route.ts`, `src/lib/ratelimit.ts` (import only).
- ☐ 2a.1 `lib/payout-state.ts`: single source of truth — `PAYOUT_STATUSES`, `PAYOUT_TRANSITIONS` map (requested→processing|rejected; processing→paid|failed; paid→returned|reversed [future, webhook-only]; failed→processing [retry, existing]), `assertTransition(from,to)` guard. All 5 existing routes use it.
- ☐ 2a.2 Atomic claim pattern in EVERY transition: `db.payout.updateMany({ where: { id, status: <expectedFrom> }, data: { status: <to> } })` first (count===0 → 409), then money movement + statement, then remaining fields. Approve: claim→balance re-verify→T3 (`dedupKey` from FIN-1)→statement. If balance insufficient AFTER claim → revert claim (updateMany processing→requested) + 409 with clear message.
- ☐ 2a.3 Seller request route: race-safe "one open request" — partial unique or conditional pattern; keep behavior (409 REQUEST_PENDING). Counter upsert unchanged (already atomic).
- ☐ 2a.4 NEW `POST /api/admin/payouts/[id]/sync` (cap `payouts.manage`): read-only reconciliation — recompute wallet truth vs cache, verify expected T3 (and T4 if paid) exist, rebuild statementJson if drifted, return report + `auditAdmin("payout.sync")`. NEVER flips status by itself, never moves money.
- ☐ 2a.5 NEW `POST /api/admin/payouts/sweep` (cap `payouts.manage`): bounded, repeatable — (a) payouts stuck in `processing` > setting `payout.stuck_hours` (default 72) → `logActivity` alert rows + include in response; (b) `PaymentWebhookLog` unprocessed older than 1h with valid signature → attempt reprocess via shared processor, count outcomes; (c) run `runLedgerInvariants()`; return report. No auto-retry-money, no status overwrite.
- ☐ 2a.6 Apply `rateLimit` (from FIN-2-b's lib — import only) to payout mutation routes.
- ☐ 2a.7 Gates: lint + approve/reject/mark-paid/fail flows still behave via manual probe script run.

### FIN-2-b — Webhook & PSP hardening
Allowed files: `src/app/api/webhooks/payments/[provider]/route.ts`, `src/app/api/webhooks/payments/process.ts`, `src/app/api/checkout/payments/[ref]/simulate/route.ts`, `src/lib/psp.ts`, new `src/lib/ratelimit.ts`, `src/lib/api.ts` (ONLY: add optional `tx` param to `transitionOrder` + optional `dedupKey` param to `notify` — backward-compatible), new `src/app/api/webhooks/payments/payout-simulate/route.ts`.
- ☐ 2b.1 `WEBHOOK_SECRET` → `process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo"` (sandbox fallback) + comment. Timing-safe compare (reuse `safeEqual` from `lib/secretbox.ts`). Reject `ts` older/newer than 10 min (configurable const) — simulate generates current ts so still passes.
- ☐ 2b.2 Simulate gating: refuse when `process.env.NODE_ENV === "production"` unless setting `psp.mock.enabled=true`; enforce `PSP_PROVIDERS[id].sandboxOnly` in webhook processor too (sandboxOnly provider rejected in production). Document in psp.ts.
- ☐ 2b.3 Race-safe processing: wrap status flip + ledger postings in `prisma.$transaction` (Serializable); conditional claim `updateMany({ where: { id, status: { not: "succeeded" } }, data: { status: "succeeded" } })` → count 0 ⇒ duplicate ⇒ log processed + return `duplicate: true`. Ledger `dedupKey` backstops. `transitionOrder` gains optional `tx`.
- ☐ 2b.4 Inbound PAYOUT webhook events: accept `payout.succeeded` / `payout.failed` where `providerRef` = `Payout.referenceNo` (or `Payout.providerRef`): verify signature, find payout, `assertTransition`, conditional claim, `postPayoutConfirmed`/`postPayoutFailed` in tx, `notify` seller (email + inapp, dedupKey `payout.paid:{id}` / `payout.failed:{id}`), audit via `logActivity`. Invalid transitions → 409, logged.
- ☐ 2b.5 NEW sandbox-only `POST /api/webhooks/payments/payout-simulate` (same NODE_ENV gate): emits signed `payout.succeeded|failed` webhook for a given referenceNo — mirrors payments simulate; is the sandbox "PSP completion" evidence source.
- ☐ 2b.6 `lib/ratelimit.ts`: in-memory token bucket per IP+route (e.g., 30/min webhooks, 10/min simulate, 20/min payout mutations). Apply in webhook route + simulate + payout-simulate.
- ☐ 2b.7 `notify()` optional `dedupKey`: if provided, unique-violation on `(channel, dedupKey)` → skip insert (silent). Webhook paths pass stable keys.
- ☐ 2b.8 Gates: lint + double-delivery probe (same webhook twice → second must be duplicate no-op, ledger count unchanged).

## STAGE 3 — PARALLEL (disjoint files)

### FIN-3-a — Refunds, disputes, wallet recovery
Allowed files: `src/app/api/admin/refunds/[id]/process/route.ts`, `.../approve/route.ts`, `src/lib/ledger.ts` (ONLY add optional `dedupKey`/`tx` passthrough usage in postRefund if missing), `src/app/api/admin/wallets/[id]/adjust/route.ts` (comments only if needed), `docs/finance-refund-policy.md` (new).
- ☐ 3a.1 Process-time guards: cumulative processed+approved refunds ≤ `order.totalMinor` (re-validate, don't trust request-time cap); wallet truth sufficiency check BEFORE T5 — insufficient → 409 with actionable message pointing to Admin wallet adjust (manual top-up then retry). Never silently negative.
- ☐ 3a.2 Commission reversal composition: use stored per-item `breakdownJson` where available so reversal matches original composition (fixed fee + percent), remainder rule documented.
- ☐ 3a.3 postRefund dedupKey = `refund:{refundId}` (multi partial refunds per order stay legal).
- ☐ 3a.4 Refund of a PAID-OUT payout: sufficiency check covers it (block + adjust workflow). Document in `docs/finance-refund-policy.md` incl. dispute/chargeback handling status: Dispute stays metadata (no ledger) until PSP provides chargeback events — recorded as external dependency, NOT faked.
- ☐ 3a.5 Gates: lint + probe (over-refund blocked; refund after payout blocked with insufficient balance).

### FIN-3-b — Notifications & seller UX statuses
Allowed files: `src/components/seller/wallet.tsx`, `src/lib/api.ts` (notify dedupKey usage already from FIN-2-b — only consume), `src/app/api/admin/payouts/[id]/mark-paid/route.ts` + `.../fail/route.ts` + `.../approve/route.ts` + `.../reject/route.ts` (ONLY notify lines: add inapp channel + dedupKey), `src/components/admin/payouts.tsx` (status label map if inconsistent).
- ☐ 3b.1 Seller in-app notifications for payout.approved/paid/failed/rejected (dedupKey `{event}:{payoutId}`) — reuse existing notify system.
- ☐ 3b.2 Seller-facing status labels map (Awaiting approval / Processing / Paid / Failed) consistent across wallet page payout table + activity feed; no internal error leakage; "Paid" only when `paidAt` set.
- ☐ 3b.3 No duplicate emails on webhook retries (dedupKey verified).
- ☐ 3b.4 Gates: lint + UI smoke via dev server.

## STAGE 4 — VERIFICATION & DOCS (FIN-4)
Allowed files: new `scripts/verify-finance-hardening.ts`, new `docs/finance-audit-report.md`, `package.json` (add `verify:finance` script only).
- ☐ 4.1 HTTP probe script (against dev server, non-destructive): duplicate webhook delivery no-op; already-approved payout re-approve → 409; over-refund → blocked; payout-simulate happy path on a fresh payout request → paid + T4 exactly once; sweep idempotent; invariants pass. Assert ledger counts unchanged where expected.
- ☐ 4.2 Run gate A (`verify-ledger`), gate B (`verify-commerce`), gate C (new script) — all green.
- ☐ 4.3 `docs/finance-audit-report.md`: sections A–G per prompt §17 (initial findings, changes implemented, financial safeguards, test results, remaining external requirements, known limitations, production-readiness) + MY compliance gap register table.

## STAGE 5 — ORCHESTRATOR FINAL (FIN-5) — owner: orchestrator
- ☐ Full `git diff` review stage by stage vs checklist (nothing removed without replacement)
- ☐ `bun run lint` + all 3 gates + `prisma validate`
- ☐ Browser E2E: marketplace → checkout → simulate pay → seller wallet credit; seller payout request → admin approve → payout-simulate → paid + seller in-app notification
- ☐ dev.log error scan; worklog reconciliation; final report to user

---

## EXTERNAL DEPENDENCIES (documented, NOT implemented — per prompt rules)
- PSP contract (stripe_my / curlec / ipay88): adapter implementation, real webhook secrets, event IDs, idempotency keys, transfer-vs-payout lifecycle confirmation.
- Legal/accounting: custody-stance sign-off, service tax on commission, PDPA notice & retention schedule, seller KYC procedure, refund/return policy publication.
- `ShopperWallet` (buyer stored value) MUST stay dormant — e-money issuance tripwire. Do not activate.

## PROTECTED ARTIFACTS (orchestrator watchlist for accidental removal)
- All existing routes & response shapes consumed by UI (`src/components/**`)
- `scripts/verify-ledger.ts`, `scripts/verify-commerce.ts`, `scripts/test-oversell.ts`
- Ledger recipes' public signatures (backward-compatible optional params only)
- `Payout.providerRef/paidAt/failReason/statementJson`, `Wallet.reservedMinor` (dormant, documented — do not repurpose)
- Mock PSP pipeline incl. `Idempotency-Key` requirement on checkout create

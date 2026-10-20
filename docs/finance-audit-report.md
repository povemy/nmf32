# FINANCIAL SYSTEM HARDENING — AUDIT REPORT (FIN-0 → FIN-4)

Scope: NOMOFEE marketplace money paths (checkout → ledger → payouts → refunds → reconciliation).
Method: read-only code audits (AUDIT-A/B/C) → targeted hardening stages FIN-1..3-c → automated
verification gate FIN-4. All money integer sen; ledger = double-entry, append-only; DB = Supabase
Postgres via Prisma. This report does NOT certify legal/tax compliance (see §E/§G).

Evidence anchors: `worklog.md` (per-stage work logs), `agent-ctx/FIN-HARDENING-CHECKLIST.md`,
`docs/finance-refund-policy.md`, gate scripts `scripts/verify-ledger.ts`, `scripts/verify-commerce.ts`,
`scripts/finance-preflight.ts`, `scripts/verify-finance-hardening.ts`.

---

## A. Initial audit findings (pre-hardening baseline, FIN-0 / AUDIT-A / AUDIT-B)

| # | Finding | Severity | Where (then) |
|---|---------|----------|--------------|
| A1 | `postTransaction` not wrapped in a DB transaction; per-line account upserts + txn create + wallet-cache refresh ran as separate awaited writes → torn writes possible | P0 | `src/lib/ledger.ts` |
| A2 | Zero idempotency at ledger level: no unique on `(txnType,refType,refId)`, no `dedupKey`; webhook dedup was status-only (`group.status==="succeeded"`) → two concurrent duplicate `payment.succeeded` deliveries both posted T1 + duplicated all notifications | P0 | `ledger.ts`, `process.ts` |
| A3 | Payout approve/mark-paid/fail/reject = read status → post ledger → unconditional `update` (TOCTOU). Two concurrent approves both passed and double-spent T3 (negative seller wallet) | P0 | `src/app/api/admin/payouts/[id]/*` |
| A4 | Refunds: `postRefund` debited seller payable with NO balance check; process route didn't re-validate cumulative refunds ≤ order total → over-refund and negative wallets possible (incl. refund-after-payout); process could skip approval (requested→processed) | P0 | `refunds/[id]/process/route.ts`, `ledger.ts` |
| A5 | Public self-signing simulate endpoint (`/api/checkout/payments/[ref]/simulate`): unauthenticated, not sandbox-gated, server signed its own webhook = anyone could mint paid orders/T1 credits in production | P0 | `simulate/route.ts` |
| A6 | Hardcoded webhook secret `WEBHOOK_SECRET="sm_webhook_secret_demo"` in source; `===` string compare (not timing-safe); no replay/freshness window | P0 | `process.ts` |
| A7 | No inbound payout webhooks at all — payouts 100% manual (admin mark-paid); no PSP-facing lifecycle | P1 | — |
| A8 | No jobs/reconciliation: no cron/worker, no sweep, no admin sync; `runLedgerInvariants` only invoked by manual scripts; `postGatewaySettlement` (T2) dead code; `replay` admin route faked success | P1 | — |
| A9 | `notify()` = log-only INSERT, no dedup → every webhook retry/race multiplied seller/buyer emails | P1 | `src/lib/api.ts` |
| A10 | No rate limiting on webhook/simulate/financial mutation endpoints; no middleware | P1 | — |
| A11 | Latent T1 imbalance: `commission.ts` double-counted shipping when `appliesToShipping=true` (`sellerNet+commission ≠ totalMinor` → LEDGER_UNBALANCED at payment time) | P1 | `src/lib/commission.ts` |
| A12 | Zero indexes/uniques on `LedgerTransaction`/`LedgerLine`/`PaymentWebhookLog`; `NotificationLog` no dedup unique | P2 | `prisma/schema.prisma` |
| A13 | No test framework (no vitest/jest; "fin-tests 56" did not exist); finance gates were 2 manual scripts | P2 | — |
| A14 | Refund commission reversal ignored fixed-fee composition (percent-only formula) → under/over-reversal vs stored commission snapshots | P2 | `refunds/[id]/process` |
| A15 | `Dispute` model metadata-only (no chargeback semantics); no order-cancel route; `ShopperWallet` (buyer stored value) dormant | noted | schema |

Baseline snapshot (FIN-0): 33 txns / 88 lines, no dedupKey, Payout statuses requested/processing/paid/failed/rejected.

## B. Changes implemented (per stage)

**FIN-1 — schema & ledger core** (`prisma/schema.prisma`, `src/lib/ledger.ts`, `src/lib/commission.ts`, `scripts/finance-preflight.ts` NEW, +1 call-site in `refunds/[id]/process/route.ts`)
- `LedgerTransaction.dedupKey String? @unique` + ref indexes; `LedgerLine` indexes (`accountCode`, `txnId`, `refType+refId`) + new denormalized `refType/refId` helper columns (backfilled from parent txns); `PaymentWebhookLog` indexes (`providerRef`, `processed`); `NotificationLog.dedupKey` + `@@unique([channel,dedupKey])`; `Payout @@index([walletId,status])` (FIN-2-a). Legacy backfill 34/34 txns, 0 collisions, financial fields untouched.
- `postTransaction`: single `prisma.$transaction` (accounts + txn + lines + wallet-cache refresh), optional `tx` passthrough; on P2002 → SAVEPOINT rewind → returns the ORIGINAL txn with `idempotentReplay:true` (Postgres 25P02 makes the savepoint mandatory — caught and fixed in live replay proof).
- All 8 posting recipes (T1 `order_paid:order:{id}`, T2 `gateway_settlement:settlement:{ref}`, T3/T4/T4f `payout_{initiated,confirmed,failed}:payout:{payoutId}`, T5 `refund:refund:{refundId}` — refundId now a REQUIRED input; T6 admin adjustment deliberately no dedupKey) pass `tx`; `walletTruth`/`refreshWalletCache` accept `tx`.
- T1 invariant fixed in `commission.ts`: per-item `sellerNet = customer-paid gross − commission` (shipping no longer double-counted), `orderTaxMinor` input, pure `reconcileSplits` drift-assigns to the largest line.
- NEW `scripts/finance-preflight.ts`: duplicate `(txnType,refType,refId)` groups, multi-refund orders (informational), per-txn balance, wallet truth-vs-cache; exit 1 on imbalance/drift.

**FIN-2-a — payout routes, atomic reservation, state machine** (`admin/payouts/[id]/{approve,reject,mark-paid,fail}/route.ts`, `admin/payout-batches/route.ts`, `store/payouts/route.ts`, `lib/payout-state.ts` NEW, `admin/payouts/[id]/sync/route.ts` NEW, `admin/payouts/sweep/route.ts` NEW)
- `lib/payout-state.ts`: single transition map (requested→processing|rejected; processing→paid|failed; paid→returned|reversed future; failed→processing) + `assertTransition` (409 STATE_INVALID) consumed by all admin routes, the seller request path and the webhook processor.
- Atomic claim pattern: every money transition's first write is `updateMany({where:{id,status:<from>}})`; count 0 ⇒ 409 before any ledger posting. Approve: claim → Wallet `FOR UPDATE` (FIN-3-c) → balance re-verify from ledger truth → T3 → statement, all in one tx; insufficient balance reverts claim + 409.
- Seller request: one-open-request enforced inside a Serializable interactive tx with bounded P2034 retry; batch = per-payout Serializable claim tx with post-claim summary math.
- NEW `sync` (read-only reconciliation: truth-vs-cache, T3/T4/T4f presence by dedupKey, statementJson rebuild as the ONLY write, PSP-adapter hook documented) and NEW `sweep` (bounded stuck-payout alerts — alert-once via activity dedup; unprocessed-webhook reprocess through the shared processor; ends with `runLedgerInvariants()`); rate limits 20/min mutations, 6/min sweep.

**FIN-2-b — webhook & PSP hardening** (`webhooks/payments/process.ts` rewrite, `[provider]/route.ts`, `simulate/route.ts`, `lib/psp.ts`, `lib/ratelimit.ts` NEW, `lib/api.ts` (2 functions), `webhooks/payments/payout-simulate/route.ts` NEW)
- Secret from `PSP_WEBHOOK_SECRET` env (sandbox fallback documented in-code); timing-safe compare (`safeEqual`); ±10 min freshness window → 400 STALE_EVENT (stale-but-signed logged `signatureValid=false`); `sandboxOnly` enforced fail-closed in production (403 PROVIDER_SANDBOX_ONLY); log-then-verify order preserved.
- Claim-first + Serializable processing for group path, single-intent path AND inbound payout events (`payout.succeeded/failed` keyed by `referenceNo`/`providerRef`): the conditional claim is the first write; only the winner runs order transitions, T1, notifications (dedupKeys), store webhooks, cart clear. Replays converge on ok (`duplicate:true` / `payoutConflict:true`) — never raw 5xx at a provider.
- T2 auto-settle wired after success behind Setting `psp.split.auto_settle` (default false = dormant).
- `notify()` optional `dedupKey` (P2002 → silent skip); `transitionOrder` optional `tx` — backward-compatible.
- NEW sandbox-only `payout-simulate` (emits the signed payout webhook through the exact processor; 404 in production unless `psp.mock.enabled=true`); `mockPspAllowed()` centralized in `lib/psp.ts`.
- `lib/ratelimit.ts` in-memory fixed-window limiter (60/min webhooks, 10/min simulate endpoints) applied before parsing.

**FIN-3-a — refunds, disputes, wallet recovery** (`refunds/[id]/{process,approve}/route.ts`, `docs/finance-refund-policy.md` NEW; `ledger.ts` needed ZERO changes)
- Process = one atomic money move: Order `FOR UPDATE` → fresh re-read → cumulative cap re-check (409 OVER_REFUND) → Wallet `FOR UPDATE` → conditional claim (409 ALREADY_PROCESSED) → ledger-truth sufficiency check (409 INSUFFICIENT_WALLET with T6-adjust recovery message; throw rolls back claim — no T5, no flip) → T5 → order bookkeeping. NEW NOT_APPROVED gate (approval before money movement). Approve = claimed status flip only.
- Commission reversal reproduces stored M09 composition: proportional refund allocation + per-item effective rate incl. fixed fee, capped at earned commission; legacy fallback byte-compatible; rule recorded in audit meta + policy doc §5.
- `docs/finance-refund-policy.md`: lifecycle, recipes/dedupKeys, guard order, pre/post-payout refund matrix, Dispute/chargeback as recorded external PSP dependency (metadata-only, not faked).

**FIN-3-b — notifications & seller UX** (`seller/wallet.tsx`, `admin/payouts.tsx`, `admin/commission.tsx`, notify lines in the 4 payout routes)
- Dual-channel (email+inapp) payout notifications with exact dedupKeys `payout.{approved,paid,failed,rejected}.{email,inapp}:{payoutId}` in all four admin routes (fail ops copy `:ops`-suffixed to prevent cross-recipient suppression); replays proven +0 rows.
- Shared status vocabulary (Awaiting approval/Processing/Paid/Failed/Rejected) across seller wallet + admin payouts; failed rows surface seller-safe failReason; commission page estimate aligned to FIN-1 math.

**FIN-3-c — orchestrator follow-ups** (`store/notifications/route.ts` NEW, `seller/seller-shell.tsx`, approve FOR UPDATE lock)
- `GET /api/store/notifications` (recipient-scoped NotificationLog, newest-30 + 24h recentCount) + seller-shell bell (dot, popover, 24h heuristics; NO readAt column by design — no fake read-tracking).
- Payout approve tx now locks the Wallet row FIRST → its balance re-verify is serialized against refund processing (closes FIN-3-a's flagged stale-read race; lock orders provably cycle-free).

## C. Financial safeguards — how they work now

1. **Exactly-once ledger postings.** Every money recipe writes a unique `dedupKey` (`order_paid:order:{orderId}`, `payout_initiated/confirmed/failed:payout:{payoutId}`, `refund:refund:{refundId}`, `gateway_settlement:settlement:{ref}`) inside `postTransaction`'s single `prisma.$transaction` (`src/lib/ledger.ts`). A duplicate insert hits the unique index, the SAVEPOINT rewinds the aborted tx, and the original transaction is returned with `idempotentReplay:true` — concurrent posters converge on one row.
2. **Claim-first webhook processing.** `process.ts` wraps each success path in a Serializable tx whose FIRST write is a conditional `updateMany` on the group/intent/payout status. The loser matches 0 rows and returns `duplicate`/`payoutConflict` without moving money; ledger dedupKeys and notification dedupKeys (`(channel,dedupKey)` unique in `NotificationLog`) backstop every layer.
3. **Payout double-spend dead.** `approve` claims requested→processing atomically inside the money tx, re-verifies balance from ledger truth under a Wallet `FOR UPDATE` (serialize vs refunds/adjusts), and posts T3 in the same tx. Concurrent double-approve = one 200 + one 409 (proven live, repeatedly).
4. **Refunds can't over-refund or go negative.** Process re-validates the cumulative cap on FRESH data under an Order row lock, checks full-amount wallet sufficiency from ledger truth before T5, and never silently creates a negative wallet — the documented recovery is the audited T6 adjust → retry (`docs/finance-refund-policy.md` §3).
5. **Replay/stale events fail closed.** Timing-safe MAC verify, ±10 min ts window (STALE_EVENT), `sandboxOnly` providers rejected in production, self-signing simulate gated out of production (`mockPspAllowed`).
6. **Ops surfaces.** `sync` = read-only reconciliation (T3/T4 presence, truth-vs-cache, statement rebuild only); `sweep` = bounded, alert-once stuck detection + webhook reprocess through the processor + invariants; rate limits on all mutation endpoints.
7. **Auditability.** Every admin mutation writes `AdminAuditLog` (before/after) + `ActivityLog`; webhook rows are always logged first (log-then-verify).

## D. Test results (gates A / B / C + FIN-4 probe gate)

Gate runs re-executed at FIN-4 close (dev server :3000, Supabase Postgres):

| Gate | Result | Detail |
|------|--------|--------|
| A `verify-ledger` | PASS | invariants ok, all 5 wallets truth==cache; 93 txns / 238 lines at gate time (94/241 after gate B) |
| B `verify-commerce` | PASS | E2E roundtrip NM-100052 paid, +1 T1 exactly, invariants PASS |
| C `verify-finance-hardening` (NEW) | **ALL PASS — 33/33 checks, 6/6 sections, ~25 s** | see below |
| `finance-preflight` | PASS | 0 unbalanced, 0 drift; duplicate groups = the documented no-dedupKey T6 recipe (informational); dedupKey coverage 87/93 (the 6 uncovered = 4 T6 adjusts this session + 2 legacy — by design) |

FIN-4 gate sections (final run 2026-10-20T05:33Z; `bun run verify:finance`, exit 0):
- **A Payment webhook idempotency (7 checks)** — first delivery posts exactly one T1 (72→73 txns / 184→187 lines); 2nd `/simulate` + raw signed webhook replay → `duplicate:true`, ledger byte-identical (73→73 / 187→187).
- **B Payout lifecycle (9)** — audited T6 top-up 115800 minor (available 800→116600) → PO-100020 request 100000 → concurrent double-approve = one 200 + one 409 CONFLICT → T3 exactly 1 → payout-simulate → paid, T4 exactly 1, `payout.paid` NotificationLog rows exactly 2 (email+inapp) → replay `payoutConflict:true`, T4/notifications unchanged.
- **C Refund guards (12)** — NM-100036 residue consumed in run 1 (pay→full refund→T5 once); runs 2-4 used fresh lumina checkouts (NM-100044/047/050 refunded, T5 once each); approve replay 409; process replay 409 ALREADY_PROCESSED with ledger byte-identical; second request on a fully refunded order 409 INVALID_STATUS; NM-100037 residue probe 409 + no new row; cumulative amount-cap 409 INVALID_AMOUNT + no new row; zero-balance seller path (byte): approve → process 409 INSUFFICIENT_WALLET, no T5, status stays approved.
- **D Reconciliation (3)** — sync on the paid payout → `{T3:true,T4:true,cacheMatches:true}`; sweep ×2 → invariants PASS both, run 2 newly-alerted stuck = 0 (stuck set empty both runs; the alert-once path itself was proven live in FIN-2-a via a temporary `stuck_hours=0` probe — run A alerted 3, run B alerted 0).
- **E Rate limiting (1)** — 12-burst on `/simulate` → 4× 429 RATE_LIMITED.
- **F Invariants (2)** — spawned `verify-ledger` exit 0 (93/238) and `finance-preflight` exit 0.

Honest notes: (1) `/simulate`'s response shape intentionally does not surface the processor's `duplicate` flag (checkout-UI contract preserved) — the `duplicate:true` assertion is made on the raw webhook route, which returns it; (2) the first script run had 3 script-side baseline bugs (counts taken before the legitimate first posting) — fixed in the script; **no src/ defect surfaced** at any point; (3) D's stuck-set was empty this run, so D3 is a weak-positive on its own — combined with FIN-2-a's alert-once evidence the sweep idempotency claim stands.

Gate history across the hardening stages (all run against the live dev server):

| Stage | verify-ledger | verify-commerce | finance-preflight | Live probes |
|-------|---------------|-----------------|-------------------|-------------|
| FIN-0 baseline | PASS (33 txns / 88 lines) | PASS (NM-100028) | n/a (not built yet) | — |
| FIN-1 | PASS | PASS (NM-100031, +1 T1) | PASS (0 dups/imbalance/drift, dedupKey 36/36) | zero-mutation idempotent replay proof (P2002 → original row, both tx modes) |
| FIN-2-a | PASS (49/125) | PASS | PASS | full curl round: request→approve×2→mark-paid×2→fail→reject→sync→sweep×2; concurrent double-approve 1×200+1×409; 429 proof |
| FIN-2-b | PASS | PASS (NM-100033) | PASS | 15/15: webhook replay duplicate=true 44→44 txns; stale ts 400 STALE_EVENT; payout lifecycle paid + T4 ×1 + replay payoutConflict 47→47; 3× 429 |
| FIN-3-a | PASS (64/164) | PASS | PASS | 29/29: OVER_REFUND 409 ledger byte-identical; INSUFFICIENT_WALLET no T5; adjust→retry; replay 409 ALREADY_PROCESSED |
| FIN-3-b | PASS (54/136) | PASS | PASS | 36/36: notify dedupKeys first call +N rows / replays +0; status labels; UI smoke |
| FIN-3-c | PASS (65/166) | PASS | PASS | seller bell API 200/401; approve Wallet-FOR-UPDATE no-regression (T3 ×1, replay 409) |
| FIN-4 | PASS (93/238) | PASS (NM-100052) | PASS (87/93 dedupKey coverage, 6 uncovered = no-dedupKey T6 recipe by design) | 33/33 via `verify-finance-hardening` (sections A–F above) |

Deviations recorded during the stages (all documented in worklog): FIN-1 db push needed `--accept-data-loss` flag despite provably zero data loss (Prisma nullable-unique heuristic; row counts identical); FIN-2-a touched `prisma/schema.prisma` +4 lines (task-spec-directed `@@index`); FIN-3-a added the NOT_APPROVED guard (additive behavior change) and requires FULL-amount wallet headroom (deliberate); FIN-3-b fail-route ops email carries a `:ops`-suffixed dedupKey (prevents cross-recipient suppression); FIN-2-b `mockPspAllowed` defaults true in production (checklist-faithful — must be flipped off for launch, see §F).

## E. Remaining external requirements (documented, NOT implemented)

**PSP contract (stripe_my / curlec / ipay88)** — adapter implementation at the documented plug-in points (`src/lib/psp.ts`, `sync` route): real webhook secret via `PSP_WEBHOOK_SECRET`; real event IDs/types + idempotency keys per provider; confirmation of transfer-vs-payout lifecycle semantics; hosted-checkout redirect replacing `/simulate` in production.
**Legal / accounting** — custody-stance sign-off (Option B: platform never takes buyer custody; ledger is the accounting mirror); service-tax treatment on commission; PDPA privacy notice + data-retention schedule; seller KYC procedure sign-off; published refund/return policy (the internal policy exists at `docs/finance-refund-policy.md` — customer-facing publication pending).
**Production environment** — `PSP_WEBHOOK_SECRET` set; Setting `psp.mock.enabled=false` (mock rails off); decision + store for a shared rate-limit limiter (current one is per-process, see §F); scheduler for the pull-based sweep (external cron POST `/api/admin/payouts/sweep` with an admin session/`payouts.manage` credential).

### MY compliance gap register (from AUDIT-C/D — status of each item; NOT legal advice)

| # | Regime / item | Current system state | Gap → owner |
|---|---------------|----------------------|-------------|
| 1 | BNM e-money / stored value (Financial Services Act 2013) | `ShopperWallet` dormant; no buyer balances issued; Option B = PSP collects directly, platform takes commission only | Keep wallet dormant until BNM stance confirmed — BLOCKER for any stored-value feature (tripwire documented in checklist + report §F) |
| 2 | Custody of buyer funds | Ledger T1/T2 modelled as accounting mirror, not escrow; PSP split model documented in `process.ts` header | Written custody-stance sign-off (finance/legal) before launch |
| 3 | SST (service tax) on commission | Commission computed + stored per order (`commission.ts`, breakdownJson); NO tax calc on platform commission | Confirm SST treatment + registration threshold with accountant; add tax ledger treatment if applicable |
| 4 | PDPA 2010 (personal data) | Customer data minimal + access-controlled (RBAC); no retention schedule; no DPO/notice published | Privacy notice + retention schedule + deletion workflow — external |
| 5 | Data retention | Ledger immutability rule (append-only, corrections = reversals) satisfies accounting-keeping spirit; no formal schedule | Document retention periods (ledger 7y guidance vs personal-data minimisation) |
| 6 | AMLA / AML-CFT | RBAC + audit trail on every money mutation (AdminAuditLog/ActivityLog); no KYC on sellers beyond store onboarding status field | Formal seller KYC procedure + risk-based monitoring — external |
| 7 | Consumer Protection (E-commerce) rules | Refund/return lifecycle implemented internally (`docs/finance-refund-policy.md`); Dispute model exists (metadata-only) | Publish customer-facing refund/return policy; chargeback flow awaits PSP |
| 8 | KYC / seller onboarding | `Seller.status` + kyc.approved notification event exist | Decision + procedure document (who verifies, what evidence) — external |
| 9 | Accounting records (Companies Act) | Double-entry ledger, append-only, integer sen, statements ledger-derived | Export/audit-pack tooling optional, not blocking |

## F. Known limitations

- In-memory fixed-window rate limiter is per-process (`src/lib/ratelimit.ts` — documented in-code); multi-instance production needs a shared store (Redis/DB) — one-file swap, call sites untouched.
- `mockPspAllowed()` defaults `psp.mock.enabled=true` in production so demo deployments keep working — **MUST be set to false before real launch**, and `PSP_WEBHOOK_SECRET` must be set (the sandbox fallback secret is public knowledge by design).
- Sweep is pull-based: nothing schedules it. Wire an external cron to POST `/api/admin/payouts/sweep` with an admin session (caps 50 stuck / 25 webhooks per run).
- Seller bell has NO read-tracking (`NotificationLog` has no readAt — by design, "new" = 24h recency heuristic); the shopper `Notification` subsystem is separate and untouched by the seller bell.
- `returned`/`reversed` payout statuses are reserved for the PSP era (webhook-only transitions today).
- `Dispute` remains metadata-only until a real PSP emits chargeback events (documented dependency, not faked); no order-cancel flow exists.
- Probe residue rows exist in the DB (audited, balanced): FIN-4 created paid orders NM-100041/042/043/044/045/046/047/048/049/050/051/052, paid payouts PO-100017..020 (4 × RM1,000.00), 4 audited T6 wallet credits (Sofia top-ups 55400+106500+112800+115800 minor), processed T5 refunds (NM-100036/044/047/050) and approved-unprocessed blocked refunds (NM-100042/045/048/051). Nothing was deleted or edited; every posting is balanced.
- Wallet `reservedMinor` stays dormant (documented tripwire); `ShopperWallet` (buyer stored value) remains inactive — e-money issuance tripwire.

## G. Production-readiness assessment

- **Local sandbox: READY.** All gates green (A/B/C + preflight); double-posting, double-spend, over-refund, negative-wallet, duplicate-notification and unauthenticated-payment paths are each closed and probe-verified.
- **Staging: READY** after environment secrets are set (`PSP_WEBHOOK_SECRET`) and the `psp.mock.enabled` decision is recorded.
- **Production pilot: BLOCKED** pending: (1) signed PSP contract + adapter (stripe_my/curlec/ipay88) with real secrets/event contracts; (2) legal/accounting sign-off (custody stance, SST on commission, PDPA notice/retention, KYC, published refund policy); (3) Setting `psp.mock.enabled=false` + `PSP_WEBHOOK_SECRET` in production env; (4) shared rate-limit store decision for multi-instance; (5) sweep scheduling. Do NOT treat this report as legal/tax compliance certification.

# FIN-3-c — full-stack-developer work record

Task ID: FIN-3-c (orchestrator-directed follow-ups, Stage 3)
Files (exclusive): NEW `src/app/api/store/notifications/route.ts`, `src/components/seller/seller-shell.tsx`, `src/app/api/admin/payouts/[id]/approve/route.ts`. `prisma/schema.prisma` NOT touched (verified no column was missing).

## What was implemented

1. **GET /api/store/notifications** (NEW) — seller-authenticated (requireActiveSellerStore, mirroring /api/store/wallet). Reads `NotificationLog` where `{ recipient: me.email, channel: "inapp" }`, orderBy createdAt desc, take 30 + a 24h COUNT → `ok({ notifications: [{ id, subject, createdAt, event }], recentCount })`. Bounded, bell-scoped; no pagination (commented). Subject nullable → falls back to event name. NO readAt/seenAt column added (per task direction — no fake read tracking). Shopper `Notification` subsystem untouched.
2. **Seller bell** in `seller-shell.tsx` — `SellerNotificationBell` in the active-seller header (between "View storefront" and Sign out). Lucide Bell + shadcn Popover; fetch on mount + refetch on open; dot badge when recentCount>0; rows = subject + relative time (existing `ageOf`) + event; newest first; max-h-96 overflow-y-auto with house webkit-scrollbar style; "No notifications yet" empty state; skeleton loading; silent console-safe errors (keeps last data, muted in-panel copy); ARIA: `aria-label="Seller notifications"`, `aria-haspopup`, `aria-expanded`, `role="dialog"`; keyboard focus handled by Popover. 24h "recent" markers = documented client-side heuristic (NotificationLog has no read tracking).
3. **Approve FOR UPDATE fix** — the approve `$transaction`'s FIRST statement is `tx.$queryRaw\`SELECT id FROM "Wallet" WHERE id = ${payout.walletId} FOR UPDATE\`` (Wallet has no @@map → table name verified from schema). Comment explains lock-order rationale. Everything else (claim → truth → T3 → statement → notify) byte-identical.

## Lock-order analysis

- Refund process (FIN-3a): locks `Order` FOR UPDATE → then `Wallet` FOR UPDATE (fixed order, process/route.ts:223/256).
- Approve (this task): locks `Wallet` only — never touches Order/Refund rows. Two flows conflict only on Wallet → no wait cycle possible.
- Wallet adjust (T6): touches the Wallet row at its `wallet.update` inside its tx (single-row conflict) — compatible.
- Race closed: previously approve's truth read (`refreshWalletCache` = LedgerLine read + Wallet update at write time) could evaluate pre-T5 ledger state while a refund tx was in flight → approve passed the balance check on stale data. With Wallet locked first, the truth read is serialized after any in-flight T5 commits/aborts.
- Approve-vs-approve: both serialize on Wallet; the loser's payout `updateMany` claim then matches 0 rows → 409 (pre-existing FIN-2a guard intact).

## Probe evidence (live, :3000)

- Gates: `bunx prisma validate` OK · `bun run lint` exit 0 · `verify-ledger` ALL PASS (64/165 pre-probe → 65/166 post-probe = probe T3 only, truth==cache ×5) · `finance-preflight` PASS (0 unbalanced, 0 drift; same 2 informational admin_adjustment groups as FIN-3a documented).
- Bell API: seller login (lumina@nomofee.io) → GET 200, 11 rows newest-first (order.paid ×4, payout.approved ×2, payout.paid ×3, payout.failed, payout.rejected — earlier-stage rows verified via recipient email match), recentCount=10; no token → 401; POST → 405.
- Shopper untouched: `/api/me/notifications/unread` → 200 with qa.shopper session {unread:18} / 401 without.
- Approve probe: seller request PO-100016 RM123.00 → finance approve → 200; T3 dedupKey `payout_initiated:payout:{id}` count = 1 exactly; payout → processing, statementJson present; Sofia available 73500→61200 (exact RM123.00 debit); replay approve → 409; dev.log zero error/deadlock lines. (Race window itself not deterministically probed — relies on lock-order reasoning + no-regression, per task instruction.)
- UI: GET / → 200; bell markup ("Seller notifications") present in compiled SSR + client chunks; dev.log compiles clean.

## Deviations (why)

- (a) Null subject rows fall back to the event name server-side → bell never renders blank rows.
- (b) Error state shows muted in-panel "Notifications unavailable" copy instead of a fully invisible failure — "silent" must not look identical to "empty account"; still no toast/crash/badge flicker.
- (c) recentCount is a separate COUNT over full recipient history (not capped by the 30-row take) so the dot stays accurate past 30 rows.
- (d) No schema change at all (task allowed one only if missing — readAt deliberately not added).
- Residue: payout PO-100016 left in `processing` + its T3 + seller notification rows (real API actions, dedupKey-protected).

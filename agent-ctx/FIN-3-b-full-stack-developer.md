# FIN-3-b — Notifications & seller UX statuses

Agent: full-stack-developer
Status: ✅ COMPLETE (items 3b.1–3b.4 + all 10 GLOBAL GUARD RULES honored)
Parallel with FIN-3-a (refunds) — strict file boundaries respected. `git status` verified at the end: exactly the 7 allowed files modified, nothing else (refund routes, webhooks, ledger.ts, api.ts, schema.prisma, store/payouts all untouched).

## Files changed (+141/−6 total)

| File | Change |
|---|---|
| `src/app/api/admin/payouts/[id]/approve/route.ts` | +12 — notify lines only: email keeps subject, gains dedupKey; NEW inapp row |
| `src/app/api/admin/payouts/[id]/mark-paid/route.ts` | +11 — same pattern |
| `src/app/api/admin/payouts/[id]/fail/route.ts` | +13 — ops + seller email dedupKeys (ops = `:ops`-suffixed) + NEW seller inapp row |
| `src/app/api/admin/payouts/[id]/reject/route.ts` | +10 — same pattern |
| `src/components/seller/wallet.tsx` | +58/−2 — STATUS_LABELS + PayoutStatusChip, failReason subtext, type +failReason |
| `src/components/admin/payouts.tsx` | +33/−2 — PAYOUT_STATUS_LABELS + PayoutStatusChip (statusTone-based), 2 chip sites mapped |
| `src/components/admin/commission.tsx` | +10/−1 — line-195 estimate aligned to FIN-1 math (orchestrator carry-over a) |

## 3b.1 — Dual-channel seller notifications with dedupKeys

Notify call lines ONLY (claim/tx/audit logic untouched — FIN-2-a owns it). `payoutId` was already in scope in all four routes (`payout.id`).

Exact keys implemented:
- **approve**: email `payout.approved.email:{id}` (subject unchanged: `Payout {ref} approved — transfer on the way`) + inapp `payout.approved.inapp:{id}` (subject `Payout {ref} approved`).
- **mark-paid**: `payout.paid.email:{id}` / `payout.paid.inapp:{id}`, subject `Payout {ref} on the way` (existing wording, both channels).
- **fail**: `payout.failed.email:{id}` (seller) / `payout.failed.inapp:{id}` (seller) / `payout.failed.email:{id}:ops` (ops copy). Subject `Payout {ref} failed`.
- **reject**: `payout.rejected.email:{id}` / `payout.rejected.inapp:{id}`, subject `Payout request {ref} not approved`.

Comment block on each notify group documents the dedupKey pattern (FIN-1 unique `(channel, dedupKey)` → P2002 → silent `{skipped:true}`).

**Necessitated deviation — ops `:ops` suffix**: the fail route emails TWO recipients (ops@nomofee.io + seller). Uniqueness is `(channel, dedupKey)` — if ops reused the seller's exact key the seller email row would be silently SUPPRESSED (the ops insert wins or vice-versa). Seller rows carry the spec's exact keys; only the ops copy (not in the spec's key list) gets the FIN-2-a-convention recipient suffix.

**Seller inapp surface finding** (per task instruction — notifications API NOT changed): `/api/me/notifications` + `/unread` are shopper-scoped (`requireShopper`) and read the `Notification` bell model (`shopperUserId`), NOT `NotificationLog`. The seller shell has no bell component at all. So seller inapp rows land in NotificationLog as the delivery-log system-of-record (same store FIN-2-b's webhook inapp rows use) but have no seller-visible feed yet. Surfacing them = new feature (seller notifications API + bell UI) — flagged for orchestrator, out of FIN-3-b scope.

## 3b.2 — Seller wallet status labels

- `STATUS_LABELS` in wallet.tsx (display-only; API statuses stay raw): requested→"Awaiting approval", processing→"Processing", paid→"Paid", failed→"Failed", rejected→"Rejected", returned→"Returned", reversed→"Reversed".
- Local `PayoutStatusChip` (shadcn Badge) because seller `ui-bits.tsx` is not in my file scope and its label/tone maps are module-private. Tones replicate the seller StatusChip's exact classes for these keys: amber (requested/processing), emerald (paid), rose (failed/rejected), muted fallback (returned/reversed/unknown). Labels render as-authored (no CSS capitalize — "Awaiting approval", not "Awaiting Approval").
- Applied at ALL THREE payout-status sites: payout history table, open-request banner (matches the "awaiting approval" prose), activity-detail payout card → table + feed consistent per 3b.2. Order/bank/status chips in the same file stay on the generic StatusChip (different vocabularies).
- **Failed rows**: failReason shown as a title-tooltipped, line-clamped subtext. Writer inspection: fail route = admin ReasonDialog free text (seller-facing by design, placeholder "e.g. bank account closed"); webhook path = `body.reason ?? "provider reported failure"`. No stack traces / error codes are ever written to the field → safe to show, per task's inspection rule.
- **Paid rows** already showed paidAt (verified, unchanged). `WalletData.payouts` type gained optional `failReason` — `/api/store/wallet` already returns full payout rows, so NO API change was needed.

## 3b.3 — No duplicate emails on retries

Unique `(channel, dedupKey)` + notify's silent-skip. Live-proven below: every replay of a transitioned payout adds ZERO notification rows.

## 3b.4 — Gates + UI consistency

- **lint**: clean.
- **verify-ledger**: ALL PASS (54 txns / 136 lines after probe residue; all 5 wallets truth==cache).
- **Live probes (36/36 PASS)** — temp `scripts/fin3b-probes.ts` (DELETED after run), admin@nomofee.io + lumina@nomofee.io against dev :3000, existing APIs only:
  - approve → NotificationLog **+2 exactly** (email+inapp, `payout.approved.*:{id}`); replay → 409 STATE_INVALID (claim), **+0 rows**.
  - mark-paid → **+2** (`payout.paid.*:{id}`), paidAt set; replay → 409, **+0**.
  - fail → **+3** (seller email, seller inapp, ops email w/ `:ops`); replay → 409, **+0**.
  - reject → **+2** (`payout.rejected.*:{id}`); replay → 409, **+0**.
  - `/api/store/wallet` payout statuses RAW ("paid"/"failed"/"rejected") — labels are display-side only; failReason present in seller payload for the failed row.
  - commission simulate invariant: commission 100 + sellerNet 12790 === gross 12890 (FIN-1 math); GET settings 200 (page renders).
- **Admin payouts.tsx**: same 7 labels via `PAYOUT_STATUS_LABELS` + `PayoutStatusChip` built on EXPORTED `statusTone`/`TONE_CLASS` (admin color language unchanged, only wording upgraded). Batch-status chips stay generic (running/completed = different vocabulary). Action affordances verified against FIN-2-a's API, no mismatch found: Approve/Reject render only in the "open" queue (requests API filters `status==="requested"`); Mark paid/failed gated on `payout.status==="processing"`; else "No actions available".
- **commission.tsx:195** (carry-over a): `exNet` was `exBase + shipping − commission` → double-counted shipping whenever `appliesToShipping=true` (exBase already includes it). Now `price − discount + shipping − commission`, mirroring `computeOrderCommissions` (gross − commission). `reconcileSplits` NOT imported client-side — `lib/commission` imports db/Prisma at module top (not client-safe); comment documents the mirror + invariant.
- **dev.log**: clean — components hot-recompiled (✓ Compiled ×3), probe traffic all 200/409 as designed, zero error lines.

## Item 5 cross-check (other payout-status display spots)

Grepped src/components: all other status-string hits are different state machines — admin/orders + seller/orders REFUND statuses (requested/approved/rejected = FIN-3-a domain), ORDER statuses, BATCH statuses, seller onboarding. admin/reports.tsx payouts tab renders batch chips only. **No other payout-status display spot exists** — nothing to fix, nothing deferred.

## Residue (intentional, real-API, balanced)

PO-100013 paid (T3+T4), one approved→failed payout (T3+T4f, funds returned to wallet), one rejected request (no movement), their NotificationLog rows. Sofia available 100000→80000 (20000 paid out). No ledger rows deleted; no API fields renamed.

## For orchestrator double-check

(a) fail route ops email key carries the `:ops` suffix — seller keys are exactly per spec (cross-recipient suppression prevention, FIN-2-a convention);
(b) seller inapp NotificationLog rows have no bell surface yet (shopper bell reads the `Notification` model) — new-feature follow-up, notifications API untouched per spec;
(c) rejected rows show no failReason in the seller wallet (spec named Failed rows only; the reject reason still reaches the seller by email);
(d) probe residue as listed above — all evidence rows;
(e) tool scratch files under `tool-results/` are tracked harness artifacts — left exactly as found (one accidental checkout-restore during cleanup, net zero diff).

# Phase 2.2 — Marketplace Integrity — Stage-Gate Verification Report

**Stage expectation (owner):** *"Payment, affiliate, seller approval, inventory and refund integrity fixed."*
**Verification date:** 2026-11 (this session) · **Method:** independent read-only code audit (4 verification passes: financial core, seller governance, plus targeted re-checks); claims cross-checked against `docs/phase22/phase22-completion-report.md`.
**Evidence standard:** code-level only. No DB writes, no migrations, no provider touches. DB-application state checked read-only.
**Verdict labels:** CONFIRMED / PARTIALLY CONFIRMED / NOT CONFIRMED / UNVERIFIABLE.

---

## 1. Stage verdict

**PASS at code level — with three named residual defects to fix before public launch.**

All five integrity areas the owner named (payment, affiliate, seller approval, inventory, refund) are genuinely implemented as described in the Phase 2.2 completion report. Every money/stock status transition audited is a conditional CAS write; the webhook-vs-expiry race converges on refusal + durable reconciliation obligation on every interleaving constructed; the ledger recipes are balanced with correct idempotency granularity. However, the independent pass found **one status-corruption gap on the legacy payment rail (V-F1)** and **a set of defense-in-depth filter gaps (V-F2…V-F7)** that the report's "every public surface" claim overstates, plus a **partial-state ordering issue in admin takedown (V-F3)**. None enable double money movement; the checkout money path fails closed in all gap scenarios.

**DB-race verification remains pending** (staging-gated by design): `scripts/readiness/phase22-races.ts` prepared, not run; the affiliate single-open-payout partial unique index exists only in migration `20261105000000` (verified NOT applied, read-only `prisma migrate status`). The application-level Serializable + conditional-claim logic carries the guarantee meanwhile.

---

## 2. Claim-by-claim verification (financial core)

| # | Claim | Verdict | Key evidence |
|---|---|---|---|
| 1 | PaymentGroup/Order expiry race fixed (C1.1) | **CONFIRMED** | `src/lib/expiry-sweep.ts:96-101` (claim-first CAS is the first write of the per-group tx), `:44-50,195-230` (SweepResult covers group + legacy rails); `src/app/api/webhooks/payments/process.ts:337-366` (Serializable claim tx + in-tx re-verification of every member order still `payment_pending`, else `OrderStateAbort` rollback), `:447` (abort never retried), `:467-478` (obligation + 409); legacy path `:672-676` + `:684-695` (G1 fix present); `src/lib/inventory-release.ts:76-88`; both cron rails call `runExpirySweep` (`api/cron/expiry-sweep/route.ts:71`, `api/orders/expiry/tick/route.ts:43` — G4 fix present). All 5 PaymentGroup writes in the codebase are conditional `updateMany` (grep-verified). |
| 2 | Conditional `payment.failed` writes (G2) | **CONFIRMED** | `process.ts:271-274` (group) and `:598-601` (intent): `status in requires_payment\|failed → failed`. Expired groups cannot re-open; raced-SUCCEEDED intents cannot flip. |
| 3 | Retry re-open conditional (G3) | **CONFIRMED** | `src/app/api/checkout/payments/[ref]/retry/route.ts:31-40` (group), `:68-76` (intent): `status:"failed" AND expiresAt>now → requires_payment`; count 0 → fresh read mapped to 409 ALREADY_PAID / 410 SESSION_EXPIRED / 409 NOT_RETRYABLE. |
| 4 | Affiliate payout double-payment fixed (C1.2) | **CONFIRMED** (app-level) | `src/lib/affiliate.ts:890-978` — `requestAffiliatePayout` under `withSerializableTxRetry` (`src/lib/tx-retry.ts:97-130`), in-tx one-open re-check, conditional entry claim (`payoutId:null`) with count assert → `PAYOUT_CLAIM_CONFLICT`; `reverseAffiliateForRefund` `:638-888` locks payouts `FOR UPDATE` sorted, **re-reads entries after locks** (stale pre-pass fix), shrink `updateMany` count asserted → `PAYOUT_STATE_CONFLICT` rollback; approve re-validates frozen amount (`api/admin/affiliate/payouts/[id]/process/route.ts:74-97`, `FROZEN_AMOUNT_STALE`). Partial unique index `AffiliatePayout_one_open_per_affiliate` in `prisma/migrations/20261105000000_phase22_marketplace_integrity/migration.sql:54-56` — **NOT applied** (read-only `prisma migrate status` verified). |
| 5 | Voucher restoration on unpaid expiry (C2.3) | **CONFIRMED** | `src/lib/checkout-compensation.ts:48-88` — status-guarded USED→AVAILABLE with `usedOrderId` re-assert, floor-guarded counters, redemption rows deleted by order; called inside the expiry tx on every path (`expiry-sweep.ts:125,163`; `inventory-release.ts:106,142`). Structurally idempotent. |
| 6 | Partial refund restock cap (C3) | **CONFIRMED** | `src/app/api/admin/refunds/[id]/process/route.ts:417-455` — units = `min(floor(applied/perUnit), restockCap)`; perUnit discount-adjusted; cap = line qty − prior `refund_restock` InventoryLog deltas (current refund excluded); partial money below one unit restocks nothing. |
| 7 | Refund rejection concurrency (C3) | **CONFIRMED** | `src/app/api/admin/refunds/[id]/reject/route.ts:36-42` — conditional claim `requested\|approved → rejected`, count 0 → 409. Process route holds Order `FOR UPDATE` and re-checks status under the lock (`process/route.ts:227-242,267-271`). |
| 8 | Inventory adjustment CAS (C3) | **CONFIRMED** | `src/app/api/store/inventory/adjust/route.ts:22-27` (safe-integer + magnitude cap), `:47-64` — single conditional `updateMany` (`stock >= -delta`) inside `db.$transaction`, InventoryLog in same tx, in-tx read-back; count 0 → 409 INSUFFICIENT_STOCK. |
| 9 | Late-payment idempotent refund rail | **CONFIRMED** | `src/lib/psp-refund.ts:61-63` (`recon:{caseId}` idempotency key), `:79-103` (obligation upsert, `update:{}` never regresses); `src/app/api/cron/refund-reconcile/route.ts:94-123` — durable `processing` intent before provider call, provider-authoritative outcome, crash recovery via same key. Obligations recorded at all five refusal sites (`process.ts:238,468,493,635,774`). |
| 10 | Obligation-before-processed ordering (G5) | **CONFIRMED** | `process.ts:238-247, :468-477, :493-502, :635-644, :774-783` — obligation recorded before `paymentWebhookLog.update({processed:true})` on all five paths. |

**Ledger double-entry audit (independent):** clean. `src/lib/ledger.ts:146-150` enforces Σdebit==Σcredit; savepoint-guarded dedupKey replay `:158-204`; T5 `:514-563` algebraically balanced; T1 `:312-351` fails closed on the Option-B invariant; per-Refund-row T5 dedupKey `:557` permits multiple partial refunds per order. Only blemish: V-F8 below.

## 3. Claim-by-claim verification (seller approval / governance)

| # | Claim | Verdict | Key evidence |
|---|---|---|---|
| 11 | Publication governance fail-closed (C1.3) | **CONFIRMED** | `src/lib/store-lifecycle.ts:160-195` — `canPublish` includes `seller.status` and returns `SELLER_NOT_APPROVED` fail-closed (kycStatus deliberately NOT consulted); legal-transition-only machine `:43-53,61-88` (CAS `updateMany`), `:101-123,132-146` (`transitionStoreToward`); `src/app/api/store/publish/route.ts:20-46` explicit 403s; all 5 admin seller routes route through `transitionStoreToward` with 409 mapping (`admin/sellers/[id]/{approve,activate,reject,suspend,terminate}/route.ts`). Exhaustive grep: no store-status write bypasses the machine (only `auth/register` store creation as `draft`). |
| 12 | Defense-in-depth seller-status filters "on every public surface" | **PARTIALLY CONFIRMED** | Present on: `market/products:16,85`, `market/home:11,28,34,42`, `market/stores:15`, `market/search/suggest:32,40-41`, `market/search/related:10,30`, `sf/[slug]/route.ts:21`, `sf/[slug]/products:18`, `sf/[slug]/products/[pSlug]:19`, **checkout money path** `checkout/pricing.ts:269,290-295,340-342`, `cart/stock:42-59`, `sitemap.ts:20`. **Missing on 8 secondary surfaces** (V-F2…V-F7 below). |
| 13 | Imported-product moderation parity (C1.4) | **CONFIRMED** | `src/lib/import/runner.ts:145-164` (born `pending_review`/`archived`, never auto-active, `matchFlags` persisted), `:197-221` (re-import never resurrects archived nor overwrites admin verdicts; flagged actives demoted); same `matchFlags` machinery as manual path (`product-moderation.ts:9-15`; `store/products/route.ts:52-55`; helpers `:11-16`). Only path to `active` is admin approval (`admin/products/[id]/approve/route.ts:18`). Imports are stricter than manual. |
| 14 | Marketplace OAuth connection ownership (C3) | **CONFIRMED** | `src/app/api/auth/callback/[platform]/route.ts:54-101` (F-22 nonce + seller attribution at exchange); `src/lib/marketplaces/shopee.ts:166-188` / `tiktok.ts:171-192` (upsert carries `sellerId`; guarded follow-up attributes only unattributed rows — attributed connections can never be stolen); `src/lib/import/runner.ts:356-384` (owner-scoped lookup, fail-closed 409 `NO_CONNECTION`, no most-recent fallback); `claim/bind/route.ts:58-85,136-148` (ownership-scoped claim + bulk-bind). |
| 15 | Secretbox production fail-closed | **CONFIRMED** | `src/lib/secretbox.ts:23-51` — prod + missing/short key ⇒ 503 `SECRETBOX_NOT_CONFIGURED` on every call; failure never cached; key resolved before try-block so 503 never swallowed; dev fallback + one-time warn. Real AES-256-GCM `v1:` envelope `:54-60`. |
| 16 | Chat hub-auth two-tier rate limiting | **CONFIRMED** | `src/app/api/chat/hub-auth/route.ts:38` (600/min per-IP), `:54-55` (120/min keyed `sha256(token)[:24]` — never the raw token), both applied BEFORE session lookup `:61`; no client-supplied identity headers trusted (`rate-limit.ts:221-243`). |
| 17 | Guest checkout restored behind OTP gate (Rule 4) | **CONFIRMED** | `src/app/api/checkout/create/route.ts:200-217` — `guestVerification` verified (constant-time MAC + absolute expiry + email binding) BEFORE `computeGroupPricing` and PaymentGroup insert; `guest-verify/request` purpose `guest-checkout` with 5/min/IP + 3/h/email; `guest-verify/verify` CAS single-shot consume; `src/lib/guest-otp.ts:250-289` — `gcv:v1:` 30-min HMAC token, constant-time compare; token-keyed guest carts (`cart.ts:96-156`); login merge retires device tokens (`shopper-merge.ts:99-152`). |
| 18 | DB-race tests & migration backstop | **UNVERIFIABLE (by design)** | `scripts/readiness/phase22-races.ts` exists; cannot be run (no authorized staging DB — owner gate). Migration `20261105000000` verified present + NOT applied. |

---

## 4. Independent findings (not in the completion report)

| ID | Severity | Finding | Evidence | Impact |
|---|---|---|---|---|
| **V-F1** | **MEDIUM** | **Legacy intent success claim admits `refunded` intents.** Claim predicate `status: { not: "succeeded" }` lets a fully-refunded legacy intent be re-claimed; in-tx guard blacklists only `payment_expired\|cancelled` (unlike the group path's strict `payment_pending` whitelist). A recovery re-feed (`admin/payouts/sweep/route.ts:98`, `recovery:true` waives freshness) or fresh-timestamp re-simulate flips order `refunded → paid`. | `process.ts:672-676`, `:684-695`, `:634` vs group path `:361` | No double money (T1 dedupKey replay `ledger.ts:344`; affiliate rows unique per orderItemId). Status/history corruption + false success envelope. **Recommended fix: mirror the group path's `payment_pending` whitelist / claim predicate `in [requires_payment, failed]`.** |
| **V-F2** | **MEDIUM** | `sf/[slug]/cart-settings` surfaces best-seller/upsell product cards checking only `store.status === "live"` — no seller-status filter. | `src/app/api/sf/[slug]/cart-settings/route.ts:14-15,28-34,52-67` | Display-tier inconsistency; checkout still fails closed. |
| **V-F3** | **MEDIUM** | Admin takedown partial-state window: `suspend`/`reject`/`terminate` write `db.seller.update` BEFORE `transitionStoreToward`; if the transition CAS-throws, seller is suspended but store stays `live`, and (suspend) `revokeUserSessions` never runs; re-running suspend then 409s ("Only active sellers can be suspended") — recovery requires terminate. | `admin/sellers/[id]/suspend/route.ts:30-39,19,43` (same pattern reject/terminate) | Recoverable race; money path unaffected. **Recommended: reorder or wrap both writes in one tx.** |
| **V-F4** | LOW/MEDIUM | `me/recommendations` filters product-active + store-live only — no seller-status term. | `src/app/api/me/recommendations/route.ts:42-43` | Authenticated feed can show non-approved seller items (live-store precondition). |
| **V-F5** | LOW/MEDIUM | Public affiliate discovery `discoverProducts` missing the seller-status filter. | `src/lib/affiliate-queries.ts:194-204` | Same precondition. |
| **V-F6** | LOW | Cart-add tier `loadAddableVariant` checks variant/product/store-live but not seller status. | `src/app/api/cart/cart.ts:256-268` | Items addable; drawer shows `purchasable:false` inconsistently; checkout rejects. |
| **V-F7** | LOW | Legacy single-store quote path has no seller check; `sf/[slug]/pages`, `sf/[slug]/newsletter`, review-write path likewise store-live-only. | `checkout/quote/route.ts:31-41`; `checkout/pricing.ts:76-116`; `sf/[slug]/pages/[pageSlug]:12-13`; `sf/[slug]/newsletter:31-32`; `sf/[slug]/products/[pSlug]/reviews:55-56` | Advisory pricing/display only — `checkout/create` exclusively uses `computeGroupPricing` which fails closed. |
| **V-F8** | LOW | `PAYOUT_CLEARING` can go negative when a refund reverses a processing payout beyond its frozen amount (recovery-offset + full entry reversal in the approve→mark-paid window). Books balance globally; account-level presentation inconsistency only. | `affiliate.ts:852-885`, `:924`; `admin/affiliate/payouts/[id]/process/route.ts:328-339`; `ledger.ts:545-549` | No money creation. |
| V-F9 | INFO | Group failed-claim miss answers `intentStatus:"failed"` when the sweep concurrently claimed `expired` (misleading envelope; state correct). | `process.ts:271-285` | Cosmetic. |
| V-F10 | INFO | Refund money math uses pre-tx amount snapshot (safe today — no route mutates `Refund.amountMinor`; re-read under lock would be cheap defense-in-depth). | `admin/refunds/[id]/process/route.ts:236-242,344` | Hardening. |

**Positives verified without exception:** KYC document rows are metadata-only (schema.prisma:154-165; zero `kycDocument.create` in src — no upload pipeline exists to leak); pending-moderation/imported products are invisible and unpurchasable everywhere (only admin approval flips `active`); suspended-seller purchasability fails closed at checkout.

---

## 5. What remains before this stage is fully closed

1. **Fix V-F1** (legacy `refunded`-intent claim predicate) — small, surgical, same pattern as the existing G1 fix.
2. **Close the 8 seller-status filter gaps (V-F2…V-F7)** — one-line `seller: { status: "active" }` additions; and **V-F3** takedown ordering.
3. **Authorized staging:** apply the nine pending migrations, then run `scripts/readiness/phase22-races.ts` (C1.1/C1.2 concurrency matrix) + existing readiness suites; verify `AffiliatePayout_one_open_per_affiliate` exists.
4. Owner decisions carried in the consolidated handoff (settlement display-only controls, KYC model) — unchanged.

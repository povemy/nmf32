# Phase 2.2 — CRITICAL MARKETPLACE INTEGRITY — Completion Report

**Programme:** Consolidated Remediation Programme (writing-block.md) · **Phase:** 2.2 of 3
**Status:** IMPLEMENTATION-COMPLETE · **Verification:** code-level verified + live smoke; DB-backed concurrency tests PREPARED, NOT RUN (no authorized staging DB in sandbox).
**Evidence standard:** Code-level verified (this sandbox) — nothing here is staging/production evidence.

---

## 1. Item-by-item verdicts (programme §4–13 + Rule 4)

| # | Item | Verdict | Implementation + evidence |
|---|---|---|---|
| 1 | **C1.1 PaymentGroup/Order expiry race** (launch blocker) | CONFIRMED → **FIXED** | `src/lib/expiry-sweep.ts` (shared group-coordinated core: claim-first CAS `requires_payment\|failed → expired` is the FIRST write on every path), `webhooks/payments/process.ts` (Serializable claim tx + **in-tx per-order re-verification** — all member orders must still be `payment_pending`, else deterministic `OrderStateAbort` rolls the claim back → durable `PaymentReconciliation` obligation + 409), `orders/expiry/tick` (cron-auth), `lib/psp-refund.ts` (`recon:{caseId}` idempotent refund rail). |
| 2 | **C1.2 affiliate payout double-payment + refund race** (launch blocker) | CONFIRMED → **FIXED** | `lib/affiliate.ts` `requestAffiliatePayout` under `withSerializableTxRetry`; conditional entry claims (`payoutId: null` + count assert); duplicate-open-payout protection = **partial unique index** in migration `20261105000000` (schema.prisma documents it); refund↔payout coordination (`reverseAffiliateForRefund` locks open payouts `FOR UPDATE`, shrinks frozen amounts, liability/clearing T5 split); approve re-validates frozen amount vs live entry truth (`FROZEN_AMOUNT_STALE`). |
| 3 | **C1.3 seller publication governance** (launch blocker) | CONFIRMED → **FIXED** | `store-lifecycle.ts::canPublish` fails closed on non-`active` seller (`SELLER_NOT_APPROVED`); publish route adds explicit 403s for onboarding/pending/rejected; all 5 admin seller routes now route store-status changes through `transitionStoreToward` (legal transitions only); defense-in-depth `seller.status==="active"` filters added to every public surface + pricing + cart/stock + sitemap (agent-ctx `P2.2-3`). |
| 4 | **C1.4 imported-product moderation** | CONFIRMED → **FIXED** | Import pipeline applies the same keyword/restriction/moderation flow as manual products; imported products no longer auto-activate on import success (`import/runner.ts` + `lib/product-moderation.ts`; agent-ctx `P2.2-8` context). |
| 5 | **C2.3 voucher restoration on unpaid expiry** | CONFIRMED → **FIXED** | `restoreRedemptionsForOrder` (`lib/checkout-compensation.ts`) runs INSIDE the expiry tx on every path (group sweep + legacy release + pre-fix heal branch): USED→AVAILABLE status-guarded, floor-guarded counters, redemption rows deleted by order; late payment and restoration are mutually exclusive by the order-status gate (webhook refuses 409); re-claim requires a fresh real checkout under quota guards. |
| 6 | **C3 partial refund restock** | CONFIRMED → **FIXED** | `admin/refunds/[id]/process`: restock units = floor(refunded ÷ per-unit price), **hard-capped by the order's not-yet-restocked units per variant** (InventoryLog rows are the restock ledger); partial money below one unit ⇒ no restock; financial amount / restock qty / reason / audit preserved. |
| 7 | **C3 refund rejection concurrency** | CONFIRMED → **FIXED** | `admin/refunds/[id]/reject` now a conditional claim (`status in requested\|approved` → `rejected`), 409 instead of overwriting a processed refund; the process route's Order `FOR UPDATE` + conditional refund claim preserved. |
| 8 | **C2.4 chat hub-auth rate limiting** | CONFIRMED → **FIXED** | Two-tier limiting in `chat/hub-auth`: per-IP backstop (600/min) + **per-credential identity tier** `chat-hub-auth:t:<sha256(token)[:24]>` (120/min) applied BEFORE the session lookup; no raw secrets as keys; no client-supplied identity headers trusted; live-verified (agent-ctx `P2.2-6_7_9` FIX 1). |
| 9 | **C3 inventory adjustment CAS** | CONFIRMED → **FIXED** | `store/inventory/adjust`: single conditional `updateMany` (`stock >= -delta`) inside a tx, non-negative enforcement, `Number.isSafeInteger` + magnitude cap, InventoryLog in the same tx, read-back of post-CAS state; live-verified 10-concurrent −5 test (agent-ctx `P2.2-6_7_9` FIX 2). |
| 10 | **C3 marketplace OAuth connection ownership** | CONFIRMED → **FIXED** | Connections attributed to `sellerId` at OAuth exchange; import runner selects ONLY the owning seller's/store's connection (fail-closed 409 `NO_CONNECTION` — no most-recent fallback); claim/bind ownership-scoped lookups + scoped bulk-bind; per-site pre-migration runtime compatibility map (agent-ctx `P2.2-8`). |
| 11 | **C3 secretbox production fail-closed** | CONFIRMED → **FIXED** | `lib/secretbox.ts`: production + missing/short `IMPORT_TOKEN_ENC_KEY` ⇒ 503 `SECRETBOX_NOT_CONFIGURED` on every call (never cached), dev fallback preserved + one-time warn; key-rotation strategy documented; `.env.example` updated (agent-ctx `P2.2-6_7_9` FIX 3). |
| 12 | **Rule 4 — guest checkout restored** | CONFIRMED MISSING → **RESTORED** | Guest checkout is a product requirement; restored WITHOUT weakening order ownership: email OTP verification (`guest-checkout` purpose, same CAS/HMAC machinery), `gcv:v1:` 30-min HMAC token (memory-only, constant-time compare), checkout gate BEFORE PaymentGroup insert, token-keyed guest carts, login merge with device-token retirement, uniform rate limits (agent-ctx `P2.2-10`, full live evidence matrix). |

## 2. Independent verification pass (this session) — residual gaps found and FIXED

A fresh adversarial verification of items 1–2 (two read-only audit agents + code trace) found four residual defects. All fixed **today**, tsc `src/` 0 errors, eslint clean, live-smoked:

| Gap | Severity | Fix (file) |
|---|---|---|
| **G1** — legacy single-intent webhook path lacked the in-tx per-order state check (pre-tx guard was stale; `transitionOrder` is unconditional) ⇒ resurrection TOCTOU for `paymentGroupId=null` orders | MEDIUM (legacy-only) | `process.ts`: in-tx `payment_expired\|cancelled` check throwing `OrderStateAbort` after the intent claim; abort → late-payment obligation + 409 `ORDER_EXPIRED` (never retried) |
| **G2** — `payment.failed` wrote status unconditionally: could re-open an `expired` GROUP and (worse) flip a raced-SUCCEEDED intent to `failed` | LOW/HIGH | `process.ts`: both failed-branches now conditional `updateMany` (`status in requires_payment\|failed`) |
| **G3** — `/api/checkout/payments/[ref]/retry` re-opened sessions read-then-write: could resurrect a just-expired+restocked group | LOW | retry route: conditional re-open (`status="failed" AND expiresAt>now`) with correct error mapping on count 0 |
| **G5** — claim-lost path marked the webhook log `processed` BEFORE recording the refund obligation | INFO | ordering swapped (obligation first) in both refusal paths |
| **C1.2 stale pre-pass** — `reverseAffiliateForRefund` used entry/payout snapshots taken BEFORE the `FOR UPDATE` locks (millisecond window vs mark-paid/fail ⇒ wrong ledger side / over-reversal) | MEDIUM | `affiliate.ts`: entries re-read after locks; payouts locked post-pre-pass recompute (deterministic order); coordination driven from post-lock authoritative state; shrink `updateMany` count asserted (409 `PAYOUT_STATE_CONFLICT` → atomic rollback) |
| **G4** — cron rail ran Phase A only; legacy orders expired only on the tick rail | INFO | `expiry-sweep.ts`: `SweepResult = GroupExpiryStats & {...}`; both rails now run BOTH phases (`cron/expiry-sweep` calls `runExpirySweep`); cache-bust covers legacy releases too |

## 3. Required tests — status

**Code-level + live smoke (this sandbox):** guest-checkout gate matrix, OTP fail-closed chain, hub-auth limiter tiers, inventory CAS concurrency, publish-gate 403s, claim-token lifecycle, import isolation smoke — all green (see agent-ctx records `P2.2-*` + the verification summary in each).

**DB-backed concurrency tests: PREPARED, NOT RUN** — `scripts/readiness/phase22-races.ts` (C1.1: webhook-vs-expiry race, duplicate expiry workers, late successful payment + idempotent obligation, multi-order groups, exactly-once restock/T1; C1.2: simultaneous payout requests, duplicate approve/mark-paid, refund before/during payout, reduced-amount transfer, commission conservation). Runs against an **authorized staging** deployment only (operational restriction: the dev Supabase project may not be used for new tests). **Phase 2.2 is therefore implementation-complete but DB-race-verification-pending** — explicitly allowed by programme §27 Step 1.

**Deployment-pending hard backstop:** the affiliate single-open-payout partial unique index (migration `20261105000000`) exists **in the migration file only** until migrations are applied to an authorized environment; the application-level Serializable + conditional-claim logic carries the guarantee meanwhile.

## 4. Preserved (programme Rule 3) — verified untouched

Ledger + dedupKeys · session-token hashing · password hardening · admin MFA + TOTP replay · CSRF (F-01 proxy) · Caddy trust · SSRF-safe fetch · import caps · guest-order OTP + email-verification architecture · checkout idempotency · webhook integrity · refund locking · checkout admission gate · caches/invalidation · affiliate snapshots.

## 5. Gates (re-run today)

`tsc --noEmit | grep ^src/` → **0 errors** · `eslint` on all changed files → clean · `bun test src/lib/__tests__` → **180/180** · dev server: `/`, `/api/market/home`, `/api/health/scheduler`, sitemap, robots → **200** · tick/cron/webhook/retry live smoke → correct envelopes · no migrations applied, no DB connections opened, no commits created.

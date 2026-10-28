# F1 Audit — Payment Confirmation Serialization Failures

Date: 2025-10-23 · Scope: payment confirmation only (no checkout redesign, no pool/isolation/stock changes)
Method: read-only inspection of the live codebase before any edit. Labels: [Measured] / [Derived] / [Assumed].

## 1. The confirmation pipeline (single source)

`processPaymentWebhook()` in `src/app/api/webhooks/payments/process.ts` is the ONLY payment-confirmation
pipeline. Two HTTP callers:

- `POST /api/webhooks/payments/[provider]` (real PSP stand-in; rate-limit 60/min/IP) — `route.ts`
- `POST /api/checkout/payments/[ref]/simulate` (sandbox mock PSP; rate-limit 10/min/IP) — self-signs and runs the same pipeline

Three Serializable transactions inside `process.ts`:

| Path | Claim (first write) | In-tx writes (tx client — rolled back atomically) |
|---|---|---|
| PaymentGroup success (group path, ~line 228) | `paymentGroup.updateMany WHERE status != 'succeeded'` | per order: `transitionOrder` (order + status history), `postOrderPaid` (ledger T1), cart clearing |
| PaymentIntent success (single-order path, ~line 388) | `paymentIntent.updateMany WHERE status != 'succeeded'` | `transitionOrder`, cart clearing, `postOrderPaid` |
| Payout lifecycle (payout path, ~line 559) | `payout.updateMany WHERE status = 'processing'` | T4/T4f ledger postings (out of F1 scope — different flow) |

DB: PostgreSQL 17 (Supabase, Supavisor session pooler :5432), Prisma 6.11.1, `isolationLevel: Serializable`.

## 2. Exact error codes [Measured — from code + Prisma 6 docs mapping; code confirmed at the two existing precedents]

- Transient serialization abort (PG `40001` serialization_failure) and deadlock (PG `40P01`) surface as
  `Prisma.PrismaClientKnownRequestError` code **`P2034`** ("write conflict or deadlock").
- Today `process.ts` has **no retry**: an escaping P2034 hits `handle()` → HTTP **500 `INTERNAL`** with the raw
  Prisma message. The PSP must redeliver to converge (claim-miss on redelivery → `duplicate:true`).
- Precedent: `src/app/api/admin/payout-batches/route.ts` and `src/app/api/store/payouts/route.ts` already
  bound-retry exactly P2034 with max 3 attempts (no backoff). F1 follows the same, established pattern.

## 3. Which concurrent writes conflict [Derived from statement analysis]

1. Same-event race: two deliveries of the same ref — loser's claim UPDATE hits a row the winner updated →
   PG SERIALIZABLE raises 40001 at that statement/commit → P2034. (Most common.)
2. Cross-payment contention: concurrent buyers paying the SAME store contend on shared rows read/written
   inside the tx — seller wallet row (ledger T1 credit), `Setting` (commission settings read), order rows.
   SSI read-write cycles abort one party → P2034. This is the influencer-drop signature: N buyers, one store.
3. Not conflicts (never retried): `AMOUNT_MISMATCH` (409), `BAD_SIGNATURE`/`STALE_EVENT` (400), unknown events,
   `ORDER_NOT_FOUND`/`INTENT_NOT_FOUND` (404), `ApiError` business failures, non-P2034 errors.

## 4. Side effects inside the transaction (retry-safety audit)

Side-channel writes (own `db` connections, NOT tx clients — they survive an abort):

| Writer | Idempotent on retry? | Evidence |
|---|---|---|
| `notify()` seller email/inapp | ✅ YES — dedupKey + P2002 → silent skip | `lib/api.ts` notify() catch P2002 |
| `notifyShopperOrderConfirmed()` | ⚠️ best-effort, swallows errors, no dedup — duplicate bell row possible | `lib/notify-shopper.ts` |
| `dispatchStoreWebhooks()` | ⚠️ inserts WebhookDelivery rows, no dedup — duplicate row possible | `lib/api.ts` |
| `logActivity()` | ⚠️ inserts ActivityLog row, no dedup — duplicate audit row possible | `lib/api.ts` |

Key fact: this duplication window (abort AFTER the side-writes, then re-execution) is **not new** — it exists
today via the PSP-redelivery recovery path (abort → 500 → PSP redelivers → claim wins → side-writes re-run).
The dedupKeys in the code header exist precisely for that path. Retries replicate the already-accepted recovery
semantics in-process; they do NOT introduce a new class of duplication. Money-class state (payment claim, order
transition, ledger T1, cart clearing) is tx-scoped → provably once per payment.

Decision: NO restructuring of side-writes in F1 (minimal-change rule; adds hot-path reads to a contended tx).
Measured duplicate counts will be captured in the regression runs and reported. If money-adjacent duplication
is ever observed, the follow-up is "move log-only writes post-commit" — recorded as a residual risk, not done here.

## 5. Retry interaction with claim-first + idempotency design [Derived]

- Retrying the ENTIRE transaction callback from its beginning re-runs the conditional claim first. If a previous
  attempt (or a concurrent delivery) already committed the success, the claim matches 0 rows → clean
  `duplicate:true` response — convergence is inherent to the existing design.
- Stale pre-reads (`group`/`intent` snapshots, `paidAt`, settings) are safe: the claim re-validates the decisive
  state at write time inside the fresh tx; `transitionOrder` guards order state; ledger `postOrderPaid` carries
  dedupKey `order_paid:order:{orderId}` with P2002 replay recovery (`lib/ledger.ts`) — no duplicate ledger entries.
- On exhaustion the `paymentWebhookLog` row stays `processed=false` — visible to the FIN-1 unprocessed-queue
  sweep (schema index `@@index([providerRef])` comment). Correct: an unconverged delivery must remain visible.
- T2 auto-settle + final `processed=true` run AFTER the wrapper — executed at most once per delivery, unchanged.

## 6. External calls check

No external network calls inside any tx (sandbox `notify`/webhooks are DB-row writes; no PSP HTTP in the loop).
`autoSettleEnabled()` reads a Setting outside the tx. ⇒ The flow CAN safely retry; no stop-and-document-separation
trigger is hit.

## 7. Proposed minimal change (recorded before editing)

1. New `src/lib/tx-retry.ts`: `withSerializableTxRetry(fn)` — wraps `db.$transaction(..., {isolationLevel:
   Serializable})`; retries the WHOLE transaction ONLY on P2034; configurable max attempts (default 3, clamp 1–5)
   and bounded exponential backoff with jitter (base 25 ms, cap 400 ms, env-tunable); logs attempt count +
   final failure class (no customer/payment-sensitive data); on exhaustion throws
   `ApiError(503, "PAYMENT_TX_RETRY_EXHAUSTED")` — never disguised as success (HTTP 503 is the correct
   PSP-retry-later contract).
2. `process.ts`: use the helper for the two payment-confirmation success transactions (group + single-order).
   Payout lifecycle tx intentionally NOT touched (F1 scope = payment confirmation).
3. `process.ts` header note documenting the retry semantics.
4. No changes to: pool limits, isolation levels, checkout, stock behavior, notification/ledger semantics.

## 8. Reproduction & evidence plan

- Baseline ("before") FIRST on current code: `scripts/test-payment-retry.ts` drives (a) deterministic unit checks
  of the retry helper semantics, (b) concurrent confirmation storms over one store (wallet-row contention) and
  same-ref duplicate deliveries via the real webhook route with self-computed HMAC (sandbox secret is
  `PSP_WEBHOOK_SECRET` fallback), capturing success/500/P2034 counts, latencies, ledger/stock/audit counts.
- After: same workload, compare. Correctness gates: `scripts/test-oversell.ts` (launch-rush race),
  `scripts/verify-ledger.ts`.
- NOTE: the full `purchase`/`correctness` load-test profiles and the isolated load-test environment DO NOT EXIST
  yet (the Phase 0–3 harness was never built) — evidence here uses the F1 repro workload + existing correctness
  scripts, honestly labeled. F2 (checkout-pool saturation) and F3 (stock-reservation expiry) remain outstanding.

## 9. Measured findings (post-implementation — updates §2/§3/§7 predictions)

- Baseline reproduction (before fix): storm 1 (4 concurrent same-ref deliveries) = 1×200 + 3×500 (the three
  P2034 losers leaked as INTERNAL, exactly as §2 predicted); storm 2 (12 cross-ref) = 11×500 — but the
  dominant codes there are P2028 (interactive-tx budget) + P2024 (pool-fetch), NOT P2034. §3's "cross-payment
  contention" prediction was directionally right (wallet-row convoy) but the abort manifests as tx-budget
  timeouts under pool=10 + side-channel connection pressure, not clean 40001s.
- Retry wrapper behavior (after fix): every P2034 recovered at attempt 1/3 (backoff 25–30 ms); zero exhausted
  retries across all integration runs; storm 1 → 4×200 (1 winner + 3 duplicate-converged).
- Tx budget: Prisma's default maxWait 2s / timeout 5s fire mid-convoy and leave the server-side transaction
  running (documented Prisma itx-timeout behavior) — measured as blocked redelivery waves for the SAME refs.
  The wrapper therefore sets maxWait/timeout = 10s (env-tunable, clamped 5–30s) for the transactions it owns.
- Latency trade-off (honest): storm-2 first-delivery wall-clock p50 6597 → 12190 ms (waits instead of hard
  failures). First-delivery success under a 12-way burst is UNCHANGED (pool-bound = F2). Convergence after
  redelivery: 1 wave / 11 redeliveries / 0 failures (vs 3 waves / 25 / 21 and 7 payments stuck in the
  canonical before run; earlier before-runs varied 0–7 stuck).

## 10. Pre-existing bug found & fixed (required safety dependency — updates §4)

notify()'s dedup catch (api.ts:141) used `Prisma.PrismaClientKnownRequestError` at runtime while `Prisma` was
imported TYPE-ONLY — erased at runtime. Every real P2002 (dedupKey collision when a retried/redelivered
confirmation re-runs the side-channel notify writes after an aborted attempt) threw
"ReferenceError: Prisma is not defined" INSIDE the Serializable tx → confirmation aborted → not P2034 → never
retried → every future delivery of that payment repeated the failure → payment PERMANENTLY unconfirmable.
Measured proof: ref ref_a896c4ffce68e8a3 failed 3 redelivery waves + 1 manual redelivery while the bug was
live; after the one-keyword fix (`import type` → value import) the same delivery returned 200 and the group
flipped to succeeded. This bug predates F1 (PSP redelivery after any aborted attempt could hit it); F1's
retries made it deterministic, and the retry contract cannot ship without it functioning. Fix = one import
keyword; business logic untouched. Codebase scan: no other type-only Prisma imports with runtime uses.

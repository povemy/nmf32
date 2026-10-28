# F3 Inventory Audit — reservation lifecycle & expiry (pre-edit evidence)

Date: 2025-10-23 · Status: audit complete, NO code changed yet · Labels: **Measured** / **Derived** / **Assumed**.

## 1. Current stock lifecycle (code-verified)

- **Stock moves AT CHECKOUT** (checkout/create tx): per line, conditional atomic `UPDATE … WHERE stock >= qty` (the oversell guard) + `inventoryLog(delta:-qty, reason:"order:<num>")` + `product.salesCount+qty`. **The payment webhook never touches stock** (documented contract in create route).
- Logical mapping onto existing schema (no reservation table exists or is needed):
  - **RESERVED** = `Order.status="payment_pending"` with stock already deducted, `PaymentGroup.status="requires_payment"`, `PaymentGroup.expiresAt = checkout+30 min`.
  - **COMMITTED** = `Order.status="paid"` (webhook claim flips group → succeeded; stock stays deducted — correct).
  - **RELEASED** = does not exist yet — nothing in the codebase ever restores stock for unpaid/expired/failed orders.
- **Expiry is stored and reported but never enforced**: `expiresAt` is written at checkout; `GET /payments/[ref]` computes `status:"expired"` for display; the retry route refuses expired sessions (410). No worker, no cron, no sweep queries `expiresAt`.
- **payment.failed** (group path): `PaymentGroup.status="failed"` only. Orders stay `payment_pending`, stock stays deducted. Legacy single-order path: intent → failed only.
- **Late payment** (success webhook for an expired-but-unclaimed group): the claim (`status != succeeded`) has **no expiry guard** — confirmation still succeeds (order → paid; stock still deducted from checkout, so it remains consistent as long as nothing released the stock. After F3 adds release, a late-success guard becomes mandatory — see §3).
- **Restock today**: ONLY refund processing (`refund.restock=true` → `inventoryLog(delta:+qty)`) and seller inventory adjust routes. No path restores stock for non-payment.
- **State vocabulary**: `cancelled` is an existing recognized terminal bucket (shopper/seller/admin UI status lists, me-orders buckets). OrderStatusHistory records every transition with actor+note.

## 2. Why stock stays reserved (Measured backlog, 2025-10-23)

The previous storms accumulated unpaid orders; nothing releases them:

| State | Count (Measured) |
|---|---|
| `payment_pending` orders | 45 |
| …eligible for release now (group `requires_payment`, `expiresAt < now`) | **30** (holding 30 units) |
| …not yet expired | 11 |
| …on `failed` groups (definitive failure, never released) | 3 |
| …without a payment group (legacy) | 1 |

Earlier storms were cleaned by [LT] cleanup / reseeds, so "352 pending" was the historical peak, not the current count. The mechanism that accumulated it is unchanged: **no release path exists for expiry or definitive failure**.

## 3. Design — one authoritative lifecycle on the existing schema (no new tables)

- RELEASED terminal state = `Order.status="cancelled"` + `orderStatusHistory(actor, note "expired unpaid"/"payment failed")` + `inventoryLog(delta:+qty)` per item. One atomic transaction does: **(1) CAS claim** — `order.updateMany({ where: { id, status: "payment_pending" }, data: { status: "cancelled" } })`; count=0 ⇒ someone else released or a webhook committed first ⇒ **return without restocking** (exactly-once); (2) restock every item (`variant.updateMany` increment by qty) + inventoryLog rows; (3) history row; commit or roll back everything.
- **Shared release primitive** (`src/lib/inventory-release.ts`) used by all terminal-unpaid transitions: expiry sweep, definitive payment failure (webhook), and any future cancel path.
- **Expiry sweep** — `POST /api/orders/expiry/tick` following the sandbox's established worker precedent (`/api/shipping/tick`: unauthenticated POST + in-memory throttle; DB-side CAS makes overlapping runs safe — no reliance on timers as source of truth). Bounded batch (50, oldest first); per-order failure is collected, batch continues. Scheduling: (a) lazy trigger hooked where shoppers poll payment status (same laziness pattern as shipping tick), (b) documented crontab line for a real deployment, (c) direct invocation from tests/harness.
- **Payment-failure classification (webhook)**: definitive terminal failure (`payment.failed` for a non-succeeded group/intent) → release immediately via the shared primitive. Pending/timeout/unknown outcomes are NEVER treated as failure (no release) — the existing PSP redelivery contract covers them (F1).
- **Late success after release** (success webhook claims a group whose orders were already released): inside the SAME confirmation tx, before transitioning to paid — atomically re-reserve stock per item (conditional decrement; the authoritative guard pattern). If re-reservation succeeds → confirmation proceeds, inventory stays consistent. If stock is insufficient → **refuse confirmation**: typed `STOCK_LOST_AFTER_RELEASE` aborts the tx (F1 wrapper does NOT retry ApiErrors), the webhook log is marked processed, and a `Refund(status="requested", restock=false)` row records the reconciliation obligation in the existing admin refunds queue (deduped per order; **no automatic refund is claimed** — external PSP refund APIs are never called inside or around the tx).
- **Paid orders are never restocked by the sweep**: eligibility requires `PaymentGroup.status="requires_payment"`; a succeeded group fails the claim (order no longer payment_pending → count=0).
- **TTL unchanged**: 30 minutes kept exactly (short-TTL only via [LT]-owned backdated rows in tests — never the real configuration).

## 4. Race-safety matrix

| Race | Resolution |
|---|---|
| Sweep vs sweep (overlapping workers) | CAS claim: exactly one `updateMany` wins (count=1); loser restocks nothing; both report safely |
| Sweep vs payment confirmation | Order row is the serialization point: whoever flips `payment_pending` first wins; winner-only side effects; loser observes count=0 / released status |
| Late success vs released stock | Re-reserve-or-refund policy above; never silent fulfillment; never negative stock (conditional decrement) |
| Failed webhook vs concurrent success | Success claim (`status != succeeded`) wins first; failure path's release claim then matches 0 rows (order already paid) → no restock of a paid order |
| Crash mid-release | Single tx: claim+restock+history commit together or not at all; on retry the claim is re-evaluated |
| Duplicate release via redelivery | Claim count=0 → no-op; stock can never exceed pre-order capacity |

## 5. Implementation plan (minimal)

1. `src/lib/inventory-release.ts` — shared atomic release (claim → restock → history).
2. `POST /api/orders/expiry/tick` — bounded sweep (eligibility query incl. `requires_payment` + expired), throttle, error collection.
3. process.ts: `payment.failed` → release group orders via the primitive (both group + legacy paths).
4. process.ts success txs: released-order guard + atomic re-reserve-or-refund-required policy.
5. Lazy trigger hook on the payment-status polling route + documented deployment scheduling (crontab) in the audit + README note.
6. Harness `reservation` profile (scripts/loadtest/run.ts) implementing mission Steps 6.1–15 on [LT]-owned data only (backdated expiry rows, never the real TTL), plus oversell/ledger/parity regression re-runs.

## 6. Integrity risks & mitigations

| Risk | Mitigation |
|---|---|
| Double restock | CAS claim is the single gate; all restock paths require count=1 |
| Restocking a paid order | Claim requires `payment_pending` + eligibility query requires `requires_payment` group; paid groups excluded |
| Re-release exceeding capacity | Increment is claim-gated; equality restored to pre-checkout exactly (tests assert stock == before) |
| Late payment silently fulfilled | Re-reserve inside the confirmation tx; on stock loss → explicit Refund(requested) row; no fake success |
| Negative stock | Restock = increment (never conditional-fail); re-reserve = conditional decrement (never negative) |
| Refund duplication on redelivery | per-order requested-refund existence check before insert |
| Sweep load | Bounded batch 50, indexed lookup (`Order.status` + group expiresAt; verify plan), throttle |

---

## 7. Implementation results (appended 2025-10-23 after the canonical runs)

Shipped (all evidence-driven, existing schema only, 30-min TTL unchanged):

| Component | File | Proof |
|---|---|---|
| Atomic release primitive (CAS claim → restock → history, one tx) | `src/lib/inventory-release.ts` | R2/R4/R5: exactly-once under redelivery, repeated sweeps, and two concurrent workers |
| Expiry sweep worker (`POST /api/orders/expiry/tick`, bounded batch 50, error-collecting) | `src/app/api/orders/expiry/tick/route.ts` + `src/lib/expiry-sweep.ts` | R3/R12; scheduling = lazy trigger + documented crontab (audit §3) |
| Lazy trigger on payment-status polling (same pattern as shipping tick) | `checkout/payments/[ref]` GET | fire-and-forget, throttled, CAS-safe |
| Definitive payment.failed → release exactly once (group + legacy paths) | `webhooks/payments/process.ts` | R2 (+redelivery) |
| Late-success-after-release: atomic re-reserve-or-refund-required inside the confirmation tx | `webhooks/payments/process.ts` | R8a (re-reserved → paid, net stock −2, one T1) and R8b (stock gone → order stays cancelled, `Refund(requested)` row, NO T1, no fake fulfillment) |

Reservation profile (scripts/loadtest/run.ts, [LT]-owned data, TTL backdated on [LT] rows only): **18/18 PASS** — including the payment/expiry race (exactly one valid outcome), paid-orders-never-restocked (R14), duplicate-webhook dedup (R7), multi-item exact quantities (R10: mid −1/−2/−3, net 0/0/0), multi-seller release (R11), ledger integrity after all churn (R13). R9 (rollback under injected DB failure) is structural — claim+restock+history share one tx — and is honestly recorded as not fault-injected in this sandbox.

Backlog honesty note: the audit's Measured 30 eligible orders were residue from earlier [LT] load storms; they were consumed by [LT] cleanup and the profile runs during this session (test data lifecycle, not production data). Post-run steady state (Measured): **0 eligible expired unpaid reservations remain, 0 negative stock variants (whole DB), ledger balanced (verify-ledger ALL PASS)**. Legacy `payment_pending` orders predating PaymentGroups (no group) are out of the sweep's scope by design (documented in §3 eligibility) — they require the manual refunds flow.

## 8. Deployment scheduling (claim documentation)

- Sandbox/dev: lazy trigger (payment-status polling) + harness invocation. Creating a script alone is NOT claimed as automation — the runner is a real HTTP worker endpoint with bounded batch + CAS idempotency.
- Production (documented requirement): `* * * * * curl -fsS -X POST http://127.0.0.1:3000/api/orders/expiry/tick` (1-minute cron) or a platform scheduler hitting the same endpoint; overlapping executions are inherently safe (DB-side claim). Multi-worker deployments need no extra coordination for THIS sweep (row-CAS), though the F2 checkout gate does need a cross-instance limiter at that scale.

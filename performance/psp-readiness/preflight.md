# PSP Integration-Readiness — Preflight

**Mission phase:** 0 (pre-work inspection) · **Verified:** 2026-10-27 (UTC)
**Repo:** `main @ 78ee258` · **Scope:** what exists today in payment/PSP surface, verified in code, before any provider-specific work.

> **Honest boundary:** NOMOFEE's payment testing today uses a **mock PSP** (`mock` provider + `/simulate` endpoints). No real PSP sandbox, no provider contract, no provider credentials exist. Nothing here may be represented as provider certification or approval. The detailed review package for a provider's technical reviewers is `docs/psp-readiness/` (built in Phase 4 of this mission).

---

## 1. Payment surface inventory (verified files)

| Surface | File(s) | Status |
|---|---|---|
| Payment-group checkout (1 buyer charge → N seller orders) | `/api/checkout/*`, `src/lib/psp.ts` | Implemented, mock rails |
| PSP provider registry | `src/lib/psp.ts` (`PSP_PROVIDERS`: `mock` active; `stripe_my`/`curlec`/`ipay88` documented candidates, no adapters) | Scaffold |
| Webhook ingest + verification | `src/app/api/webhooks/payments/[provider]/route.ts` + `process.ts` (797 lines) | Implemented (HMAC, replay window, claim-first) |
| Mock PSP (plays the gateway) | `/api/checkout/payments/[ref]/simulate`, `/api/webhooks/payments/payout-simulate` | Implemented; production-refuse unless Setting `psp.mock.enabled=true` |
| Refund adapter layer | `src/lib/psp-refund.ts` (`RefundAdapter` interface + mock adapter + registry) | Implemented, mock only |
| Late-payment obligations | `PaymentReconciliation` + `PspRefundRecord` models; both GROUP_EXPIRED sites in `process.ts` | Implemented |
| Refund/reconciliation sweep | `/api/cron/refund-reconcile` | Implemented |
| Payout lifecycle (T3/T4/T4f) | `src/lib/payout-state.ts`, admin payout routes | Implemented (mock confirmation via payout-simulate) |
| Ledger (double-entry, T1/T2/T3/T4) | `src/lib/ledger.ts` | Implemented; 325/325 balanced, 6/6 wallets cache==truth (2026-10-27 re-run) |

## 2. Webhook verification — current exact rules

- HMAC-SHA256 hex over `${providerRef}.${eventType}.${amountMinor}.${ts}`; secret = `process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo"` (**public fallback — sandbox only**; production must set the env var; a real provider's signing scheme will be provider-specific — do not assume this generic HMAC shape transfers).
- Timing-safe compare (`safeEqual`); signature accepted from `X-SM-Signature` header or `body.sig`.
- Replay guard: `|now − ts| ≤ 10 min` else `400 STALE_EVENT`.
- Rate limit 60 req/min/IP applied before parsing.
- Log-then-verify: every delivery (including invalid) is persisted to `payment_webhook_logs` with `signatureValid` before any state change.
- Enforcement order: provider sandboxOnly (403 in prod) → field validation → signature → freshness → unknown-event/amount checks → claim-first Serializable processing.
- Duplicate safety: conditional status-flip claim + ledger dedupKeys + notification dedupKeys; claim-loss answered 200 `duplicate:true`.
- Ambiguous outcomes: webhook tx retry (P2034 ≤3, bounded 10 s statement_timeout / 15 s tx); PSP redelivery converges; a crash mid-window leaves "case exists, webhook answered 5xx".

## 3. Secrets posture (measured today)

| Secret | Dev status | Production requirement |
|---|---|---|
| `PSP_WEBHOOK_SECRET` | **NOT SET** (public fallback active) | set via hosting secret manager; rotate per provider spec |
| `CRON_SECRET` | **NOT SET** (dev-open) | set via hosting secret manager; endpoints fail closed without it |
| Supabase keys | new-style publishable + secret keys installed and REST-validated (2026-10-27) | per-environment values from Supabase dashboard |

No secret values are printed by any endpoint, script, or log path audited (cron-auth and process.ts deliberately echo-free; scheduler exposes only `secretConfigured: boolean`).

## 4. Internal payment states (current model)

- `PaymentGroup.status`: `requires_payment → succeeded | failed | expired` (claim-guarded transitions; `expired` set only by sweep).
- `Order.status` payment leg: `payment_pending → paid | payment_expired` (conditional per-order guard).
- `PaymentIntent.status` (legacy single-order path): succeeded/failed.
- `Payout`: `requested → processing → paid | failed (+ rejected)` via `assertTransition`.
- `PaymentReconciliation.status`: `requested → processing → succeeded | failed | unknown` (+ exhausted-after-cap operator item).
- Every transition writes `OrderStatusHistory` / durable settings rows.

## 5. What is genuinely READY for a PSP technical review (code-level)

1. End-to-end buyer journey with signed webhooks, idempotency, and duplicate/replay handling — **demonstrable on mock rails**.
2. Exactly-once money movement (claim-first + ledger dedupKeys) — regression-tested (finance-regression 37 rows ALL PASS, archived 2026-10-25; re-verified green 2026-10-27).
3. Late-payment-after-expiry policy with durable refund obligations and a reconciliation sweep with provider-side idempotency keys — mock-adapter-tested (10/10 scenarios).
4. Double-entry ledger integrity + wallet-truth reconciliation + drift audit tooling.
5. Scheduler (expiry + refund-reconcile) with fail-closed auth, alerts, catch-up — sandbox-e2e 17/17 PASS.

## 6. What is NOT ready (provider-specific, out of scope until provider chosen)

1. No real PSP adapter (create/initiate payment via provider API, hosted checkout redirect, provider status mapping, provider refund execution, provider reconciliation pulls). The `RefundAdapter`/`PspProvider` seams exist for this.
2. No provider-specific webhook verification (each provider signs differently — the generic HMAC here must be replaced/augmented per official spec).
3. No split-settlement confirmation flow (auto-settle dormant; commission currently ledger-mirrored, not provider-enforced `application_fee`).
4. No provider sandbox credentials, no signed contract, no BNM/SSM registration evidence in-repo (business prerequisites).
5. Production/staging deployment itself (see deployment-preflight.md blockers D-1/D-2/D-5).

## 7. Verdict

**Code-level payment readiness: demonstrable on mock rails only.** The provider-neutral contract, sequence diagrams, state machine, test evidence and staging demo guide are packaged in `docs/psp-readiness/` for a reviewer. Provider-specific integration status: **NOT STARTED (blocked on provider selection + sandbox credentials)**.

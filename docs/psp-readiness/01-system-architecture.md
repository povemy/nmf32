# 01 — System & Payment Architecture

**Repo:** Next.js 16 (`package.json`: `next ^16.1.1`, React 19, Prisma `^6.11.1`) ·
**DB:** Supabase Postgres (Prisma schema `prisma/schema.prisma`) · **All facts below cite repo files.**

## 1. Deployment shape (single application + one scheduler process)

- **One Next.js application** serves storefront, seller/admin back-offices and the
  HTTP API surface (`src/app/`). Intended production topology is a single instance ×
  single process with a 10-connection pool — horizontal scaling is explicitly gated
  (`performance/production-topology.md` §4; `src/lib/checkout-gate.ts` scope note).
- **One scheduler mini-service** (`mini-services/expiry-scheduler/`, port 3005,
  30 s interval, durable `state.json`) POSTs two cron tick endpoints:
  `/api/cron/expiry-sweep` and `/api/cron/refund-reconcile`
  (`mini-services/expiry-scheduler/README.md`). Production equivalent: platform cron
  at ≤60 s cadence with `CRON_SECRET` (`performance/environment-matrix.md` §1/§3).
- **Database:** Supabase Postgres via Supavisor session pooler; credentials come from
  `SUPABASE_*` env vars (never in code; see `09-environments-secrets.md`).

```
                        ┌────────────────────────────────────────────────────────────┐
                        │                    NOMOFEE (single Next.js app)             │
                        │                                                            │
  Buyer ──HTTP────────▶ │  /api/checkout/*          checkout gate (admission ctrl)    │
                        │  /api/market/*            idempotency-key replay            │
                        │  /api/me/*                stock + commission snapshots       │
                        │                                                            │
  Mock PSP (sandbox) ──▶│  /api/webhooks/payments/[provider]                          │
  (or real PSP later)   │    rate limit → HMAC verify → log-then-process              │
                        │    claim-first Serializable tx → ledger + orders            │
                        │  /api/checkout/payments/[ref]/simulate  (sandbox stand-in)  │
                        │  /api/webhooks/payments/payout-simulate (sandbox stand-in)  │
                        │                                                            │
  Scheduler :3005 ─────▶│  /api/cron/expiry-sweep      requires_payment → expired      │
  (or platform cron)    │  /api/cron/refund-reconcile  late-payment refund execution  │
                        │                                                            │
  Seller/Admin ────────▶│  /api/store/payouts, /api/admin/payouts/[id]/*              │
                        │  /api/admin/payment-reconciliation, /api/admin/ledger, ...  │
                        │                                                            │
                        │  src/lib/ledger.ts  (double-entry: T1 T2 T3 T4 T4f)        │
                        │  src/lib/commission.ts · src/lib/payout-state.ts           │
                        │  src/lib/psp.ts · src/lib/psp-refund.ts · cron-auth.ts     │
                        └───────────────────────┬────────────────────────────────────┘
                                                │ Prisma (pool ≤10)
                                                ▼
                        ┌────────────────────────────────────────────────────────────┐
                        │ Supabase Postgres: orders, payment_groups, payouts,         │
                        │ payment_webhook_logs, payment_reconciliations,             │
                        │ psp_refund_records, ledger_transactions/lines, wallets,     │
                        │ settings (durable cron state) … (prisma/schema.prisma)      │
                        └────────────────────────────────────────────────────────────┘
```

## 2. Payment model — Option B, marketplace facilitator (licensed-PSP split)

Defined in `src/lib/psp.ts` (header block) and restated at the top of
`src/app/api/webhooks/payments/process.ts`:

- The buyer pays **once per checkout**; a `PaymentGroup` **is** one PSP checkout
  session covering **N per-seller orders** (`prisma/schema.prisma`, `PaymentGroup`
  ↔ `Order` relation; created in `src/app/api/checkout/create/route.ts`).
- A **licensed PSP** collects the buyer payment, deducts the platform commission
  (application fee) **at payment time**, and settles each seller their share.
- **NOMOFEE never takes custody of buyer funds.** The ledger T1 postings are the
  platform's **accounting mirror** of the PSP's per-seller balances (seller
  dashboards + payout pipeline), not escrow (`src/lib/ledger.ts` Option B note).
- Documented production candidates (no adapters exist): `stripe_my`, `curlec`,
  `ipay88` — `PSP_PROVIDERS` in `src/lib/psp.ts`; split-settlement scaffold and
  candidate notes in `PSP_SPLIT_CANDIDATES` (same file).

## 3. Mock-PSP rails (the PSP stand-in in every test result)

- Provider `mock` is `sandboxOnly: true` (`src/lib/psp.ts`), so it **cannot process
  webhooks in production** (403 `PROVIDER_SANDBOX_ONLY`, `process.ts`).
- `POST /api/checkout/payments/[ref]/simulate` **plays the PSP**: the server signs
  the exact webhook payload a real gateway would send (HMAC never reaches the
  client) and feeds it through the same `processPaymentWebhook` pipeline
  (`src/app/api/checkout/payments/[ref]/simulate/route.ts`).
- `POST /api/webhooks/payments/payout-simulate` plays the PSP for payout
  completions (`src/app/api/webhooks/payments/payout-simulate/route.ts`).
- Both refuse with 404 under `NODE_ENV=production` unless an operator explicitly
  sets Setting `psp.mock.enabled=true` (`mockPspAllowed()` in `src/lib/psp.ts`).

## 4. API surfaces relevant to a PSP review

| Surface | Route(s) | Guard |
|---|---|---|
| Checkout create | `POST /api/checkout/create` | shopper session + required `Idempotency-Key` header + admission gate (`src/app/api/checkout/create/route.ts`, `src/lib/checkout-gate.ts`) |
| Payment webhook ingest | `POST /api/webhooks/payments/[provider]` | rate limit 60/min/IP → HMAC verify (`src/app/api/webhooks/payments/[provider]/route.ts`, `process.ts`) |
| Sandbox simulate | `POST /api/checkout/payments/[ref]/simulate`, `POST /api/webhooks/payments/payout-simulate` | rate limit 10/min/IP + production mock gate (files above) |
| Expiry sweep tick | `POST/GET /api/cron/expiry-sweep` | `assertCronAuth` — fail-closed 503 in production without `CRON_SECRET` (`src/lib/cron-auth.ts`) |
| Refund reconcile tick | `POST/GET /api/cron/refund-reconcile` | same cron-auth (`src/app/api/cron/refund-reconcile/route.ts`) |
| Payout lifecycle | `/api/store/payouts`, `/api/admin/payouts/[id]/{approve,reject,mark-paid,fail}` | seller/admin auth + `assertTransition` (`src/lib/payout-state.ts`) |
| Reconciliation ops view | `GET /api/admin/payment-reconciliation` | admin auth (`src/app/api/admin/payment-reconciliation/`) |
| Health / fingerprints | `GET /api/health[?fresh=1]` | public; TTL-cached ledger invariants + `deployment.dbFingerprint` (`src/app/api/health/route.ts`) |

## 5. Production plug-in points (config-level swap, from `src/lib/psp.ts`)

1. Implement `PspProvider` for the chosen gateway and register it in `PSP_PROVIDERS`.
2. Replace the simulate endpoint with the provider's hosted checkout/redirect flow.
3. Point `/api/webhooks/payments/[provider]` at the real gateway webhook with
   per-provider signature verification.
4. `PaymentGroup.provider` already stores the provider id per checkout; the
   commission rate (`CommissionSetting`) becomes the PSP application fee.

A dormant outbound payout adapter scaffold (`PspPayoutAdapter`: transfer /
bank_payout phases, stable outbound idempotency keys, never-auto-succeed unknown
states) exists unwired at `src/lib/psp-adapter.ts` (design intent — zero callers,
verified by the FIN-era worklog record).

## 6. What is NOT in this architecture (honest list)

- No real PSP adapter, no provider sandbox credentials, no provider contract
  (`performance/psp-readiness/preflight.md` §6).
- No staging or production deployment (both BLOCKED — `performance/environment-matrix.md` §1,
  `performance/deployment-preflight.md` blockers D-1/D-2/D-5).
- Rate limiting and the checkout admission gate are **single-process** in-memory
  implementations (`src/lib/ratelimit.ts`, `src/lib/checkout-gate.ts` — documented
  limitations; multi-instance deployment requires shared stores first).

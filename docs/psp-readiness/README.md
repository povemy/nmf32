# PSP Readiness Review Package — NOMOFEE Marketplace

**Purpose:** self-contained technical review package for a Payment Service Provider
(PSP) evaluation of the NOMOFEE marketplace (Next.js 16 + Prisma + Supabase Postgres).
**Assembled:** 2026-10-27 (UTC) · documentation only — no business logic was changed.

---

## Honest boundary (read first)

- **No real PSP is integrated.** The only provider in the registry is the sandbox
  `mock` provider (`src/lib/psp.ts`, `PSP_PROVIDERS`); production candidates
  (`stripe_my`, `curlec`, `ipay88`) are documented placeholders with **no adapters**.
- **All test results in this package are internal, mock-rail evidence.** The mock
  rails (`/api/checkout/payments/[ref]/simulate`, `/api/webhooks/payments/payout-simulate`)
  play the PSP by server-signing the real webhook shape and feeding it through the
  production verification/processing pipeline (`src/app/api/webhooks/payments/process.ts`).
- **Nothing here is provider certification, sandbox validation, or approval.** No
  provider sandbox credentials, contract, or provider-side test has ever been executed.
- A real provider's signing scheme, event catalog, status model, refund semantics and
  settlement mechanics **must supersede the generic implementations described here**
  (see `05-webhook-security.md` §6 and `11-provider-integration-contract.md`).
- Load/capacity numbers were measured **dev-mode, on a combined environment** (app,
  generator and remote DB in one 2-vCPU sandbox) and must not be extrapolated to
  production capacity (`performance/REPORT.md`, `performance/runs/2026-10-25-load-*.json`).

## How a reviewer should use this package

1. Read `01` (architecture) → `02` (payment flows) → `03` (state machines) for the
   money-movement model and its invariants.
2. Depth dive as needed: `04` (idempotency), `05` (webhook security), `06` (refund
   recovery), `07` (ledger integrity), `08` (commission & settlement).
3. Operational posture: `09` (environments & secrets), `10` (test evidence — with
   the boundary above in mind).
4. Integration scope: `11` (provider-neutral integration contract — the key document),
   `12` (information the provider must supply before implementation starts).
5. Provider selection: `provider-fit-gap.md` (decision document — capability
   matrix from official docs fetched 2026-10-27, conditional recommendation,
   written-confirmation question list, 12-case sandbox acceptance suite).
6. Demonstration: `13` (staging demo guide, once a staging environment exists —
   currently BLOCKED, see `09`).

## Index

| # | File | Contents |
|---|---|---|
| 01 | `01-system-architecture.md` | System + payment architecture, Option-B facilitator model, ASCII diagram |
| 02 | `02-payment-flows.md` | Sequence diagrams: happy path, duplicate webhook, late payment→refund, payout lifecycle |
| 03 | `03-state-machines.md` | PaymentGroup / Order payment leg / Payout / PaymentReconciliation transitions + owners |
| 04 | `04-idempotency-design.md` | Checkout idemKeys, claim-first semantics, ledger/notification dedupKeys, refund idempotency, P2034 retry |
| 05 | `05-webhook-security.md` | Exact HMAC rules, enforcement order, replay window, rate limits, production secret requirements |
| 06 | `06-refund-recovery.md` | Late-payment policy, reconciliation sweep contract, runbook, RefundAdapter seam |
| 07 | `07-ledger-integrity.md` | Double-entry model, T1–T4f postings, wallet cache vs truth, drift classification, tooling |
| 08 | `08-commission-settlement.md` | Commission engine, hold periods, facilitator settlement design, dormant T2, split-settlement change plan |
| 09 | `09-environments-secrets.md` | Dev/staging/prod matrix, secret inventory, handling rules, rotation outline |
| 10 | `10-test-evidence.md` | Archived mock-rail test results with dates, file paths and honest labels |
| 11 | `11-provider-integration-contract.md` | Provider-neutral integration contract (interface requirements) |
| 12 | `12-provider-checklist.md` | Exact information required from the chosen provider before implementation |
| 13 | `13-staging-demo-guide.md` | Staging demonstration script for a PSP reviewer (no secrets disclosed) |
| 14 | `provider-fit-gap.md` | Provider selection & fit-gap decision document (researched 2026-10-27; capability matrix, conditional recommendation, acceptance suite) |

## Conventions

- Every system claim cites a repo file path (`src/...`, `prisma/...`, `scripts/...`).
- **PASS / verified** labels are used only for results archived under
  `performance/runs/...`; anything else is labelled **design intent** or **NOT TESTED**.
- No URLs, API keys, secrets, provider endpoints or test results are invented; provider
  specifics are marked **TO BE MAPPED FROM CHOSEN PROVIDER'S OFFICIAL DOCUMENTATION**.
- Related in-repo documents: `docs/late-payment-refund-runbook.md`,
  `performance/psp-readiness/preflight.md`, `performance/environment-matrix.md`,
  `performance/deployment-preflight.md`, `performance/production-topology.md`.

# Phase 2.3 — PSP Selection for the Malaysian Multi-Vendor Marketplace

**Status:** DECISION DOCUMENT — research consolidated + recommendation recorded. **No provider account created, no adapter activated, no live-money code changed.** Owner authorization is REQUIRED before any PSP integration is implemented (programme §14: "Implement only after the provider choice and commercial configuration are explicitly authorized").
**Supersedes:** extends `docs/psp-readiness/provider-fit-gap.md` (2026-10-27 architecture audit + first research pass) with the 2026-11 verification pass (raw official-doc fetches archived in `.agent-tmp/psp-research/`).
**The `PSPProvider` abstraction is untouched**: the mock sandbox rail remains the only active adapter, gated off in production (`psp.mock.enabled`); `src/lib/psp-adapters/stripe-my.ts` exists as a dormant scaffold.

---

## 1. What a marketplace PSP must do (four distinct layers)

The programme requires distinguishing four operations that must never be conflated:

| Layer | Meaning | Where it lives in NOMOFEE today |
|---|---|---|
| **L1 Collect** | Charge the buyer (FPX/cards/e-wallets, MYR) | `PaymentGroup` = one checkout session; signed webhook → T1 ledger |
| **L2 Allocate** | Decide platform commission vs seller share | Commission engine, per-item snapshots (never recomputed) |
| **L3 PSP transfer** | Programmatic platform→seller (or buyer→seller split) funds movement at the provider | `PspPayoutAdapter` scaffold (`psp-adapter.ts`) — dormant |
| **L4 Bank payout** | Money actually reaching the seller's bank account | Manual CSV workflow today; provider-managed onboarding is the target |

A provider that only supports L1 (most Malaysian gateways) forces every seller payment through manual bank transfer — acceptable at launch, but the audit's honest verdict stands: **the mock rail is the only production blocker among PSP concerns**, and the remediation for it is the adapter + owner decision, not a rewrite.

## 2. Verified provider findings (official docs fetched during this programme)

### 2.1 Curlec (Razorpay Curlec) — **RECOMMENDED PRIMARY**

Verified from `curlec.com/docs` (official, incl. `llms.txt` index; fetches archived):

- **Route is available in Malaysia** 🇲🇾 and is purpose-built for marketplaces: *"split incoming funds among multiple third-parties, sellers or bank accounts… suited for businesses, such as marketplaces or platforms, that operate on a one-to-many disbursement model."* `[V]`
- **Linked Accounts** give each seller a self-service portal (refunds, reversals, settlements, profile) — this can also carry **seller KYC/onboarding** (provider-managed identity verification, programme §16 preference). `[V]`
- **Split-at-charge transfers + automated reversals**: refunds trigger automated transfer reversals — directly matching NOMOFEE's T5 refund + `PspRefundRecord` reconciliation design. `[V]`
- **Settlement control APIs**: per-transfer settlement hold (`modify settlement hold for transfer`) and per-Linked-Account settlement schedules — maps onto NOMOFEE's `payoutHoldDays` liability model (hold is currently ledger-level; provider-side hold is the PSP mirror). `[V]`
- **Webhooks** for orders/payments/settlements/disputes; API-driven reconciliation (Route's stated advantage over file-based recon). `[V]`
- Transfer/gateway fee examples documented (Route fees page). `[V]` — commercial rates for NOMOFEE's volumes: **needs a sales quote** `[N]`.

Fit: covers L1+L3(+L4 via Linked Account settlements) with KYC. Gaps to confirm in sandbox: FPX/e-wallet coverage parity with incumbents, onboarding SLAs, webhook signature scheme details. `[N]`

### 2.2 CHIP-IN — **recommended alternative (collect + disburse)**

Verified from `docs.chip-in.asia` (official):

- **CHIP Collect**: checkout creation API, success callbacks, **asymmetric (public-key) signed webhooks** (`X-Signature` verification docs). `[V]`
- **CHIP Send**: programmatic payouts to recipient bank accounts with built-in approval workflows — the L3/L4 layer executed by the platform rather than split-at-charge. `[V]`
- Model implication: platform-of-record collects 100%, holds seller balances in its CHIP Send account, pays out on schedule. Simpler contract, but the platform bears e-money/float considerations and seller KYC stays NOMOFEE-managed (programme §16 fallback). `[N] — legal review of float/settlement terms required`

### 2.3 Stripe — capable rails, Malaysian marketplace gap

- Payment collection in MYR works; extensive research archived (Connect, payouts, idempotency, refunds, disputes, webhooks). `[V]`
- **Decisive gap: MY-platform Connect availability for Malaysian connected accounts is not offered in the form a MY marketplace needs** (conclusion recorded in `.env.example` §PSP note and the research artifacts; cross-border payouts exist but seller onboarding as MY connected accounts is the blocker). Final word belongs to a Stripe sales confirmation. `[N — confirm current availability before excluding]`
- Stripe remains the best-documented PSP for idempotency/webhook ergonomics — the dormant `stripe-my.ts` scaffold is retained for the day MY Connect opens up.

### 2.4 Others researched (not recommended for the marketplace model)

| Provider | Verdict | Evidence |
|---|---|---|
| **iPay88** | Incumbent MY gateway; no documented split/transfer API for marketplaces | enterprise/ecom docs `[V — absence]` |
| **Billplz** | Collection-only; no split payments/payouts product | about/api/pricing docs `[V — absence]` |
| **HitPay** | SME POS-first; no marketplace split primitive documented | home/MY pricing `[V — absence]` |
| **Airwallex** | Strong payout rails (L3/L4), MY collect via partnership; Connected Accounts availability for MY sellers needs sales confirmation | MY docs fetches `[V/N]` |

## 3. Recommendation

1. **Primary: Curlec Route (Linked Accounts)** — split-at-charge + automated reversals + settlement holds/schedules + provider-side seller onboarding is the closest match to NOMOFEE's four-layer model, with Malaysian availability verified.
2. **Fallback: CHIP Collect + CHIP Send** — if Curlec commercial terms disappoint; accept platform-of-record fund flow.
3. **Park: Stripe** (MY Connect gap), iPay88/Billplz/HitPay (no split primitive), Airwallex (revisit if payouts-only rail is later needed alongside a collect PSP).

## 4. What implementation will look like (post-authorization, staged)

1. **Adapter**: implement `PSPProvider` for the chosen PSP behind `src/lib/psp.ts` selection (production can never silently fall back to mock — boot gate already enforces explicit `psp.mock.enabled`).
2. **Mapping**: PaymentGroup → checkout/PaymentLink; webhook → existing `/api/webhooks/payments/[provider]` pipeline (signature verification adapted per provider scheme); refunds → `RefundAdapter` (`recon:{caseId}` idempotency); payouts → `PspPayoutAdapter` (`payout_bank:{id}` / `payout_transfer:{id}` idempotency — already designed).
3. **Sandbox-first**: provider sandbox passes before any live key (`psp-readiness/12-provider-checklist.md`).
4. **Seller onboarding**: prefer Curlec Linked Accounts for KYC (§16); else NOMOFEE-managed document upload design.
5. **Bank destinations**: prefer provider-managed (Linked Account bank details never touch NOMOFEE storage); the AES-GCM `sealSecret` path in `store/bank-accounts` exists for the fallback.

## 5. Owner decisions required (blockers — programme §31)

| # | Decision | Why it blocks |
|---|---|---|
| D1 | Choose PSP (recommendation: Curlec Route primary, CHIP fallback) | No adapter may be implemented without authorization |
| D2 | Commercial agreement + account creation + sandbox credentials | Adapter work needs sandbox keys |
| D3 | Seller KYC owner: provider-managed (Curlec) vs NOMOFEE-managed documents | §16 architecture |
| D4 | Payout model: provider settlement holds vs platform-held balances | Float/compliance posture (CHIP path) |
| D5 | Fee pass-through policy (who absorbs PSP fees) | Pricing/commission interplay — business policy, not code |

Everything else (adapter seams, idempotency design, reconciliation, webhook pipeline, refund/late-payment rails) is already built and PSP-agnostic — verified in `provider-fit-gap.md` §1 and unchanged by this programme.

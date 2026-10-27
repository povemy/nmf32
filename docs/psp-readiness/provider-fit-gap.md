# PSP Provider Selection & Integration Fit-Gap Assessment — NOMOFEE

**Assembled:** 2026-10-27 (UTC) · **Status:** DECISION DOCUMENT (assessment only — no provider integration, no financial business logic changed)
**Method:** every architecture claim below was verified against the current code on 2026-10-27 (file paths cited); every provider claim was fetched from the provider's OFFICIAL public documentation on 2026-10-27 via HTTP (URL cited, fetch status recorded) by two research passes plus direct spot-verification of the three load-bearing claims (Xendit MYR split, Curlec settlement-hold, Stripe MY pricing). Anything not established in official docs is marked **NEEDS CONFIRMATION** — capability is never inferred from a product name or from prior knowledge.

**Labels:** `[V]` verified in official docs fetched 2026-10-27 · `[N]` not found in official docs (needs written confirmation) · `[U]` page unreachable/unreadable via curl · `[CODE]` verified in this repository · `[GAP]` missing capability requiring a change before/ during integration.

---

## 1. Current payment architecture (audit, code-verified)

### 1.1 Checkout & payment creation
- Buyer cart is priced into **per-seller groups**; `POST /api/checkout/create` requires an `Idempotency-Key` header and creates **ONE `PaymentGroup` (= one PSP checkout session) + N per-seller `Order` rows** inside one transaction. Per-order idemKeys are derived (`${idemKey}:${storeId}`) so replays converge (`src/app/api/checkout/create/route.ts`; schema `prisma/schema.prisma` `PaymentGroup`, `Order`).
- `PaymentGroup` carries `provider`, `currency` (MYR default), subtotal/discount/shipping/total minor units, a unique `idemKey`, `redirectUrl`, and a **30-minute `expiresAt`** payment window `[CODE]`.
- Commission is computed per seller group at checkout (`computeOrderCommissions`) and **snapshotted per order item — never recomputed** (`src/lib/commission.ts`).
- Stock is **reserved at checkout** (decremented) and released by the expiry sweep if unpaid `[CODE]`.

### 1.2 Payment confirmation & webhook verification
- Inbound: `POST /api/webhooks/payments/[provider]` → `processPaymentWebhook` (`src/app/api/webhooks/payments/process.ts`): **signature-before-trust** — timing-safe HMAC-SHA256 compare against `PSP_WEBHOOK_SECRET` (constant `expectedSignature` formula over `providerRef|eventType|amountMinor|ts`), then a **±10-minute freshness window** (400 `STALE_EVENT`), every delivery (even rejected) logged to `PaymentWebhookLog`.
- Processing is **claim-first inside a Serializable transaction** (`updateMany where status != succeeded` as the claim), `statement_timeout 10s`, bounded P2034 retry (≤3 attempts), post-commit wallet-cache refresh and notification fan-out (F1 remediation) `[CODE]`.
- One webhook for a group settles **all N per-seller orders** in one transaction; each order gets its own T1 ledger posting `[CODE]`.
- The sandbox mock PSP (`POST /api/checkout/payments/[ref]/simulate`) **server-signs the real webhook shape** and feeds the same pipeline; it is gated off in production unless `psp.mock.enabled` is explicitly set (`src/lib/psp.ts` `mockPspAllowed`) `[CODE]`.

### 1.3 Commission & shipping allocation (M09 engine)
- Rate resolution: fee holiday > product override > category ancestor > seller override > global default (**8% default**); `appliesToShipping` default **false**; optional per-order fixed fee and minimum-commission floor; deterministic remainder handling (`src/lib/commission.ts`).
- **Invariant (Option B, FIN-1):** `sum(item.sellerNetMinor) + sum(item.commissionMinor) === order.totalMinor`, where `total = subtotal − discount + shipping + tax`; `sellerNet = lineGross − commission` and line gross **includes the shipping allocation** `[CODE]`.

### 1.4 Seller balances, settlement eligibility, payouts
- Double-entry ledger (`src/lib/ledger.ts`): **T1** payment `DR GATEWAY:{provider} total | CR SELLER:PAYABLE (available_at = paidAt + holdDays) | CR PLATFORM:COMMISSION`; **T2** gateway settlement `DR BANK_MAIN | CR GATEWAY:{provider}` (**dormant** — `auto_settle` default false); **T3** payout approve `DR SELLER:PAYABLE | CR PAYOUT_CLEARING`; **T4** paid `DR PAYOUT_CLEARING | CR BANK_MAIN`; **T4f** failure reversal; **T5** refund (below); **T6** admin adjustment `[CODE]`.
- Delayed settlement is implemented as the **`available_at` hold on seller payables** (`payoutHoldDays` default **7 days**, `days_after_paid`; per-seller override exists) — seller wallet shows pending → available at hold expiry; wallet rows are a **derived cache** of ledger truth with drift detection and self-healing refresh `[CODE]`.
- Payout lifecycle `requested → approve → processing → paid/failed (+reject)` with guard-only state machine (`src/lib/payout-state.ts`); today's execution mode is **`manual_csv`** (finance marks paid/failed from bank evidence). A **dormant `PspPayoutAdapter` scaffold** (`src/lib/psp-adapter.ts`: `submit`/`recover`, outbound idempotency keys, `unknown → null` never-auto-succeed guard) is the wired-in plug point for provider-executed payouts; bank details are stored **masked (last4) only** `[CODE]`.

### 1.5 Refunds, late payments, chargebacks
- Refund flow: request → admin approve → process posts **T5: `DR SELLER:PAYABLE (seller share) + DR COMMISSION (reversal) | CR GATEWAY:{provider}`** and calls the **provider-neutral `RefundAdapter`** (`src/lib/psp-refund.ts`: `executeRefund`/`getRefundStatus` with `recon:{caseId}` idempotency) **outside the DB transaction**; completion is read from the provider's authoritative record, never assumed `[CODE]`.
- **Late payment after expiry** (buyer pays after the 30-min window and the sweep already released stock): a `PaymentReconciliation` obligation is recorded; the `refund-reconcile` cron (scheduler service, ~30 s cadence; claim-first, batch 25, exponential backoff, max 8 attempts, `awaitingOperator` escalation) drives the money back to the buyer with `PspRefundRecord` as the durable provider-side mirror `[CODE]` (evidence: `performance/runs/2026-10-25-late-payment-refund.json`, S1–S10).
- **Chargebacks/disputes:** a `Dispute` schema model and admin refund/dispute surfaces exist, but there is **no inbound dispute webhook automation and no provider dispute API adapter** — `[GAP]`.

### 1.6 Idempotency & duplicate-event handling (4+ layers)
1. Checkout `Idempotency-Key` (group + per-order) `[CODE]`; 2. `PaymentWebhookLog` per delivery + claim-first conditional updates `[CODE]`; 3. ledger dedupKeys + unique constraints per T-recipe (exactly-once postings — proven by T1 `1→1` under duplicate webhooks) `[CODE]`; 4. outbound refund/payout idempotency keys (`recon:{caseId}`, `payout_bank:{id}` / `payout_transfer:{id}`) `[CODE]`; plus notification `dedupKey` silent-skip. Evidence: `performance/runs/2026-10-27-deployment-smoke.json` (22/22 incl. duplicate-webhook convergence, unsigned → `BAD_SIGNATURE`, stale → `STALE_EVENT`), `2026-10-27-finance-regression.json` (failures: 0 incl. injected-fault exactly-once retry).

### 1.7 Mock-PSP limitations — provider functionality NOT implemented
- **No hosted-checkout/redirect authorization flow** (the simulate endpoint plays the PSP; production plug-in points documented in `src/lib/psp.ts`) `[GAP]`.
- **No real provider signature verification** (generic HMAC formula will be superseded by the provider's scheme — see `05-webhook-security.md` §6, `11-provider-integration-contract.md`) `[GAP]`.
- **No PSP fee model anywhere**: T1 debits the gateway for the FULL buyer total; there is no fee/expense account and the commission engine deducts nothing for processing fees `[GAP — required change under ANY provider]`.
- **No real refund API adapter** (mock only), **no payout submission wiring** (manual mode), **no settlement confirmation ingestion** (T2 dormant), **no reconciliation-report ingestion** (provider statements/reports), **no seller KYC onboarding to a PSP** (connected/linked/sub-accounts), **no chargeback webhook handling**, **no real courier payment rail** (shipping is a rate-card quote from a mock courier; `src/lib/shipping.ts`) `[GAP]`.
- Registry placeholders `stripe_my`, `curlec`, `ipay88` in `PSP_SPLIT_CANDIDATES` carry **assumption notes, not verified capabilities** — corrected by this document's research (§3): iPay88 (now NTT DATA ADAPTIS) has **no public marketplace/split documentation at all**; Curlec is **Razorpay-owned** (not Stripe-owned); Stripe MY support is newly published on stripe.com.

---

## 2. Required marketplace money flow (RM108 worked example)

Illustrative transaction (per the brief; commission expressed as a 5% rate — the engine default is 8%, both are configuration):

| Amount | MYR | Where it goes (current code) |
|---|---|---|
| Product subtotal | 100.00 | Basis of commission (appliesToShipping=false default) |
| Shipping collected | 8.00 | **Pass-through**: allocated into line gross, lands inside seller proceeds |
| Buyer pays PSP | **108.00** | `PaymentGroup.totalMinor` — the single buyer charge |
| Platform commission | 5.00 | `PLATFORM:COMMISSION` credit (T1) |
| Seller proceeds | **103.00** | `SELLER:PAYABLE` credit (T1) = (100 + 8) − 5 |

- **Invariant holds exactly:** 103 + 5 = 108 (`src/lib/commission.ts` `reconcileSplits`; ledger `LEDGER_UNBALANCED` guard at payment time) `[CODE]`.
- **The RM8 shipping is NOT platform profit and is not booked as platform revenue under any setting.** It is collected by the PSP inside the RM108, credited to the seller's payable, and the seller pays the courier out of it (courier booking today is the mock rate-card engine; real courier payment is the seller's out-of-band arrangement). If `appliesToShipping=true`, commission is *computed on* goods+shipping, but the shipping principal still flows to the seller net of commission `[CODE]`.
- **PSP processing fees are currently modelled NOWHERE** (no account, no deduction). On published rates (e.g. Stripe MY "3% + RM1.00"), an RM108 card/FPX charge costs ≈ RM4.24. **Who bears fees is an open commercial decision** (platform absorbs against commission revenue / seller share reduced / buyer surcharge — the latter subject to scheme and BNM rules) → §5 Q1, §6 `[GAP]`.
- **Refund responsibility (books):** T5 funds a refund from the seller's payable and reverses the platform's commission, crediting `GATEWAY:{provider}` — i.e., both the RM95-product-share and the commission component return to the buyer; the shipping RM8 follows the seller's share policy chosen at refund time (partial vs full amount logic in the admin refund route) `[CODE]`. **Who physically fronts the money at the PSP** (platform balance vs per-seller split reversal) is provider-model-dependent → §5 Q4.

**Intended timing (per current code):**
t0 checkout → group created, stock reserved, 30-min window → t1 verified `payment.succeeded` webhook → T1 posted, **commission recognized immediately**, seller payable credited with `available_at = paid + 7 days` (default hold) → hold expiry → amount becomes payout-eligible → seller requests payout → finance approves (T3 reserves) → provider/manual payout executes (T4 confirms / T4f reverses) → refund any time (T5 + adapter; late-after-expiry via reconciliation loop) → continuous reconciliation (wallet truth vs ledger; provider reports to be added) `[CODE]`.

---

## 3. Provider research findings (official docs fetched 2026-10-27)

Full fetch logs (URL + HTTP status per page) are archived with this assessment's research notes in the mission worklog (`psp-fitgap-3-a`, `psp-fitgap-3-b` sections, 2026-10-27). Summary matrix — **rows are NOMOFEE's requirements**, columns the candidates; a blank-ish local-provider summary follows.

### 3.1 Global / regional platforms

| Requirement | Stripe Connect¹ | Xendit XenPlatform | Curlec (Razorpay)² | Airwallex | Adyen for Platforms | 2C2P |
|---|---|---|---|---|---|---|
| Marketplace split (one buyer charge → N sellers) | [V] separate charges & transfers ("helps marketplaces split payments between multiple parties") | [V] split rules, flat/percent, "Online Marketplace" use case, **MYR** supported | [V] Route: linked accounts + transfers from orders | [V] payments for platforms: connected accounts, "automatically split funds" | [V] split payments incl. commission booking | **[N]** no split/marketplace docs at all |
| MY platform-entity eligibility | **[V-mixed]** MY listed as supported country + en-my pricing; but Connect-**platform** onboarding for a MY Sdn Bhd + cross-border transfer limits → **NEEDS CONFIRMATION** | [V-indirect] MY KYC docs, MYR split rules, MY payouts coverage; self-serve activation → confirm during activation | [V] MY company, MYR pricing published; **Route availability for MY accounts NEEDS CONFIRMATION** (Route docs sit on the Curlec MY docs site; Route pricing page links to Razorpay India) | [N] entity-country list not public → NEEDS CONFIRMATION | **[N — critical]** MY absent from the published platform onboarding country list (36 countries) | [V] MY merchants supported (gateway) |
| Commission/application-fee collection | [V] application fee / reduced transfer | [V] split rule to platform account; **fee must be deductible — splits must leave remainder for fees** (documented) | [V] platform's own linked account as transfer destination | [V] "route proceeds to sellers after deducting your platform fee" | [V] commission split type | [N] |
| Delayed settlement / payout hold | [V] `delay_days` + manual payouts; refunds don't auto-reverse transfers | [V-partial] funds sit in **sub-account balances**; platform initiates payouts via API; platform controls timing — matches NOMOFEE hold design | **[V]** `on_hold` / `on_hold_until` per transfer, indefinite hold, release via API — **direct match to NOMOFEE's holdDays model** | [V-partial] settlement time settings per destination account → confirm per-seller N-day hold | [V] per-balance-account settlement delay + scheduled payouts | [N] |
| Full/partial refunds | [V] | [V] multiple partials up to original value (cards); FPX refund semantics → confirm | [V] refund API + transfer reversal; FPX refund semantics on MY rails → confirm | [V] up to remaining refundable amount | [V] incl. split refunds (partial caveats by method) | [V-partial] refunds on settled txns; partials undocumented |
| Chargebacks | [V] disputes | [V] dispute webhooks + sandbox dispute simulation | (cards) [V]-ish; provider confirmation advised | [V] disputes | [V] split chargebacks | [N] |
| Webhook signing + retry | [V] Stripe-Signature HMAC, 5-min tolerance, 3-day exponential backoff | [V] `x-callback-token`, 6 retries exponential backoff, dashboard re-trigger | [V] `X-Razorpay-Signature` HMAC-SHA256 constant-time compare; automatic retry policy [N] | [V] HMAC per subscription; retries documented | [V] HMAC + retry queue | [V-partial] JWE/JWS on API; notification retry policy [N] |
| Idempotency keys | [V] | [V] `idempotency-key` header semantics documented | [V] idempotent refund + transfer variants documented | [N] → confirm | [V] | [N] |
| Sandbox / test mode | [V] | [V] test mode incl. split/transfers | [V] test keys, full lifecycle | [V] | [V] | [V] demo accounts |
| Reconciliation reports | [V] payout reconciliation + reports API | [V] reconciliation reports + per-method reconciliation IDs | [V] settlements API + reports | [V] transaction/settlement reports + API | [V] full report suite | [N] |

¹ Key URLs: docs.stripe.com/connect/separate-charges-and-transfers, /connect/manage-payout-schedule, stripe.com/en-my/pricing ("3% + RM1.00"), docs.stripe.com/api/idempotent_requests, /webhooks, /refunds, /disputes, /testing.
² **Correction of prior assumptions:** curlec.com is branded "Razorpay Curlec — part of the Razorpay group" (not Stripe-owned). Key URLs: curlec.com/docs/api/payments/route/create-linked-account, /create-transfers-orders, /modify-settlement-hold ("on_hold … on_hold_until … indefinitely"), /docs/api/sandbox-setup, curlec.com/pricing (cards 2.40%, FPX 1.50% or RM1, Premium tier 2.00%/1.00%).
Other key URLs: docs.xendit.co/docs/split-payments.md (+ llms.txt index), docs.xendit.co/docs/xenplatform-overview.md, /docs/activate-xenplatform.md, /docs/testing-xenplatform-features.md, /apidocs/create-payout-v3.md; docs.adyen.com/platforms, /marketplaces, /platforms/custom-payouts/configure-settlement-delay, /api-idempotency; airwallex.com/docs/payments-for-platforms/overview, /payment-operations/reporting, /developer-tools/webhooks/webhooks-overview.

### 3.2 Malaysian local PSPs

| Requirement | Billplz | ToyyibPay | SenangPay (DOKU) | iPay88 / GHL (NTT DATA) | HitPay |
|---|---|---|---|---|---|
| Split / commission | [V] **FPX-only** Split Rule, **≤ 2 recipients** per collection, fixed/variable cut | [V] FPX-only `billSplitPaymentArgs` per-recipient amounts; Enterprise sub-user creation API | [V-marketing] "Split Payments" marketed; **mechanics undocumented** | **[N]** nothing public (sites now NTT DATA ADAPTIS marketing) | [U] unreachable from this environment |
| Seller payouts | [V] DuitNow Payment Orders (**pre-funded float required**) | [N] marketing only | [V] DOKU Payouts API (MY domestic) | [N] | [U] |
| Delayed hold | [N] platform holds funds itself (T+1 payout-to-own-bank) | [N] | [N] | [N] | [U] |
| Refunds | [V] **via disbursement** ("FPX transactions are non-reversible"); card refunds via support email | **[N]** no refund documentation at all | [V] **cards + same-day e-wallet only — NO FPX refunds** (FAQ) | [N] | [U] |
| Webhooks | [V] HMAC-SHA256 (bills) / SHA512 (payment orders), 5-attempt retry schedule | [V] **MD5 hash** (weaker scheme) | [V] signature + manual resend | [N] | [U] |
| Idempotency | [N] | [N] | [V] documented (24 h key window) | [N] | [U] |
| Sandbox | [V] full mirror environment | [V] bank simulators | [V] sandbox portal | [N] | [U] |
| Reconciliation | [V] statements + guides | [N] | [N] | [N] | [U] |
| Published pricing | [V] (FPX from RM0.75–1.25/txn by plan; DuitNow payout fee) | [V] (FPX RM1; cards 1.5% + RM100 onboarding) | [V] (FPX RM1 or 1.5%; plans RM199–349/yr) | none public | [U] |

**PayNet/FPX context [V]:** FPX acquiring is available directly via a member acquiring bank (MRF registration → staging → production Seller IDs; settlement to the platform's own business account) or via any PSP third-party acquirer — but PayNet provides **no split/commission/hold layer**; those are PSP concerns. FPX buyer limits: RM30,000 individual / RM1,000,000 corporate per transaction.

---

## 4. Capability comparison vs NOMOFEE's required workflow

**Decisive observation — two fund-flow families:**
- **Family A — split-capable platforms** (Curlec Route, Xendit XenPlatform, Stripe Connect, Airwallex, Adyen): the PSP itself splits the RM108 (commission to platform, remainder to seller sub-accounts), can hold/release settlement, and reverses on refund. This **preserves the architecture's stated intent** ("NOMOFEE NEVER TAKES CUSTODY OF BUYER FUNDS", `src/lib/psp.ts` Option B) — the platform's ledger remains the accounting mirror it was designed to be.
- **Family B — collection + disbursement gateways** (Billplz, ToyyibPay, SenangPay/DOKU, 2C2P): the RM108 settles gross to the PLATFORM's account; seller payouts are separate pre-funded disbursements. Under this family **the platform takes custody of buyer funds** — directly contradicting the Option B intent and raising Bank Negara Malaysia licensing questions (Merchant Acquiring Services / e-money / money services business scope) that MUST be answered by qualified advisers before choosing this family `[GAP — legal, see §5 Q8]`.

**Fit per requirement (Family A shortlist only):**

| NOMOFEE requirement (code evidence) | Curlec | Xendit | Stripe | Airwallex | Adyen |
|---|---|---|---|---|---|
| One buyer payment → N per-seller orders (PaymentGroup) | [V] transfers to N linked accounts | [V] split rules w/ multiple routes | [V] one charge → N transfers | [V] | [V] |
| Commission RM5 at payment time (T1) | [V] platform account as destination | [V] flat/percent split rule | [V] application fee / reduced transfers | [V] | [V] commission split |
| 7-day hold then payout (available_at / holdDays) | **[V] on_hold_until — closest semantic match** | [V] sub-account balance + platform-initiated payout | [V] delay_days (payout-schedule semantics — verify per-account minimums) | [V-partial] settlement time settings | [V] settlement delay per account |
| Refund w/ commission reversal (T5 + adapter) | [V] refund + transfer reversal | [V] partial refunds (cards) — FPX semantics confirm | [V] refunds; transfers reversal is platform's job | [V] | [V] split refunds |
| Late-payment reconciliation loop | map `getRefundStatus` → settlements/refunds API | [V] status + reconciliation IDs | [V] retrieve APIs + reports | [V] reports | [V] reports |
| Webhook contract (sign-before-trust, replay window) | HMAC-SHA256 (same family as our verifier) | token header — **different scheme, adapter must implement** | Stripe-Signature — different scheme | HMAC per subscription | HMAC |
| Idempotency (checkout + outbound) | [V] idempotent variants | [V] idempotency-key header | [V] | [N] confirm | [V] |
| FPX (dominant MY method) | [V] FPX 1.5%/RM1 published | [V] FPX via PayNet documented | [V] FPX 3%+RM1 (en-my pricing) | [V] FPX (APAC methods) | [V] FPX acquiring |
| MY entity as platform | **confirm Route for MY accounts** | [V-indirect] activation self-serve | **confirm Connect platform for MY entity** | **confirm** | **[N] MY absent from platform country list — likely blocked** |

**Family B blockers (vs our requirements):** Billplz — ≤2 split recipients **cannot express a 3+ seller cart**; FPX-only split; pre-funded payout float; refunds-by-disbursement (workable but custody model). SenangPay/DOKU — split undocumented; **no FPX refunds** (material for the dominant method). ToyyibPay — no refund docs; MD5 callbacks. iPay88/GHL/2C2P — no public marketplace capability. HitPay — unverifiable from this environment.

---

## 5. Commercial & operational questions awaiting WRITTEN answers

Must be answered in writing by the provider's sales/technical team (or qualified advisers) before implementation. Public documentation does not establish them.

**Fund flow & eligibility**
- **Q1 (all):** Exact processing-fee bearer mechanics for split payments — is the fee netted from the platform's commission share, the seller share, or charged separately? (Xendit documents that splits must leave a fee remainder — confirm the arithmetic in MYR for our RM5/RM103 split.)
- **Q2 (Curlec):** Is Route (linked accounts, transfers, `on_hold`/`on_hold_until`) enabled for Malaysia-registered platform accounts in MYR? What are linked-account onboarding/KYC requirements for MY sellers?
- **Q3 (Stripe):** Can a Malaysian Sdn Bhd onboard as a Connect **platform** (not only a Standard merchant), with MY connected accounts and domestic MYR separate-charges-and-transfers in production? What are the minimum `delay_days` for MY accounts?
- **Q4 (all shortlist):** Refund funding mechanics — does the PSP reverse the split (commission + seller shares) automatically, or must the platform balance be pre-funded? What happens on insufficient seller sub-account balance (negative balance / reserve policy)?
- **Q5 (all shortlist):** FPX refund semantics on their MY rails (SenangPay/DOKU publicly state FPX is non-refundable; Billplz routes refunds via disbursement; Curlec/Xendit/Stripe card-oriented docs don't state FPX refund behaviour) — **the single biggest universal gap.**
- **Q6 (Xendit):** XenPlatform approval criteria and pricing for a MY master account; FPX settlement timing to sub-account balances; dispute-liability questionnaire expectations.
- **Q7 (Airwallex):** MY entity eligibility for platform + connected accounts; request-level idempotency mechanism; configurable per-seller payout hold.
- **Q8 (advisers — legal/tax, BNM):** Under each candidate fund flow, is NOMOFEE's role outside Merchant Acquiring Services registration scope (FSA 2013 s.11/s.17), e-money issuance (FSA 2013 s.52-53), and MSB licensing (MSBA 2011)? Confirm the Family-B custody implications and any consumer-protection/PTA obligations. *(Questions for qualified advisers — this document asserts no legal conclusions.)*
- **Q9 (all):** Settlement/timing SLAs per payment method (FPX/card/e-wallet) to sub-account or platform balance; bank payout cutoffs and rails (DuitNow vs IBG); reconciliation report formats and access (API/dashboard/export).
- **Q10 (all):** Sandbox test coverage — which of the 12 acceptance cases (§8) can be driven in their sandbox (esp. dispute simulation, timeout/unknown-outcome simulation, partial refunds on FPX rails, payout failure simulation)?

---

## 6. Recommended provider (CONDITIONAL)

**Primary recommendation: Curlec (Razorpay Curlec) — conditional on Q2.**
Its public documentation uniquely matches NOMOFEE's designed money model end-to-end: linked accounts (seller sub-accounts) + split transfers (commission) + **`on_hold`/`on_hold_until` settlement hold (the holdDays equivalent)** + refund APIs with transfer reversal + idempotent request variants + sandbox with test keys + published MYR pricing — and it is a Malaysian company on BNM-registered rails. The single gating confirmation is Route availability for MY platform accounts (the docs live on the Curlec MY site but Route pricing links to Razorpay India).

**Backup 1: Xendit XenPlatform — conditional on Q6.** Best-documented MY marketplace fit overall (MYR split rules, sub-account balances with platform-initiated payouts, FPX, idempotency keys, test mode, reconciliation reports); the hold is platform-controlled rather than provider-side, which maps cleanly onto our T1 `available_at` design.

**Backup 2: Stripe Connect — conditional on Q3.** Deepest marketplace tooling and the strongest sandbox/dispute simulation; MY support is newly published (en-my pricing exists) but Connect-platform eligibility for a MY entity requires written confirmation; also note MYR pricing (3%+RM1) is the highest of the shortlist.

**Not recommended as primary:** Adyen (MY absent from published platform onboarding countries; enterprise sales motion), Airwallex (strong but two open confirmations incl. idempotency), and all Family-B local gateways (custody model + capability gaps above — Billplz remains a viable fallback only for ≤2-seller FPX-only carts if legal sign-off on custody is obtained, which is not the marketplace norm).

**All recommendations are conditional on §5's written confirmations and §9's decisions — no provider is "selected" until those land.**

---

## 7. Required credentials, webhook configuration, sandbox & onboarding (per chosen provider)

| Item | Detail |
|---|---|
| API credentials | Platform/master API keys (secret — secret-manager only, cf. `09-environments-secrets.md`); per-environment (sandbox/live); key rotation procedure |
| Seller onboarding | Connected/linked/sub-account application flow mapped from NOMOFEE seller KYC (we store masked bank details + KYC status today — providers need full beneficiary details at THEIR side; define the data hand-off) |
| Webhook configuration | Provider dashboard endpoint → `POST /api/webhooks/payments/{provider}`; register event types (`payment.succeeded/failed`, refund/settlement/payout/dispute events); obtain the signing secret (replaces/augments `PSP_WEBHOOK_SECRET`); confirm retry policy + tolerance window vs our ±10 min STALE_EVENT (may need per-provider window config) |
| Sandbox access | Test API keys + test payment methods (FPX simulators, test cards); dispute/timeout simulation availability (Q10) |
| Onboarding docs (business) | SSM registration, business bank account (MYR), director/UBO identity docs, website compliance review, projected volumes; PSP contract + pricing schedule |
| Payout setup | Beneficiary verification, payout rails (DuitNow/IBG), pre-funding requirements (if any), settlement reports access |

---

## 8. Sandbox acceptance suite (12 cases) & executability

Cases 1–12 from the brief, mapped to our existing internal rails first (all 12 are already exercised on the mock rails — `2026-10-27-deployment-smoke.json` 22/22, `2026-10-27-finance-regression.json` failures:0, scheduler-e2e, late-payment-refund S1–S10), then re-run against the chosen provider's sandbox:

| # | Case | Internal (mock) | Provider sandbox | Production/manual only |
|---|---|---|---|---|
| 1 | Single-seller payment | PASS (archived) | YES — all candidates | — |
| 2 | Multi-seller checkout | PASS (archived) | YES for split-capable (Curlec transfers / Xendit routes / Stripe charge+transfers); Billplz-style CANNOT (>2 recipients) | — |
| 3 | Payment failure + pending | failure PASS; pending is mock-instant | YES — failure trivially; **pending** requires an async method (e-wallet/BNPL) or provider test tooling | — |
| 4 | Duplicate + out-of-order webhooks | PASS (duplicate convergence, T1 1→1) | YES — replay via provider retry/`re-trigger`; observe their ordering behaviour | — |
| 5 | Provider timeout, unknown outcome | simulated (mock timeout behavior) | PARTIAL — needs provider status-query API (map to `getRefundStatus`-style polling); timeout simulation where offered (Q10) | — |
| 6 | Retry with same idempotency key | PASS (outbound keys designed) | YES where idempotency documented (Curlec/Xendit/Stripe/Adyen/DOKU) | — |
| 7 | Expired reservation + late payment | PASS (S1–S10 archived) | PARTIAL — late-capture semantics are method-specific (FPX settles instantly; card auth expiry differs); confirm per method | — |
| 8 | Full + partial refund | PASS on mock adapter | YES on cards; **FPX per-provider (Q5 — may require disbursement fallback)** | — |
| 9 | Commission + proceeds reconciliation | PASS (ledger invariants, 0 drift) | YES — cross-check provider split/settlement reports vs ledger T1/T2 | — |
| 10 | Settlement eligibility, transfer, payout, payout failure | PASS on mock payout adapter (dormant scaffold) | transfers YES; **real bank payout to a seller bank account requires a production-approved account** (sandbox payouts are usually simulated) | bank payouts, paid confirmations |
| 11 | Chargeback / dispute | NOT implemented (no dispute automation) | ONLY where the provider sandbox simulates disputes (Stripe test disputes [V], Xendit sandbox dispute simulation [V], Adyen [V]); FPX has no chargebacks (push payments) | provider live dispute flow |
| 12 | DB failure & recovery without duplicate postings | PASS (fault injection, exactly-once retry — finance-regression case 11) | n/a (internal) — re-run around each provider interaction to prove no double-posting on their retries | — |

---

## 9. Decisions & access required BEFORE implementation

1. **D1 — Fund-flow family decision** (split-capable vs collection+disbursement) with legal-adviser sign-off on Q8. This decision determines whether the Option B "no custody" architecture intent survives.
2. **D2 — Provider written confirmations** (§5 Q1–Q7, Q9–Q10) received in writing; contract + pricing signed.
3. **D3 — PSP fee-bearer decision** (platform absorbs / seller share reduced / buyer surcharge) → then implement the missing fee ledger account + commission-engine adjustment `[GAP §1.7]`.
4. **D4 — FPX refund strategy** (provider native refund vs disbursement fallback vs refund float) → maps onto the existing `RefundAdapter` + `refund-reconcile` operator escalation.
5. **D5 — Sandbox credentials obtained** and the §8 suite green-lit for execution.
6. **D6 — Seller onboarding mapping** defined (KYC data hand-off to connected/linked/sub-accounts).
7. **D7 — Hosting/staging prerequisites** (unchanged blockers from `performance/REPORT.md` §Q: staging deployment, platform cron, production secrets).

**Proposed implementation sequence (post-decision, separate task):** adapter A (hosted checkout + real webhook signature per `11-provider-integration-contract.md`) → fee model → refund adapter + reconciliation mapping → payout wiring via `PspPayoutAdapter` → seller onboarding mapping → full 12-case suite in provider sandbox → staging capacity validation → production cutover per the readiness checklist.

---

## Honest boundary (unchanged)

NOMOFEE is **NOT PSP-integrated**. Everything in this document is an assessment of readiness and provider fit; no provider sandbox has been contacted, no credentials exist, and no capability above may be treated as delivered until the corresponding integration task is executed and verified. Shipping (RM8) is a pass-through with no documented accounting basis for platform profit; PSP fees have no bearer decision yet. All provider facts are as published on 2026-10-27 and must be re-verified at contracting time.

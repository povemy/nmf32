# Seller KYC Ownership — Decision Assessment (Phase 3 carry-forward)

**Status:** decision assessment prepared for the owner — no implementation performed, no document
collection added, no provider contracted (per the work order: no unnecessary collection of identity
documents before an approved model).

---

## 1. Current implementation (verified by code read, 2026-11-03)

| Piece | State |
|---|---|
| `Seller.kycStatus` | metadata column, default `pending`; **deliberately NOT consulted by the store-approval lifecycle** (`src/lib/store-lifecycle.ts` — approval is an ops judgment; the Step 4 marketplace E2E proved the honest gate: unapproved storefront 404 → ops approve → live) |
| `Seller.emailVerifiedAt` | **real email-ownership verification** (Phase 2.3 C2.7: OTP challenge consumed in the same transaction; verified live in Step 4) |
| `KycDocument` rows | **METADATA ONLY** (`docType`, `fileName`, `status`, `reviewedBy/At`) — no document bytes are ingested or stored anywhere; rows can only appear via out-of-band seeding (the review route's own honesty header states this) |
| Admin KYC review route | `POST /api/admin/sellers/[id]/kyc/[docId]` (approve/reject with reason + audit row) — reviews *metadata*, never claims the document was received or verified |
| Seller onboarding | self-service: email OTP verification, store creation, first-product `pending_review` moderation; logs a `kyc.submitted` activity event |
| Bank accounts | `BankAccount` model exists (payout rails) — payout execution is manual/offline by finance ops (T-A4 with reference), so no PSP-side beneficiary verification exists yet |

**Net: the platform verifies email ownership and exercises operational approval, but performs NO identity
verification of sellers. This is honest (nothing claims verification that did not occur) but incomplete for
real money.**

## 2. The three options

### Option A — Provider-managed KYC/KYB (PSP performs KYC)
*How it works:* the PSP onboards each seller as a linked/sub-account and performs KYC/KYB itself; NOMOFEE
records the PSP's verification verdict (webhook/API) and never touches documents.
* **Pros:** zero PII custody for NOMOFEE (no document storage, retention policy, or breach surface); the
  PSP's compliance machinery is audited and maintains BNM/AMLA obligations; payout rails are unlocked to
  verified beneficiaries (Curlec Linked Accounts / CHIP verified recipients work exactly this way — see
  docs/psp-readiness/phase3-work5-psp-research-update.md).
* **Cons:** tied to the PSP choice (owner decision D1 still open); per-seller onboarding friction; approval
  SLAs outside NOMOFEE's control; monthly/platform fees.
* **Cost:** platform fee only (no NOMOFEE engineering beyond the verdict-sync webhook + status surface).

### Option B — NOMOFEE-managed document collection & verification
*How it works:* sellers upload SSM/ID documents; NOMOFEE stores them (object storage + encryption +
retention) and staff verify manually.
* **Pros:* full control; no PSP dependency.
* **Cons:** NOMOFEE becomes a PII/identity-document custodian — secure upload pipeline, encryption at rest,
  access controls, retention/destruction policy, breach liability, and Malaysia AMLA/PDPA obligations all
  become NOMOFEE's problem; significant engineering (the current `KycDocument` is metadata-only *by
  honesty design*); verification quality is worse than a PSP's bank-grade checks; does NOT unlock payout
  rails (banks still need beneficiary verification for transfers).

### Option C — Hybrid (recommended)
*How it works:* **the PSP performs KYC for every seller that receives payouts** (Option A mechanics), while
NOMOFEE keeps only *non-document* operational signals (email ownership — already live; store approval —
already live; risk tier / review notes — already modeled) plus a thin verdict-sync surface.
* **Pros:** KYC burden lands on the audited party; payout rails unlock naturally; NOMOFEE retains
  operational control of the marketplace (approval, moderation, risk tiers) without PII custody; matches the
  provider-neutral architecture (verdict ingestion is generic: status + providerRef + timestamps).
* **Cons:* onboarding flow must surface PSP-verification status (UX work at integration time); a seller
  rejected by the PSP needs a support path.

## 3. Recommendation

**Option C (hybrid, PSP-managed KYC for payout-eligible sellers).** It is the only option that both (a)
avoids making NOMOFEE an identity-document custodian and (b) unlocks verified payout rails. Option B is
strictly worse on risk, cost, and capability; pure Option A discards useful operational signal NOMOFEE
already has.

**Operational implications:** verdict-sync webhook ingestion + seller-status surfacing at PSP integration
time; ops runbook entry for PSP-rejected sellers; `kycStatus` becomes a *derived mirror* of the provider
verdict (honesty rule preserved: null/unknown = unverified).
**Privacy/security implications:** NOMOFEE stores no identity documents; PDPA exposure limited to the
existing business-contact data; breach blast radius unchanged.

## 4. Launch implication

**Not a public-launch blocker for the non-money track** (no payouts happen without a PSP anyway), but it IS
a **precondition for the real-money pilot**: seller payouts must only flow to PSP-verified beneficiaries.
The decision itself (choosing the model) should be made together with D1 (PSP selection) since the two are
architecturally coupled.

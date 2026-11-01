# Phase 2.3 — Seller verification (C2.7 email verification + KYC honesty, C2.5 bank accounts)

Created 2026-11-07 · task P2.3-3/4. Companion migration:
`prisma/migrations/20261107000000_phase23_seller_verification` (authored, NOT applied).

## What IS implemented (this phase)

- **Seller email verification (genuine, C2.7).** New OTP purpose `"seller-email"`
  reuses the guest-otp machinery (HMAC'd code hashes, 5-attempt lockout,
  attempt carry-over, day-bucket rollover, CAS exactly-once consume).
  - `POST /api/auth/seller/email-verification/request` — seller-session
    authenticated; rate-limited (5/min/IP, 3/h/account); the code goes to the
    session's OWN seller email only (never caller-supplied).
  - `POST /api/auth/seller/email-verification/verify` — consumes the
    challenge and sets `Seller.emailVerifiedAt` **in the same `$transaction`
    as the consume** (optional `onWin` hook in `verifyEmailOtp`), itself
    CAS-guarded (`WHERE emailVerifiedAt IS NULL`). This route is the ONLY
    writer of that column.
  - Registration best-effort sends the first code (never blocks signup) and
    honestly returns `emailVerified: false`.
  - Seller console: Dashboard shows a "Verify your email" card driven by
    `/api/store/me`'s `seller.emailVerified` (tolerant read: null column,
    stale client or un-migrated DB ⇒ **not verified**).
- **KYC honesty.** `kycStatus: "approved"` is only ever written by
  admin-reviewed decisions (the KYC doc auto-rule in
  `admin/sellers/[id]/kyc/[docId]` and the admin seller state routes); its
  comment now states exactly what "approved" means. `KycDocument` rows are
  METADATA ONLY — no bytes are ingested, no route creates them, and the
  admin copy no longer implies an upload pipeline ("No document records").
- **Publish gating.** Store publish requires `seller.status === "active"`
  (Phase 2.2, untouched here).
- **Bank accounts (C2.5).** `POST /api/store/bank-accounts` now seals the
  full account number with the real AES-256-GCM secretbox
  (`sealSecret` → `accountNumberEnc`), stores `accountNumberMasked =
  "••••" + last4`, validates 5–31 digits, and every read surface
  (`/api/store/bank-accounts` GET/POST, kyc-queue, admin seller profile)
  returns masked fields ONLY — never the ciphertext, never the full number.

## What REQUIRES OWNER decisions (NOT implemented on purpose)

1. **Document storage backend + retention policy.** No object storage is
   wired; "uploading" KYC documents is impossible today (rows are metadata
   seeded out-of-band). Choosing a store (Supabase Storage / S3 / other),
   upload route, virus scanning, encryption-at-rest and a deletion/retention
   policy (jurisdiction-sensitive) is an owner + legal decision.
2. **Provider-managed KYC via the PSP.** Recommended path per the Phase 2.3
   PSP research: **Curlec Route linked accounts** — the PSP onboards and
   verifies the seller's identity + bank details; NOMOFEE stores only a
   linked-account reference and stops being a PII/PA-DSS surface for account
   numbers. If that decision lands, `BankAccount.accountNumberEnc` should be
   phased out (migrate to provider-managed onboarding).
3. **Jurisdiction-specific requirements** (MY AML/KYC thresholds, doc types,
   periodic re-verification) must come from the owner/legal — nothing here
   guesses at them.
4. **Decryption of bank numbers.** `openSecret` is intentionally NOT wired to
   any route: no admin view displays full numbers today. When the manual
   payout execution view needs them, decryption belongs in that single
   admin-only route (payouts.manage cap). Key rotation: see the contract in
   `src/lib/secretbox.ts`.

## Legacy data note (C2.5)

Rows created before this phase store `accountNumberEnc = "enc:<last4>"` (a
masked tail, not a ciphertext). They cannot be decrypted (`openSecret` fails
them gracefully) — the seller must re-enter the account number. No data
migration is performed.

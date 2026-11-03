# Shopper Password Recovery — Recommended Design (Phase 3 carry-forward)

**Status:** design documented only — NOT implemented (per the work order: do not silently change the
authentication architecture). Current state verified by code read, 2026-11-03.

---

## 1. Current state (verified)

| Capability | Status |
|---|---|
| Shopper login/register | live (`/api/auth/shopper/*`, Argon2id hashes) |
| Shopper **password recovery** | **DOES NOT EXIST** — no reset-request route, no token table, no reset route (only login/register exist under `api/auth/shopper/`) |
| Guest-order OTP access | live and staging-proven (knowledge pair → OTP → 15-min HMAC grant; a *guest order access* system, not account recovery) |
| Admin MFA recovery | live and staging-proven (recovery codes + offline operator reset runbook; an *admin MFA* system, not password recovery) |
| Seller password recovery | also absent (same gap family; sellers currently recover via operator) |

The three systems above are deliberately distinct; this design adds the missing fourth: **shopper account
password recovery**, without touching the others.

## 2. Gap analysis

A shopper who forgets their password **cannot regain access to their account** (orders, claiming, wallet
view). The only workaround is operator-side (manual), which does not scale and creates support load. For a
public launch with registered checkout, this is a genuine account-availability gap — and the standard
account-takeover vector if done sloppily, so the design must reuse the platform's proven OTP/mailing
infrastructure rather than inventing a parallel one.

## 3. Recommended design (reuses existing, proven primitives)

**Flow:** request → emailed single-use link/code → verify → set new password → session revocation.

1. **Request (`POST /api/auth/shopper/password-reset/request` { email })**
   * **Uniform 200 always** (registered and unknown addresses are indistinguishable — no account-existence
     oracle; mirrors the guest-OTP uniform-response rule).
   * Rate limits: 3/hour/email AND 5/hour/IP (per-IP tighter than register — reset is the higher-value
     oracle target). 429 with Retry-After.
2. **Token issuance (server-side, reuses `EmailOtpChallenge` table + patterns)**
   * 32-byte random token (URL-safe base64) → **stored hashed** (SHA-256 keyed with the existing
     `EMAIL_OTP_SECRET` HMAC, same family as session-token hashing) — plaintext token exists ONLY in the
     email body.
   * TTL **15 minutes**, single-purpose; one open challenge per shopper (new request supersedes+deletes the
     prior — CAS, exactly like the guest-OTP consume).
   * Delivered through the existing `TransactionalEmailChannel` (Mailpit in dev/staging; Resend in
     production) with the existing suppression check (suppressed addresses get the uniform 200 and no send,
     audit `issued:false, suppressed:reason` — identical to the guest-OTP delivery-failure semantics proven
     in Step 4).
3. **Verify + reset (`POST /api/auth/shopper/password-reset/confirm` { token, newPassword })**
   * Constant-time token compare (hash-then-compare, same as cron secret); attempt counter with lockout (5
     attempts → challenge dead, uniform 401s) — replay/brute-force posture identical to guest OTP.
   * On success, ONE transaction: consume challenge (delete), update `passwordHash` (Argon2id), **revoke all
     sessions** for the shopper (`DELETE FROM Session WHERE userId = …`), write an audit row
     (`shopper.password.reset`, actor=system-via-email-proof).
   * New password policy identical to register (unchanged validation).
4. **Audit logging:** request rows (rate-limited, no PII beyond hashed email key), success/failure events —
   same ActivityLog family as `admin.mfa.reset`.
5. **What this deliberately does NOT do:** no security questions, no email change during reset, no session
   preservation, no admin-initiated resets (shoppers are self-serve; admin reset remains an MFA-gated
   possibility ONLY if support load justifies it later — separate decision).

## 4. Rejected alternatives

* **Email-based one-time login (passwordless magic link) instead of reset:** bigger authentication-model
  change (the work order forbids silent architecture changes); can be layered later.
* **OTP code instead of link:** equivalent security; a link is one click fewer and carries the token in the
  fragment-free path param — either works; code-based reuses the OTP email template family. Recommend the
  **link** form with the token in the query string served over the existing HTTPS edge.
* **Reuse of the guest-order OTP challenge purpose:** rejected — purpose separation (`purpose:
  "shopper-password"`) keeps claim/consume semantics independent (a guest-order OTP must never unlock an
  account).

## 5. Is this a public-launch blocker?

**CONDITIONAL — YES for public launch, NO for the non-money staging acceptance.**
* Non-money staging acceptance: not required (test accounts are operator-managed).
* Real-money controlled pilot: strongly recommended (paying customers who lose passwords generate support
  load and chargeback-adjacent frustration, and operator-side recovery does not scale).
* Public launch: **should be treated as a blocker** — a public marketplace without self-serve password
  recovery is an availability and support liability. The design above is deliberately small (≈2 routes, one
  migration-free reuse of `EmailOtpChallenge` with a new purpose value, email template) and rides entirely on
  primitives already staging-proven (uniform responses, CAS consume, rate limits, hashed-at-rest tokens,
  session revocation, audit rows).

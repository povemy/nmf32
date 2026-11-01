# NOMOFEE — Guest-Order Ownership Verification (Email OTP) — Implementation Design

**Status: DESIGN COMPLETE — BLOCKED on one external decision (transactional
email provider).** No code was shipped for this flow in Phase 2.1: the platform
has NO real email-delivery mechanism (the notification system is in-app
DB-rows only; the seller `notify()` logger records channels, it does not send
mail), and per the Phase 2.1 mandate we do not fake OTP delivery or expose
codes in API responses/logs. This document is the complete, code-ready design
so implementation is a short step once the provider decision lands.

---

## 1. Current state (verified in Phase 2.1)

| Surface | Auth required today | Data released |
|---|---|---|
| `GET /api/orders/lookup?email=&orderNumber=` | knowledge pair (email + NM number), 3-axis throttled, uniform 404 | order status, totals, items(titles+qty), history, store info |
| `GET /api/orders/receipt?email=&orderNumber=` | same pair, payment-gated (409 while unpaid), PSP ref stripped | PDF with customer NAME, EMAIL, **PHONE**, items, totals, refunds |
| Chat order-context (`POST /api/chat/threads`) | **hardened in Phase 2.1**: `shopperId === me.id` only (unverified-email fallback removed) | order summary card in thread |
| Guest-order claiming at registration | email match (`claimGuestStateForShopper`) — inherent to the claimable design | full account-scoped access to claimed orders |

**Residual exposure (accepted, throttled):** anyone knowing a customer's
email + order number can read the lookup payload and the receipt PDF (incl.
phone). Phase 1's throttles (10/min/IP, 10/h/email, 30/h/order) make
enumeration impractical, but a phished/leaked pair yields full access. This
design closes that.

**Root cause noted for the record:** shopper registration itself does not
verify email (no `emailVerified` in the model), so email-match grants (chat
fallback — removed; guest-order claiming at registration — preserved by
mandate) are knowledge-of-email only. The same OTP mechanism below should,
in a later phase, gate claiming and registration verification.

---

## 2. Chosen mechanism: short-lived 6-digit email OTP → restricted access token

OTP-over-email to the address ALREADY on the order (never caller-supplied),
then a signed short-lived **order-access grant**. Chosen over magic links
because: no new routes/redirect surface (SPA), works inside the existing
knowledge-pair UX (lookup page), codes are typeable cross-device, and the
grant token model is identical to the import-capability HMAC pattern already
in production (`src/lib/import-cap.ts`) — one consistent primitive.

## 3. Delivery seam (the external decision)

`GuestOtpChannel` interface with exactly one production implementation slot:

```
interface GuestOtpChannel { send(toEmail, code, orderNumber): Promise<void> }
```

- Provider candidates (Malaysia-market fit): Resend, Postmark, AWS SES, or the
  Supabase project's own Auth mailer via an admin API (already in the env —
  but that couples order-OTP to Supabase Auth and is NOT recommended).
  **Decision required from ops:** one transactional provider + domain
  (SPF/DKIM) for `orders@nomofee.io`.
- Until a provider is configured, the two new routes answer
  **503 `ORDER_OTP_NOT_CONFIGURED`** — identical fail-closed posture to
  `MFA_ENCRYPTION_KEY` / `PSP_WEBHOOK_SECRET`. No fake dev sender: dev may
  point the channel at a local SMTP sink (Mailpit) for testing, which is a
  real (local) provider, not a fabricated one.

## 4. Flow

1. `POST /api/orders/otp/request { email, orderNumber }`
   - Uniform 200 ALWAYS (never reveal whether the order exists).
   - Input validation: email ≤254, orderNumber ≤32 (same caps as lookup).
   - Rate limits (in-memory `rateLimitKey`, existing infra):
     5/min/IP + 3/h/email + 5/h/orderNumber + **3/h/(email,orderNumber) pair**.
   - If (and only if) the pair matches an order: mint a 6-digit numeric code
     (crypto random, mod-10^6, zero-padded), store **sha256(code ‖ orderId ‖
     day-bucket)** hashed with `GUEST_OTP_SECRET` (HMAC — keyed, not plain
     sha256, so DB reads can't brute-force the 10^6 space offline), TTL
     **10 minutes**, max **5 attempts**, single row per order (latest wins —
     an older request is implicitly superseded).
   - Send ONLY to `order.customerEmail` (the address on file).
   - Never log the code; audit records carry {orderId, channel:"email"} only.
2. `POST /api/orders/otp/verify { email, orderNumber, code }`
   - Same rate-limit axes as lookup (plus the row's own attempt counter).
   - Wrong code → uniform 401 `INVALID` (attempts decremented; 5th wrong →
     row locked; further tries uniform 401 until TTL).
   - Right code → **consume the row atomically** (`updateMany WHERE hash =
     storedHash` CAS — replay of the same code impossible) and mint a signed
     **order-access grant**: `oag = orderId.expiryTs.hmac(ORDER_ACCESS_SECRET)`,
     TTL **15 minutes**, bound to the single orderId.
   - Response: `{ accessGrant }` only — never order data + grant together
     (keeps the verify response uniform in size/timing).
3. `GET /api/orders/lookup` / `receipt` accept **either** the knowledge pair
   (today's behavior, unchanged — support + legacy compatibility) **or**
   `Authorization: Bearer oag…` (grant path). The grant path skips the
   knowledge-pair check; BOTH paths keep all existing throttles. Receipt
   additionally keeps the payment gate.
4. Grant hygiene: single order scope; 15-min TTL; no refresh; revocation not
   needed (short TTL); HMAC secret fail-closed in production like the others.

### What deliberately does NOT change
- Guest checkout, NM- order numbers, guest-order claiming, the knowledge-pair
  lookup for support workflows, all existing throttles.

## 5. Schema addition (ONE new table — created only when the provider lands)

```sql
CREATE TABLE "GuestOrderOtp" (
  "id"        TEXT NOT NULL,
  "orderId"   TEXT NOT NULL,
  "codeHash"  TEXT NOT NULL,          -- HMAC-SHA256(GUEST_OTP_SECRET, code|orderId|bucket)
  "attempts"  INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestOrderOtp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GuestOrderOtp_orderId_key" ON "GuestOrderOtp"("orderId");
```

No PII beyond the orderId FK; codes are hashed; rows are swept by the existing
session-purge cron pattern (add a 15-min-throttled delete of expired rows).

## 6. Requirements checklist (from §4 of the Phase 2.1 mandate)

| # | Requirement | Where |
|---|---|---|
| 1 | Verification only to the email on the order | request route reads `order.customerEmail` — never caller input |
| 2 | No redirection to another address | same |
| 3 | Secrets stored hashed | HMAC-keyed hash (§4.1) |
| 4 | Expiry + attempt limits | 10-min TTL; 5 attempts; pair lockout |
| 5 | IP/email/order rate limits | 4 axes (§4.1) |
| 6 | OTP replay prevention | CAS consume on verify (§4.2) |
| 7 | No code enumeration | uniform responses; constant-shape verify |
| 8 | Uniform existence responses | request route ALWAYS 200; verify 401 uniform |
| 9 | Short-lived restricted token after verify | 15-min single-order HMAC grant |
| 10 | Receipt protected independently | grant accepted on BOTH routes; payment gate stays |
| 11 | Verified access not unlimited/permanent | TTL, no refresh, per-grant scope |
| 12 | Guest checkout + claiming preserved | nothing in the flow touches them |

## 7. Estimation after provider decision

~1 day: table + migration, `src/lib/guest-otp.ts` (issue/verify/grant —
mirror of `import-cap.ts` + `mfa.ts` primitives), two routes, channel
implementation (~40 lines for Resend/Postmark/SES alike), lookup/receipt
Bearer acceptance, unit tests (mirroring mfa.test.ts's pure-crypto style),
plus the staging E2E pack entry. **Zero changes to checkout/ledger/inventory.**

# NOMOFEE — Guest-Order Ownership Verification: OTP + Access Grants

**Status: IMPLEMENTED (FINAL CLOSURE).** This document supersedes the earlier
Phase 2.1 draft, whose authorization model was **rejected as insufficient**:
that draft let `/api/orders/lookup` and `/api/orders/receipt` accept *either*
the knowledge pair (email + order number) *or* a verified OTP grant — which
left the original vulnerability (knowledge-pair authorization bypass) fully
intact. The corrected model below is what now ships in the code.

---

## 1. The corrected authorization model (the core of FINAL CLOSURE §1)

```
                          ┌─────────────────────────────────────────────┐
  email + NM- order no. ──► POST /api/orders/otp/request                 │
  (the "knowledge pair")  │  → may REQUEST a verification challenge ONLY │
                          │  → NEVER authorizes order data              │
                          └──────────────┬──────────────────────────────┘
                                         │ 6-digit code → the email ON the order
                                         ▼
                          POST /api/orders/otp/verify (CAS consume)
                                         │
                                         ▼ 15-min, order-specific HMAC grant
          ┌──────────────────────────────┴───────────────────────────────┐
          ▼                                                              ▼
  GET /api/orders/lookup                                     GET /api/orders/receipt
  GET /api/orders/receipt                                    (payment gate retained: 409
  Authorized by EXACTLY ONE OF:                               while payment_pending)
   (a) Authorization: Bearer <order-access grant>, or
   (b) an authenticated shopper session with order.shopperId === me.id
  Everyone else → uniform 401 ORDER_VERIFICATION_REQUIRED (no DB row is even
  examined on the unauthenticated path — no existence oracle, no PII).
```

**What changed vs the rejected draft:** the knowledge pair is no longer an
authorization factor *anywhere*. It is an input to the verification-request
route only. A phished/leaked pair now yields: one rate-limited code request to
the victim's own mailbox — and nothing else.

**Preserved exactly as before:** guest checkout paths, NM- order numbers,
order claiming (now behind email verification — §4), all existing throttle
axes (re-tuned per surface below), the receipt payment gate and
providerRef-stripping, chat authorization (`shopperId === me.id` only, no
email fallback — Phase 2.1), and account ownership checks.

## 2. Implementation inventory (all shipped)

| Piece | Location |
|---|---|
| Core OTP + grant primitives (pure crypto) | `src/lib/guest-otp.ts` |
| Email provider seam (interface + fail-closed selection) | `src/lib/email-provider.ts` |
| Challenge storage (one table, P2021-tolerant) | `prisma/schema.prisma` → `EmailOtpChallenge` + migration `20261104000000_final_email_otp` (**created, NOT applied**) |
| OTP request route (uniform 200, 4 throttle axes) | `src/app/api/orders/otp/request/route.ts` |
| OTP verify route (uniform 401, CAS consume, grant mint) | `src/app/api/orders/otp/verify/route.ts` |
| Lookup — corrected authorization | `src/app/api/orders/lookup/route.ts` |
| Receipt — corrected authorization + payment gate | `src/app/api/orders/receipt/route.ts` |
| Shopper email verification (request/verify + exactly-once claiming) | `src/app/api/auth/shopper/email-verification/{request,verify}/route.ts` |
| Claiming gate (email ownership required) | `src/lib/shopper-merge.ts` |
| Registration (no auto-claim; best-effort code send) | `src/app/api/auth/shopper/register/route.ts` |
| Login / unified-login (`emailVerified` in response) | `api/auth/shopper/{login,unified-login}/route.ts` |
| Client grant store (IN-MEMORY ONLY — never persisted) | `src/components/shopper/guest-order-access.ts` |
| Two-step verification UX (lookup view) | `src/components/shopper/checkout.tsx` (`LookupView`) |
| Grant-aware status/orders/receipt UX | `checkout.tsx` (`OrderStatusView`, `OrdersView`) |
| Me-hub verification card | `src/components/shopper/me-hub.tsx` |
| Expired-challenge sweep | `api/cron/session-purge` (verified rows are KEPT) |
| Unit tests (executed — pure crypto/logic) | `src/lib/__tests__/guest-otp.test.ts` |
| Staging E2E (prepared — authorized staging only) | `scripts/readiness/guest-order-otp-e2e.ts` |

## 3. Technical design (mandate §3 — item by item)

### 3.1 HMAC construction
- OTP code hash: `HMAC-SHA256(EMAIL_OTP_SECRET, "otp:v1:" + purpose + ":" + subjectId + ":" + utcDayBucket + ":" + code)` → 64-char lowercase hex. Keyed (not plain sha256) so a stolen DB read cannot brute-force the 10^6 code space offline. The `"otp:v1:"` domain tag and `purpose` field make a hash from one purpose useless in the other.
- Access grant: `v1.<orderId>.<expiryMs>.<HMAC-SHA256(ORDER_ACCESS_SECRET, "oag:v1:" + orderId + ":" + expiryMs)>`. Separate secret from the OTP key so either can rotate without invalidating the other's outstanding artifacts.

### 3.2 OTP issuance (`issueEmailOtp`)
- 6 digits from `crypto.randomBytes(4)` with **rejection sampling** (`limit = floor(2^32 / 10^6) * 10^6`) — uniform, no modulo bias (unit-tested: >4,900 distinct codes in 5,000 draws, all 10 leading digits present).
- One row per `(purpose, subjectId)` (unique index). Re-issuance REPLACES the codeHash and extends `expiresAt` — the newest email always works.
- **Attempt counters survive re-issuance** while the row is unexpired; they reset only after expiry — repeated issuance cannot reset brute-force accounting (mandate: "verification cannot be … reset through repeated issuance").
- A LOCKED row (attempts ≥ 5, unexpired) is never re-issued.

### 3.3 OTP verification (`verifyEmailOtp`)
- Normalization: digits-only, exactly 6 — anything else is an invalid code.
- Order of checks: row exists → not already verified → not expired → not locked → **constant-time** hash compare (`safeEqualHex`) → CAS consume. All failure reasons collapse to one uniform 401 at the route.
- **CAS consumption**: guest-order rows are `deleteMany({ id, codeHash })` — exactly one concurrent winner; replay finds no row. shopper-email rows transition `verifiedAt: null → now` under `WHERE verifiedAt IS NULL` — exactly-once claiming proof.
- Wrong codes: `updateMany({ id, attempts: { lt: 5 } }, { attempts: { increment: 1 } })` — the bound holds even under concurrent guesses.

### 3.4 Day-bucket handling — UTC midnight rollover
- Bucket = `floor(nowMs / 86_400_000)` (UTC epoch day), bound into the HMAC payload.
- Verification tries **BOTH the current and the previous day bucket**
  (`otpCandidateBuckets`), so a code issued at 23:55 verifies at 00:05 — the
  full intended 10-minute TTL carries across midnight. Unit-tested with pinned
  timestamps (2026-11-04T23:55Z → 2026-11-05T00:05Z, epoch days 20761→20762).
- Tomorrow's bucket is never accepted (a future-dated code cannot exist).

### 3.5 Access grants
- **Order-specific**: orderId is inside the HMAC payload AND the route
  cross-checks that the requested orderNumber belongs to the granted order
  (defense in depth on both layers).
- **Purpose-specific**: the `"oag:v1:"` domain tag + dedicated
  `ORDER_ACCESS_SECRET` mean the token is not an import capability, not a
  session, not valid on any other surface (import-cap cookies and session
  Bearers have different secrets/formats; a grant never parses as a hex
  session token and vice versa — unit-tested).
- **Short-lived**: 15 minutes, absolute expiry minted server-side (no skew
  tolerance to abuse), no refresh token exists.
- **Cryptographically protected**: HMAC-SHA256, constant-time compare, strict
  shape validation (`v1.` / orderId charset / 13–16 digit expiry / 64 hex MAC).
- **Not logged**: audit rows carry ids/status/ttl only. **Never in client-side
  persistent storage**: the SPA keeps grants in a module-level Map
  (`guest-order-access.ts`) — no localStorage, no sessionStorage, no cookies;
  a page reload drops them and the shopper re-verifies.

### 3.6 Rate limits (retained + strengthened)
| Surface | Axes |
|---|---|
| `POST /api/orders/otp/request` | 5/min/IP · 3/h/email · 5/h/orderNumber · **3/h/(email,orderNumber) pair** |
| `POST /api/orders/otp/verify` | 10/min/IP · 10/h/email · 30/h/orderNumber · 5 attempts/challenge (CAS-bounded) |
| `GET /api/orders/lookup` / `receipt` | 10/min/IP · 300/h/orderNumber (polling-friendly; the old 30/h anti-enumeration cap moved to the OTP request route, where the knowledge pair is now accepted) |
| `POST /api/auth/shopper/email-verification/request` | 5/min/IP · 3/h/account |
| `POST /api/auth/shopper/email-verification/verify` | 10/min/IP · 20/h/account · 5 attempts/challenge |

### 3.7 Uniformity / anti-enumeration
- OTP request: **always** 200 `{ sent: true, message }` — identical for match,
  mismatch and missing order. The two global fail-closed pre-flights (provider,
  storage) run BEFORE the order lookup so their 503s cannot act as an oracle.
- OTP verify: one uniform 401 `INVALID` for every failure mode.
- Lookup/receipt: uniform 401 `ORDER_VERIFICATION_REQUIRED` without touching
  the order table when unauthenticated.
- Delivery failures never propagate (fail-soft inside `issueEmailOtp`).

### 3.8 Fail-closed posture
- No provider configured → every issuance route answers **503
  `EMAIL_PROVIDER_NOT_CONFIGURED`** (uniformly, pre-lookup). Lookup/receipt
  then accept only owning sessions. Nothing is faked, no code is exposed
  anywhere, no email is "simulated".
- Migration not applied (table missing) → 503 `EMAIL_OTP_UNAVAILABLE`
  (uniformly, pre-lookup); claiming gate reads as unverified (disabled).
- Secrets unset in production → `EMAIL_OTP_SECRET_UNSET` /
  `ORDER_ACCESS_SECRET_UNSET` (503 / unverifiable grants), surfaced loudly at
  boot by `instrumentation-node.ts`.

## 4. Shopper registration & guest-order claiming (mandate §2)

- **Registration no longer claims.** `claimGuestStateForShopper` is not called
  at registration; the response keeps the legacy `claimed` shape (zeros) and
  adds `emailVerified: false` + `emailVerificationSent` (best-effort code send
  — never blocks signup).
- **The gate lives inside `claimGuestStateForShopper`** (login, unified-login,
  and the verification route all flow through it — no call site can bypass):
  guest orders are transferred ONLY when a verified `EmailOtpChallenge` row
  (purpose `shopper-email`) exists for the account. Email match alone is
  knowledge-of-email, not ownership.
- **Verification flow**: signed-in shopper requests a code (Me → Profile card)
  → code to the account's own email → verify → CAS-set `verifiedAt` → the
  single winner claims exactly once. Re-verify answers `alreadyVerified` with
  `ordersClaimed: 0`; re-login claims nothing new (idempotent `shopperId IS
  NULL` filter).
- **The closed attack** (staging script §8): register with a victim's email →
  login → 0 orders claimed, `emailVerified: false`, guest orders still
  `shopperId = null`, and the unverified account cannot even READ them (401).
- Chat authorization remains strictly `order.shopperId === me.id` (Phase 2.1)
  — untouched by this work.
- Existing shopper data and already-claimed orders are untouched (the gate
  only affects FUTURE claiming of still-unclaimed legacy guest orders).

## 5. Storage & schema

One new table (`EmailOtpChallenge`, migration `20261104000000` — **created,
NOT applied**; additive, empty on creation, safe at any point in the sequence):

- `(purpose, subjectId)` UNIQUE — one live challenge per subject; also
  serializes concurrent issuances and backs the CAS transitions.
- `codeHash` (keyed HMAC), `attempts`, `expiresAt`, `verifiedAt` (shopper-email
  proof only — KEPT forever by the purge job).
- **No column was added to any existing table**: a missing column would break
  every existing Prisma query pre-migration, while a missing TABLE is tolerated
  fail-closed via the P2021 guard (same dev contract as AdminMfaEnrollment).
- Purge: expired unverified rows are swept by the session-purge cron tick
  (10-min throttle, P2021-tolerant); verified rows are permanent proofs.

## 6. Email provider integration readiness (mandate §4)

**No real delivery exists and none is simulated.** `src/lib/email-provider.ts`
ships the interface + a fail-closed selection seam only:

```ts
interface TransactionalEmailChannel {
  readonly providerId: string;
  send(email: { to: string; subject: string; textBody: string; htmlBody?: string;
                meta?: { purpose: string; subjectId?: string } }): Promise<void>;
}
```

- `getEmailChannel()` returns **null** today (no adapter compiled in). Naming
  `EMAIL_PROVIDER` without an adapter logs a loud warning — misconfiguration
  must be visible.
- When the provider decision lands, one ~40-line adapter + the selection
  switch is ALL that changes; the security logic never rewrites. Registration
  verification reuses the SAME channel (already wired).
- Adapter contract (enforced by review): ≤10 s timeout; failures must reject
  (never silently drop); provider rate limits surfaced as rejections; the
  delivery address always comes from server-side records; bodies/codes never
  logged.

**Operational requirements before any real sending (the ops decision):**
1. Provider + sending domain for `orders@nomofee.io` (candidates: Resend,
   Postmark, AWS SES; Supabase Auth mailer possible but NOT recommended —
   couples order-OTP to Supabase Auth).
2. SPF + DKIM + DMARC on the sending domain; warm-up plan.
3. Provider API credentials in the deployment secret store (never the repo):
   `EMAIL_PROVIDER` + the provider's key variable.
4. Bounce/complaint handling: hard bounce → disable issuance for the address
   (provider webhook → audit row); delivery failures audited as
   `email.otp.delivery_failed` (already wired in the request route).
5. Provider rate ceilings must exceed the route limits (§3.6).
6. Email templates (order-OTP + registration-verification subjects/bodies —
   current inline text is the interim).
7. Audit logging stays ids-only (already enforced — codes/grants never logged).

**Do not send real email until the provider is authorized and configured.**

## 7. Tests (executed vs staging-only — see final report §6)

- **Executed (this sandbox, no DB):** `src/lib/__tests__/guest-otp.test.ts` —
  16 tests: code generation/uniformity/padding, normalization, day-bucket
  math, **midnight rollover**, challenge binding (purpose/subject/code/bucket),
  HMAC construction, grant round-trip/expiry/order-specificity/tamper/
  malformed/forgery. Full suite: **180/180**.
- **Staging-only (prepared, NOT executed — needs authorized staging + provider
  or Mailpit):** `scripts/readiness/guest-order-otp-e2e.ts` — the full §7
  matrix incl. the registration attack scenario and exactly-once claiming.
- **Live sandbox verification (read-only):** the fail-closed 503 behavior of
  the new routes and the 401 authorization model of lookup/receipt (see the
  final report).

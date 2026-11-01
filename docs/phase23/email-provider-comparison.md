# Phase 2.3 — Transactional Email Provider Decision: Resend vs Brevo

**Status:** DECISION DOCUMENT (verification of the preferred candidate against CURRENT official documentation; the Resend adapter is implemented behind `TransactionalEmailChannel` — no account created, no real email sent).
**Verification date:** 2026-11 (this remediation programme). Every provider fact below was fetched from the provider's own official pages on this date (raw fetches archived in `.agent-tmp/email-research/`). Anything not established in official docs is labelled **[N] — needs written confirmation**.
**Requirement source:** programme §15 (required functionality list) + the Final Security Closure email-provider mandate (`docs/security/final-closure-report.md` §4).

---

## 1. What NOMOFEE actually needs

| Requirement (programme §15) | Provider capability needed | Notes |
|---|---|---|
| Guest-order OTP | transactional send API, low latency, idempotent retry | `guest-checkout` + `order-access` purposes ride `issueEmailOtp` |
| Shopper email verification | same | `shopper-email` purpose; claiming gate |
| Seller email verification | same | `seller-email` purpose (Phase 2.3) |
| Password recovery | same | **PRODUCT GAP: no forgot-password flow exists yet** (only authenticated change via `/api/me/password`). Provider choice is unaffected; flow is an owner decision — see §6. |
| Order / payment / refund / shipping notifications | templates, high volume, webhook feedback | `notify()` fan-out |
| Seller registration / order / settlement notifications | same | |
| Security alerts | DKIM/SPF/DMARC + suppression | |
| Bounce & complaint processing | signed delivery webhooks + suppression list | hard bounce ⇒ issuance disabled for the address |
| No OTP/secret in logs, ids-only audit | adapter contract (already enforced in code) | `lib/email-provider.ts` rules 1–5 |

Scale reality check: OTPs + transactional notifications for a launching marketplace are **hundreds to low-thousands of emails/month**, far below any paid tier. The decision is therefore driven by **deliverability tooling, API correctness guarantees (idempotency), webhook security, and regional latency** — not headline volume pricing.

## 2. Verified provider comparison (official docs, this month)

### 2.1 Pricing & sending limits

| | **Resend** (resend.com/pricing, fetched this month) | **Brevo** (brevo.com/pricing, fetched this month) |
|---|---|---|
| Free tier | $0 — **3,000 emails/mo**, 100/day, 3 domains | **300 emails/day** (after account approval for sending) |
| Entry paid | **Pro $20/mo — 50,000 emails/mo**, no daily limit, overage **$0.90/1,000** | Starter — **from 5,000 emails/mo** (volume-tier calculator; exact price is dynamic — confirm in console) |
| Higher | Scale $90/mo — 100,000 emails/mo, $0.90/1,000, dedicated IP add-on $30/mo (>3k/day), domains add-on $20/mo | Professional — **from 150,000 emails/mo**; Enterprise via sales |
| Rate limit | API rate limit is **per team, same on every plan** (official FAQ); **Batch API: up to 100 emails/request** | Per-plan API limits; publicly documented numbers vary by plan — **[N] confirm exact req/s for the chosen tier** |
| Data retention | 30 days (Free/Pro/Scale), flexible on Enterprise | **Unlimited log retention on all plans** (official FAQ) |

Interpretation: at NOMOFEE's launch scale both are effectively free; at 50k+/mo Resend Pro ($20) undercuts a comparable Brevo volume tier and its overage bucket is a published flat rate. Brevo's unlimited retention is genuinely useful for ops forensics, but NOMOFEE already retains durable delivery/suppression state in its own DB (`EmailDeliveryEvent`, `EmailSuppression`, `NotificationLog`), reducing the value of provider-side retention.

### 2.2 Transactional API correctness — the deciding engineering factor

| Capability | **Resend** | **Brevo** |
|---|---|---|
| **Native send idempotency** | ✅ **`Idempotency-Key` header on POST /emails — verified in the current API reference**: keys expire after **24 h**, max 256 chars, duplicate requests return the original email instead of re-sending | ❌ No native idempotency key documented for the transactional send API **[N]** — dedup must be built application-side (NOMOFEE's OTP layer already CAS-consumes challenges, so double-send exposure is limited to notification fan-out retries) |
| Signed webhooks | ✅ **Svix-style HMAC signatures** (`svix-id`/`svix-timestamp`/`svix-signature`, `v1,` candidates, timing-safe compare — implemented + 36-check harness in `verify-webhook-signing.ts`… the email twin `verifySvixSignature` is unit-covered) | ⚠️ Outbound (transactional) webhooks exist on all plans (official FAQ), but authentication is a **token/secret in the callback URL** rather than an HMAC over the raw body **[N]** — replay- and forgery-resistant verification is weaker |
| Automatic suppression | ✅ **Built-in automatic suppression list** (feature matrix) + bounce details; NOMOFEE additionally mirrors into `EmailSuppression` via the signed webhook | ⚠️ Hard-bounce/complaint handling configurable in dashboard; suppression list semantics **[N] confirm exact behaviour** |
| Auth methods | API keys with **scoped permissions** (`Sending access` vs full), MFA, SSO on Scale+ | API keys; broader multi-channel account |
| Compliance/security posture | **SOC 2 Type II**, GDPR, pen testing, DDoS protection (feature matrix) | GDPR (EU company, EU data residency available); SOC report **[N] request latest** |

### 2.3 Regional considerations (Malaysia)

- **Resend offers four sending regions: North Virginia, Ireland, São Paulo, and Tokyo (`ap-northeast-1`)** — verified in the official regions doc. Tokyo is the nearest region to Malaysia ⇒ lowest OTP delivery latency for MY shoppers.
- Brevo is EU-headquartered (EU data residency strength); sending infrastructure region selection for APAC is less explicit in public docs **[N]**.
- Data residency caveat (official Resend doc): region selection controls routing/sending, not storage residency — acceptable for OTP/notification use, and consistent with NOMOFEE's PDPA posture of not storing OTP codes anywhere.

### 2.4 Email authentication

Both providers require sender-domain verification and publish DKIM/SPF/DMARC records. Resend's feature matrix explicitly lists **DKIM, SPF, DMARC authentication** on all plans. Operational prerequisites remain as documented in `docs/security/guest-order-otp-design.md` §6 (own subdomain, e.g. `mail.nomofee.com`, provider-managed DNS records).

## 3. Recommendation — RESEND (confirmed)

**Resend is confirmed as the production provider.** Reasons, in priority order (programme Rule 2):

1. **Send idempotency is native and verified** — the single most important correctness feature for OTP/verification mail, and it maps 1:1 onto the adapter's content-derived `Idempotency-Key` (already implemented in `src/lib/email-providers/resend.ts`).
2. **Svix-signed webhooks** make bounce/complaint ingestion verifiable rather than trust-on-URL — the adapter's suppression pipeline (`/api/webhooks/email/resend` → `EmailDeliveryEvent` + `EmailSuppression`) is built exactly on this.
3. **Tokyo region** minimizes OTP latency for the Malaysian shopper base.
4. **Developer-correct failure surfacing** (typed 429, timeout ceiling 8 s < contract's 10 s, rejections never silently dropped) matches the fail-closed security posture of the OTP routes.
5. Pricing is simpler and cheaper at the scale that matters next ($20/50k with published overage), with the same API rate limit on every plan.

**Brevo remains the documented fallback**: it is a capable, GDPR-strong transactional provider with unlimited log retention and generous day-1 free sending (300/day). Switching cost is deliberately one ~40-line adapter + the `EMAIL_PROVIDER` selection switch — **zero security-logic changes** (the `TransactionalEmailChannel` seam isolates provider specifics; verified: OTP, verification and claiming flows reference only the interface).

## 4. Implementation state (Phase 2.3, verified)

| Component | State |
|---|---|
| `src/lib/email-provider.ts` | Selection seam + fail-closed contract (unchanged since Final Closure) |
| `src/lib/email-providers/resend.ts` | **Implemented** — content-hash idempotency keys, 8 s timeout, typed 429, suppression pre-check, Svix `verifySvixSignature` (timing-safe, `v1,` candidates) |
| `src/lib/email-providers/mailpit.ts` | Dev-only local catcher (production boot ABORTS if selected — enforced in `instrumentation-node.ts`) |
| `src/lib/email-providers/suppression.ts` | Suppression reader (tolerant of un-applied migration) |
| `POST /api/webhooks/email/resend` | Signed delivery-event ingestion → `EmailDeliveryEvent` (exactly-once per `(provider, providerEventId)`) + suppression add/remove |
| Migration `20261106000000_phase23_email_delivery` | **Created, NOT applied** (repo policy — authorized environments only) |
| Boot gate | `EMAIL_PROVIDER=resend` ⇒ `RESEND_API_KEY` + `EMAIL_FROM` are **boot-fatal in production**; unset provider aborts boot |
| Real sends | **None until an authorized account + verified domain + secrets are configured** (owner decision; no credentials exist in this repo) |

## 5. Activation checklist (owner-authorized steps, when approved)

1. Create the Resend account (owner), enable **2FA**, create a **Sending-scoped API key**; store in the deployment secret store (never the repo).
2. Add + verify the sending domain (`mail.nomofee.com` recommended); publish the provided **DKIM/SPF/DMARC** DNS records; select the **Tokyo region** for the domain.
3. Set `EMAIL_PROVIDER=resend`, `EMAIL_FROM="NOMOFEE <no-reply@mail.nomofee.com>"`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (Svix secret from the webhook configuration); configure the endpoint `https://<origin>/api/webhooks/email/resend` with `email.*` events.
4. Apply migration `20261106000000_phase23_email_delivery` in the authorized environment (with the five other outstanding migrations — see the consolidated handoff).
5. Verify: OTP request → 200 + real email received; delivery webhook → `EmailDeliveryEvent` row; hard-bounce → address suppressed; `GET /api/health/scheduler` and metrics unaffected.

## 6. Decisions this document does NOT make (owner input required)

- **Password recovery ("forgot password") flow** — the provider requirement is satisfied, but the product currently has no unauthenticated password-reset flow (only authenticated change). Building one is a business decision with its own security design (token TTL, enumeration-safe UX); it is NOT silently invented here.
- Marketing/newsletter sending (Brevo's strength) — out of scope; if NOMOFEE later wants campaigns, Brevo (or Resend Broadcasts) can be evaluated separately from transactional mail.
- Account ownership, domain purchase, and credential custody.

# Work 4 — Transactional Email Provider Recheck (research only, 2026-11-03)

**Posture:** research + recommendation only. **No provider account created, no forms submitted, no
credentials added, no real emails sent, no DNS changes.** The `TransactionalEmailChannel` adapter
architecture and the Mailpit dev rail are untouched. Activation requires the owner's approval, a provider
account, a verified domain, and credentials (kept outside source control).

All facts below were fetched live from official sources on 2026-11-03 (resend.com/pricing.md, resend.com
docs/*.md, resend.com/security.md, brevo.com/pricing.md, brevo.com/products/transactional-email/,
developers.brevo.com docs, help.brevo.com articles).

## Verified current facts

| Dimension | Resend | Brevo |
|---|---|---|
| Free tier | 3,000/mo, 100/day cap, 30-day retention | 300/day (queue up to 1,000 beyond cap), unlimited log retention |
| Entry paid | **Pro $20/mo = 50k** (confirmed; overage $0.90/1k) | Starter from $9/mo (5k); 20k ≈ $32/mo; 50k ≈ $56/mo; **MYR billing available (RM35/mo Starter)** |
| Sending regions | us-east-1, eu-west-1, sa-east-1, **ap-northeast-1 (Tokyo)** — ⚠️ corrects the earlier "ap-southeast-1"; **account data stored in the US regardless** | **EU only** (France/Germany hosting; no APAC sending region) |
| SPF/DKIM/DMARC | all three; ~15 min typical verification | all three; 3 verification methods |
| Idempotency | `Idempotency-Key` header, **24h retention**, 409 semantics | `idempotencyKey` body param, **30-min TTL** |
| Rate limits | 10 req/sec/team (all plans; raise on request) | 1,000 RPS (all plans incl. free) |
| Webhook signing | **Svix HMAC-SHA256** (svix-id/timestamp/signature), secret rotation, 8-attempt backoff, manual replay API | **NO HMAC** — IP allowlisting / basic auth / bearer / custom headers; 4 retries then **discard** |
| Events | delivered/bounced/complained/failed/delivery_delayed + `suppression.added/removed` | sent/delivered/soft_bounced/hard_bounced/spam/invalid/blocked/error… |
| Suppression | managed list (auto hard-bounce/complaint), full API, CSV export | auto bounce/complaint handling + blocklist APIs |
| OTP fit | positioned for magic-links/password-resets; region choice for latency; pristine shared IPs | markets 2FA via SMS/WhatsApp on the same platform (separate credits) |

## Material changes vs the 2026-11-01 assessment
1. Resend Pro $20/50k **unchanged** (decision point stable); overage + region details now documented.
2. Region correction: Tokyo = **ap-northeast-1** (previous doc said ap-southeast-1/Singapore — wrong).
3. Brevo plan lineup restructured: "Lite ~$25" is gone → Starter $9 + credit tiers; 20–50k/mo now 60–180%
   pricier than Resend Pro; MYR billing confirmed.
4. Brevo webhooks remain unsigned (IP-allowlist model) — unchanged concern.
5. Brevo data residency: EU only (France/Germany) — earlier "EU + US" not supported by current docs.

## Recommendation

**Primary: Resend** — decisive for NOMOFEE because the app already ships a **Svix-signature-verified
webhook route** (`/api/webhooks/email/resend` — the Step 4 timestamp-units fix made it production-correct),
its 24h idempotency keys fit OTP retries, Tokyo region is the closest available to MY, and its signed
webhooks + suppression events map 1:1 onto the existing code. Brevo as **secondary/fallback adapter only**
(dev/staging free tier; SMS/WhatsApp 2FA is a future option) — adopting it as primary would require a
different webhook verification path for strictly weaker guarantees.

**Requires sales/account confirmation:** Resend rate-limit raises, Enterprise terms/DPAs, actual OTP
latency to MY mailboxes; Brevo checkout pricing at volume, MY SMS rates, account approval SLAs; **PDPA
cross-border assessment** for Resend's US data residency (owner/legal action).

## Activation checklist (blocked on owner approval + credentials)
1. Owner approves provider + creates account; verify the sending domain (SPF/DKIM/DMARC DNS records —
   owner DNS change, explicitly gated).
2. Set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM` in the deployment
   environment (never source control); configure the provider webhook to the deployed
   `/api/webhooks/email/resend` URL.
3. Staging verification: controlled test mailbox delivery, OTP + account-verification flows, idempotent
   duplicate send, signed bounce/complaint/suppression webhook handling (the Step 4 M10 regression suite
   already exercises all of these against the signed route — re-run against the real provider).
4. Mailpit stays the dev/test rail (already fail-closed in production — proven in the Work 3A boot gate).

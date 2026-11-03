# Work 5 — PSP Research Update (research only, 2026-11-03)

**Posture:** research update + shortlist ONLY. **No provider selected, no account created, no form
submitted, no commercial agreement accepted, no credentials, no provider-specific adapter implemented —
the provider-neutral architecture is untouched.** The owner's decision D1 remains open.

All facts fetched live from official sources on 2026-11-03 (curlec.com + curlec.com/docs, chip-in.asia +
docs.chip-in.asia incl. OpenAPI specs, docs.xendit.co, airwallex.com/en-my, senangpay.com, doku.com,
hitpayapp.com, billplz.com, stripe.com/en-my).

## Material changes vs the 2026-11-01 assessment

1. **CHIP's old domain is dead** (chip.com.my NXDOMAIN) — CHIP lives at **chip-in.asia**; old bookmarks stale.
2. **CHIP regulatory framing corrected**: BNM-Registered Merchant Acquirer (Non-bank) + PayNet FPX
   Third-Party Acquirer (not "BNM-licensed e-money" as previously framed).
3. **Curlec entity renamed** "Razorpay Curlec Sdn. Bhd." (fully Razorpay group; no Bank Islam framing on
   the current site). Docs moved to **curlec.com/docs** (475 pages).
4. **Curlec Route is now documented MY-available at product level** (🇮🇳🇲🇾 badges) — the previous open
   question; MY linked-account KYC field list + enablement still needs sales confirmation.
5. **Curlec pricing now fully public** (per-method MDR Basic/Premium; FPX 1.5%/1.0%, cards 2.4%/2.0%,
   DuitNow QR approval-required, BNPL 6%/5%; refunds flat RM0.50; 18% GST; Route transfer fee docs example
   0.25%). Internal inconsistency: setup RM0 (table) vs RM99 (FAQ) → confirm.
6. **CHIP product expansion** (CHIP mini in-person QR, Capital/Advance, stablecoin collection, cross-border
   QR) and a **Payment-Facilitator/Sub-Merchant framework in its TOS (§5A/§B)** — contractual marketplace
   hook, but still **no public split-at-charge API**.
7. **SenangPay mid-migration to DOKU**; its split-settlement guide 404s — weak evidence, not shortlistable.

## Comparison summary (marketplace-relevant)

| Dimension | Razorpay Curlec — Route | CHIP — Collect + Send |
|---|---|---|
| Split at charge | **YES** — Route: transfers via Orders (split defined at creation, auto on capture) / via Payments / direct; MYR only | **No public split-at-charge** — platform-of-record custody; TOS PF clause only |
| Seller KYC | **Provider-managed Linked Accounts** (lifecycle webhooks under_review→needs_clarification→activated; dedicated seller dashboard; 24h cooling before transfers; API docs still India-shaped → confirm MY fields) | Platform onboards Sub-Merchants to CHIP standards (TOS §5A); Send recipients bank-verified by CHIP in real time |
| Payouts | Linked-Account settlements T+2; **Settle Now / Schedule / Hold (on_hold, on_hold_until) per transfer**; auto-retry failed ≤3 days | Send: RM1/transfer, RM1 verification; real-time rails; accepted ≤24h on bank outage |
| Refunds | Full+partial (idempotent variant); RM0.50 flat; timing per method (cards 5–10d, FPX 0–3d) | Full+partial via API; **FPX refunds supported** (RM1/RM2 fee; free on others) |
| Chargebacks | No MY dispute docs → sales | **`payment.charged_back` / `chargeback_reversed` events** documented |
| Webhooks | `X-Razorpay-Signature` HMAC over raw body; rich event set; retry policy undocumented | Collect: RSA-SHA256 signatures; Send: RSA-SHA512 + epoch/HMAC request signing; webhook CRUD + resend |
| Settlement | T+2 standard; Instant Settlement APIs (MY avail → confirm) | FPX/DuitNow next-day; cards T+2; Atome weekly |
| Fees (public) | Basic RM0 setup (FAQ says RM99 — confirm); MDR table above | **No setup/monthly fees**; FPX RM1; DuitNow QR 1%; cards 2%/1%; 8% SST |
| API/sandbox | Mintlify docs, SDKs (Node/PHP/Python/Java/.NET/Ruby/Go), sandbox setup guide, test-mode webhooks | OpenAPI 3.1 specs; **Send staging sandbox** (virtual RM1,000/day); SDKs incl. Node |
| Onboarding restrictions | Proprietorship/Partnership/**Sdn Bhd**/Bhd/LLP/Trust/Society; **no Individual/unregistered**; RM30k pre-full-KYC cap | Self-serve signup, no fees; entity restrictions not published |

**Others (marketplace capability only):** Xendit XenPlatform (sub-accounts + Split Rules incl. MYR — MY
activation/pricing unverifiable from here); Airwallex MY (Connected Accounts documented; multiple
confirmations outstanding); SenangPay/DOKU (migration risk, undocumented split); HitPay/iPay88/Billplz (no
marketplace primitive); Stripe (MY Connect gap unchanged — parked).

## Shortlist (ranked research candidates — NOT a selection)

1. **Razorpay Curlec Route** — only provider with MY-badged, product-level split-at-charge docs,
   provider-side linked-account verification, per-transfer settlement holds, reversals automation,
   sandbox, and published MYR pricing.
2. **CHIP Collect + Send** — cleanest published commercial terms, full OpenAPI + Send sandbox, FPX refunds,
   chargeback events, RSA-signed webhooks; trade-off: platform-of-record custody (seller KYC stays with
   NOMOFEE per TOS §5A — see docs/security/seller-kyc-decision.md) → legal review required before elevation.
3. **Xendit XenPlatform** — strongest split-rule docs; MY activation/pricing unverified.
4. **Airwallex MY** — platform rails documented; eligibility/hold semantics unconfirmed.

## Items requiring sales confirmation (owner pack D1–D5)

**Curlec:** Route enablement + MY transfer-fee %; MY Linked-Account KYC requirements/SLA (and whether
Dashboard/API self-serve creation is live for MY); dispute webhooks for MY; payout cut-offs/minimums; FPX
refund SLA; RM0-vs-RM99 setup discrepancy; Instant Settlements MY availability.
**CHIP:** Send minimums/cut-offs; refund timing per method; dispute workflow/liability; §5A
productization; entity-type restrictions; bulk-payout throughput beyond 100 req/5 min.
**Both:** fee-bearer arithmetic for split/payout chains; sandbox coverage of the 12-case payment
acceptance suite (esp. dispute + payout-failure simulation); reconciliation report formats.

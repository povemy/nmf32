# NOMOFEE — CONSOLIDATED HANDOFF: Phases 2.2 / 2.3 / 2.4

**Programme:** Consolidated Remediation Programme (writing-block.md §27 Step 4)
**Date:** 2026-11 (final consolidation session)
**Companion reports:** `docs/phase22/phase22-completion-report.md` · `docs/phase23/phase23-completion-report.md` · `docs/phase24/phase24-completion-report.md` · `docs/phase23/email-provider-comparison.md` · `docs/psp-readiness/phase23-psp-selection.md`
**Per-task implementation records:** `agent-ctx/P2.2-*.md`, `P2.3-*.md`, `P2.4-*.md`

---

## 1. All modified files (programme scope, by area)

**Phase 2.2 — integrity:** `src/lib/expiry-sweep.ts`, `src/app/api/cron/expiry-sweep/route.ts`, `src/app/api/orders/expiry/tick/route.ts`, `src/app/api/webhooks/payments/process.ts`, `src/app/api/checkout/payments/[ref]/retry/route.ts`, `src/lib/affiliate.ts`, `src/lib/ledger.ts`, `src/lib/checkout-compensation.ts`, `src/lib/inventory-release.ts`, `src/app/api/admin/refunds/[id]/{process,reject,approve}/route.ts`, `src/lib/store-lifecycle.ts`, `src/app/api/store/publish/route.ts`, `src/app/api/admin/sellers/[id]/{approve,activate,reject,suspend,terminate}/route.ts`, public filter sites (`market/*`, `sf/[slug]/*`, `checkout/pricing.ts`, `cart/stock/route.ts`, `sitemap.ts`), `src/app/api/checkout/create/route.ts` + `guest-verify/*`, `src/app/api/cart/cart.ts`, `src/lib/guest-otp.ts`, `src/lib/shopper-merge.ts`, `src/lib/session-client.ts`, `src/components/shopper/{checkout,ui-bits,shopper-shell}.tsx`, `src/components/auth/unified-auth-panel.tsx`, `src/app/api/chat/hub-auth/route.ts`, `src/app/api/store/inventory/adjust/route.ts`, `src/lib/secretbox.ts`, marketplaces/ownership sites (`marketplaces/*`, `import/runner.ts`, `import/jobs/route.ts`, `claim/bind/route.ts`, `auth/callback/[platform]/route.ts`), `prisma/schema.prisma` (+ `MarketplaceConnection.sellerId`, `PaymentGroup.shopperId` nullable).

**Phase 2.3 — integrations/ops:** `src/lib/email-provider.ts`, `email-providers/{resend,mailpit,suppression}.ts`, `src/app/api/webhooks/email/resend/route.ts`, `src/lib/seller-email-verification.ts` + `api/auth/seller/email-verification/*`, `src/app/api/store/bank-accounts/route.ts`, `src/lib/webhook-delivery.ts` + `api/cron/webhook-delivery` + `api/admin/webhook-deliveries/*` + `api/store/webhooks/[id]/test`, `src/components/seller/{dashboard,integrations}.tsx`, `next.config.ts`, `src/lib/api.ts` (prod 500 sanitization), `api/health/ready/route.ts`, `.github/workflows/ci.yml`, `src/instrumentation-node.ts`, `.env.example`, `src/app/api/health/scheduler/route.ts`, `src/lib/metrics.ts` (wiring audit), `mini-services/expiry-scheduler/index.ts`.

**Phase 2.4 — experience:** `src/app/api/market/products/route.ts`, `src/components/shopper/market.tsx`, `src/lib/chat-pagination.ts` + chat thread routes + shopper/seller chat UIs, `src/components/seller/imports.tsx` (sync warning), app-root dynamic shells, `src/app/robots.ts` (+ static robots.txt removed), `src/app/sitemap.ts` (chunking note), `src/lib/search-normalize.ts`, `src/lib/expiry-sweep.ts`/`order-completion.ts` (dead-code removal), `scripts/attic/*`, `src/app/api/metrics/route.ts` (constant-time), `src/lib/import/normalise.ts` (category whitelist), checkout SM→NM copy.

**This consolidation session:** the six residual-gap fixes in §2 of the Phase 2.2 report (process.ts ×4 sites, retry route, affiliate.ts ×2 sites, expiry-sweep/cron rail unification), `scripts/readiness/phase22-races.ts` (NEW, prepared), the three phase reports + email comparison + PSP decision (NEW), this handoff, worklog entry.

## 2. All migrations created (NONE applied — repo policy)

| Migration | Content | Applied? |
|---|---|---|
| `20261101000000_phase1_session_token_hashing` (+ `…000001_review_verified_purchase`, `…000002_admin_mfa_enrollment`) | Phase 1 | NO (pre-existing backlog) |
| `20261102000000_phase2_performance_indexes` | Phase 2 | NO |
| `20261103000000_phase21_mfa_totp_replay` | Phase 2.1 | NO |
| `20261104000000_final_email_otp` | `EmailOtpChallenge` | NO |
| `20261105000000_phase22_marketplace_integrity` | `PaymentGroup.shopperId` DROP NOT NULL, `MarketplaceConnection.sellerId`+index, **affiliate single-open-payout PARTIAL UNIQUE INDEX**, Item affiliate-sponsor snapshot columns | NO |
| `20261106000000_phase23_email_delivery` | `EmailDeliveryEvent`, `EmailSuppression` | NO |
| `20261107000000_phase23_seller_verification` | `Seller.emailVerifiedAt` | NO |
| `20261108000000_phase23_webhook_delivery` | `WebhookDeliveryAttempt` + indexes | NO |
| `20261109000000_phase24_search_indexes` | `pg_trgm` + GIN trigram indexes | NO |

**Nine migrations are outstanding.** All are additive or annotated; `20261105000000` includes a documented pre-check. Application order = filename order, in an AUTHORIZED environment only, with the backup-first + rollback-hard-rule from `docs/ops/phase21-deployment-runbook.md`.

## 3. Tests

- **Passed (local, this sandbox):** 180/180 unit (`bun test src/lib/__tests__` — OTP/HMAC/CAS/grant/proxy-CSRF/rate-limit-bounds/search-normalize/url-guard/safe-fetch/MFA/password); 36-check webhook-signing harness; tsc `src/` 0 errors; prisma validate; eslint clean on all programme files; live route smoke (publish gates 403s, guest OTP fail-closed chain, hub-auth limiter tiers, inventory CAS concurrency, chat pagination, search matrix, sitemap/robots, scheduler health, webhook/refund/retry envelopes — re-run today, all green).
- **Prepared, NOT executed:** `scripts/readiness/phase22-races.ts` (C1.1+C1.2 DB concurrency matrix) — requires an **authorized staging** deployment; prior readiness suites (`guest-order-otp-e2e`, `finance-regression`, `webhook-resilience`, `scheduler-e2e`, …) likewise prepared for staging.
- **Not executed:** real production build (`bun run build` not runnable in this sandbox — CI runs it), provider sandbox tests (no credentials by design), load tests (restriction).

## 4. Evidence standard (programme §30) — honest separation

| Category | Status |
|---|---|
| 1 Code-level verified | ✅ everything above (this sandbox) |
| 2 Local test verified | ✅ unit suites + live route smoke |
| 3 Authorized staging verified | ⛔ none yet (no authorized staging in this environment) |
| 4 Provider sandbox verified | ⛔ none (no PSP/email credentials — by design) |
| 5 Production verified | ⛔ none |

## 5. DB-dependent verification requirements (staging gate)

1. Apply the nine migrations; restart; re-run the fail-closed probes (they must flip from 503/401-unavailable to functional).
2. Run `scripts/readiness/phase22-races.ts` (C1.1/C1.2 concurrency matrix) + the existing readiness suites.
3. Verify the affiliate partial unique index exists (`\d "AffiliatePayout"` → `AffiliatePayout_one_open_per_affiliate`).
4. EXPLAIN the tokenized search with/without GIN indexes at representative catalog size.
5. Guest order E2E: OTP → create → pay → receipt; guest→account claiming exactly-once.

## 6. PSP & email provider readiness

- **Email: READY pending activation.** Resend confirmed against current official docs (adapter, webhook, suppression, boot gate all implemented; no account/keys/domain). Brevo documented as the one-adapter fallback. Activation checklist: `email-provider-comparison.md` §5.
- **PSP: RESEARCH COMPLETE, implementation owner-gated.** Curlec Route recommended (MY verified), CHIP fallback, Stripe parked. All adapter seams (`PSPProvider`, `PspPayoutAdapter`, `RefundAdapter`, webhook pipeline, idempotency keys) exist and are PSP-agnostic. Decisions D1–D5 block implementation.

## 7. Outstanding business-policy decisions (owner)

1. PSP selection + commercial terms (D1–D5) · 2. Email provider activation + domain custody · 3. KYC ownership (provider-managed vs documents) + retention/deletion policy · 4. Settlement display-only controls (grace-days, hold-release-rule): **wire or remove** — currently labelled NOT-ENFORCED · 5. Password-recovery product flow (does not exist yet) · 6. KYC "approved" auto-rule remains a human-decision display flag — decide whether it must become a hard gate before launch.

## 8. Security & financial risks (residual, honestly stated)

- **Migration-dependent backstops:** the affiliate single-open-payout DB index and marketplace-connection ownership column exist only in migration files until applied (application-level guarantees active meanwhile).
- **Legacy single-intent orders:** now protected in-tx (G1 fix), but the population is historical; staging race suite should cover both paths.
- **No real PSP** = the single biggest launch blocker for real money; mock rail is production-gated.
- **No real email** = OTP/email-verification/claiming stay fail-closed (503) in production until the provider is activated — by design, but it means production launch REQUIRES activation.
- **Client-rendered storefront (SEO)** remains the known structural limitation (documented SSR plan).
- **KYC is honesty-layer only**; publishing/payouts fail closed via seller status, but genuine identity verification is provider-managed-KYC (recommended) or a document pipeline still to be built.

## 9. Deployment prerequisites

Authorized environment (staging → production) with: the nine migrations applied; ALL boot-fatal secrets set (`PSP_WEBHOOK_SECRET`, `CRON_SECRET`, `MFA_ENCRYPTION_KEY`, `IMPORT_TOKEN_ENC_KEY`, `ORDER_ACCESS_SECRET`, `EMAIL_OTP_SECRET`, `EMAIL_PROVIDER` block — boot aborts listing any missing); process supervision (supervisor/systemd per `process-supervision.md`); scheduler + external health check (`/api/health/scheduler`); crontab entries sending `x-cron-secret`; email provider activation; PSP account + sandbox → live only after checklist `psp-readiness/12-provider-checklist.md`.

## 10. Rollback considerations

- Migrations: each file carries a documented ROLLBACK section; **hard rule from the runbook stands** — backup before applying, no destructive re-runs; `20261105000000` includes its pre-check.
- Code: no commits were created by the programme (per restrictions) — all work is in the working tree; the sandbox's auto-commit history + the agent-ctx per-task records provide the restoration map. Rollback of the integrity fixes should be avoided (they close launch-blocking races); if needed, revert by file per §1 grouping.
- Email/PSP: `EMAIL_PROVIDER` unset → all OTP routes fail closed 503 (safe); mock PSP remains available ONLY behind the explicit production kill-switch (`psp.mock.enabled`), never by silent fallback.

## 11. Final acceptance criteria (§30) — scorecard

**Critical marketplace integrity: PASS (code-level).** No payment/expiry stock resurrection (in-tx verification on both paths; re-open races closed) · no affiliate double payout (Serializable + conditional claims + pending-migration index) · no unapproved seller publication (fail-closed gates + unified state machine) · no imported-product moderation bypass · no voucher loss on expiry · no excessive restock on partial refunds · no refund status overwrite race · no cross-seller connection access · no lost inventory updates (CAS).

**Production integration: PARTIAL — by design.** Email adapter implemented + provider verified, NOT activated (owner) · PSP selected on paper, NOT implemented (owner) · seller verification honest, KYC provider-managed path recommended · bank handling secure · webhook delivery real.

**Marketplace functionality: PASS (code-level).** Guest checkout restored + verified fail-closed chain (E2E staging-pending) · multi-vendor checkout intact · imports intact · search tokenized/relevance + submit-only · seller sync limitation communicated · all three portals function (live-verified).

**Operational readiness: PARTIAL.** CI exists (build gate pending a real runner) · supervision + scheduler health implemented · migrations reviewed, NOT applied (authorized envs only) · env documentation complete · monitoring honest.

---

## 12. Is NOMOFEE ready for Phase 3?

**Verdict: CONDITIONALLY READY — the marketplace is internally safe; it is not yet externally real.**

- **Ready to start Phase 3 (acceptance testing):** YES, in a non-money sandbox or staging with the mock rails + a configured email provider. Every financial/inventory/authorization integrity launch-blocker in this programme is now closed at code level, and the remaining gaps are exactly the ones that REQUIRE external authorization (PSP account, email account, domain, migrations in an authorized environment).
- **Ready for real customers/money: NO — and Phase 3 should not be expected to certify that until:** (1) the nine migrations are applied in an authorized environment and the DB-backed race suites pass; (2) the PSP decision (D1) is made and the adapter passes provider-sandbox testing; (3) the email provider is activated so OTP/verification/claiming actually deliver; (4) the KYC ownership decision (D3) is implemented to the chosen model.
- **Honest risk framing:** the two financial systems that touch real money post-launch (PSP rail and real email OTP) have never executed against a real provider in any environment. Phase 3's acceptance testing is the right place to close that — it should be run against provider SANDBOXES with authorized credentials, and its pass/fail criteria should include the §5 staging checklist above.

The objective set by the programme — *"a marketplace that can safely handle real customers, sellers, inventory, payments, refunds, commissions and settlements"* — is met at the code level for safety-critical paths; what remains is precisely the authorized-external world (database migrations, PSP, email) that this environment was never permitted to touch.

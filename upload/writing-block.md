# NOMOFEE — CONSOLIDATED REMEDIATION PROGRAMME
## Phase 2.2, Phase 2.3 & Phase 2.4
### Final engineering work before Phase 3 acceptance testing

## 1. OVERALL OBJECTIVE

We have completed several rounds of engineering work:

- Phase 1 — Security Hardening & Marketplace Correctness.
- Phase 2 — Performance, Operational Reliability & Scalability.
- Phase 2.1 — Remaining Security Gaps, Migration Verification & Production Readiness.
- Final Security Closure — Guest Order Ownership, Email Verification & Database Safety.
- Comprehensive Platform Assessment & Independent Technical Review.

The latest independent assessment identified additional problems that earlier audits missed.

I now want you to implement a consolidated remediation programme consisting of three sequential phases:

**Phase 2.2 — Critical Marketplace Integrity**

**Phase 2.3 — Production Integrations & Operational Readiness**

**Phase 2.4 — Marketplace Experience, Search & Growth Improvements**

The objective is to resolve the remaining important problems before proceeding to Phase 3, which will be the final end-to-end marketplace acceptance and production-readiness testing stage.

This is an implementation assignment, not another general assessment.

However, you must independently verify every finding before modifying anything.

Do not blindly implement recommendations that are already addressed, incorrect or unnecessary.

---

# 2. MANDATORY ENGINEERING RULES

These rules apply to all three phases.

### Rule 1 — Verify before fixing

Use the current codebase as the authoritative source.

Previous reports are historical references, not proof that the current implementation remains unchanged.

For every finding:

- Inspect the relevant source code.
- Trace the complete execution flow.
- Inspect relevant database models and existing migrations.
- Verify whether the problem still exists.
- Identify existing safeguards.
- Determine whether the recommended solution is appropriate.

Classify findings as:

- CONFIRMED.
- PARTIALLY CONFIRMED.
- ALREADY FIXED.
- INCORRECT.
- UNNECESSARY.
- DEFERRED.
- BLOCKED BY EXTERNAL DECISION.

Do not introduce redundant fixes.

### Rule 2 — Choose the optimum implementation

Select the most reliable and suitable implementation for NOMOFEE's actual architecture.

Prioritize:

1. Security.
2. Financial and inventory correctness.
3. Data consistency.
4. Reliability under concurrency.
5. Compatibility.
6. Maintainability.
7. Performance.
8. Infrastructure and operational simplicity.

Do not choose a complicated architecture merely because it is technically possible.

Do not introduce Kubernetes, microservices, Redis, external search services or additional infrastructure without demonstrating why they are required.

### Rule 3 — Preserve all successful previous implementations

Preserve:

- Double-entry financial ledger.
- Existing ledger dedupKeys.
- Session-token hashing.
- Password verification hardening.
- Administrator MFA.
- TOTP replay protection.
- CSRF protections.
- Caddy proxy trust configuration.
- SSRF-safe fetching.
- Import capability controls.
- Guest-order OTP and email-verification architecture.
- CAS-based inventory protection.
- Checkout idempotency.
- Payment webhook integrity.
- Refund locking.
- Checkout admission gate.
- Existing caching and invalidation.
- Search submit-only interaction.
- Affiliate tracking and commission snapshots.

Do not unnecessarily rewrite functioning systems.

### Rule 4 — Protect marketplace functionality

NOMOFEE is intended to operate as a multi-vendor marketplace.

Preserve:

- Shopper registration.
- Guest checkout.
- Guest order claiming.
- Seller registration and store claiming.
- Product importing.
- Multiple sellers in one checkout.
- Product variants.
- Cart and vouchers.
- Payments and refunds.
- Commissions and affiliate functionality.
- Seller wallets and settlements.
- Chat and notifications.
- Administrative operations.

**Important guest-checkout clarification:**

The latest audit found that the current implementation requires an authenticated shopper for checkout.

This contradicts our earlier explicit requirement to preserve guest checkout.

Treat guest checkout as an intended product requirement. Verify the current implementation and restore the ability to purchase without registering an account.

Use the existing guest-order ownership and email-verification mechanisms.

Do not confuse guest checkout with unverified access to customer order information.

### Rule 5 — Financial correctness must never be sacrificed for speed

Every financial operation must preserve:

- Idempotency.
- Transaction integrity.
- Ledger balance.
- Refund limits.
- Inventory consistency.
- Seller liability.
- Affiliate liability.
- Correct settlement calculations.

No duplicate payment, payout, commission, refund or stock restoration may occur.

---

# 3. OPERATIONAL RESTRICTIONS

Continue respecting the database-access restriction.

Do not connect to the existing Supabase project, production database or staging database without explicit authorization.

Do not:

- Apply migrations.
- Run database resets.
- Modify financial or inventory records.
- Perform test payouts.
- Execute production PSP transactions.
- Send real emails.
- Modify production infrastructure.
- Expose secrets.
- Automatically clean up existing test financial residue.

You may:

- Inspect source code and migration SQL.
- Modify application code.
- Create migration files.
- Add unit and integration tests.
- Prepare staging test scripts.
- Run safe local tests that do not connect to unauthorized databases.
- Run local builds and static analysis.
- Prepare provider integration adapters where they do not require external activation.

Do not silently use the existing development Supabase project for new tests.

If database-dependent testing is necessary, prepare the tests for a separately authorized staging environment.

Before beginning modifications, inspect Git status and protect all existing work.

Do not reset, overwrite or discard unrelated changes.

Do not create commits unless explicitly authorized.

---

# PHASE 2.2 — CRITICAL MARKETPLACE INTEGRITY

## 4. C1.1 — Fix PaymentGroup / Order expiry race

This is a critical inventory and payment correctness issue.

The independent audit found a possible stock-resurrection window:

1. An order is cancelled by the order-level expiry sweep.
2. Its inventory is restored.
3. Its PaymentGroup remains `requires_payment`.
4. A late successful webhook can still claim the PaymentGroup.
5. The cancelled order can transition to paid.
6. The customer may receive an order for inventory already sold to another buyer.

This must be fixed.

### Requirements

Inspect:

- PaymentGroup lifecycle.
- Order lifecycle.
- `releaseOrderReservation`.
- `/api/orders/expiry/tick`.
- Payment webhook group-claim logic.
- `transitionOrder`.
- Existing late-payment compensation mechanisms.

Implement a consistent atomic lifecycle.

Requirements:

1. The expiry process must coordinate the associated PaymentGroup and orders.
2. The order-level release path must not restock while leaving an eligible payment group claimable.
3. The webhook must verify the current state of every affected order before applying financial effects.
4. A cancelled or expired order must never be resurrected by a late successful webhook.
5. Stock must be restored exactly once.
6. Late successful payment must create the appropriate durable refund or reconciliation obligation.
7. Scheduler and polling paths must share consistent state-transition rules.
8. `/api/orders/expiry/tick` must not remain an unauthenticated privileged maintenance operation. Require the established cron authentication mechanism.
9. Preserve idempotency and InventoryLog records.

Do not introduce deadlocks through inconsistent row-lock ordering.

### Required tests

- Webhook versus expiry race.
- Expiry versus duplicate expiry.
- Late successful payment.
- Two simultaneous expiry workers.
- Multiple-order PaymentGroup.
- Stock restoration exactly once.
- No resurrection of cancelled orders.
- No duplicate ledger postings.

This item is a launch blocker.

## 5. C1.2 — Fix affiliate payout double-payment and refund race

This is a critical financial issue.

The audit found that `requestAffiliatePayout` may allow simultaneous payout requests to claim the same commission entries.

It also found that refunds occurring after payout request creation may not be reflected in the frozen payout amount.

### Requirements

Bring affiliate payout processing to the same standard as the seller payout system.

Inspect:

- `lib/affiliate.ts`.
- AffiliateCommission.
- Payout models.
- Payout approval.
- Payout execution.
- Refund reversals.
- PSP transfer idempotency.

Implement:

1. Transactional payout creation.
2. Appropriate Serializable isolation and bounded retry.
3. Atomic commission-entry claims using conditional updates, including `payoutId: null` where appropriate.
4. Database-level protection against duplicate open payout requests.
5. Correct reservation of commission liability.
6. Correct coordination between refunds and payout requests.
7. Revalidation of payout eligibility and amount before transfer.
8. Protection against simultaneous refund and payout processing.
9. Exactly-once external transfer behaviour using PSP idempotency.
10. Consistent ledger and audit records.

Important:

Do not simply recalculate an amount after a PSP transfer has already started.

Define a safe payout reservation and state-transition process so that a refund and payout cannot both consume the same commission liability.

Preserve affiliate commission calculation snapshots.

If schema migrations are needed, create them but do not apply them.

### Required tests

- Two simultaneous affiliate payout requests.
- Duplicate payout approval.
- Duplicate transfer requests.
- Refund before payout request.
- Refund after payout request but before approval.
- Refund during payout processing.
- Retry after PSP timeout.
- Exactly-once commission consumption.
- Ledger and affiliate liability reconciliation.

Temporarily prevent new affiliate payouts from being processed if the existing path is confirmed vulnerable. Preserve historical data.

## 6. C1.3 / C1.4 — Enforce seller approval and product moderation

The audit found conflicting seller publication paths.

A seller may potentially publish while onboarding, pending review or rejected.

Imported products also appear to bypass the moderation flow applied to manual products.

Unify the publication rules.

### Seller requirements

Verify the existing seller lifecycle and implement appropriate enforcement for:

- Onboarding.
- Pending review.
- Active.
- Rejected.
- Suspended.
- Terminated.

A seller must not be able to publish a public store while in an ineligible status.

Require the appropriate verification and approval state before public selling.

### Product requirements

Ensure manually created and imported products follow the same moderation and publication rules.

Imported products must not automatically become publicly active merely because an import succeeded.

Apply existing:

- Keyword flagging.
- Restricted product checks.
- Moderation status.
- Publication eligibility.

### State-machine consistency

The seller self-publish route and administrator approval route must use one authoritative state-transition mechanism.

Do not let one route override the approval requirements enforced by the other.

Preserve legitimate product importing and store-claiming workflows.

Do not invent KYC approval policies without identifying the business rules involved.

Until genuine seller verification is implemented, fail closed for public selling or payout privileges where required.

### Tests

- Pending seller cannot publish.
- Rejected seller cannot publish.
- Suspended seller cannot publish.
- Terminated seller cannot publish.
- Eligible approved seller can publish.
- Imported products enter the correct moderation state.
- Administrator approval follows the same state machine.
- Direct API manipulation cannot bypass these rules.

This item is a launch blocker.

## 7. C2.3 — Restore vouchers after eligible unpaid checkout expiry

The audit found that voucher redemption may happen during order creation, but unpaid expiry does not restore the redemption.

This can permanently consume customer vouchers or promotional quotas through abandoned checkouts.

Implement safe compensation.

Requirements:

- Identify eligible unpaid and expired reservations.
- Restore user voucher availability where appropriate.
- Restore applicable quota counters.
- Prevent duplicate restoration.
- Coordinate with successful or late payment.
- Preserve legitimate voucher usage restrictions.
- Maintain auditability.

Use idempotent status transitions and transactional safeguards.

Do not allow users to claim the same promotion repeatedly by manipulating expiry cycles.

## 8. C3 — Fix partial refund inventory restoration

The current implementation may restock an entire order line even when only a partial quantity is refunded.

Implement explicit restock quantities or refund-line quantity tracking.

Do not derive restock quantity merely from the refunded money amount.

Preserve:

- Financial refund amount.
- Restock quantity.
- Refund reason.
- Inventory audit records.

A partial monetary refund does not automatically mean a full product restock.

Add regression tests for partial and full refunds.

## 9. C3 — Fix refund rejection concurrency

Inspect the refund rejection route.

Replace unconditional state changes with an appropriate conditional claim or compare-and-set transition.

A refund that has already been processed must not be overwritten by a concurrent rejection.

Preserve the existing `FOR UPDATE` refund-processing safeguards.

Test simultaneous approval, rejection and processing.

## 10. C2.4 — Correct chat hub authentication rate limiting

The audit found that hub authentication requests may share an `unknown` IP bucket because requests originate from loopback.

This can create a platform-wide connection bottleneck during reconnect storms.

Implement appropriate authenticated identity-based rate limiting.

Requirements:

- Do not trust arbitrary client-supplied identity headers.
- Derive identity from the authenticated hub request or verified connection credential.
- Avoid using raw secrets as bucket keys.
- Prevent one shopper from consuming another shopper's quota.
- Preserve handshake authentication.
- Preserve fail-closed behaviour for invalid credentials.
- Preserve the existing bounded-memory protections.

Test reconnect bursts and simultaneous connections.

## 11. C3 — Inventory adjustment concurrency

The audit found that stock adjustment uses read-modify-write rather than an atomic conditional operation.

Correct this.

Requirements:

- Prevent concurrent adjustments from overwriting each other.
- Enforce non-negative stock.
- Validate integer quantities and permitted bounds.
- Preserve inventory logs.
- Preserve authorization.
- Ensure audit records match the final inventory state.

Use atomic database updates or version-based compare-and-set according to the existing schema.

## 12. C3 — Marketplace OAuth connection ownership

Verify `claim/bind` and import runner behaviour.

Marketplace connections must be associated with the correct seller and store.

Implement explicit ownership checks using the correct seller/store identifiers.

The import runner must never choose another seller's marketplace connection simply because it is the most recently created connection.

Preserve Shopee and TikTok integration functionality.

Test cross-seller and cross-store isolation.

## 13. C3 — Secretbox production fail-closed behaviour

Review development-key fallback behaviour for marketplace OAuth tokens.

Production must never silently encrypt sensitive credentials using a development fallback.

Require the appropriate configured production encryption key.

Fail closed when missing or invalid.

Preserve existing encrypted values and document the key-rotation strategy.

---

# PHASE 2.3 — PRODUCTION INTEGRATIONS & OPERATIONAL READINESS

## 14. C2.6 — Real payment provider integration

The latest audit confirms that all current checkout payment rails are mock-based.

This is a fundamental production blocker.

Assess appropriate PSP candidates for NOMOFEE's Malaysian multi-vendor marketplace.

Revisit relevant providers such as:

- Stripe Malaysia / Connect, where commercially available.
- Curlec.
- iPay88.
- CHIP-IN.
- Other appropriate providers discovered through current official documentation.

Do not assume that every PSP supports multi-vendor split payments.

### Comparison requirements

Compare:

- Malaysian merchant eligibility.
- Platform and marketplace support.
- Connected seller onboarding.
- Seller KYC.
- Split payments.
- PSP transfers.
- Bank payouts.
- Delayed settlement.
- Refunds.
- Chargebacks.
- Webhook signatures.
- Idempotency.
- Provider references.
- MYR support.
- Fees.
- Setup costs.
- Settlement timelines.
- Operational restrictions.

Distinguish clearly between:

1. Collecting money from a customer.
2. Allocating funds between platform and sellers.
3. PSP transfers.
4. Actual bank payouts.

Do not assume that a PSP transfer and bank payout are the same operation.

### Implementation requirements

Prepare the adapter architecture around the existing `PSPProvider` abstraction.

Preserve mock functionality for testing.

Ensure production cannot silently fall back to mock payment processing.

Implement only after the provider choice and commercial configuration are explicitly authorized.

Requirements for the selected provider:

- Payment creation.
- Signature-verified webhooks.
- Amount and currency verification.
- Duplicate webhook handling.
- Payment retries.
- Refund references.
- PSP transfer tracking.
- Seller payout references.
- Reconciliation.
- Failure recovery.

Do not enable live-money processing until provider-sandbox testing passes.

## 15. Transactional email — Resend / Brevo

The platform currently has no genuine transactional email delivery.

A notification log entry is not a delivered email.

Evaluate the following official providers using current documentation:

Brevo: https://www.brevo.com/

Resend: https://resend.com/

Previous technical assessment preferred Resend because of its developer experience, signed webhook verification and email idempotency.

Treat Resend as the preferred candidate, but verify current features, pricing, regional considerations, limits and suitability before finalizing.

Do not assume previous pricing or feature information remains current.

### Required email functionality

The selected provider must support:

- Guest-order OTP.
- Shopper email verification.
- Password recovery.
- Order confirmation.
- Payment notifications.
- Refund notifications.
- Shipping notifications.
- Seller registration and verification.
- Seller order notifications.
- Settlement and payout notifications.
- Security alerts.

### Architecture

Implement the existing `TransactionalEmailChannel` abstraction.

Keep provider-specific logic inside an adapter.

Do not tightly couple OTP or authentication code to the email vendor.

If Resend is approved, implement a Resend adapter.

Requirements:

- Secure API-key storage.
- Domain verification.
- SPF, DKIM and DMARC.
- Request idempotency.
- Timeouts.
- Delivery-failure handling.
- Bounce and complaint processing.
- Signed webhook verification.
- Retry handling.
- Suppression of hard-bounced addresses.
- IDs-only audit logging.
- No OTP or API secrets in logs.

Do not send actual emails until the provider account, domain and credentials are authorized and configured.

Use a real local mail testing service such as Mailpit for isolated development testing when appropriate.

Do not expose fake OTP delivery.

## 16. C2.7 — Seller email verification and KYC

The audit found that seller email verification is incomplete and KYC document ingestion is only a facade.

Review the current seller onboarding flow.

Implement a genuine seller verification architecture.

Consider whether the selected PSP can manage seller identity verification and connected-account onboarding.

Prefer provider-managed KYC when it safely meets business and compliance requirements.

Otherwise, assess a secure document upload and storage design.

Never claim a seller's identity has been verified when no actual verification occurred.

Requirements:

- Seller email verification.
- Seller identity verification status.
- Verification-pending state.
- Approval/rejection workflow.
- Secure document handling where applicable.
- Administrative review.
- Access control.
- Audit trail.
- Retention and deletion policy.
- Restrictions on publishing and payouts until appropriate requirements are met.

Do not invent jurisdiction-specific legal requirements.

Identify decisions that require owner or legal approval.

## 17. C2.5 — Bank account handling and payout destinations

The audit found that bank account numbers are effectively discarded and that an existing encryption mechanism is not being used.

Assess whether the selected PSP can manage payout banking details directly.

Prefer provider-managed bank onboarding when suitable, reducing NOMOFEE's responsibility for sensitive banking information.

If NOMOFEE must retain account details:

- Use the existing AES-GCM secretbox mechanism correctly.
- Never store raw account numbers.
- Never expose complete account numbers through GET responses.
- Use masked display.
- Enforce access controls.
- Audit sensitive operations.
- Implement key rotation and recovery.

Preserve the PSP transfer versus actual bank payout distinction.

Ensure the platform can retain and reconcile the appropriate provider references.

## 18. C2.8 — Implement real seller webhook delivery

The audit found that webhook delivery records may report success without making any HTTP request.

Correct this.

Implement actual outbound webhook delivery.

Requirements:

- Real HTTP request.
- HMAC signing.
- Request timeout.
- SSRF protections.
- Retry policy.
- Idempotency.
- Delivery attempt records.
- Accurate response status.
- Backoff.
- Failure state.
- Administrative visibility.

Never report `success` unless a real delivery attempt returned an accepted response according to the defined contract.

Use safe outbound networking and prevent sellers from using webhook URLs to reach internal infrastructure.

A durable queue or dedicated worker may be introduced only if the current mini-service architecture cannot deliver reliable retries.

Do not add unnecessary infrastructure.

## 19. Security headers and browser session storage

The latest audit identified potentially weak browser token storage and missing security headers.

Reassess:

- localStorage session tokens.
- XSS exposure.
- CSP.
- HSTS.
- X-Content-Type-Options.
- Referrer-Policy.
- Other relevant response headers.
- Production error-message sanitization.

Implement appropriate security headers.

Consider moving browser authentication to Secure, HttpOnly cookies where suitable.

However, do not blindly replace the existing authentication transport.

Preserve:

- Current CSRF protections.
- Guest-order grants.
- Chat authentication.
- Mobile/API authentication where applicable.
- Existing session revocation.

If changing browser token storage, implement a coordinated authentication design and test all portals and API clients.

Do not introduce an authentication regression to eliminate a storage concern.

Production errors must not reveal raw internal exception messages or sensitive implementation details.

## 20. Production deployment and operational supervision

The latest assessment identified several operational shortcomings.

Address the following:

### Production build and CI

- Produce a real production build.
- Verify the build in the intended deployment configuration.
- Inspect the referenced but missing CI workflow.
- Create the appropriate CI workflow if genuinely absent.
- Include type checking, linting, relevant automated tests and build validation.
- Do not claim production build success based on dev-server compilation.

### Process supervision

Review the three services:

- Caddy/web application.
- Chat service.
- Expiry scheduler.

Establish reliable process supervision and restart behaviour using the actual hosting environment.

Do not assume systemd or Docker Compose exists without verifying the deployment model.

The scheduler must have external health monitoring, not merely its own internal state file.

Address the previously reported silent scheduler outage.

### Environment configuration

Ensure `.env.example` and deployment documentation include every required variable, including:

- MFA_ENCRYPTION_KEY.
- IMPORT_CAP_SECRET.
- ORDER_ACCESS_SECRET.
- EMAIL_OTP_SECRET.
- EMAIL_PROVIDER.
- Applicable email provider credentials.
- PSP_WEBHOOK_SECRET.
- CRON_SECRET.
- Optional rate-limiting configuration.
- Other required production secrets.

Do not put actual secret values into example files.

Production boot should fail clearly when mandatory secrets are missing.

### Monitoring

Verify that the metrics pipeline works or remove misleading dead-code representations.

Add useful monitoring for:

- Payment failures.
- Webhook backlog.
- Payout failures.
- Inventory expiry.
- Scheduler health.
- Checkout latency.
- Database pressure.
- Email delivery failures.
- Seller webhook failures.

Never expose sensitive information in monitoring output.

## 21. Settlement configuration

The audit found that the hold-days and grace-period override chain may not affect actual ledger maturity calculations.

Inspect:

- Global hold settings.
- Seller overrides.
- Product/category overrides.
- Delivery-based maturity rules.
- Affiliate hold periods.
- Actual T1 ledger creation and maturity.

Determine which settings are genuinely intended to affect settlement.

Either wire the documented configuration into the authoritative calculation or remove misleading non-functional settings from the administrative interface.

Do not silently change current seller payout policies.

Preserve existing business rules unless an explicit policy change is authorized.

---

# PHASE 2.4 — MARKETPLACE EXPERIENCE, SEARCH & GROWTH

## 22. C2.2 — Improve main marketplace search

The latest audit found that the main search endpoint uses case-sensitive substring matching and fails to use the more capable existing tokenized search engine.

Fix the actual marketplace search implementation.

Use the existing `_shared/search.ts` engine after verifying its correctness and intended behaviour.

Requirements:

- Case-insensitive search.
- Tokenized search.
- Search across appropriate product fields.
- Appropriate relevance ranking.
- Multi-word queries.
- Partial matching where appropriate.
- Correct filtering by store/category.
- Correct pagination.
- Deterministic sorting.
- Appropriate PostgreSQL indexes.

Evaluate `pg_trgm` and other suitable PostgreSQL indexing approaches.

Do not introduce Elasticsearch, Typesense or another external search engine at this stage unless there is evidence the existing PostgreSQL architecture is insufficient.

### Preserve submit-only search

The desired search interaction is already established.

Customers must be able to type freely without triggering search requests.

Search occurs only when they:

- Press Enter.
- Click the Search button/icon.

Do not reintroduce per-character autocomplete requests.

Preserve the current no-autocomplete behaviour.

Ensure pagination, filters and sorting continue using the submitted keyword.

### Cache requirements

Preserve search normalization and cache-key protection.

Avoid caching incomplete queries.

Ensure query length, whitespace and unusual characters are handled correctly.

Measure search quality and response time before and after implementation.

## 23. C3 — Seller external-marketplace stock warning

Shopee and TikTok imports currently do not provide complete stock and price write-back synchronization.

Until that capability exists, make the limitation clear to sellers.

Display an appropriate warning in the seller interface:

"Products imported from external marketplaces are not automatically synchronized. Stock and price changes made on NOMOFEE do not automatically update your Shopee or TikTok listings."

Do not suggest synchronization exists when it does not.

Preserve current import functionality.

A future two-way synchronization feature should have its own idempotency, conflict-resolution and inventory-authority design.

Do not implement it in this task unless the current APIs genuinely support it and the business requirements are established.

## 24. Chat experience and UX improvements

Inspect:

- Chat history pagination.
- Chat message-send rate limiting.
- Browser back/forward integration.
- Mobile navigation.
- Large portal bundle loading.
- Search and storefront usability.
- Order-number display consistency.
- Product discovery UX.

Correct the `SM-` versus `NM-` order-number copy bug.

Implement browser History support where appropriate so mobile shoppers do not exit the website when pressing Back.

Consider code-splitting shopper, seller and admin portals to avoid loading every portal unnecessarily.

Improve chat pagination and message abuse protection.

Do not introduce broad UI redesigns or break existing portal functionality.

## 25. SEO and storefront delivery

Assess:

- Public product metadata.
- Storefront metadata.
- Open Graph images.
- Canonical URLs.
- Product JSON-LD.
- Sitemap generation.
- Large-catalog sitemap scalability.

Ensure search query parameters do not create unnecessary duplicate SEO pages.

Consider sitemap chunking when justified by actual product volume.

Do not compromise private-page security or force dynamic caching changes on personalized content.

## 26. Other cleanup and integrity improvements

Reassess:

- Dead metrics code.
- Unused dependencies.
- Unused models.
- Stale documentation.
- Broken financial reconciliation tooling.
- Obsolete SQLite-era references.
- Missing CI configuration.
- Misleading simulated webhook success records.
- Constant-time comparison of sensitive claim tokens.
- Anonymous import abuse and category pollution.
- Notification read-state.

For every proposed cleanup, verify that the feature is genuinely unused.

Remove or correct misleading functionality rather than leaving something that falsely suggests it is operating.

Do not conduct indiscriminate refactoring.

---

# 27. EXECUTION ORDER AND PHASE GATES

You must execute the programme in the following sequence.

## Step 0 — Protect the current implementation

Before modifications:

- Inspect Git status.
- Identify outstanding user changes.
- Confirm the current Phase 1/2/2.1/Final Closure implementation.
- Prepare a safe checkpoint recommendation.
- Do not reset or discard changes.
- Do not overwrite existing working features.

## Step 1 — Complete Phase 2.2

Prioritize:

1. PaymentGroup/order expiry race.
2. Affiliate payout double-payment and refund race.
3. Seller publishing governance.
4. Imported product moderation.
5. Voucher restoration.
6. Partial refund restock.
7. Refund rejection concurrency.
8. Chat hub authentication rate limiting.
9. Inventory adjustment CAS.
10. OAuth seller/store ownership.
11. Production secretbox fail-closed behaviour.
12. Restore intended guest checkout if the existing code does not support it.

Do not begin Phase 2.3 until the critical Phase 2.2 work has been implemented and the corresponding available tests have passed.

Provide a Phase 2.2 completion report.

If database-backed concurrency testing is unavailable, prepare the tests and classify the phase as implementation-complete but verification-pending.

## Step 2 — Complete Phase 2.3

Proceed with:

1. PSP provider research and selection recommendation.
2. Transactional email provider decision and implementation preparation.
3. Seller email verification.
4. Seller KYC/onboarding.
5. Bank payout destination security.
6. Actual store webhook delivery.
7. Production security headers and browser authentication review.
8. Production build.
9. CI workflow.
10. Process supervision.
11. Scheduler monitoring.
12. Environment documentation.
13. Settlement configuration verification.

External provider decisions must be clearly identified.

For Resend, use it as the preferred email candidate based on the previous technical comparison, but verify current official documentation and pricing before finalizing.

Do not activate an account, send actual emails or enable a provider without authorized credentials and owner approval.

For PSP, do not assume a provider is suitable simply because it supports ordinary payment collection. It must satisfy the marketplace's vendor-onboarding, commission, transfer, refund and payout requirements.

Provide a Phase 2.3 completion report.

## Step 3 — Complete Phase 2.4

Proceed with:

1. Main marketplace search improvements.
2. Appropriate PostgreSQL indexes.
3. Preserve submit-only search.
4. External marketplace synchronization warnings.
5. Chat pagination and rate limiting.
6. Browser History support.
7. Portal code splitting.
8. SEO and sitemap improvements.
9. Metrics and operational cleanup.
10. Final documentation consistency review.

Provide a Phase 2.4 completion report.

## Step 4 — Consolidated handoff

After all three phases, prepare one consolidated report.

Include:

- All modified files.
- All migrations created.
- All external decisions still pending.
- Tests passed.
- Tests failed.
- Tests not executed.
- Database-dependent verification requirements.
- PSP and email provider readiness.
- Outstanding business-policy decisions.
- Security and financial risks.
- Deployment prerequisites.
- Rollback considerations.

Do not declare Phase 3 ready merely because all code changes have been implemented.

---

# 28. TESTING REQUIREMENTS

For every critical change, provide relevant:

- Unit tests.
- Integration tests.
- Transaction tests.
- Concurrency tests.
- Security tests.
- Regression tests.

Important scenarios include:

- Expiry versus payment webhook.
- Affiliate payout versus refund.
- Simultaneous affiliate payout requests.
- Seller publication and approval.
- Imported product moderation.
- Voucher expiry and payment races.
- Partial refund quantities.
- Inventory adjustment races.
- Cross-seller OAuth isolation.
- Guest checkout.
- Guest-order OTP.
- Seller email verification.
- Email-provider delivery events.
- PSP webhook idempotency.
- Refund and payout reconciliation.
- Search case-insensitivity and relevance.
- Cache invalidation after inventory changes.

Never claim that a staging-only test passed when only a unit test was run.

Measure performance before and after relevant optimizations.

Do not run uncontrolled load tests against existing development or production infrastructure.

---

# 29. ITEMS NOT TO OVERENGINEER

Unless new evidence justifies it, do not:

- Replace the financial ledger.
- Rewrite the checkout architecture.
- Introduce multi-region deployment.
- Introduce Kubernetes.
- Build a new search service.
- Introduce Redis solely for hypothetical scaling.
- Build a large worker infrastructure prematurely.
- Introduce unnecessary UI virtualization.
- Change working transaction isolation levels without evidence.
- Increase Prisma pool size blindly.
- Replace existing human-readable order numbers.
- Remove existing guest-order verification features.
- Rewrite secure-fetch or CSRF protections.
- Change commission or rounding policies unnecessarily.

Preserve the current architecture wherever it is already appropriate.

---

# 30. FINAL ACCEPTANCE CRITERIA BEFORE PHASE 3

At the end of this consolidated remediation programme, evaluate the following.

### Critical marketplace integrity
- No payment/expiry stock resurrection.
- No affiliate double payout.
- No unapproved seller publication.
- No imported-product moderation bypass.
- No voucher loss caused by expired unpaid checkouts.
- No excessive restocking from partial refunds.
- No refund status overwrite race.
- No cross-seller marketplace connection access.
- No lost inventory updates.

### Production integration
- Real email provider adapter available and verified in an authorized test environment.
- Guest OTP and shopper email verification delivery tested.
- PSP selection completed and actual provider sandbox integration tested.
- Seller verification mechanism established.
- Bank payout handling secure.
- Store webhook delivery implemented honestly.

### Marketplace functionality
- Guest checkout restored and tested.
- Multi-vendor checkout intact.
- Product imports intact.
- Search works correctly and remains submit-only.
- Seller marketplace limitations communicated.
- Shopper, seller and admin portals function correctly.

### Operational readiness
- Production build succeeds.
- CI workflow exists and works.
- Scheduler is supervised and monitored.
- Migrations are reviewed and ready for authorized staging deployment.
- Required environment variables are documented.
- Monitoring and recovery procedures exist.

### Evidence standard

Separate all results into:

1. Code-level verified.
2. Local test verified.
3. Authorized staging verified.
4. Provider sandbox verified.
5. Production verified.

Do not promote evidence from one category into another.

---

# 31. FINAL INSTRUCTION

This programme is intended to close the remaining important issues before NOMOFEE enters Phase 3.

Work sequentially.

Preserve existing successful implementations.

Prioritize genuine financial, inventory and customer-protection risks over cosmetic changes.

Use the simplest reliable engineering solution.

Do not silently invent business rules or select external providers without the necessary owner authorization.

When blocked by an external decision, provide the exact decision required and continue with independent work where safe.

Do not execute migrations or access unauthorized databases.

Do not start Phase 3.

At the end, give me an honest assessment of whether NOMOFEE is ready to proceed to:

**Phase 3 — Final End-to-End Marketplace Acceptance & Production Readiness Testing.**

The objective is not to achieve the largest possible number of code changes.

The objective is to have a marketplace that can safely handle real customers, sellers, inventory, payments, refunds, commissions and settlements.

**Correctness, security and financial integrity come first. Performance and scalability must support them, never undermine them.**
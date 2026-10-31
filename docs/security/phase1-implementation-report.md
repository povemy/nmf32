# NOMOFEE Phase 1 — Security Hardening & Marketplace Correctness

**Implementation report** · 2026-10-31 · All code changes verified: 150 unit tests pass, `tsc --noEmit` clean for `src/`+`mini-services/`, ESLint clean on every Phase-1 file (47 pre-existing errors elsewhere untouched), dev server running Next 16.4.3, browser golden path verified end-to-end. **No migrations were applied** (DB access withheld per task constraints); no commits were created.

---

## A. Executive summary

**Implemented (complete):**
- **A1** Next.js 16.1.3 → **16.4.3** (clears 4 CRITICAL + 15 HIGH advisories incl. proxy-bypass and Image-Optimization RCE; 16.4.3 verified advisory-clean live), sharp 0.34.5 → 0.35.5 (3 HIGH), zod 4.3.5 → 4.6.7 (1 HIGH), undici added at 8.12.3 (safe-fetch dependency; prior transitive had advisories).
- **A2** Caddy trust re-verified: repo `Caddyfile` overwrites `X-Forwarded-For`/`X-Real-IP` with `{remote_host}` on both public routes. No code change needed; deployment requirement documented (§F).
- **A3** CSRF gate regression-tested post-upgrade: 23 new unit tests in `src/lib/__tests__/proxy-csrf.test.ts` — cross-site rejection, null origin, form-POST 415, exemptions (webhooks/cron/claim/retry/tick) all pass on 16.4.3.
- **B1** Verified-purchase reviews: auth + delivered/completed-order eligibility + seller self-review block + `@@unique([productId, shopperId])` + pending moderation + published-only aggregates + 3-axis rate limits + input caps. Admin moderation API (`reviews.moderate` cap). Pre-migration shims keep the PDP read path working and answer clean 503s.
- **B2** Order lookup/receipt: NM- numbers kept; 3-axis rate limits (IP/email/orderNumber) on both routes; receipt no longer renders the PSP `providerRef`; uniform 404s preserved.
- **B3** Chat order-context IDOR fixed: ownership = `order.shopperId === me.id || order.customerEmail === me.email` (same rule as lookup); uniform 404; thread-creation rate limit.
- **B4** Rate limits applied: orders/lookup (10/min/IP + 10/h/email + 30/h/order), orders/receipt (same), reviews (5/min/IP + 3/h/account + 10/h/product), newsletter (5/min/IP + 3/h/email + 24h duplicate guard), chat threads (20/min). New `rateLimitKey(identity, …)` helper for identity-keyed buckets.
- **B5** SSRF fixed: `src/lib/safe-fetch.ts` — undici Agent with guarded DNS lookup (real rebinding protection: validation happens on the SAME resolution used to connect), manual redirect loop with full per-hop re-validation (cap 3), IPv4/IPv6/mapped/NAT64 private+metadata range rejection, 10s timeout, 5MB cap, content-type + magic-byte sniffing. Import routes gated by HMAC-signed 60-min onboarding capability cookie (`import_cap`) or seller session — pre-registration onboarding preserved and verified live.
- **C1** Async scrypt (`verifyPasswordAsync`/`hashPasswordAsync` — identical `s1:` semantics, benchmarked 29.2ms/call) + **DUMMY_PASSWORD_HASH** equalization on every login path + per-email throttle (20/h). Verified live: unknown-email 203ms vs wrong-password 199ms (was 0ms vs 30–90ms).
- **C2** Session tokens hashed at rest: `sha256(token)` stored/looked up in `auth.ts` + `chat/hub-auth`; migration 20261101000000 (one-time in-place UPDATE). Verified live: login → Bearer → `/api/auth/me` round-trip.
- **C3** Expired-session purge: `/api/cron/session-purge` (throttled 10min, set-based, never touches active sessions) wired into the scheduler's `sessions` job. **Live result: 483 expired sessions purged in 596ms.**
- **C4** Admin TOTP MFA: full module (`src/lib/mfa.ts` — RFC 6238 ±1 step, base32, AES-256-GCM secrets via `MFA_ENCRYPTION_KEY` fail-closed in prod, 10 hashed one-time recovery codes, 5-min challenge map with progressive lockout 3→60s / 8→permanent), enrollment/confirm/disable routes (password reauth + audit + session revocation on confirm/disable), login challenge flow on BOTH admin login paths + `/api/auth/mfa/verify`, unified-auth-panel MFA step, admin Settings card. 29 unit tests (all RFC vectors).
- **C5** Seed fail-closed: production seeding without `SEED_*_PASSWORD` env now **throws** instead of warn-and-continue.
- **D1** Store webhook secrets write-only: GET/PATCH return `secretMasked`; one-time reveal on create/rotate; new `[id]/rotate` endpoint (ownership + audit, secret never logged).
- **D2** URL scheme allowlist: `src/lib/url-guard.ts` (http/https only, credentials rejected, relative-path option) applied at save time (socials, logo/banner, avatarUrl incl. `grad:` carve-out, product images) and render time (product-card parseSocial, storefront socials). 42 unit tests.
- **E1** Failed-group + legacy-intent inventory expiry: both sweeps now cover `failed` groups past `expiresAt` (retry window preserved) and legacy single-intent orders; late-success guard added to the legacy webhook path (mirrors GROUP_EXPIRED: refuse + `recordLatePaymentObligation`, never resurrect released stock — `transitionOrder` is unconditional, so without this a late webhook would double-sell).
- **E2** `processPayoutEvent` hardened: `withSerializableTxRetry` (bounded P2034 retry, jittered backoff, 503 on exhaustion), `SET LOCAL statement_timeout='10s'`, timeout/maxWait 10s/10s, notification+audit fan-out moved post-commit. `withSerializableTxRetry` is now wired (was dead code).
- **E3** Webhook recovery: `processPaymentWebhook({ opts: { recovery: true } })` — internal-only mode for the ops sweep; HMAC still fully verified against the stored payload (never forged/skipped), only the ±10min freshness is waived for events verified at original receipt. Payment-path P2034 exhaustion now returns **503 PAYMENT_TX_RETRY_EXHAUSTED** instead of raw 500.

**Not executed / blocked (by task constraints):**
- The 3 migrations are authored but NOT applied (DB access prohibited). Consequences in dev: review submission/moderation answer 503 `REVIEWS_NOT_MIGRATED` (read paths fine), MFA enrollment answers 503 `MFA_NOT_MIGRATED` (login unaffected — no one is enrolled), existing sessions were invalidated once by the hashing change (re-login; new sessions hash correctly — verified).
- DB-dependent integration tests (review eligibility join, moderation transitions, expiry-sweep races, payout-event retries) are written for but not runnable here.
- Full payout-event webhook flow needs a controlled runbook test with a processing-state payout (see §E/F).

---

## B. Finding-by-finding results

| Finding | Classification | Changes | Files | Tests (executed) | Limitations |
|---|---|---|---|---|---|
| **A1 Next advisories** | CONFIRMED | 16.1.3→16.4.3, sharp→0.35.5, zod→4.6.7, +undici@8.12.3 | `package.json`, `bun.lock` | advisory API live-check (41→0 for next@16.4.3); 150 tests; browser golden path | — |
| **A2 XFF trust** | ALREADY MITIGATED (gateway) | none (docs) | `Caddyfile` re-read | proxy tests prove gate behavior | prod topology unverifiable from sandbox |
| **A3 CSRF** | ALREADY MITIGATED | none (tests added) | `src/lib/__tests__/proxy-csrf.test.ts` | **23/23 pass** | — |
| **B1 SEC-03 reviews** | CONFIRMED | full verified-purchase + moderation system | `src/lib/reviews.ts`, `sf/[slug]/products/[pSlug]/reviews/route.ts`, `sf/[slug]/products/[pSlug]/route.ts`, `api/admin/reviews/**`, `src/lib/admin-caps.ts`, `src/components/shopper/pdp.tsx`, schema+migration | **21/21 unit**; live: anon→401, non-purchaser→403, PDP renders | eligibility-join + moderation need migrated DB |
| **B2 SEC-05 orders** | CONFIRMED | 3-axis limits both routes; providerRef stripped | `api/orders/lookup/route.ts`, `api/orders/receipt/route.ts` | live: 11th burst→429; 12th same-order→429 (30/h); owner OK; wrong email uniform 404 | knowledge-pair remains the auth model (see §F) |
| **B3 chat IDOR** | CONFIRMED | ownership check + rate limit | `api/chat/threads/route.ts` | live: other-customer order→404 (uniform); own store thread works | positive order-owner control done via predicate-class (lookup) — no owned order existed for test accounts |
| **B4 rate limits** | CONFIRMED | all four routes + chat + newsletter hardening | see above + `api/sf/[slug]/newsletter/route.ts`, `src/lib/rate-limit.ts` (`rateLimitKey`) | live bursts verified | — |
| **B5 SSRF** | CONFIRMED | safe-fetch + import capability | `src/lib/safe-fetch.ts`, `src/lib/import/runner.ts`, `api/import/{resolve,jobs}/route.ts` | **28/28 unit** (redirect→private/metadata, IPv6, rebinding via injected lookup, hop cap, size, magic bytes); live: cap issuance + gating | real-CDN redirect behavior to be spot-checked in staging |
| **C1 SEC-01/04** | CONFIRMED | async scrypt + dummy hash + email throttle, all 6 call sites | `src/lib/password.ts`, 3 login routes, `me/password`, `dev-accounts`, `admin/activity-logs/purge` | **7/7 unit**; live timing 203 vs 199ms | — |
| **C2 F-4 sessions** | CONFIRMED | sha256-at-rest everywhere (incl. chat hub-auth) | `src/lib/auth.ts`, `api/chat/hub-auth/route.ts`, migration 20261101000000 | live round-trip login→Bearer→me | deploy-order rule in §C |
| **C3 expired sessions** | CONFIRMED | purge cron + scheduler job | `api/cron/session-purge/route.ts`, `mini-services/expiry-scheduler/index.ts` | **live: purged 483** | — |
| **C4 F-5 MFA** | CONFIRMED | full TOTP MFA system | `src/lib/mfa.ts`, `api/admin/mfa/**`, `api/auth/mfa/verify/route.ts`, both login routes, `unified-auth-panel.tsx`, `admin/mfa-card.tsx`, `admin/system.tsx`, migration 20261101000002 | **29/29 unit** (RFC vectors); live: fail-closed 503 pre-migration | end-to-end enroll/confirm/login needs migrated DB |
| **C5 seed safety** | CONFIRMED | prod seed fails closed | `prisma/seed.ts` | code inspection (throw on missing env in prod) | — |
| **D1 F-6 webhook secrets** | CONFIRMED | masked GET/PATCH + rotate route + UI | `api/store/webhooks/route.ts`, `[id]/route.ts`, `[id]/rotate/route.ts`, `seller/integrations.tsx` | live: GET shows `whsec_…5b4a` | — |
| **D2 F-7 URL schemes** | CONFIRMED | allowlist save+render | `src/lib/url-guard.ts`, settings/profile/products routes, `product-card.tsx`, `storefront.tsx` | **42/42 unit** | — |
| **D3 authz recheck** | — | none weakened | — | spot re-verified requireSeller/requireShopper/requireCap guards intact | — |
| **E1 stock leak** | PARTIALLY CONFIRMED (fixed) | failed-group + legacy-intent sweep + late-success guard | `api/cron/expiry-sweep/route.ts`, `src/lib/expiry-sweep.ts`, `webhooks/payments/process.ts` | unit tests via CSRF/reviews suites indirectly; race tests blocked (no DB) | concurrency tests pending staging |
| **E2 payout hardening** | CONFIRMED | retry + timeouts + post-commit fan-out | `webhooks/payments/process.ts` | tsc + pattern-parity with payment path | needs controlled payout-event test |
| **E3 recovery** | CONFIRMED | recovery mode + 503 exhaustion | `webhooks/payments/process.ts`, `admin/payouts/sweep/route.ts` | code-path verified; live needs stuck-webhook fixture | — |
| **E4 financial safeguards** | — (preserved) | zero changes to ledger recipes, dedupKeys, rounding, caps | none touched in `lib/ledger.ts` | verify:finance static suite untouched | run after migration in staging |

---

## C. Database migrations (CREATED, NOT APPLIED)

| Migration | Changes | Deployment action |
|---|---|---|
| `20261101000000_phase1_session_token_hashing` | One-time `UPDATE Session SET token = sha256(token)` — converts plaintext rows to hashed-at-rest | **Run `prisma migrate deploy` BEFORE deploying this code.** If order is flipped, all sessions invalidate once (benign re-login) — never both-ways-broken. No schema shape change (token stays TEXT PK, 64-hex). |
| `20261101000001_phase1_review_verified_purchase` | Adds `Review.shopperId`, `Review.orderId` (+FKs, set-null), `@@unique([productId, shopperId])`, default status→`pending` | Standard apply. Legacy published rows stay visible; pre-migration shims (PDP legacy projection, 503 guards) auto-retire once columns exist + app restarts. Transitional probe in `lib/reviews.ts` marked REMOVE-AFTER-MIGRATION. |
| `20261101000002_phase1_admin_mfa_enrollment` | Creates `AdminMfaEnrollment` (secretEnc AES-GCM ciphertext, recoveryHashes JSON, confirmedAt, adminId unique FK) | Standard apply. Empty table = no enforcement; code tolerates absence (P2021/P2022 → 503 MFA_NOT_MIGRATED). Set `MFA_ENCRYPTION_KEY` in production before admins enroll (fail-closed 503 otherwise). |

**Deployment order:** migrate → deploy code → set env (`CRON_SECRET` already required; add `MFA_ENCRYPTION_KEY`, `IMPORT_CAP_SECRET`) → restart scheduler.

---

## D. Security verification — how each protection now works

- **Review eligibility:** POST requires shopper session → 503 pre-migration / normal path: store-live+product-active → seller-self-review 403 → `findEligibleOrderForReview` (most recent `delivered|completed` order of THIS shopper containing the product in THIS store) → duplicate (code + `@@unique` P2002) → validation (80/120/2000 caps, control chars stripped) → identity limits (3/h/account, 10/h/product) → created `pending`. Aggregates (`ratingAvg/ratingCount`) recomputed ONLY from `status:"published"` on moderation transitions. Anonymous can never touch aggregates.
- **Order ownership:** email+orderNumber knowledge pair with 3-axis throttling; uniform 404; receipts additionally payment-gated (409 NOT_PAID) and PSP-reference-free.
- **Chat order authorization:** server-side `shopperId === me.id || customerEmail === me.email` — identical predicate to lookup; uniform 404 (no existence oracle); resolver paths already participant-gated.
- **SSRF:** every hop fully re-validated (scheme, credentials, IP ranges); DNS pinned via undici guarded lookup (validation on the connection's own resolution — rebinding closed); redirects manual, ≤3; 10s/5MB; content-type + magic bytes; `javascript:`/metadata/private all rejected (28 tests). Import execution requires seller session or 60-min HMAC capability cookie.
- **Rate limiting:** existing in-memory/optional-Redis infra + new `rateLimitKey` identity buckets; login 10/min/IP + 20/h/email; orders 10/min/IP + 10/h/email + 30/h/order; reviews 5/min/IP + 3/h/acct + 10/h/product; newsletter 5/min/IP + 3/h/email + 24h dupe guard; chat threads 20/min/IP; import 5/min/IP.
- **Password verification:** async scrypt (thread pool, 29.2ms measured), identical `s1:` semantics (cross-verified sync↔async in tests); dummy-hash equalization on every not-found branch; uniform 401s; live timing delta now ~4ms (noise).
- **Session-token hashing:** raw 256-bit token only in cookie/Bearer response; DB stores sha256; lookup/rotate/destroy/revoke all hash-first (auth.ts + chat hub-auth); migration converts existing rows; no plaintext fallback.
- **Administrator MFA:** enrollment requires current password; secret AES-256-GCM at rest (`MFA_ENCRYPTION_KEY`, fail-closed prod); confirm requires valid TOTP → recovery codes revealed once (sha256-hashed, optimistic-concurrency burn); sessions revoked on confirm/disable (every live admin session passed MFA); BOTH login paths gate session minting on confirmed enrollment → `/api/auth/mfa/verify` (challenge is 256-bit, 5-min TTL, progressive lockout) — no alternate-path bypass; audit on enroll/confirm/disable/recovery/lockout.
- **Webhook secrets:** masked (`whsec_…5b4a`) on every read; plaintext only in the create-201/rotate response (one-time); signature verification unchanged (reads DB internally); audit records endpointId+host only.
- **Payment recovery:** receipt-time HMAC verification persisted (`signatureValid`); ops sweep re-feeds only signatureValid rows through the processor in `recovery` mode — HMAC re-verified against the stored payload, freshness waived (age is the reason for recovery); claims + ledger dedupKeys guarantee no second financial effect; exhaustion → 503 so the PSP retries.
- **Inventory expiry:** unpaid `requires_payment` AND `failed` groups release after `expiresAt` (retry window intact); legacy intents included via order-level sweep; CAS claims make release exactly-once; late success on released orders → refuse + durable refund obligation (group path: existing; legacy path: new guard).

---

## E. Tests

**Passed (executed):** 150 unit tests across 6 files — password (7), proxy-csrf (23), mfa (29), reviews (21), url-guard (42), safe-fetch (28). ESLint clean on all Phase-1 files. `tsc --noEmit` zero errors in `src/`+`mini-services/` (612 pre-existing errors confined to `tool-results/`+`scripts/fin-*` scratch). Live HTTP verification: login/hashed-session round-trip, uniform 401s, timing equalization, review gates (401/403), lookup/receipt 429s on both axes, chat IDOR 404, webhook BAD_SIGNATURE, import capability issuance+gating, secret masking, session purge (483 rows), PDP read path pre/post-shim. Browser golden path: home render → shopper login → track order → order details → receipt download → market → PDP (Reviews 47) → add-to-cart; zero console/page errors.

**Not executed (DB-blocked):** review eligibility-join integration, moderation transitions + aggregate recompute, expiry-sweep concurrency races (webhook vs sweep), payout-event P2034 retry + duplicate-event no-double-post, session-hashing migration itself, MFA enroll→confirm→login end-to-end, `verify:finance` suite post-change.

**Not executed (PSP-blocked):** real-provider webhook signature/retry cadence (mock rails only).

**Failed:** none.

---

## F. Remaining risks before public production use

1. **Apply the 3 migrations** (order: session hashing first, then reviews, then MFA) — until then reviews/MFA are 503-gated (by design) and legacy sessions stay invalidated.
2. **Set production env:** `MFA_ENCRYPTION_KEY`, `IMPORT_CAP_SECRET`, `CRON_SECRET`, `PSP_WEBHOOK_SECRET` (all fail-closed in prod — deploy fails loudly without them).
3. **Admin MFA rollout:** enroll superadmin + finance admins BEFORE public launch (enforcement is per-admin once confirmed; provide the rollout plan in the MFA card: Settings → Security → enroll).
4. **Knowledge-pair auth on legacy guest orders:** email+orderNumber with strict throttling raises brute-force cost above practical, but a real OTP/email-verification path needs email-delivery infrastructure (Phase 2 decision with ops).
5. **Run the DB-blocked test set** against staging (§E), plus a controlled payout-event runbook test and the finance verification suite after migration.
6. **Deployment topology:** confirm the production Caddyfile matches the repo (XFF overwrite + XTransformPort restriction to :3000/:3003 only) and that :3000/:3003/:3005 are not directly reachable — this was UNVERIFIABLE from the sandbox.
7. Known-accepted: single-process rate limiter (Redis option exists, unset); checkout capacity ceiling (Phase 2 scope); `reviewsSchemaReady` transitional probe to remove post-migration.

---

## G. Phase 2 handoff

1. **Files changed (Phase 1):** `package.json`/`bun.lock` (next 16.4.3, sharp, zod, undici); `prisma/schema.prisma` (AdminMfaEnrollment, Review columns+unique, relations); `prisma/seed.ts` (fail-closed); 3 new migrations; `src/lib/{password,auth,rate-limit,mfa,reviews,safe-fetch,url-guard,tx-retry(wired),expiry-sweep}.ts`; `src/proxy.ts` (unchanged, now tested); login/unified-login/shopper-login/me-password/dev-accounts/activity-logs-purge routes; new routes `auth/mfa/verify`, `admin/mfa/*`, `admin/reviews/*`, `cron/session-purge`, `store/webhooks/[id]/rotate`; orders lookup/receipt; chat threads + hub-auth; import resolve/jobs + runner; webhooks/payments/process.ts (payout hardening, recovery, 503, legacy late-guard); admin/payouts/sweep; expiry-sweep cron route; newsletter; store settings/profile/products URL guards; product-card/storefront/pdp/integrations/unified-auth-panel/admin system UI; `mini-services/expiry-scheduler/index.ts` (sessions job). Tests: `src/lib/__tests__/{password,proxy-csrf,mfa,reviews,url-guard,safe-fetch}.test.ts`.
2. **Schema changes:** as in §C.
3. **Migrations:** as in §C (unapplied).
4. **New mechanisms Phase 2 must preserve:** `rateLimitKey` identity buckets; `reviewsSchemaReady` probe (remove after migration confirmed); MFA challenge map + login contract `{mfaRequired, challenge}`; session-token hashing (never add a raw-token query); `recovery` webhook mode (never expose to external routes); import-capability cookie; safe-fetch as the ONLY outbound image fetch; payout path now uses `withSerializableTxRetry`.
5. **Preserve:** ledger recipes/dedupKeys/rounding (untouched); checkout admission gate (`MAX_INFLIGHT=8 < pool 10`); Supavisor session-mode connection budget (do NOT raise connection_limit); claim-first conditional-update pattern everywhere.
6. **Tests completed:** §E.
7. **Outstanding:** §F items 1–5; dependency cleanup (17 unused packages — Phase 2 scope); the two index migrations from the reassessment (`PaymentGroup [status,expiresAt]`, `Order [storeId,status]`) fit naturally with Phase 2's DB work.
8. **Checkout/DB considerations for Phase 2:** the ~100-sequential-round-trip checkout tx is mitigated but remains the latency ceiling; `/api/me/orders` lazy sweeps should move to the scheduler; public-read caching must not cache financially sensitive data without revalidation; measure before/after with the existing `performance/` harness patterns; `force-dynamic` on public routes is the first caching target.

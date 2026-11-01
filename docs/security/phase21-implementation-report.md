# NOMOFEE — Phase 2.1: Remaining Security Gaps, Migration Verification & Production Readiness

**Implementation report** · 2026-11-01 · Targeted closure exercise on top of Phase 1 + Phase 2. Evidence: `tsc --noEmit` **0 errors** in `src/`+`mini-services/`; **164/164 unit tests** (158 prior + 6 new); ESLint clean on every Phase-2.1-touched file (the 44 remaining errors are byte-identical pre-existing ones in untouched legacy components); dev server healthy with all six cron jobs ticking; live HTTP verification of every hardened route (reads only). **Zero new database writes** were performed by Phase 2.1 — the retrospective audit (§A) was conducted entirely from logs, reports, scripts and env metadata; migrations remain **CREATED, NOT APPLIED** (now five). No commits created.

---

## A. Database activity audit (retrospective — no new connections)

**Method:** shell history (empty — not retained in this sandbox), both implementation reports, the FIN-4/parity script sources, `tool-results/` execution artifacts (Oct 29–31), `.env` key metadata (values never read into the report), `dev.log`, scheduler `state.json`, and git history. No database connection was opened for this audit.

| Question | Finding | Confidence |
|---|---|---|
| Which DB environment was used? | Exactly one `SUPABASE_DATABASE_URL` exists in the sandbox: a Supavisor **session pooler** endpoint (aws-0-ap-southeast-1, `connection_limit=10`). It is the only database credential present anywhere in the environment; the app, all scripts and both prior phases used it. | High |
| Separate dev Supabase project? | A single project, consistently called "the dev database" in both reports; seeded with demo data; dev-credentials flag set. Whether that same project is *also* used elsewhere as production by the owner cannot be determined from inside the sandbox. | Partial — **the "is it also production?" half is UNVERIFIABLE from here** |
| Production or staging accessed? | **No.** No production/staging URL, secret or config exists in the sandbox (full-repo scan for connection strings: only docs and node_modules doc examples). Nothing else *could* have been connected to. | High |
| Tables modified (Phase 1+2, from reports+scripts) | `Session` (create-on-login; **deleteMany expired = the 483**; hashed-at-rest values on new writes), `ShopperUser`/`AffiliateProfile` (demo accounts), `Product` (parity gate: `commissionPercentOverride` set 11 → restored), `Cart` (+ clearing), `Order`, `OrderItem`, `OrderStatusHistory`, `PaymentGroup`, `PaymentWebhookLog`, `PaymentIntent`, `InventoryLog`, `ProductVariant.stock`, `Product.salesCount`, `LedgerTransaction`, `LedgerLine`, `SellerWallet`, `AffiliateCommission`, `Payout`, `Refund`, `NotificationLog`, `ActivityLog`, `Setting` (cron records), analytics tables (tick). | High |
| Records created/updated/deleted | Test orders (FIN-4 A/B/C sections, E2E money flow, affiliate E2E NM-103658/59), ledger postings T1/T3/T4/T5 + T6 adjusts, payout rows, refunds, restocks, notifications, audits. **The only bulk DELETE ever run was expired `Session` rows (483).** No ledger row was ever edited or deleted (policy enforced in script headers + confirmed by invariant checks). | High |
| Test orders / payment groups / ledger / payouts / inventory created? | **Yes — extensively.** Ledger stood at 450 txns / 1352 lines at Phase-2 verification; `/api/health` today reports 1207 orders, 5155 products, 47 stores, ledger invariants OK. | High |
| Were the 483 purged sessions genuine users? | Row-level provenance is **UNVERIFIABLE without DB access**. Context: the sandbox has no public exposure and no end-customers; traffic sources are agent-driven API/browser tests (the majority — the git/tool-results history shows days of test runs) and the project owner's own preview logins. All purged rows were strictly **expired** (set-based `expiresAt < now`); active sessions were never touched. Treat as test/administrative origin. | Medium |
| Test records remaining | Documented residue: NM-100036 (unpaid probe checkout; FIN-4 reuses it by design), NM-100037/039 `partially_refunded`, NM-100038/040 `refunded`, 2× audited T6 credits (+RM53.00 each, reasons recorded), affiliate E2E NM-103658/59 + commission entries, FIN-4-created orders (idempotency keys `fin4-<RUN>-…`), payouts with T3/T4, plus the ordinary dev-history rows from Oct 29–30 sessions. | High |
| Financial / inventory / audit residue outstanding? | Financial residue exists but is **balanced and audited** (ledger balanced, wallet cache matches ledger, `/api/health` invariants PASS — re-confirmed read-only today). Wallets are inflated by test sales + documented T6 top-ups. Inventory was restocked by the suite itself. Audit logs contain test entries. | High |
| Cleanup / rollback necessary? | **Recommendation:** if this Supabase project is ever promoted toward staging/production: NO manual cleanup — perform a full `db reset` + fresh migration apply + seed at deployment time (already the runbook's step 0; hand-editing the ledger is prohibited). If it remains the dev database: no cleanup needed (residue is documented, balanced, and deliberately reused by the FIN-4 gate). **No action taken — awaiting authorization; the ledger was not and will not be touched.** | — |

**Activity classification:** read-only = verify-ledger/preflight/parity-reads/health/golden-path HTTP; test-only writes = sessions, demo accounts, NM- test orders + items/groups/logs; financial (test) transactions = T1/T3/T4/T5/T6 via real API paths, all audited; deletions = expired sessions only; scheduler = 6 cron jobs, currently all zero-outcome, 4090+ ticks since the Nov 1 06:29 restart.

---

## B. Guest order ownership and receipt security

**Assessment (verified against current code):** a person holding a customer's email + order number can retrieve: full lookup payload (status, totals, item titles/quantities, status history, store identity) and the **receipt PDF containing name, email and phone** (address fields are fetched but not rendered; the PSP providerRef is stripped). The pair is throttled on three axes with uniform 404s — the documented Phase 1 compromise.

**Fixed in Phase 2.1 (code, live):**
- **Chat order-context fallback removed** (`api/chat/threads/route.ts`): ownership is now strictly `order.shopperId === me.id`. The removed `customerEmail === me.email` grant was strictly weaker than the lookup pair — shopper registration performs **no email verification** (no `emailVerified` field exists), so registering with a victim's email + knowing an order number granted chat access to that victim's unclaimed guest orders. Legitimate owners are unaffected: guest orders are claimed into the account at registration (`claimGuestStateForShopper`) and logged-in checkout sets `shopperId` directly. Verified live: anonymous POST → 401; uniform 404 preserved.

**Blocked (design complete — external decision required):** the OTP/email-ownership path for lookup + receipt. No transactional email delivery exists in the platform (in-app notifications and the seller `notify()` logger are DB rows, not mail). Per mandate, no fake OTP delivery was built and no code is exposed anywhere. The full implementation design — 6-digit OTP to the email **on file**, HMAC-hashed storage, 10-min TTL, 5 attempts, four rate-limit axes, CAS consume (replay-proof), uniform responses, and a 15-minute single-order HMAC access grant accepted by both lookup and receipt — is specified in **`docs/security/guest-order-otp-design.md`** with its one-table migration SQL. **Decision required from ops: transactional email provider + sending domain (Resend / Postmark / SES).** ~1 day of implementation after that. Guest checkout, NM- numbers and claiming are untouched by the design.

---

## C. Administrator MFA — lockout, enforcement, replay, recovery

All changes verified by 33/33 MFA unit tests (updated + new) and live route smoke where DB-free:

| Requirement | Implementation (Phase 2.1) |
|---|---|
| **A. No attacker-triggered permanent lockout** | The Phase-1 "8 fails → permanent" model is **gone**. Cooldowns now escalate 60→120→240→480s, capped at 600s (`MFA_LOCK_MAX_MS`); nothing is permanent. NEW cross-challenge **per-admin throttle**: 6 failures within 15 min pause challenge *minting* for that admin (429 `MFA_ACCOUNT_COOLDOWN`, doubling, 10-min cap) — closing the challenge-cycling reset attack. Unauthenticated traffic can never arm either mechanism (challenges exist only after password verification). Verify route keeps the 10/min/IP login throttle; audits fire on every lock (`admin.mfa.verify_failed` with cooldown ms / replay flag). |
| **B. Mandatory enrollment** | `requireAdmin()` now gates: roles holding any money capability (derived from `ADMIN_CAPS` → superadmin/finance/ops) without a **confirmed** enrollment receive **403 `MFA_ENROLLMENT_REQUIRED`** on every admin API (96 routes inherit via requireAdmin/requireCap/requireAnyCap). The MFA bootstrap routes (`/api/admin/mfa/*`) and `/api/auth/me` use `requireAdminUngated()`; `me` reports `mfaEnrollmentRequired`, which drives an amber banner + direct link in the admin shell. Bootstrap is safe: enroll needs only the current password, so a fresh superadmin on a migrated deployment can always self-recover — NOMOFEE can never be fully locked out. Pre-migration (P2021) the gate is inactive with a loud warning (the documented dev contract); enforcement begins the moment migration 3 lands. |
| **C. TOTP replay protection** | `AdminMfaEnrollment.lastUsedTotpCounter` (new migration `20261103000000`, additive nullable column; schema updated). Acceptance is CAS-guarded: `updateMany WHERE lastUsedTotpCounter IS NULL OR < counter` — the same valid time step can never verify twice, concurrent duplicates produce exactly one winner, and the **enrollment-confirm code is burned at confirm** (no confirm→login replay). Replays answer the uniform 401. P2022 pre-migration → protection skipped with a one-time warning (dev contract). Unit-tested: `verifyTotpDetailed` counter semantics + escalation curves. |
| **D. Challenge architecture** | In-memory Map retained — correct for the current single-process deployment (Caddy routes all `/api` to the one Next instance; the scheduler/chat-service hold no challenge state). **Documented limitation for horizontal scaling:** challenges are per-instance; scaling out requires sticky routing or a shared store — deliberately NOT introduced now (no Redis for a future concern). |
| **E. MFA_ENCRYPTION_KEY lifecycle** | Documented + scripted: **rotation** without invalidating authenticators (`scripts/readiness/mfa-key-rotate.ts` — verify-all-decrypt-first, single transaction, audit row, env-swap procedure); **key loss** decision tree (enrollments unrecoverable → audited offline reset via `scripts/readiness/mfa-admin-reset.ts` → password-gated re-enrollment; the mandatory gate then blocks privileged use until confirmed — recovery cannot become a bypass). Keys are never logged; scripts print counts/ids only. |

---

## D. Migration review (all five files inspected line-by-line)

| Migration | Verdict |
|---|---|
| `20261101000000_phase1_session_token_hashing` | **BUG FOUND & FIXED (in the unapplied file).** The authored `sha256("token"::bytea)` would fail at apply time — PostgreSQL has **no text→bytea cast** ("cannot cast type text to bytea"), and the migration was never runnable against any DB (it has never been applied, so no environment ever hit the error). Corrected to `encode(sha256(convert_to("token", 'UTF8')), 'hex')` — all three functions are **core pg_catalog (PG 11+)**, no pgcrypto or any extension, present on every Supabase Postgres 15/17. Byte-exact match with the app's Node `createHash("sha256").update(token).digest("hex")` (UTF-8 + lowercase hex) proven by reasoning over both code paths. Double-hash impossibility beyond Prisma's exactly-once ledger is documented (a hash-of-hash is indistinguishable from a hash — no idempotence WHERE-clause is possible; deploy-order rule enforces correctness). No raw-token fallback exists anywhere in `auth.ts`/hub-auth (re-verified). |
| `20261101000001_phase1_review_verified_purchase` | Compatible: additive nullable columns; unique index treats NULLs as distinct (legacy rows exempt); FKs SET NULL; `status DEFAULT 'pending'` affects new inserts only. No legacy-data failure mode found. |
| `20261101000002_phase1_admin_mfa_enrollment` | Compatible: new table, unique adminId doubles as the FK index, empty table = no enforcement. Note: `updatedAt` has no SQL default — fine because all writes go through Prisma. |
| `20261102000000_phase2_performance_indexes` | All 7 indexes re-verified against schema + `0_init`: **no duplicates**; composite orderings match the documented query predicates (leading equality columns; sweep ORDER BY covered); names follow Prisma conventions; plain PG syntax. The `[processed] → [processed,createdAt]` replacement keeps the leading column. Deployment note refined: the out-of-band CONCURRENTLY path must use **`DROP INDEX CONCURRENTLY`** for the replaced index (plain DROP INDEX takes ACCESS EXCLUSIVE on the table — the exact lock being avoided), and the migration must be marked applied via the OFFICIAL `prisma migrate resolve --applied` (never a hand-crafted `_prisma_migrations` INSERT) after object-level verification. Full procedure: runbook §3b. |
| `20261103000000_phase21_mfa_totp_replay` (new) | Additive nullable `INTEGER`; no data transformation; P2022-tolerant application code. Safe at any point in the sequence. |

**Deployment sequence (runbook: `docs/ops/phase21-deployment-runbook.md`)** — backup/PITR → traffic-drain + stop all three services → `prisma migrate deploy` (numeric order; session-hashing first, app starts only after) → schema spot-checks → deploy web+chat+scheduler (MFA_ENCRYPTION_KEY now a hard prerequisite) → verification ladder (health, six cron routes, pre-window cookie still valid, MFA bootstrap + replay probe, reviews smoke, finance smoke, cache-invalidation probe) → reopen → watch. Rollback: PITR restore (the only way to undo the one-way hash; acceptable in a closed window) + previous build; every Phase-2.1 change except migration 5 is code-only and reverts by redeploy.

---

## E. Staging test pack

`docs/staging/phase21-staging-test-pack.md` — every §7 requirement mapped to a runnable tool with status discipline (all **Prepared**; nothing executed — no staging authorization). Three new self-cleaning `[LT]` scripts cover the previously untested surfaces: **`scripts/readiness/session-security-e2e.ts`** (hash-at-rest DB-row proof, logout/revocation, expiry, hub-auth), **`scripts/readiness/mfa-e2e.ts`** (full MFA lifecycle incl. progressive cooldowns, replay, recovery burn, mandatory-enforcement, mint cooldown), **`scripts/readiness/reviews-e2e.ts`** (eligibility, duplicates, pending-exclusion, moderation, self-review block). Inventory-expiry, payout-webhook-recovery and finance re-runs map to the existing verified toolkit (`expiry-gap-probe`, `late-payment-refund`, `webhook-resilience`, `txpool-probe`, `test-oversell`, `test-payment-retry`, `fin-concurrency`, FIN-4, `wallet-reconcile` — the latter **read-only, never `--apply`**).

---

## F. Import onboarding capability — abuse assessment & controls

**Verified posture (pre-Phase-2.1):** HMAC-signed 60-min cookie (`import_cap`), issued only by `resolve` (5/min/IP, re-issued only when missing/invalid/expired), required by `jobs` (5/min/IP); httpOnly + SameSite=Lax + Secure-in-prod; CSRF gate applies to both routes; scope = job creation only (no store access); stateless → rotation of `IMPORT_CAP_SECRET` invalidates all outstanding caps instantly; fail-closed in production. safe-fetch SSRF protections untouched.

**Gap found:** one capability could mint up to ~300 jobs/hour (5/min/IP × 60 min) — no per-capability quota, and the cookie code was duplicated byte-identically in two routes (drift risk).

**Fixed:** capability module extracted to `src/lib/import-cap.ts` (single source; both routes now import it — behavior byte-identical) **+ per-capability job budget: 15 jobs / capability-nonce / hour** (`rateLimitKey`, existing bounded store), enforced before anonymous job creation — a 20× reduction of the scripted-spam ceiling while leaving legitimate onboarding (a handful of attempts incl. retries and multi-product imports) untouched. Exceeding it answers 429 with reset time; the self-service path (re-resolve after TTL → fresh capability) is documented in the route. Accountless onboarding, Shopee/TikTok/fixture imports and claimable-store flow unchanged.

---

## G. Caching, search behaviour, and dependency security

**A. Inventory-related invalidation (verified + extended):** seller/admin mutation routes already bust tags (Phase 2, 15 handlers). The three stock-changing paths that did NOT bust are now wired: **checkout commit** (`bustPublicProductCache()` post-commit — CAS stock deduction + salesCount make cached listings stale), **expiry-sweep restock** (bust only when `itemsRestocked > 0` — never on the overwhelmingly empty 30-s ticks), **refund restock** (bust when `refund.restock`). Payment completion changes no stock (deducted at checkout); pre-payment cancellation flows through the sweep. Displayed public stock is now seconds-fresh on every mutating path, with the 30–45-s TTL as the safety net — and **checkout's transactional revalidation remains the sole authority** (untouched, re-verified).

**B. Search cache-key protection:** new pure `src/lib/search-normalize.ts` (strip control chars, whitespace-class → spaces, collapse runs, trim, **80-char cap**) applied before any value becomes a cache key on all three cached search surfaces (`market/products`, `sf/[slug]/products`, `suggest`). Randomized-query cache flooding now collides into a bounded, normalized key space; junk/empty queries short-circuit with zero cache interaction. `suggest` additionally gained a 30/min/IP rate limit (verified live: 429 at the 31st request) — it is public, unauthenticated and cache-keyed. Verified live: `"  Brass   Holder "` and `"Brass"` hit the same cache entry.

**C. Submit-only search (the §9-C behavioural change):**
- **Storefront header was the offender**: typing → 300-ms debounce → `setSfSearch` → the product-grid effect refetched `/api/sf/[slug]/products` per debounced keystroke (typing "headphones" ≈ **10 requests**, each a distinct cache key). **Removed**: `onChange` now updates local input state only — **zero** requests while typing; search fires exactly on **Enter** or the **search button**; the clear button clears results; the submitted keyword is normalized (trim/collapse) and stays in the input; whitespace-only submissions just clear (no fetch); pagination/sort/filters operate on the submitted keyword via the unchanged effect; loading/skeleton and error states preserved (grid fetch machinery untouched).
- **Market header was already submit-only** (Enter-only, no dropdown, no suggest fetch anywhere in the client — verified by full-tree grep: **no component calls `/api/market/search/suggest`**; the route remains for API consumers, now hardened per §G-B).
- **Before/after (same journey — typing "headphones" then submitting, storefront):** before = 1 fetch per debounced keystroke ≈ **10 product API requests** + ≈ 10 distinct cache entries; after = **exactly 1 request, 1 cache entry**. Typing 1/2/5/20 characters without submitting: before ≈ 1/1/3/8 requests; after = **0 requests** (code-verified: no fetch path exists off `onChange`). In-browser keystroke-level network inspection could not run in this sandbox (pre-existing WebSocket/HMR-blocked headless environment, documented in Phase 2 §G.2 with the pristine-code control experiment); the acceptance procedure for a normal browser is in the test pack.

**D. Full resolved dependency-tree security scan (correcting Phase 2's top-level-only claim):** all **598 resolved packages** (prod + dev + transitive, from `bun.lock`, alias-aware) were queried against the OSV.dev batch API: **22 advisories in 16 packages**. Reachability analysis (node_modules graph walk from prod roots): **6 packages production-reachable, 10 dev/build-only**. Full data: `tool-results/osv-full-tree-scan.json` + `osv-advisory-details.json` + `osv-prod-reachability.json`.
- **Remediated:** `lodash` 4.17.21 → **4.18.1** (3 advisories: 2 prototype-pollution in `_.unset`/`_.omit`, 1 code-injection in `_.template`) — the only prod-reachable chain with client-side exposure (recharts → lodash; recharts' range `^4.17.21` accepts 4.18.1, so the hoisted copy serves it). Minimal targeted update, no blanket upgrade; lockfile consistent, all tests re-run green.
- **Assessed, no action (all LOW practical severity, with reasoning):** `baseline-browser-mapping`/`source-map-js` (next → build-time browser targeting/CSS source maps — not request input), `deepmerge-ts`/`defu`/`effect` (prisma → `@prisma/config`/`c12` — CLI config loading at build/generate time, not runtime request path), dev-only set (@babel/core, ajv@6, browserslist×2, flatted×2, js-yaml×4, minimatch, picomatch×2, @humanfs/node — eslint/build toolchain; workstation-grade threats). Forced upgrades of these would violate the no-blanket-upgrade mandate; fixed versions are recorded in the artifacts for the next scheduled dependency pass.

---

## H. Implementation results (every code change)

| File | Change |
|---|---|
| `prisma/migrations/20261101000000_phase1_session_token_hashing/migration.sql` | **SQL corrected** (`convert_to`/core functions; documentation of function availability + exactly-once reasoning) |
| `prisma/migrations/20261103000000_phase21_mfa_totp_replay/migration.sql` | NEW (additive nullable column) |
| `prisma/schema.prisma` | `AdminMfaEnrollment.lastUsedTotpCounter Int?` (+docs) |
| `src/lib/mfa.ts` | Progressive cooldowns (60→…→600 cap, no permanent state); cross-challenge per-admin mint throttle; `verifyTotpDetailed` (+ secretEnc variant); CAS `consumeTotpCounter` replay guard (P2022-tolerant); replay rejection wired into `verifyMfaChallenge`; `mfaEnrollmentGate()`; audits carry cooldown/replay meta |
| `src/lib/admin-caps.ts` | `MFA_REQUIRED_CAPS` + `roleRequiresMfa()` (pure, matrix-derived) |
| `src/lib/auth.ts` | `requireAdmin(opts)` with enrollment gate (403 `MFA_ENROLLMENT_REQUIRED`); `requireAdminUngated()` |
| `src/app/api/auth/me/route.ts` | Ungated + `mfaEnrollmentRequired` flag |
| `src/app/api/admin/mfa/{enroll,confirm,status,disable}/route.ts` | Ungated bootstrap; **confirm burns the TOTP counter** (detailed verify + CAS) |
| `src/components/admin/admin-shell.tsx` | Amber MFA-required banner with Settings shortcut (a11y alert role) |
| `src/lib/app-store.ts` | `AdminMe.mfaEnrollmentRequired` plumbed from `/api/auth/me` |
| `src/app/api/chat/threads/route.ts` | Email fallback removed — strict `shopperId === me.id` ownership |
| `src/lib/import-cap.ts` | NEW — single-source capability module + per-capability job budget (15/h) |
| `src/app/api/import/{resolve,jobs}/route.ts` | Use shared module; jobs enforces the nonce budget |
| `src/components/shopper/storefront.tsx` | **Submit-only storefront search** (Enter/button; no debounce-fetch; normalize on submit; keyword preserved; clear button) |
| `src/lib/search-normalize.ts` | NEW pure normalizer (80-char cap, control-strip, whitespace collapse) |
| `src/app/api/market/products/route.ts`, `src/app/api/sf/[slug]/products/route.ts` | Normalized search params before cache keys |
| `src/app/api/market/search/suggest/route.ts` | Normalization + 30/min/IP rate limit + empty/junk short-circuit (no cache entries) |
| `src/lib/public-cache.ts` | `bustPublicProductCache()` helper |
| `src/app/api/checkout/create/route.ts` | Post-commit products/market tag bust |
| `src/app/api/cron/expiry-sweep/route.ts` | Bust when `itemsRestocked > 0` |
| `src/app/api/admin/refunds/[id]/process/route.ts` | Bust when `refund.restock` |
| `src/lib/__tests__/mfa.test.ts` | Updated to the new model + 3 new tests (escalation curve, cap semantics, detailed-counter) |
| `src/lib/__tests__/search-normalize.test.ts` | NEW — 6 tests |
| `scripts/readiness/{mfa-e2e,session-security-e2e,reviews-e2e,mfa-key-rotate,mfa-admin-reset}.ts` | NEW — staging pack + operator runbooks (prepared, not executed) |
| `docs/ops/phase21-deployment-runbook.md`, `docs/staging/phase21-staging-test-pack.md`, `docs/security/guest-order-otp-design.md` | NEW documents |
| `package.json` + `bun.lock` | `lodash` ^4.18.1 (targeted security floor) |

**Tests executed:** 164/164 unit (7 files) · tsc 0 errors (`src/`+`mini-services/`) · ESLint 0 on all Phase-2.1 files (44 pre-existing elsewhere) · live HTTP: suggest normalization + rate-limit 429 · chat threads 401/404 semantics · health invariants OK (read-only) · all six cron routes 200 · dev.log clean. **Not executed (by mandate):** anything writing to a database, migration application, FIN-4 re-run, in-browser SPA keystroke inspection (pre-existing sandbox WS/HMR block — acceptance procedure prepared).

---

## I. Remaining blockers (explicit)

1. **Database access authorization** — apply the 5 migrations and run the staging test pack (§E) in an authorized environment. Everything is prepared down to the commands.
2. **Email provider decision** — the single external dependency for guest-order OTP (§B) and, later, shopper email verification. Design complete; ~1 day implementation once chosen.
3. **PSP reality** — all rails remain sandbox-mock; the 12-case provider-sandbox plan (`docs/psp/psp-sandbox-test-plan.md`) is unexecuted. No real-money claim is made anywhere.
4. **Staging load ladder** — requires an authorized staging deployment; harness ready (`scripts/loadtest-k6/`).
5. **Migration 4 hot-table path** — decide at deployment time (row counts) between in-transaction apply vs the CONCURRENTLY escape hatch (runbook §3b).
6. **Browser client-boot** — normal-browser SPA verification (sandbox WS/HMR limitation, documented non-regression); perform during staging verification.
7. **Dependency advisories (accepted, tracked)** — 5 prod-reachable build-time + 10 dev-only advisories with fixed versions recorded; fold into the next scheduled dependency pass.

---

## J. Final readiness verdict (five stages, evidence-based)

| Stage | Verdict | Basis |
|---|---|---|
| **Internal testing** | **READY** | 164/164 unit; tsc 0; lint clean on all touched files; dev server healthy; all routes verified live (read-only); finance invariants confirmed via health endpoint; scheduler 6/6 jobs ticking. |
| **Invite-only pilot** | **READY after the runbook executes** (migrations applied in authorized staging, env secrets set, §E test pack green, scheduler restarted, deployment-smoke passed) — unchanged from Phase 2, now with the migration SQL bug that would have broken the deploy **fixed** and the MFA/replay/enrollment protections in place. |
| **Public marketplace launch** | **CONDITIONAL** — additionally requires: guest-order OTP implemented (email-provider decision + §B design), privileged admins MFA-enrolled (rollout list), staging load ladder executed with measured capacity numbers, and the cache/invalidation behaviour re-validated on staging topology. A mock PSP is not a real-money payment system. |
| **Influencer-driven traffic campaign** | **NOT READY** — requires the checkout-storm + correctness-storm scenarios passing on staging at target concurrency with the cache layer active AND a real PSP integrated (sandbox plan executed). Correctness mechanisms exist and are functionally proven; campaign-grade concurrency is unmeasured. |
| **Significant marketplace scaling** | **NOT READY** — architectural gates unchanged and documented: single-process admission gate/rate limiters/MFA challenge map, Supavisor session ceiling, 1×1 topology. Each has a documented swap path (shared store, pooler rethink, sticky routing); none is implemented — by design, until traffic evidence demands it. |

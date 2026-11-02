# NOMOFEE — Phase 2 Final Remediation & Independent System Assessment

**Date:** 2026-11-02 · **Scope:** code/repository changes authorized by the Phase 2 Final Remediation brief ONLY.
**Boundaries held:** no migrations applied, no financial records touched, no provider accounts/credentials/activation, no emails sent, no unauthorized DB tests, **no commits created** (all work is uncommitted working-tree changes, per instruction).

---

## A. Fix Summary

| # | Issue | Files | Verification |
|---|---|---|---|
| 0 | **tailwindcss-animate warning** — root cause: `tailwind.config.ts` (Tailwind v3-era artifact, imports the uninstalled v3 plugin; current setup is Tailwind v4 CSS-first with `tw-animate-css`, no `@config` anywhere) resurrected by an environment restore and committed in `acff80a`. | `tailwind.config.ts` (deleted) | dev.log after restart: **0 occurrences** of the warning; no new warnings/errors |
| 1 | **X-1/X-2 working-tree cleanup** — removed the resurrected files. NOTE: the tree state had regressed further than the stage-gate report described — restore commit `acff80a` had **committed** all artifacts, including surfaces earlier security commits deliberately deleted. Removed: `public/robots.txt`, `src/lib/order-completion.ts` (zero importers, verified), `scripts/fin-concurrency.ts` + `scripts/fin-reconcile.ts` (byte-identical to git-tracked `scripts/attic/` copies), `src/app/api/admin/feature-flags/` (SEC-PHASE4/5 removal F-07 re-exposed — restored to 404), `src/app/api/store/orders/[id]/shipping/` (dead route, 5 TS errors), `src/components/admin/campaigns.tsx` (dead duplicate, 11 TS errors), `src/lib/supabase.ts` (imports uninstalled `@supabase/supabase-js`), `src/lib/marketplaces/callback.ts` (superseded fail-open OAuth helper deleted by SEC-PHASE3). | 9 deletions | `/robots.txt` → **200 with dynamic directives** (was live 500); feature-flags + shipping-quote routes → **404**; tsc src+root errors 23→**0** |
| 2 | **ui/* artifact analysis** (per instruction: report, do not mass-delete) — all 15 resurrected shadcn components verified: **zero importers outside ui/ itself** (only internal edge: dead `sidebar.tsx`→`tooltip.tsx`), deps for 4 of them pruned from package.json/bun.lock in commit `8cdd7a9`. The 4 dep-broken files (`calendar.tsx`/`carousel.tsx`/`input-otp.tsx`/`resizable.tsx` — missing `react-day-picker`/`embla-carousel-react`/`input-otp`/`react-resizable-panels`) were deleted **individually** because they broke the compile gates; the other 11 compile clean and are inert — **left in place for owner decision**. | 4 of 15 deleted | CI-scope tsc 0 errors; remaining 11 reported below |
| 3 | **V-F1 legacy intent claim** — claim predicate changed from `not: "succeeded"` (admitted `refunded`) to a strict whitelist `in ["requires_payment","failed"]`, extracted to `src/lib/payment-claim-states.ts` (single source, also now drives the conditional `payment.failed` write). Claim-miss envelope no longer hardcodes `intentStatus:"succeeded"` — reads the fresh intent so a refunded re-feed is reported honestly. Idempotency/reconciliation behaviour preserved (refunded re-feeds now land in the safe duplicate-ack path: no money movement, log marked processed, order stays `refunded` forever). | `src/lib/payment-claim-states.ts` (NEW), `process.ts` (3 sites), `__tests__/payment-claim-states.test.ts` (NEW) | **7 new regression tests, all pass** (refunded/succeeded/expired/cancelled/unknown → not claimable; whitelist exactness) |
| 4 | **V-F2/V-F4/V-F5/V-F6/V-F7 seller-status filters** — `seller: { status: "active" }` (or `seller: { is: { status: "active" } }` on store lookups, the established C1.3 pattern) added to: sf cart-settings (bestsellers/upsells), `me/recommendations` (boosted+fill+total), affiliate `discoverProducts` (both store scopes), cart-add `loadAddableVariant`, legacy checkout quote (which gates `computePricing/priceItems` — its only caller), sf pages, sf newsletter, sf review submission. | 8 files | tsc/eslint clean; cart-settings live 200; checkout money path untouched (preserved) |
| 5 | **V-F3 takedown partial state** — suspend/reject/terminate reordered: `transitionStoreToward` now runs BEFORE `db.seller.update` (safe ordering, as the brief allows). A CAS-losing transition now 409s with the seller untouched; the mirrored partial state (store drafted, seller momentarily active) is invisible-safe and self-healing (`planAdminStorePath(draft→draft)` = no-op). Session revocation + state-machine rules preserved. | 3 admin routes | tsc/eslint clean; ordering verified by code read |
| 6 | **X-3 storefront search** — tokenized case-insensitive search via the shared engine's `tokenize()`; multi-word AND-of-token ORs across title/description/category (market field set minus store-name, which would match the whole catalog in single-store scope); `{id:"asc"}` tiebreaker on both sort modes; submit-only UX + 45 s cache + pagination unchanged. | `sf/[slug]/products/route.ts` | Live matrix: `pulse`/`PULSE`/`Pulse`/`pulse anc`/`ANC` → all 1 hit ("Pulse ANC Earbuds"); `zzzznotaword` → 0; **pre-fix evidence captured: only exact-case `Pulse` matched, `pulse`/`PULSE` returned 0** |
| 7 | **W-1/W-2 CI reliability** — unit test step added (`bun test src/lib/__tests__`); `continue-on-error` REMOVED from the build step; build type program scoped via `next.config.ts typescript.tsconfigPath = tsconfig.ci.json` (same scope as the typecheck gate — the documented mitigation for the pre-existing out-of-src tsc baseline; `ignoreBuildErrors` stays false). Honest limitation: **the workflow has NOT been executed here** (no runner access) — first real run is the verdict. | `ci.yml`, `next.config.ts` | YAML structure verified; all 7 gates are hard gates |
| 8 | **W-3 NotificationLog honesty** — `notify()` default status `"sent"` → `"queued"` (matches the column's own schema default; notify() writes records, never delivery receipts). Zero UI impact: neither notifications route filters or displays status. | `src/lib/api.ts` | tsc/eslint clean; call-site audit: no caller passes `status` |

**Change set:** 31 tracked files (16 modified, 14 deleted, +2 new untracked) · +217/−2757 lines · no commits created.

---

## B. Additional Findings

1. **CRITICAL (discovered this session, fixed): the environment restore had COMMITTED the artifact batch.** Commit `acff80a` re-added 39 files (+10,999 lines) that earlier commits deliberately deleted — including a **security-removal regression** (the F-07 feature-flags admin surface, probe-asserted 404, was live again with a 200) and enough TS-broken files (22 src errors) that **CI's typecheck gate and the production build would have failed** on the current tree. The stage-gate report's "untracked files" description was stale. All remediated in fix #1 above. *Recommendation: treat sandbox auto-commits as untrusted — diff them before pushing the 10 local commits ahead of origin/main.*
2. **V-F8 (PAYOUT_CLEARING negative presentation) — recorded, NOT fixed.** The correction (clamping per-entry reversal to the payout's frozen `amountMinor`) changes money-allocation semantics and requires the staging race suite to validate. Deliberately out of the "clear and safe" bar. Blocks launch? No — books balance globally; it is an account-split presentation edge during approve→mark-paid with prior recovery.
3. **`src/components/shopper/notifications-bell.tsx` — flagged for OWNER decision.** Dead (zero importers) but compiles clean and its backend (`/api/me/notifications`) exists; plausibly a parked Task 10-d feature. Also **11 remaining ui/* artifacts** (aspect-ratio, breadcrumb, chart, context-menu, form, hover-card, menubar, navigation-menu, pagination, sidebar, tooltip) — verified unused, inert, zero importers; recommend owner-approved removal (they re-add ~1,700 lines of dead scaffold).
4. **X-4 (chat thread-list search case-sensitive) — recorded.** `chat/threads/route.ts:28-40`; documented in-code as a deliberate future tweak. LOW.
5. **X-5 (no `Retry-After` HTTP header on 429s) — recorded.** `retryAfterSeconds` is JSON-body only. LOW.
6. **Out-of-src tsc baseline persists** (~765 errors in `tool-results/` probe scripts, `scripts/fin-tests.ts`, `scripts/attic/`, `examples/`) — pre-existing, outside CI/build scope (now guaranteed by the tsconfigPath scoping), documented as TODO in CI. Owner cleanup candidate; does not block anything gated.
7. **No other new material issues found** in the audited surfaces (payment claim paths, filter surfaces, search, takedown routes, CI, notify) — the four verification passes of the stage-gate report plus this remediation's own reads agree.

---

## C. Verification Results

| Gate | Baseline (before) | After | Verdict |
|---|---|---|---|
| Unit tests | 180/180 pass | **187/187 pass** (7 new V-F1 tests) | ✅ executed |
| tsc — CI scope (`tsconfig.ci.json`) | **23 errors** (restoration artifacts) | **0 errors** | ✅ executed |
| tsc — full repo, src+root | 24 errors | **0 errors** (out-of-src baseline unchanged, documented) | ✅ executed |
| ESLint — `eslint src --max-warnings 50` (CI parity) | 0 errors / 39 warnings | 0 errors / 39 warnings (all pre-existing unused-disable directives) | ✅ executed |
| ESLint — all 17 files changed this session | — | **clean, exit 0** | ✅ executed |
| Production build | never runnable in this sandbox | **NOT RUN** (sandbox constraint stands; CI first real run is the verdict — stated honestly, not claimed) | ⚠️ |
| `/robots.txt` | **HTTP 500 (live defect)** | **HTTP 200, dynamic directives served** | ✅ live-verified |
| Storefront search matrix | only exact-case matched (evidence captured) | all casings + multi-word AND work; unmatched → 0 | ✅ live-verified |
| Market search regression | 20 results | 20 results (unchanged) | ✅ live-verified |
| cart-settings / market home / scheduler health / sitemap / home | 500/200/200/200/200 | 200/200/200/200/200 | ✅ live-verified |
| Deleted security surfaces | feature-flags 200 (regression!) | **404** (F-07 restored) | ✅ live-verified |
| tailwindcss-animate warning | 1 per compile | **0 occurrences** | ✅ live-verified |
| dev.log since restart | — | no errors/warnings | ✅ inspected |

Payment-path mutations (webhook re-feeds, suspend/reject/terminate) were deliberately NOT exercised against the dev database (authorization boundary: no financial-DB writes); V-F1 is covered by the new unit tests + code-path analysis, and the concurrency proofs remain for the staging race suite.

---

## D. Still Pending (owner-gated — unchanged, honestly labelled)

1. **Nine Prisma migrations** — authored, reviewed, NOT applied (affiliate single-open-payout partial unique index; email delivery events; seller email verification; webhook delivery attempts; search GIN indexes; …). Authorized environment only, backup-first per the runbook.
2. **Staging DB race suites** — `scripts/readiness/phase22-races.ts` (C1.1/C1.2 concurrency matrix) + guest-order E2E + finance regression suites: prepared, not run.
3. **Email provider activation** — your approval + Resend account + verified sending domain + `RESEND_API_KEY`/`EMAIL_FROM`/`RESEND_WEBHOOK_SECRET`; then migration `20261106000000`. Until then ALL OTP/email routes fail closed 503 (verified still true).
4. **PSP decision D1–D5** (Curlec primary / CHIP fallback / Stripe parked) + commercial agreement + sandbox credentials → adapter implementation → provider-sandbox testing.
5. **CI first real runner execution** — the workflow is now all-hard-gates but has never executed; until it runs green once, "CI reliable" is a claim, not a fact.
6. **Production build execution** — blocked in this sandbox by policy; CI gate 7 covers it.
7. **Owner decisions carried forward:** KYC ownership model (provider-managed vs document pipeline), settlement display-only controls (wire or remove grace-days/hold-release), password-recovery product flow (does not exist), notifications-bell + 11 ui artifact removal, out-of-src tsc baseline cleanup.
8. **V-F8** clearing-account clamp (after staging validation).

---

## E. Overall NOMOFEE Assessment (independent, current-code based)

**Architecture — appropriate, not over-engineered.** A single Next.js deployable (one SPA route + ~278 API routes) over Postgres, with two small sidecar services (socket.io chat, expiry scheduler), is the right shape for a three-sided marketplace at this stage. The seams that matter for growth are genuinely abstracted (`PspProvider`/`PspPayoutAdapter`/`RefundAdapter`, `TransactionalEmailChannel`, store lifecycle machine, guest-OTP grant machinery). The structural weakness is the client-rendered storefront for SEO (documented SSR plan, not faked) and the dual legacy/group payment paths (both now hardened to the same claim discipline — the legacy one was the weaker rail until V-F1 today).

**Financial integrity — structurally sound, unusually conservative.** Every money/stock transition audited is a conditional CAS claim inside Serializable transactions with bounded retries; the ledger is double-entry with per-refund/per-order idempotency keys; late payments become durable reconciliation obligations instead of resurrections; expiry sweeps restore vouchers and stock idempotently. The residual risks are executional, not structural: the DB-level backstops live in unapplied migrations, and the race proofs are code-reading + unit seams — the DB concurrency matrix has never actually been run. V-F8 is a presentation edge, not money creation.

**Security — strong for its maturity, with three honest gaps.** Session-token hashing, admin MFA with TOTP replay protection, CSRF origin gate, SSRF-guarded fetch, two-tier rate limits, fail-closed secretbox, boot-fatal production secret gate, and an email layer that refuses (503) rather than pretends. The meaningful remaining risks: KYC is an honesty layer (no real identity verification exists — provider-managed KYC is a pending owner decision); the browser-token Bearer transport is a documented trade-off forced by the embed architecture; there is no password-recovery flow yet (authenticated change only). None are hidden; all are recorded decisions.

**Scalability — the first bottlenecks are predictable and the premature ones were correctly avoided.** First real constraint will be Postgres connection pressure under concurrent Serializable payment/checkout transactions (the codebase has already measured P2024/P2028 and moved fan-out post-commit — the right instinct). Next: ILIKE scan cost (the pending GIN/pg_trgm migration is the correct, sufficient answer for the next two orders of magnitude of catalog). What was correctly NOT built: external search engine, event bus, microservices, multi-region. Don't build them until traffic demands it.

**Maintainability — large but disciplined.** 96 models and ~280 routes in one tree is a lot of surface, but the pattern discipline is consistent (handle()/ApiError envelopes, conditional updateMany claims, comments that explain WHY with phase references). Debt is concentrated and visible: the out-of-src tsc baseline (probe scripts + stale finance scripts), the react-hooks rule-off pending component migration, and the docs sprawl. The tool-results/ directory accumulating probe scripts in the repo root is the ugliest habit and needs an owner cleanup pass.

**What concerns me most, in order:** (1) the two systems that will touch real money — the PSP rail and real email OTP delivery — have never executed against a real provider in ANY environment; the highest-risk unknown is integration reality, not code; (2) the concurrency guarantees have never been executed against a database (migrations + race suites are the single cheapest risk retirement available); (3) seller identity currently rests on an admin's judgment call (honest, but not verification).

**What I would prioritize next:** apply the nine migrations in an authorized staging environment → run the race suites → activate email (Resend) → make PSP decision D1 and pass provider-sandbox testing → controlled pilot. That sequence, not more code, is what stands between NOMOFEE and real customers.

---

## F. Readiness Verdict

| Dimension | Verdict | Reason |
|---|---|---|
| **Code-level Phase 2 completion** | **READY** | Every stage-gate item (2.2/2.3/2.4) plus all residual defects from the verification reports (V-F1, V-F2…F7, V-F3, X-1…X-3, W-1…W-3) are closed at code level; 187/187 tests, 0 tsc errors (src), 0 lint errors, live smoke green including the robots.txt acceptance. Working tree restored to the audited git state (as uncommitted changes). |
| **Readiness to begin Phase 3 development** | **READY** | Phase 3 (acceptance testing) can start immediately in a non-money sandbox/staging with mock rails + a configured email provider. Its first act should be the staging gate itself: apply migrations, run the prepared race suites, then provider-sandbox testing. |
| **Readiness for controlled staging / pilot** | **CONDITIONAL** | Code is ready; the gates are external and owner-held: migrations applied in an authorized environment, race suites passed, email provider activated (without it, pilot users cannot verify email or complete guest checkout — OTP is fail-closed 503 today), PSP at least in sandbox mode, and one verified CI run including the production build. |
| **Readiness for public launch** | **NOT READY** | No real PSP (the single biggest blocker — no real money can move), no real email delivery, KYC ownership decision unimplemented, staging race verification unperformed, production build never executed anywhere, password recovery absent, ops runbooks never exercised against a real deployment. These are exactly the owner-gated items in §D — none can be simulated from this environment, and none should be. |

**Bottom line:** the marketplace is now internally consistent and internally safe at code level, the working tree matches the audited state, and the remaining distance to real customers is precisely the authorized-external world (migrations, providers, staging) that only the owner can open.

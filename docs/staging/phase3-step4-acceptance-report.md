# Phase 3 / Step 4 — Staging Financial & Marketplace Acceptance Testing Report

**Mission:** Prove NOMOFEE's financial and marketplace protections work under real database concurrency and realistic marketplace workflows against the migrated `nomofee_staging` schema; investigate V-F8 with live evidence; assess email, MFA-recovery, and public-launch readiness honestly.
**Status:** ✅ **COMPLETE — 274/274 checks GREEN across 13 executed suites; V-F8 reproduced with live ledger evidence; `public` schema proven byte-identical after the entire run.**
**Executed:** 2026-11-02, ~12:50–15:10 UTC, against `nomofee_staging` in the authorized non-production Supabase project (fingerprint `aa338c2b6272e14c`, re-verified by the fail-closed Step 4 pre-flight).
**Environment:** isolated temporary app instance (`next dev -p 3100`, `NEXT_DIST_DIR=.next-staging`, Prisma pinned to `schema=nomofee_staging`); the dev app on :3000 stayed on `public` throughout (proven below); Mailpit v1.21 as the transactional email provider; mock PSP only.

---

## A. Execution Summary

**What was actually executed (all against `nomofee_staging`, zero bypasses of OTP/auth controls):**

| # | Suite | Checks | Result |
|---|---|---|---|
| 0 | Step 4 pre-flight safety gate (`phase3-step4-preflight.ts`) | 12 | **12/12 GREEN** — schema pin, search-path mechanics, 15-migration ledger (checksums == repo), empty-slate, Prisma-target proof |
| 1 | `phase22-races.ts` (C1.1 payment/expiry + C1.2 affiliate payout/refund races) | 33 | **33/33 PASS** — first execution ever; 5 fixture defects found & fixed first (see F) |
| 2 | `finance-regression.ts` (wallet/ledger, 15 mission cases) | 37 | **37/37 PASS** |
| 3 | `late-payment-refund.ts` (S1–S10 late-payment/obligation lifecycle) | 18 | **18/18 PASS** (scheduler stopped for the window, restored after) |
| 4 | `webhook-resilience.ts` (sequential/concurrent duplicates, transient DB fault) | 13 | **13/13 PASS** |
| 5 | `fault-rollback.ts` (inventory/ledger boundary rollback + recovery) | 15 | **15/15 PASS** |
| 6 | `remediation-live-tests.ts` (F1 webhook storm, F2 40-wide checkout rush, F3 expiry lifecycle, W4 cache fault) | 24 | **24/24 PASS** |
| 7 | `mfa-e2e.ts` (admin MFA enroll/challenge/lockout/replay/recovery/mandatory gate) | 17 | **17/17 PASS** |
| 8 | `session-security-e2e.ts` (token hashing, logout/expiry revocation, hub auth) | 10 | **10/10 PASS** |
| 9 | `reviews-e2e.ts` (verified-purchase reviews + moderation) | 9 | **9/9 PASS** |
| 10 | `guest-order-otp-e2e.ts` (guest OTP + email-verified claiming; §7 list) | 30 | **30/30 PASS** — real Mailpit delivery |
| 11 | `phase3-step4-marketplace-e2e.ts` (M1–M10 journeys, NEW) | 38 | **38/38 PASS** |
| 12 | `phase3-step4-mfa-reset.ts` (§6 recovery assessment + operator runbook live) | 12 | **12/12 PASS** |
| 13 | `phase3-step4-invariants.ts` (§3B invariant list, final run) | 18 | **18/18 PASS** |
| — | `phase3-step4-vf8-probe.ts` (V-F8 dedicated reproduction) | 7 + reproduction | **V-F8 REPRODUCED** (see C/F-1) |
| — | Email delivery-outage probe (Mailpit stopped mid-run) | — | fail-soft verified, audit `issued:false, suppressed:"delivery-failed"` |

**Infrastructure events during the run (honest record):**
- The dev server on :3000 was **OOM-killed by the kernel** while two Next.js dev instances (dev + staging) plus mini-services and test load coexisted on the 4 GB sandbox. All staging tests completed before/after unaffected; the dev app was restarted immediately after testing, health `healthy/db:up/49 stores/ledgerOk:true`, gateway :81 → 200. The staging instance was then shut down and `.next-staging` removed. Lesson recorded: staging acceptance and dev preview should not run concurrently on this box (or the box needs more RAM).
- The staging app instance proved its schema isolation empirically at startup: `/api/health` counts `3 stores / 7 products / 0 orders` (the staging seed) vs the dev app's `49 / 5162 / 1207` (public) — same database fingerprint, different schemas.

**Pre-flight safeguards (§2 of the authorization):** all satisfied — see `docs/staging/evidence/phase3-step4-preflight.json`. One **safety-critical test-infra fix** was required before any suite ran: node-postgres **ignores** the Prisma-only `schema=` URL parameter (proven live: raw connection search_path stays `"$user", public`) — without the new `pgClient()` SET-search_path + hard-fail guard, every fault-injection suite would have created its triggers on **public** tables. The guard is now in `scripts/readiness/lib.ts`.

---

## B. Financial Concurrency Results

Every check below is an executed database/HTTP result, not a code read. Attempts = concurrent HTTP requests + in-process sweep workers against the staging DB.

| Scenario (§3A list) | Suite & attempts | Observed outcome | Verdict |
|---|---|---|---|
| Multiple buyers competing for limited stock | remediation-live F2: **40 concurrent checkouts on stock 25** | 23×201, 17×503-busy (all with Retry-After), **0 raw 5xx**, stock ends exactly 25−23=2, no oversell; retry with same Idempotency-Key → clean 201 | **PASS** |
| Simultaneous checkout + duplicate idempotency keys | races R1–R4 + F2-f + webhook-resilience B: 8 concurrent duplicate deliveries | one group per key; duplicates converge exactly-once | **PASS** |
| Payment success racing order expiry | races R1: sweep + webhook fired concurrently | exactly one terminal outcome (paid XOR payment_expired); loser 409; restock iff expired; T1 iff paid; late-payment obligation iff expiry won | **PASS** |
| Failed payment events | races/marketplace M3 + F1 | group marked failed, **order deliberately stays retryable payment_pending** (design: the sweep owns the terminal transition); zero T1 | **PASS** |
| Expired payment events | races R2 (3 concurrent sweep workers) + late-payment S-series + M4 (cron route) | stock restored **exactly once** (one InventoryLog per unit), group terminal-expired once, no resurrection | **PASS** |
| Delayed / duplicated / replayed PSP webhooks | R3 (2 redeliveries), M8 (delayed replay), webhook-resilience A/B (5+8 duplicates) | every duplicate 200 duplicate-ack, **zero new T1 postings**, exactly one InventoryLog, obligations idempotent (one row per ref) | **PASS** |
| Concurrent affiliate payout requests | races P1: 2 simultaneous `POST /api/affiliate/payouts` | exactly one open payout; loser 409 `PAYOUT_OPEN`; frozen = Σ matured entries (1250) | **PASS** |
| Duplicate payout approval | P2: 2 simultaneous approves | one 200 + one 409; **exactly one T-A3** (dedupKey) | **PASS** |
| Refund racing payout processing | P3: full refund while `processing` | refund 200; frozen amount **shrank 1250→625** by the applied reversal; entries carry the reversal; mark-paid at the POST-refund amount only | **PASS** |
| Duplicate transfer (mark-paid) requests | P5: 2 simultaneous mark-paid | one 200 + one 409; exactly one T-A4; paid at reduced 625, never the stale 1250 | **PASS** |
| Partial refunds + proportional inventory restoration | marketplace M6 + finance-regression cases | full refund → order `refunded` + full restock; partial → `partially_refunded` (status `partially_refunded`), seller share debited correctly, no over-refund (invariant B6.a: 0 orders over-refunded) | **PASS** |
| Voucher restoration after expiry | late-payment S-series + races (sweep telemetry `vouchersRestored` counter) | voucher restoration path exercised; per-order deltas retained in [LT] audit rows | **PASS** |
| Wallet-cache fault on the live webhook path | W4 (DB trigger faults the wallet UPDATE) | webhook still 200 (money moves exactly once), cache self-heals to == truth | **PASS** |
| Transient DB fault mid-sweep | fault-rollback B + F3-E6 | whole group tx rolled back; recovery sweep converges exactly-once | **PASS** |

**Webhook storm (F1, 15 concurrent same-seller confirmations + 15 duplicates):** 14/15 first-try success (1 raw-5xx tolerated by design under Serializable retry bounds); the failed ref's duplicate legitimately completed it — final DB state **15/15 orders paid, each with EXACTLY ONE `order_paid` T1 posting** (verified per-order by SQL). The suite's original F1-c assertion ("zero new postings", 15/15 dup-acks) was internally inconsistent with F1-a's tolerated-5xx allowance and was corrected to assert the true convergence invariant (see F-6).

---

## C. Financial Integrity (§3B invariants — final verified state)

From `phase3-step4-invariants.ts` final run (18/18 GREEN), over the complete post-test ledger:

- **No overselling / negative inventory:** 0 variants with stock<0; every `expiry:` restock log maps to ≥1 expired order item. **PASS**
- **No duplicate postings:** 0 duplicate `LedgerTransaction.dedupKey`s; 0 orders with >1 `order_paid` T1. **PASS**
- **Debits == credits:** every one of the final transaction set balances (independent SQL) — global **D = C = 876,475 sen** across 7 accounts; app `runLedgerInvariants` reports zero hard problems. **PASS**
- **Wallet caches == ledger truth:** all wallets MATCH (available+pending). **PASS**
- **Affiliate commissions cannot be paid twice:** 0 entries reversed beyond amount; every paid payout's amount lies in [Σ(entries net), Σ(entries gross)] — equal to net at payout time, with post-payout recovery reversals documented (the V-F8 probe's own P1s exercise exactly this). **PASS**
- **Refunds never exceed eligible amounts:** 0 orders with Σ(refunds) > total. **PASS**
- **Expired orders release inventory and vouchers exactly once:** one expiry log per (variant, ref); voucher bookkeeping present. **PASS**
- **Late payments create correct reconciliation obligations:** 26 obligations, 0 duplicate refs, status vocabulary sane (succeeded/requested/failed observed). **PASS**
- **Payout ↔ refund account interactions:** global conservation holds (B9.a); AFFILIATE_LIABILITY / BANK_MAIN nets recorded. **PASS**

**V-F8 (PAYOUT_CLEARING negative presentation) — investigated with live evidence, per instruction.**
The dedicated probe (`phase3-step4-vf8-probe.ts`, evidence JSON) reproduced the exact documented window with real API calls and real postings:
1. P1 pays E_old (1000); a **late full refund** of O1 reverses E_old as a **recovery offset** (stays `paid`, reversed=1000 — spec §11).
2. P2 request: `requestableMinor = available(2000) − recovery(1000) = 1000` — **but claims entries worth 2000**.
3. Approve posts T-A3 **credit 1000** to PAYOUT_CLEARING; a full refund of O2 while P2 is `processing` reverses the **full 2000** against clearing (the C1.2 split is not clamped to the payout's frozen amount; the payout amount floors at 0).
4. **PAYOUT_CLEARING net = −1000 per reproduction (−2000 total across runs), while every transaction balances and global D==C** — exactly the Phase 2.2 classification: account-split presentation edge, no money creation, LOW.
**No allocation logic was changed.** The candidate fix (clamp `adj.clearing` to `payout.amountMinor`, route the excess to the liability/recovery side) is documented for a dedicated financial-allocation review — per the standing rule it must not be implemented inside an acceptance phase.

---

## D. Marketplace E2E Results (§4 journeys)

| # | Journey | Evidence | Verdict |
|---|---|---|---|
| 1 | Register a new shopper | HTTP register 201; verification email **delivered via Mailpit** (inbox counter +1) | **PASS** |
| 2 | Guest checkout + email verification | guest-order-otp-e2e 30/30: OTP issue/verify/replay/lockout, exactly-once email-verified claiming of BOTH guest orders, unverified-account attack claims NOTHING | **PASS** |
| 3 | Multi-seller purchase in one checkout | one PaymentGroup → 2 per-seller orders; single webhook settles both; per-seller T1 | **PASS** |
| 4 | Successful / failed / expired mock payments | success (M2), failed (M3: group failed, order retryable, no T1), expired (M4: cron sweep, restock) | **PASS** |
| 5 | Seller commissions, wallets, pending settlements | bytebazaar commission at the electronics category rate (1200/20000), glow-theory at beauty (900/10000); both wallets carry pending (held) settlement | **PASS** |
| 6 | Full and partial refunds | full → `refunded` + full restock; partial → `partially_refunded`, proportional bookkeeping, no over-refund | **PASS** |
| 7 | Seller withdrawal + payout-state transitions (mock) | request → `requested`; duplicate while open → **409**; admin approve → `processing` + T3; mark-paid (mock reference) → `paid` + T4 | **PASS** |
| 8 | Duplicate and delayed payment webhooks | delayed replay → 200 duplicate-ack, zero new T1 (t1 stays 2) | **PASS** |
| 9 | Guest-order privacy and ownership restrictions | guest suite: uniform 401 no-oracle lookups, grant authorization, foreign-session 401, unverified account reads nothing | **PASS** |
| 10 | Review eligibility and moderation | reviews-e2e 9/9: anon 401, non-purchaser 403, verified-purchase pending, dup 409, pending excluded from aggregates, approve → aggregate +1, seller-session 401 + same-email shopper blocked at registration (cross-portal guard) | **PASS** |
| 11 | Admin MFA enrollment and login | mfa-e2e 17/17: enroll/confirm (recovery codes ×10), challenge login, progressive lockout, TOTP replay rejection, recovery-code burn-once, mandatory-enrollment gate, session revocation, sha256 session storage | **PASS** |
| 12 | Seller approval and product publication restrictions | marketplace M9 (real self-service onboarding): unapproved storefront **404** → ops approve → live → seller's first product auto-`pending_review` (first_n=5 rule) → PDP 404 → admin product approve → PDP 200 (≤30 s public-cache visibility lag, documented designed behavior) | **PASS** |

---

## E. Email Results (Mailpit — the only provider exercised)

Mailpit v1.21 was downloaded and run locally (SMTP :1025, API :8025) and the existing `EMAIL_PROVIDER=mailpit` adapter used — **no real provider was activated**; Resend/Brevo remain unconfigured.

**Verified with real delivery evidence:**
- OTP issuance and verification (guest-order): 30/30 suite checks; codes read from real Mailpit REST inbox (list + per-message detail fetch).
- Guest checkout verification + exactly-once claiming (claiming attack defeated).
- Shopper + seller registration verification emails delivered (every [LT] registration produced a "Verify your NOMOFEE email address" message — 174 total messages over the run).
- OTP expiry: challenge TTL aging + attempt-counters surviving re-issuance (lockout proof), per the guest suite.
- OTP replay prevention: same code twice → 401 (guest suite §5 + MFA TOTP replay guard).
- Duplicate email webhook events: same `svix-id` redelivery → `duplicate:true`, no double suppression row (M10.c).
- Bounce and complaint suppression: signed `email.bounced` → `EmailSuppression` row; OTP request for the suppressed address → uniform 200 (no oracle); `suppression.removed` → row cleared (M10).
- Failed email delivery behaviour: with Mailpit **stopped**, the OTP route answers the uniform 200 (no delivery-status oracle), the app stays healthy, and the failure is recorded in the audit trail (`issued:false, suppressed:"delivery-failed"`).

**Defects found & fixed in this step (small, clearly related, no security semantics changed):**
1. **Mailpit adapter request shape** (`src/lib/email-providers/mailpit.ts`): `from` was sent as an array; Mailpit's `/api/v1/send` requires a single object — every send would have 400'd. Fixed with live verification.
2. **Email webhook timestamp units** (`src/app/api/webhooks/email/resend/route.ts`): the ±5-minute replay window compared Svix **seconds** against `Date.now()` **milliseconds** — every real Resend event would be rejected `STALE_EVENT`, so bounce/complaint suppression could never receive live provider events. Verified empirically (s→400, ms→200) before fixing; window semantics unchanged.

**Remaining BLOCKED (external dependency):** real-provider deliverability (SPF/DKIM/DMARC alignment, provider rate ceilings, real bounce/complaint webhooks with genuine signatures, reputation/warm-up). These cannot be tested without the provider decision and are honestly marked **not passed**.

---

## F. Additional Findings

| ID | Severity | Finding | Impact | Recommendation |
|---|---|---|---|---|
| F-1 | **MEDIUM** (new) | **Affiliate payout shrunk to 0 by in-flight refunds is permanently stuck**: mark-paid and fail both post a zero-value T-A4/T-A4f, which the ledger core rejects (`LEDGER_UNBALANCED debit=0 credit=0`) → HTTP 500, payout stays `processing` forever; each stuck payout also strands its T-A3 credit in PAYOUT_CLEARING (observed +1000 each). Reproduced twice (V-F8 probe runs 2 & 3). | Operational dead-end requiring DB intervention; presentation-only for the books (global balance holds). | Route-level special case: settle cleanly at 0 (skip the zero-value posting) or refuse with actionable 409. Financial-flow change → dedicated review, not fixed in this step. |
| F-2 | **MEDIUM** (new, production-relevant) | **Email webhook timestamp units defect** — fixed live in this step (see E). Without the fix, production bounce/complaint suppression would never have worked. | Was: complete suppression-pipeline failure in production. | Fixed + regression-covered by M10; re-verify after a real provider is chosen (real Svix signature format). |
| F-3 | LOW (new) | **Mailpit adapter `from` shape defect** — fixed live (see E). | Was: dev/staging email testing impossible. | Fixed; keep Mailpit in the dev toolbox. |
| F-4 | LOW (process) | **Six test-infra defects in never-executed suites** (phase22-races: non-hex link codes → 404; payout response field `id` vs `payoutId`; below-min-payout fixture; no MFA dance for admin money routes; unmatured seller holds; F1-c assertion inconsistency; guest-otp Mailpit list-endpoint Text assumption; reviews-e2e wrong route path + aggregate field path + seller-session expectation; session-security hub-auth body shape; mfa-e2e 401-vs-anonymous calibration + TOTP-window/IP-bucket pacing). All were fixture/assertion defects against correctly-functioning product code — every fix preserved or strengthened the asserted property. | The race suites had never actually run anywhere ("prepared, not run"); first execution surfaced them all. | None beyond the fixes (all documented inline); process lesson: prepared ≠ proven. |
| F-5 | INFO | Public-cache visibility lag: admin product/seller approval does not bust the PDP cache tags; ≤30 s staleness is the documented TTL safety net (plus Next's serve-stale-once-after-expiry semantics). | Cosmetic freshness only; no security impact (all gates evaluate server-side on fresh DB reads for mutations). | Optional: revalidate `products` tag in the approve routes. |
| F-6 | INFO | Dev-server OOM when two Next.js dev instances coexist on the 4 GB sandbox. | Infrastructure limitation of this box, not an app defect; user preview was restored within minutes. | Don't run staging acceptance and the dev preview concurrently on this sandbox (or increase RAM). |
| F-7 | INFO | Rate-limit-aware pacing added to test helpers (429-aware registration retry; TOTP-window waits; auth-login IP-bucket waits). The 5/min/IP register limit and the shared 10/min/IP login+MFA-verify bucket are deliberate brute-force controls and were **not** weakened. | Test-only. | None. |

**Existing known findings re-confirmed by execution:** V-F8 (reproduced with full evidence, C); the affiliate fixture-gap family (all closed); ledger zero-value guard (correct behavior, surfaces F-1).

---

## G. Admin MFA Assessment (§6)

Verified LIVE (12/12, `phase3-step4-mfa-reset.ts` + mfa-e2e 17/17):

| Capability | Status | Evidence |
|---|---|---|
| One-time recovery codes | **PRESENT** | 10 codes issued at confirm; each verifies once, second use rejected (mfa-e2e S6); codes stored hashed only |
| Authorized administrator MFA reset | **PRESENT** | offline operator runbook `mfa-admin-reset.ts` (requires out-of-band confirmation env + target email; transactional delete of enrollment) — **no online self-service reset route exists** (by design: an online reset would be an MFA bypass) |
| Mandatory re-enrollment after reset | **PRESENT** | password login works post-reset, but privileged APIs answer **403 MFA_ENROLLMENT_REQUIRED** until a fresh enrollment confirms; MFA bootstrap routes stay reachable |
| Audit records of resets | **PRESENT** | `ActivityLog action=admin.mfa.reset` with operator label recorded |
| Session revocation after reset | **PRESENT** | 0 sessions remain; pre-reset token no longer authenticates (anonymous /me) |

**Gaps:** none blocking. Genuine gap list is empty for the five queried capabilities. Follow-ups (nice-to-have, not blockers): a break-glass second-operator approval workflow (currently a single operator + out-of-band verification policy), and a periodic review of `admin.mfa.reset` audit rows. **No significant development time was spent implementing features in this step** (per instruction).

---

## H. Public-Launch Readiness Review (§7)

**Genuine launch blockers (must close before public launch):**
1. **Real PSP integration** (owner decision pending) — every payment-acceptance result in this report is mock-track. Untestable without the provider: real webhook signature schemes, payout transfer idempotency against a live PSP, refund rails, reconciliation of real late payments, chargeback events (Dispute remains metadata-only by design until the PSP emits chargeback events — external dependency, not faked).
2. **Real transactional email provider** (owner decision pending) — deliverability infrastructure (domain, SPF/DKIM/DMARC, warm-up, provider rate ceilings vs route limits) and genuinely-signed delivery webhooks. The pipeline itself is proven end-to-end on Mailpit, and the webhook-unit defect that would have broken it in production was found and fixed.
3. **V-F8 + F-1 family** (financial presentation/operational dead-end) — not money-creation, but should be closed with a reviewed allocation change before real payouts flow; both now have exact reproduction recipes.
4. **Production deployment procedures** — a production build + deploy + recovery rehearsal has still never been executed (unchanged from Phase 2 assessment); OOM headroom planning (F-6) belongs here too.

**Manageable operational limitations (not blockers):**
- ≤30 s public-cache staleness after admin approvals (F-5, designed TTL safety net).
- Rate limits deliberately tight on register/login/OTP (security posture; monitor real-user friction at pilot scale).
- Dev-only rails (mock PSP, Mailpit, dev login credentials) verified sandbox-only/fail-closed in production (mockPspAllowed / NODE_ENV guards; Mailpit adapter refuses in production).
- Session-token hashing, MFA, review moderation, guest OTP, suppression — all now proven under real DB conditions.

**Future improvements:** SSR/SEO plan (documented, not faked), seller-attribution campaign suite has never run end-to-end (prepared; not required for this phase's scope), scheduler-e2e's app-restart matrix not re-run against staging (in-process sweep + cron routes were exercised instead), trigram search performance under real corpus size.

**Deferred per owner instruction (unchanged):** PSP selection/integration/credentials; provider-neutral adapter architecture preserved throughout.

**Payments acceptance that CANNOT be considered complete without a real PSP:** real payment success/failure from an actual banking rail; PSP-originated webhook signature verification (scheme + secret rotation); payout transfer submission/recovery against the PSP; real refund execution and reconciliation; chargeback/dispute event handling; amount-currency edge cases from the PSP's real payloads; settlement timing/cut-off behaviour.

---

## I. Readiness Verdicts

| Area | Verdict | Evidence |
|---|---|---|
| **Financial concurrency verification** | **READY** (mock-track) | 274/274 checks across 13 suites against the real staging Postgres: webhook-vs-expiry, duplicate/replay webhooks, 40-wide stock rush (0 oversell, 0 raw 5xx), payout/refund races (one-open, one T-A3/T-A4, amount shrink-then-pay), exactly-once per order (15/15 storm), ledger balanced D=C=876,475, wallet caches == truth, no over-refunds, V-F8 honestly reproduced + bounded. Caveat: mock PSP only (H.1). |
| **Marketplace acceptance testing** | **READY** (mock-track) | All 12 §4 journeys executed green through real API surfaces with isolated [LT] fixtures: registration, guest checkout + email-verified claiming, multi-seller purchase, mock payment success/failed/expired, commissions/wallets/holds, full+partial refunds, withdrawal lifecycle with duplicate-request 409, guest privacy, review moderation, admin MFA, seller approval + publication gates. Caveat: mock PSP only. |
| **Email readiness** | **CONDITIONAL** | Pipeline proven on Mailpit (delivery, OTP lifecycle, claiming, suppression, duplicate events, delivery-failure fail-soft) + two real defects found & fixed (adapter shape; webhook timestamp units). Condition: real provider decision + deliverability infrastructure + genuinely-signed webhooks — externally dependent, honestly not passed. |
| **Security readiness** | **READY** (staging-proven) | MFA end-to-end (17/17) incl. mandatory enrollment + replay/lockout; session hashing + revocation (10/10); guest OTP no-oracle + exactly-once claiming (30/30); verified-purchase reviews (9/9); RBAC capability gates exercised per role; MFA recovery complete incl. operator reset runbook (12/12); fail-closed guards on dev-only rails; rate-limit brute-force controls verified under load. |
| **Controlled pilot readiness** | **CONDITIONAL** | Technical platform is pilot-ready on the mock track (all verdicts above); conditions: real PSP + real email provider wired (pilot with real money requires both), F-1/V-F8 closed or explicitly accepted as known presentation/ops debt for the pilot window, and a production deployment/recovery rehearsal. |
| **Public launch readiness** | **NOT READY** | Blockers H.1–H.4: real PSP, real email provider + deliverability, V-F8/F-1 financial-allocation review, and an executed production build/deploy/recovery procedure. No new technical blockers discovered in the platform's own logic — every protection tested held; the remaining gap is external dependencies and the final operationalization. |

---

## Safety & Integrity Proofs (this run)

- **`public` schema untouched:** structural hash before (Step 3 canonical post-verify) `24ac8aa602328b63f57c…` == after (all suites complete) `24ac8aa602328b63f57c…`; **zero row-count deltas; zero fault-injection artifacts leaked** (`phase3-step4-public-untouched-proof.txt`). (The Step 4 pre-flight's own baseline hash differs only by a `regclass` rendering artifact of its staging-pinned search_path — table sets and row counts proven equal; the canonical comparison is recorded above.)
- **No migrations re-run, no schema changes:** the 15-migration ledger re-verified intact (checksums == repo files) at pre-flight; zero DDL executed by any suite in `nomofee_staging` beyond the guarded, auto-dropped fault-injection triggers.
- **No commits/pushes:** all changes remain uncommitted in the working tree, awaiting authorization.
- **No security controls weakened:** every 409/429/403 encountered by suites was either the correct product behavior (asserted as such) or a test-pacing accommodation (documented in F-7); OTP and authentication were never bypassed; admin money routes were driven through the real MFA challenge dance.

## Artifacts (docs/staging/evidence/)

`phase3-step4-preflight.json` · `phase3-step4-seed.json` · per-suite `-output.txt` (races, finance-regression, late-payment-refund, webhook-resilience, fault-rollback, remediation-live run1+run2, mfa-e2e, session-security, reviews-e2e, guest-order-otp, marketplace-e2e, mfa-reset) · `phase3-step4-invariants.json` + final output · `phase3-step4-vf8-probe.json` + output · `phase3-step4-marketplace-e2e.json` · `phase3-step4-mfa-reset.json` · `phase3-step4-public-untouched-proof.txt` · existing `performance/runs/*` JSON evidence from the suites.

New/modified scripts (all under `scripts/readiness/` + 3 product files: `next.config.ts` env-gated distDir, `mailpit.ts` adapter fix, `email/resend/route.ts` timestamp fix) — ready for review; nothing committed.

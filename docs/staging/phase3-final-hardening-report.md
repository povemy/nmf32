# NOMOFEE — Phase 3 Final Hardening & Pre-Launch Readiness Report (Works 1–6)

**Mission:** close the remaining financial defect (V-F8/F-1), verify deployment and recovery procedures,
prepare real transactional email, continue PSP research without selecting a provider, and establish the
remaining requirements before a controlled pilot and public launch.
**Executed:** 2026-11-03 (UTC), against the authorized non-production Supabase project — financial tests
against `nomofee_staging` (fingerprint `aa338c2b6272e14c`, reconfirmed by the fail-closed reconfirm gate);
`public` proven untouched; mock PSP + Mailpit only; no commits/pushes.
**Baseline carried in:** Phase 3 Step 4 (274/274 checks, 13 suites) and Step 3 (15/15 migrations, 44/44
post-verify).

---

## A. Code Review & CI

**Git state.** The sandbox's auto-snapshot mechanism had committed the working tree (16 unpushed commits on
`main`, origin unreachable — no credentials; nothing was pushed). Full review performed over status,
tracked/untracked files and the cumulative diff. **No real secrets anywhere in the diff** (`.env*` ignored
and untracked; scan found only vendor-HTML false positives); `db/custom.db` (dev SQLite, non-secret) was
already on origin. Scratch areas captured by the snapshot (`.agent-tmp/` 243 files, `tool-results/` 454,
`db/backup/` incl. 404 hashed session tokens) were **quarantined via .gitignore** — an authorized cleanup
commit remains owner work before any push.

**Step-4 file review.** `lib.ts` pgClient guard, `next.config.ts` env-gated distDir, `mailpit.ts` adapter
fix, `email/resend/route.ts` Svix timestamp fix — all reviewed and correct. **One hardening gap closed live:
the pgClient guard only engaged when a URL pinned a schema — an env override WITHOUT a pin silently
retargeted raw fault-injection DDL at the role-default `public` schema.** Now refused (unpinned override →
hard fail; explicit `schema=public` → hard fail), proven live by `pgclient-guard-proof.ts` (3/3: unpinned
refused, public refused, staging pin connects with `search_path=nomofee_staging`).

**Restore artifacts.** The Oct-30 sandbox snapshot had resurrected 10 stale, zero-referenced files that
broke the CI typecheck (5 errors) — deleted after verifying no inbound references (carousel/input-otp/
resizable/supabase.ts scaffolds; old shipping-quote route, admin campaigns UI, calendar; attic-duplicate
fin scripts; tailwind.config.ts re-deleted after a second resurrection).

**CI gates (all reproduced locally, in CI-workflow order):** `bun install --frozen-lockfile` OK ·
`prisma validate` OK · `prisma generate` OK · **tsc (tsconfig.ci.json) 0 errors** · **eslint src 0 errors /
39 warnings (<50 bound; none in touched files)** · **unit tests 187/187** · **production build EXIT 0** —
the first-ever successful production build for this project (memory-watched: min 541 MB free, dev server
survived). **A real CI runner execution was NOT obtained — it requires a push, which needs owner
authorization** (no GitHub credentials in this sandbox). Reported, not claimed.

## B. Financial Correction (V-F8 + F-1) — COMPLETE

**Root cause (verified by full lifecycle code read):** the payout request nets the recovery offset into its
amount (`A = V − recovery`) while claiming entries worth the full value `V` (the overclaim IS the
spec-§11 recovery-withholding vehicle — only `A` is parked in PAYOUT_CLEARING by T-A3), but
`reverseAffiliateForRefund` booked the FULL entry reversal against clearing (`adj.clearing += R` uncapped)
— debiting clearing beyond its T-A3 credit when `R > remaining` (V-F8's negative presentation) and never
reversing the withheld liability; and mark-paid/fail on a refund-shrunk-to-0 payout attempted zero-value
T-A4/T-A4f postings which the ledger core rejects (`LEDGER_UNBALANCED debit=0 credit=0`) → HTTP 500 →
payout permanently stuck `processing` (F-1), stranding its T-A3 credit.

**Design (documented BEFORE implementation — docs/finance/vf8-f1-correction-design.md):** per refund,
per payout, per share: `X = min(share, remaining)` goes to clearing (processing) and shrinks the payout
amount; the excess routes to the T5 liability line via postRefund's existing global arithmetic
(`affiliateReversal − affiliateClearing`); processing payouts consumed to 0 auto-terminate to `failed`
(auto-release, mirroring the requested-state path) with live entries released; mark-paid/fail at amount 0
skip the zero-value posting (reference requirement dropped at 0); request-time `requestable ≤ 0` refused
(belt-and-braces against a hand-edited `min_payout=0`). Conservation proven in the design: clearing nets to
zero at every terminal state and is never negative at any intermediate point; total liability reversal ==
total entry reversal; amount == `(V − ΣR) − recovery` floored at 0.

**Files changed:** `src/lib/affiliate.ts` (coordination block: capped allocation + tracked remaining +
auto-release-at-0 + loud negative guard), `src/app/api/admin/affiliate/payouts/[id]/process/route.ts`
(zero-value skips + reference rule). No schema change, no ledger-recipe change, no requestable-model
change, no lock/idempotency change.

**Regression & concurrency (all against staging, real API surfaces incl. the admin MFA dance):**
`phase3-work2-vf8f1-regression.ts` — the required 12 scenarios (refund before request / after request /
after approve / full-shrink-to-zero / partial / multiple refunds / concurrent refund+mark-paid /
concurrent refund+approval / repeated processing + duplicate-open / **late recovery + overclaimed payout +
full in-flight reversal (the exact V-F8 window)** / payout failure + retry / duplicate refund delivery) —
**75/75 PASS**, with independent DB invariants: every txn balanced, D=C=1,787,375, **no zero-value txn,
PAYOUT_CLEARING run-delta 0 and never negative, nothing stuck, no entry paid/reversed twice, wallets ==
truth, terminal postings == row amounts, BANK_MAIN delta == Σ payouts (12,401)**. The V-F8 window itself:
**clearing delta 0 (pre-fix: −recovery), P2 auto-released at 0, no stuck processing.**

**Existing suites re-run post-fix:** `phase22-races` **33/33** (one latent fixture-assertion defect found
and fixed en route: R1.b's paid-branch asserted stock 5 instead of 5−qty — only visible when payment wins
the race; product behaviour was correct throughout), `finance-regression` **37/37**, `late-payment-refund`
**18/18**, `phase3-step4-invariants` **18/18** (D=C=1,876,125; clearing positive). **Legacy remediation:
8/8** — the three real pre-fix rows left by Step 4 (two stuck processing@0, one requested leftover) were
remediated through the sanctioned admin API (fail@0 → 200, mark-paid@0 without reference → 200, reject →
200; zero new postings; clearing unchanged).

**Public untouched (Work 2 run):** artifact scan all clean (the 5128 `[LT]` products are legacy dev data —
zero created in the window); only deltas = live dev-server housekeeping (Session expiry sweep,
WebhookDeliveryAttempt heartbeat) — evidence file written.

## C. Deployment Rehearsal — COMPLETE (all three, executed & documented)

**Production build & boot (`phase3-work3-production-rehearsal.sh`, 19/19):** build EXIT 0 → standalone
staged → **fail-closed boots proven** (mailpit refused: "DEV-ONLY catcher… Select a production provider";
missing secrets abort with the mandatory list) → **valid production-mode boot on :3200** (health 200,
nodeEnv=production, authorized staging fingerprint, ledger invariants ok, CSP + nosniff headers, root
renders) → **money gates** (mock-PSP webhook 403 PROVIDER_SANDBOX_ONLY even with a valid-format demo
signature; cron 403/403/200 for missing/wrong/correct secret — timing-safe `x-cron-secret`) → **restart
persistence** (kill + reboot → healthy) → teardown; degraded-mode warnings (SHIPPING_WEBHOOK_SECRET
fail-closed 503 posture) observed as documented.

**Scheduler reliability (`phase3-work3-scheduler-rehearsal.sh`, 11/11):** liveness + zero consecutive
failures → controlled ~70 s interruption → **app-side health flips to STALE (ageSeconds 69)** → restart →
**MISSED_INTERVAL catch-up alert** → FRESH again, zero failures → **exactly-once across the window**
(expired-order and restock-log counts unchanged).

**Backup & recovery (`phase3-work3-backup-restore-drill.ts`, 13/13):** full logical backup of
`nomofee_staging` (96 tables, 5,078 rows, checksummed, FK-safe order, self-refs handled) → **restore onto a
VIRGIN DATABASE via `prisma migrate deploy`** (the production mechanism; pg_trgm installs cleanly) →
**ledger identical (15 rows, names+checksums), all 96 row counts equal, drill books balanced D=C=1,877,925
== source** → temporary app instance boots healthy against the restored database (ledgerOk=true, txns=191)
→ full teardown (database dropped WITH FORCE). **DR-runbook finding:** migration 20261109000000 references
`gin_trgm_ops` unqualified — replay into a *second schema of the same database* (where pg_trgm lives in the
other schema) fails 42704; a virgin-database deploy — the real DR path — is unaffected (proven). Also fixed
two drill-infrastructure defects found en route (pg `sslmode=require` → verify-full override;
`pg_get_serial_sequence` identifier folding). The hashed-session rollback rule is documented in the
deployment runbook (never roll back to an old build against a newer hashed-session database — the drill's
current-build health check against restored rows is the positive half of that proof).

## D. Email Provider

**Recommendation: Resend primary; Brevo secondary/fallback only** (full comparison + sources:
docs/psp-readiness/phase3-work4-email-provider-recheck.md). Decisive facts: NOMOFEE already ships a
Svix-signature-verified Resend webhook route (production-corrected in Step 4); Resend Pro $20/50k with 24 h
idempotency keys and Tokyo (ap-northeast-1) sending; Brevo's webhooks are unsigned (IP-allowlist model),
30-min idempotency, EU-only sending, and 60–180 % pricier at 20–50k/mo — though it bills in MYR and adds
SMS/WhatsApp 2FA options. **Activation status: NOT ACTIVATED** — requires the owner's approval + provider
account + verified domain (DNS changes) + credentials (outside source control); staged activation
checklist is documented. Mailpit remains the dev rail (fail-closed in production — proven in Work 3A).
Mailpit-only results are explicitly NOT real-provider verification.

## E. PSP Research

**Evidence-based comparison + ranked shortlist delivered; NO provider selected or activated**
(docs/psp-readiness/phase3-work5-psp-research-update.md). Shortlist: **1. Razorpay Curlec Route** (the only
MY-badged, product-level split-at-charge documentation: provider-managed Linked Accounts with lifecycle
KYC webhooks, per-transfer settlement holds, reversals, sandbox, public MYR pricing), **2. CHIP Collect +
Send** (cleanest commercial terms, OpenAPI + Send sandbox, FPX refunds, chargeback events — but
platform-of-record custody: seller KYC stays with NOMOFEE per TOS §5A), 3. Xendit XenPlatform (MY
activation unverified), 4. Airwallex MY (confirmations outstanding). Material changes vs the previous
assessment captured (CHIP domain/regulatory framing, Curlec→Razorpay rename + MY Route availability,
public pricing, SenangPay/DOKU migration). Sales-confirmation list prepared for the owner's D1 decision.
No accounts, forms, credentials, adapters, or agreements — provider-neutral architecture untouched.

## F. KYC & Password Recovery (carry-forward decisions — documented, not implemented)

**Seller KYC (docs/security/seller-kyc-decision.md):** current state verified — email-ownership
verification is real and staging-proven; `KycDocument` is metadata-only (honest by design, no upload
pipeline); `kycStatus` deliberately not consulted by the approval lifecycle. Three options assessed;
**recommended: hybrid (Option C)** — the PSP performs KYC for payout-eligible sellers (verdict-sync
ingestion), NOMOFEE keeps non-document operational signals. Avoids becoming a PII custodian, unlocks payout
rails. **Not a blocker for the non-money track; a precondition for the real-money pilot; decide together
with D1.**

**Shopper password recovery (docs/security/shopper-password-recovery-design.md):** verified **absent**
(distinct from guest-order OTP and admin MFA recovery). Recommended design reuses proven primitives
(EmailOtpChallenge table with a new purpose, hashed single-use 15-min tokens, uniform no-oracle responses,
CAS consume, rate limits, full session revocation, audit rows; ≈2 routes). **Not a blocker for non-money
staging; should be treated as a public-launch blocker** (small, primitive-reusing build). No
authentication architecture was changed.

## G. Additional Findings (this phase)

| ID | Severity | Finding | Action |
|---|---|---|---|
| G-1 | MEDIUM | pgClient unpinned-override hazard (closed): env override without `schema=` pin would have retargeted fault-injection DDL at `public` | Fixed + 3/3 live guard proof (`pgclient-guard-proof.ts`) |
| G-2 | MEDIUM | Sandbox auto-snapshot commits the tree and captured scratch/backup areas (~700 files, incl. 404 hashed session tokens) unpushed; origin credentials absent | `.gitignore` quarantine now in place; **owner: authorized cleanup commit before any push** |
| G-3 | LOW | Latent R1.b fixture-assertion defect (paid-branch stock expectation) in the never-run-this-branch race path | Fixed (assertion only; product behaviour was correct) |
| G-4 | LOW | DR-runbook note: unqualified `gin_trgm_ops` blocks same-database second-schema migration replay (42704); virgin-DB deploy unaffected (proven) | Documented in the drill evidence + runbook |
| G-5 | LOW | Resend region correction: Tokyo = ap-northeast-1 (not ap-southeast-1); account data US-resident → PDPA assessment | Research doc corrected; owner/legal action item |
| G-6 | INFO | Sandbox restarted mid-phase (auto-snapshot rollback lost scratch logs; platform services auto-recovered); two drills re-executed with full evidence regeneration | Environment note; no data impact (staging DB unaffected — reconfirm gates re-passed) |
| G-7 | INFO | Drill-infrastructure defects fixed en route (pg sslmode→verify-full override; pg_get_serial_sequence identifier folding; pkill self-match) | Test-infra only; product code untouched |

## H. Overall NOMOFEE Assessment (honest opinion)

**Technical maturity — high and now genuinely proven under concurrency.** The core money engine
(double-entry ledger, exactly-once postings, payout state machine, refund coordination, race-hardened
sweeps/webhooks) has now survived first-execution concurrency suites, a 40-wide checkout rush, a dedicated
12-scenario payout×refund lifecycle suite, and repeated full-suite re-runs — **the last known financial
defects (V-F8, F-1) are corrected with conservation proofs and regression coverage, including remediation
of the real legacy stuck rows.** The honesty discipline (metadata-only KYC, fail-closed everything, no
unexecuted check reported) is consistent and unusually good.

**Financial safety — production-grade on the mock track.** Books balance globally and per-transaction at
every point of every suite; clearing never goes negative post-fix; wallets mirror ledger truth; late
payments create auditable obligations; refunds never exceed eligible amounts. Remaining exposure is
operational, not architectural: the manual payout workflow depends on operator action (by design), and
nothing has touched a real banking rail yet.

**Security — strong and staging-proven.** MFA end-to-end incl. recovery, session hashing, guest-OTP
no-oracle + exactly-once claiming, verified-purchase reviews, RBAC caps, rate-limit brute-force controls,
fail-closed dev rails (mock PSP, Mailpit, cron, metrics) — all verified live, several under attack-shaped
probes. CSP/frame-embedding posture is deliberate and documented.

**Scalability — adequate for pilot scale, with measured evidence only where measured.** Observed: 0 raw-5xx
under 40-wide concurrency, sub-second suites, memory-headed builds. NOT measured: real-corpus trigram
search, sustained multi-hour soak on production hardware, real PSP latency. The one-box OOM lesson
(one dev instance per environment) is documented and rehearsed around.

**Operational readiness — the largest remaining gap, and now largely de-risked by rehearsal.** Build ✓,
deploy boots ✓ (fail-closed correctly), scheduler recovers ✓, backup→restore→verify ✓ with a virgin-DB
drill, rollback rules documented. Still missing: a real CI runner execution, a production-host deploy
rehearsal (this sandbox is the template), monitoring/alert ownership (D8), and the two external rails
(PSP, real email) that no amount of staging can substitute.

**Net:** the platform's own logic is launch-worthy; every remaining blocker is an owner decision or an
external dependency, not a code defect.

## I. Readiness Verdicts

| Area | Verdict | Evidence |
|---|---|---|
| **Code and CI readiness** | **READY (local) / CONDITIONAL (runner)** | tsc 0, eslint 0 errors, 187/187 units, frozen lockfile, production build EXIT 0 (first ever), restore artifacts removed, guard hardened + 3/3 proof. Real CI runner NOT executed — requires an authorized push (G-2 cleanup first). |
| **Financial payout/refund integrity** | **READY (mock track)** | V-F8/F-1 corrected with documented conservation proofs; 75/75 dedicated suite (12 scenarios + invariants); re-runs 33/33 + 37/37 + 18/18 + 18/18; legacy rows remediated 8/8; D=C at every check; clearing never negative. Real-PSP confirmation pending (B1). |
| **Production deployment and recovery** | **READY (rehearsed; CONDITIONAL for the production host)** | Work 3A 19/19 (build, fail-closed boots, gates, restart); 3B 11/11 (scheduler interrupt/recovery); 3C 13/13 (virgin-DB backup/restore/verify + app health + teardown). The production-host execution of the same runbook remains owner infra work. |
| **Real email readiness** | **NOT READY (external)** | Pipeline + webhook route production-correct (Step 4 fixes); recommendation + activation checklist documented (Resend primary). Requires owner approval, account, domain DNS, credentials; Mailpit-only results are not real-provider verification. |
| **PSP integration readiness** | **NOT READY (deferred by owner)** | Research updated with material changes; ranked shortlist + sales-confirmation pack; NO selection/activation performed; provider-neutral architecture intact. |
| **KYC and account-recovery readiness** | **CONDITIONAL** | KYC: decision assessment delivered (hybrid recommended; coupled to D1); not a non-money blocker, precondition for real money. Password recovery: absence verified; small primitive-reusing design delivered; recommended as a public-launch blocker to close. |
| **Non-money staging acceptance** | **READY** | Milestone A of docs/ops/controlled-pilot-readiness.md — all nine gates green with executed evidence (this report A–C + Step 4). |
| **Real-money controlled pilot** | **NOT READY** | Blocked on B1–B8 (PSP selection/integration, KYC model, real email, production-host rehearsal, password-recovery decision, CI runner, ops ownership). V-F8/F-1 (B4) is the only gate already closed. |
| **Public launch** | **NOT READY** | Same blockers as the pilot plus pilot evidence itself; no new platform-logic blockers discovered this phase — the correction closed the last known one. |

---

### Safety & integrity record (this phase)
Staging-only financial tests behind the fail-closed reconfirm gate (fingerprint + pin + ledger reverified
each session); `public` untouched (Work 2 proof + post-run leak scans; dev-server housekeeping only); no
migrations re-run in staging; the only DDL executed anywhere was the drill's virgin-database deploy and its
FORCE teardown; no security control weakened (rate limits waited out, never relaxed; OTP/MFA never
bypassed); no commits/pushes (auto-snapshot commits are the sandbox's, not mine — reported in A/G-2);
evidence for every executed item under `docs/staging/evidence/phase3-work*` and `db/backup/`.

# Controlled Pilot Readiness — Two-Milestone Plan (Phase 3 / Work 6)

**Basis:** every criterion below is anchored to executed evidence (Phase 3 Steps 3–4, Works 1–3, and the
Phase 2 verification record) — no invented capacity or traffic limits. Sizes proposed derive only from
observed staging/load-test behaviour on this infrastructure.

---

## Milestone A — Non-Money Staging Acceptance (mock PSP + Mailpit)

**Can proceed NOW** — the technical gates below are all green with executed evidence:

| # | Gate | Evidence |
|---|---|---|
| A1 | Staging schema deployed & verified (15/15 migrations, ledger checksums == repo) | Step 3 post-verify 44/44; Work 2 reconfirm 10/10 |
| A2 | Financial concurrency (mock track) | Step 4: 274/274 incl. races 33/33; Work 2 re-run: races 33/33, finance-regression 37/37, late-payment 18/18, invariants 18/18 |
| A3 | V-F8/F-1 corrected + regression-proven | Work 2: 75/75 (12 lifecycle scenarios + 9 invariants); legacy stuck rows remediated 8/8 |
| A4 | Marketplace journeys (12 §4 list) | Step 4 marketplace E2E 38/38 + guest-OTP 30/30 + reviews 9/9 + MFA 17/17 + session 10/10 |
| A5 | Email pipeline (Mailpit) incl. suppression + delivery-failure | Step 4 E section + the two live defect fixes (adapter shape, Svix timestamp units) |
| A6 | Production build + deployment rehearsal | Work 1 build EXIT 0; Work 3A rehearsal 19/19 (fail-closed boots, gates, restart persistence) |
| A7 | Scheduler reliability | Work 3B rehearsal 11/11 (interrupt → stale detection → catch-up recovery, exactly-once) |
| A8 | Backup & recovery | Work 3C drill 13/13 (virgin-DB restore via migration mechanism, ledger identical, app healthy) |
| A9 | Code/CI hygiene | Work 1: tsc 0, eslint 0 errors, 187/187 units, frozen lockfile OK |

**Milestone A scope (what may be exercised):** internal team + a bounded group of invited test users
browsing, registering (real Mailpit emails), guest checkout, mock payments, mock refunds, review
moderation, seller onboarding — all against the staging environment. **No real money, no real PSP, no
real-provider deliverability claims.**
**Suggested size (evidence-derived):** ≤ 50 invited users, ≤ 10 test sellers — well within the observed
staging envelope (the 40-wide concurrent checkout rush on the 4 GB sandbox held 0 raw-5xx; the staging
instance ran all suites without resource incidents; the only OOM observed was two full Next.js dev
instances coexisting — avoided by the one-instance-per-environment rule, F-6).

## Milestone B — Real-Money Controlled Pilot

**BLOCKED until every item below is closed (owner decisions in bold):**

| # | Blocker | Owner action required |
|---|---|---|
| B1 | Real PSP selected + integrated (provider-sandbox acceptance of the 12-case payment suite: success/failure/expiry/duplicate/replay/late/refund full+partial/payout transfer/reconciliation/chargeback) | **D1: select provider** (shortlist: docs/psp-readiness/phase3-work5-psp-research-update.md) |
| B2 | Seller KYC ownership model approved (payouts only to PSP-verified beneficiaries) | **D2: approve model** (recommendation: hybrid, docs/security/seller-kyc-decision.md) |
| B3 | Real transactional email activated + deliverability verified (domain, SPF/DKIM/DMARC, signed webhooks, controlled test mailbox) | **D3: approve provider + provide account/domain/credentials** (recommendation: Resend, docs/psp-readiness/phase3-work4-email-provider-recheck.md) |
| B4 | V-F8/F-1 family closed | ✅ DONE (Work 2) — re-verified at PSP integration time |
| B5 | Production deployment + recovery rehearsed on the production host (this sandbox rehearsal is the template; the real host's runbook execution remains) | Owner infra + runbook docs/ops/phase21-deployment-runbook.md |
| B6 | Shopper password recovery implemented (or explicitly accepted as pilot debt with operator-recovery runbook) | **D4: approve design** (docs/security/shopper-password-recovery-design.md — small, primitive-reusing) |
| B7 | CI on a real runner (workflow exists, gates proven locally; first real run requires a push) | **D5: authorize push / wire GitHub Actions** |
| B8 | Monitoring, incident response, operational ownership defined (metrics token + alert routing + on-call owner; the app exposes /api/metrics fail-closed and scheduler alerts today) | Owner ops decision |

**Pilot entry criteria (all measurable):** provider-sandbox suite 12/12 green; real-provider email
verification checklist 4/4 (Work 4 doc); one production-host deploy + rollback rehearsal executed; password
recovery live or debt-accepted in writing; CI green on the first real runner execution.
**Suggested pilot size (evidence-derived):** ≤ 20 buyers, ≤ 5 sellers, ≤ RM 500 total transaction value,
2-week window, daily ledger-invariant + wallet-reconcile checks (the app's own `/api/health` ledger
invariants + the readiness suites provide exactly these measurements). Numbers are ceilings derived from
the maturity of the money rails (manual payout workflow, T+2 settlement expectations), not performance
limits — the platform's observed concurrency headroom is far higher.

## Standing rules for both milestones

* Never report unexecuted checks as passed; every gate above carries its evidence pointer.
* Public launch remains a separate, later authorization (Step 7 / owner decision) — the launch blockers
  from the Step 4 report H.1–H.4 map to B1/B3/B5 (+CI) here, with V-F8/F-1 now closed.

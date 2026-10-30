# Affiliate Programme — Rollout & Launch Checklist

**Purpose:** gate every step between "code complete" (Phase 8 of `implementation-plan.md`) and "affiliate programme live in production". Each gate is owned, dated on completion, and evidenced. **No gate may be waived by engineering alone** — gates 1–3 are signed outside engineering (legal, product/legal, finance).

**Companions:** `architecture-audit.md` (what exists and its verified gaps), `implementation-plan.md` (what was built, phase by phase), `commission-definitions.md` (the money rules this checklist protects), `security-and-fraud-rules.md` (the controls being launched).

**Reading order for a reviewer:** §1 legal → §2 terms → §3 finance → §4 staging proof → §5 settings → §6 kill switch → §7 monitoring → §8 retention → §9 rollback → §10 launch day → §11 sign-off register.

---

## 1. Legal review — BLOCKER (sponsor override)

- [ ] **BLOCKER — Legal opinion obtained on the one-level sponsor override under the Direct Sales and Anti-Pyramid Scheme Act 1993 (Akta Jualan Langsung dan Skim Piramid 1993), including a written clarification request/response from KPDN (Ministry of Domestic Trade, now KPDNKK) if counsel requires it.**
  - Scope of the opinion, explicitly requested in writing:
    - [ ] (a) whether a single-generation 10% share of a seller-funded commission pool — paid to the referrer of an earning affiliate, arising only when the referred affiliate's own referred sale is paid, never from recruitment itself — constitutes a prohibited pyramid-style reward under the Act;
    - [ ] (b) whether programme registration or licensing with KPDN is required before enabling the sponsor override;
    - [ ] (c) confirmation that the structural safeguards are accurately described to counsel and reflected in the opinion: single generation only (one nullable sponsor FK, no recursion), no recruitment bonuses (no payment on activation), no click rewards (no payment on clicks), commissions arise only from actual paid sales, self-purchase excluded, kill switches exist at programme and sponsor levels.
  - **Until this gate closes: `affiliate.sponsor_enabled` stays `false` in production.** The programme may still launch with direct-only commissions (D = P, no sponsor entries, no held shares — the split degrades gracefully per `commission-definitions.md` §3). This gate blocks the sponsor override ONLY, not the direct programme.
  - Evidence artefacts: legal opinion letter stored in the compliance folder; KPDN correspondence referenced by date and reference number; the exact schema/code excerpts supplied to counsel archived alongside.
- [ ] Secondary legal confirmations (parallel, non-blocking for direct launch but required before full launch):
  - [ ] affiliate terms are enforceable consumer contracts (feeds gate 2);
  - [ ] withholding / income-tax reporting position for affiliate payouts (joint finance + counsel note — affiliate earnings reporting obligations under Malaysian income tax rules);
  - [ ] personal-data basis for affiliate display names and attribution-touch retention (PDPA position; aligns with gate 8 and the platform's existing no-PII analytics posture, `src/lib/analytics/identity.ts`).
- [ ] Legal sign-off recorded in §11: reviewer, date, reference number.

## 2. Affiliate terms — drafting + versioning

- [ ] Affiliate terms & conditions drafted (counsel-reviewed) covering at minimum:
  - [ ] programme description and eligibility (active shopper account; account standing; withdrawal rights);
  - [ ] the one-level sponsor structure — described **only to the extent gate 1 permits**; if gate 1 is open at launch, terms describe the direct programme and reserve the sponsor feature ("as may be enabled under applicable law");
  - [ ] commission calculation in plain language, reviewed by finance to match `commission-definitions.md` §3 exactly (no marketing rounding — the floor/residual split and the fixed 90/10 ratio);
  - [ ] commission lifecycle and the review window (why money is not instantly payable);
  - [ ] refund reversal policy including the **recovery mechanism** (reversals on already-paid commissions offset future earnings; no claw-back from transfers already made; termination with an outstanding obligation becomes a finance-ops matter);
  - [ ] payout terms: manual bank transfers only, minimum payout, cadence commitment, no interest;
  - [ ] suspension/termination rights and their effects (held sponsor share, paused clocks, forfeiture on termination — never redistribution of another affiliate's share);
  - [ ] prohibited conduct: self-purchase attempts, spam, misrepresentation, cookie/token manipulation;
  - [ ] the kill-switch clause: the programme may be modified, suspended, or discontinued; treatment of earned-but-unpaid balances at discontinuation (per gate 9's recorded decision).
- [ ] **Versioning implemented:** `AffiliateProfile.termsVersion` stores the accepted version string (e.g. `2026-11-v1`); a version bump blocks hub actions behind a re-acceptance banner until accepted; historical acceptances are append-only (`termsAcceptedAt` per version) and never rewritten; the activation POST rejects unknown/stale version values (server-side allowlist of valid versions).
- [ ] Terms page renders publicly (unauthenticated surface) and is linked from the activation dialog and the public showcase footer.
- [ ] Plain-language commission examples cross-checked by finance against `commission-definitions.md` §3's worked table.
- [ ] Sign-off: counsel + product; date recorded in §11; terms version string recorded.

## 3. Financial operations sign-off — manual payout runbook

**Context (verified in `architecture-audit.md` §3.10):** the platform has **no automated PSP payout capability** — `psp.payouts.mode` is registered but `wired: false`, the adapter scaffold (`src/lib/psp-adapter.ts`) is dormant, and the seller payout pipeline is deliberately manual. The affiliate pipeline mirrors that posture: the runbook below is the ONLY payout mechanism, by design.

- [ ] **Manual affiliate payout runbook written**, covering:
  - [ ] cadence and cut-off (e.g. requests processed within N business days of approval; approve in daily batches);
  - [ ] reconciliation pre-flight: the 7-point report (`commission-definitions.md` §10) must show zero unexplained variance before ANY transfer batch is executed — variance blocks the run, not the report;
  - [ ] transfer execution: manual bank transfer per affiliate; reference number captured as `bankRef` (the mark-paid API makes it mandatory — mirroring the seller payout route's `referenceNo` requirement at `src/app/api/admin/payouts/[id]/mark-paid/route.ts`);
  - [ ] state discipline: approve → T-A3 posted (requested→processing); transfer confirmed → mark-paid → T-A4 posted (processing→paid); bank rejects/delays → fail → T-A4f posted, entries return to available, affiliate notified; operator error → reject (requested→rejected, no ledger movement);
  - [ ] failure path rehearsed deliberately (staging drill below);
  - [ ] segregation: approver and transfer executor are different people where staffing allows; current holders of the `affiliate.manage` capability listed by name;
  - [ ] filing: payout statements, reconciliation snapshots, and transfer receipts archived per period (financial records retained indefinitely — gate 8).
- [ ] Runbook rehearsed on staging end-to-end: request → approve (T-A3 verified in the admin ledger explorer) → transfer-mock → mark-paid with reference (T-A4 verified) → entries `paid`; AND once with a deliberate `fail` (T-A4f verified, entries back to available).
- [ ] Finance sign-off: named approver, date, runbook version recorded in §11.

## 4. Staging verification — full commission lifecycle

**Evidence discipline:** every checkbox below is backed by a test-run log or scripted assertion output (IDs archived); reviewer + date per block. Scripts extend the existing verification family (`scripts/fin-tests.ts`, `scripts/fin-concurrency.ts`, `scripts/verify-ledger.ts`, `scripts/test-commission-parity.ts` — same repo conventions).

### 4.1 Lifecycle E2E (single happy path, `affiliate.sponsor_enabled=true` ON STAGING ONLY to exercise the split)
- [ ] activate affiliate (terms acceptance recorded, `termsVersion` persisted);
- [ ] sponsor binding via referral touch: landing beacon → `AffiliateReferralTouch` → first-touch-wins inside the window → sponsor locked at activation + `AffiliateSponsorAudit(lock)` row;
- [ ] create product link + store link + collection; public showcase renders within exposure limits (caps enforced, nofollow present);
- [ ] click → `AffiliateAttributionTouch` recorded from the httpOnly visitor cookie (verified server-side, not a client echo);
- [ ] **multi-seller checkout with mixed attribution:** item A attributed to affiliate 1; item B (same seller as A) attributed to affiliate 2 (per-OrderItem independence); item C self-purchase (excluded, `affiliateExclusion=self_purchase`); item D non-eligible store (excluded, `store_opt_out`) — one PaymentGroup, correct per-item frozen snapshots;
- [ ] webhook success → T1 posts 4 balanced lines per attributed order (DR gateway / CR seller payable net-of-pool / CR commission / CR affiliate liability); commission + entries exist exactly once per item; replayed webhook creates nothing (claim + dedupKey + unique orderItemId);
- [ ] invariant asserted by script on every order in the run: `Σ sellerNet + Σ commission + Σ affiliatePool === orderTotal`;
- [ ] order `delivered` → affiliate tick sets `approved`; review window elapses → `available`; sponsor-held case exercised (suspend the sponsor mid-lifecycle — direct 90% continues, sponsor entry `held`);
- [ ] payout request → approve (T-A3) → mark-paid with `bankRef` (T-A4) → entries `paid`; balances reconcile.

### 4.2 Refunds
- [ ] partial refund on an attributed order → T5 posts with the affiliate DR line; entries reversed proportionally to the ORIGINAL split; cumulative clamp verified across TWO sequential partial refunds (second clamped to remaining pool);
- [ ] full refund → `Σ reversal === Σ pool` exactly (stored composition reproduced);
- [ ] post-payout (late) refund → recovery obligation recorded; offsets a subsequent commission's posting (direct share reduced, never below zero); reconciliation report point 6 balances.

### 4.3 Switches & degradation
- [ ] kill-switch drill: `affiliate.enabled=false` → all routes 403 `AFFILIATE_DISABLED`; checkout stops snapshotting (orders post the historical 3-line T1); tick idles; payout requests refused; existing rows untouched; **re-enable resumes with no data repair**;
- [ ] sponsor-switch drill: `affiliate.sponsor_enabled=false` mid-staging → new postings are `D = P` single-entry; existing sponsor entries continue their lifecycle.

### 4.4 Concurrency & abuse
- [ ] concurrent activation attempts → exactly one profile;
- [ ] concurrent payout requests → one open request (Serializable + bounded P2034 retry — the `POST /api/store/payouts` pattern proven for sellers);
- [ ] webhook replay storm → one commission set, one T1;
- [ ] checkout oversell guard unaffected by affiliate fields (conditional stock decrement still the sole stock authority);
- [ ] rate-limit refactor verified: per-account buckets key off the authenticated principal (activation 5/min, link create 30/min, payout request 3/min; admin 30/min; track 60/min per IP; 429 payload carries retry seconds).

### 4.5 Integrity
- [ ] ledger invariants runner green including the affiliate term (`runLedgerInvariants` extension);
- [ ] reconciliation report (7 points) executed on the staging dataset → zero unexplained variance;
- [ ] security control tests from `security-and-fraud-rules.md` §1–§11 pass (cross-tenant access, CSRF, self-referral, network privacy allowlist, sanitisation).

## 5. Settings to set at launch (production)

All keys live in the settings registry (`src/lib/settings-registry.ts`, group `affiliate`), editable in admin System→Settings (`src/components/admin/system.tsx`) by `settings.manage` (superadmin), every change audited (`AdminAuditLog` with actor + timestamp). Defaults are fail-closed — launch is an explicit act of turning keys on:

| Key | Launch value | Note |
|---|---|---|
| `affiliate.enabled` | `true` (the launch act itself) | kill switch; gates every route + the checkout integration |
| `affiliate.sponsor_enabled` | **`false` — BLOCKED on gate 1** | flip to `true` only after the legal opinion closes |
| `affiliate.max_rate_bps` | `1000` (10%) | clamp applied at rate resolution, before the pool is computed |
| `affiliate.min_payout_minor` | `1000` (RM10) | matches the seller payout minimum default posture (`payout.min_minor` default 1000) |
| `affiliate.review_days` | `14` | approval → availability window (delivered/completed + 14d, no open refund) |
| `affiliate.attr_window_days` | `30` | product-sale attribution window (last eligible click) |
| `affiliate.sponsor_window_days` | `30` | registration attribution window (first touch) |

- [ ] Values set in production and **read back** (GET `/api/admin/settings`) — confirm the registry shows every key `wired: true` at this point (the honesty rule: a key ships wired only when running code reads it).
- [ ] Settings snapshot (all seven values + timestamps + actor) archived as the launch baseline.
- [ ] Later changes to `max_rate_bps` or window keys recorded with rationale — they affect future snapshots only, never frozen history (`commission-definitions.md` §5).
- [ ] Scheduler route map includes the affiliate tick (this deployment: `mini-services/expiry-scheduler` port 3005; production: platform cron with the identical POST contract) and `cron.affiliate_tick.last` is being written.

## 6. Production kill-switch procedure

- [ ] Procedure documented and rehearsed on staging (drill in §4.3): superadmin sets `affiliate.enabled=false` via System→Settings.
- [ ] Verified effects: all `/api/affiliate/**` routes 403 `AFFILIATE_DISABLED`; checkout create performs no affiliate resolution (new orders post the historical 3-line T1); affiliate tick idles; payout requests refused; **frozen snapshots, commission rows, ledger lines, payout history remain immutable and queryable**; re-enable requires no data repair.
- [ ] Partial switch: `affiliate.sponsor_enabled=false` alone stops sponsor entries on future postings (D = P) while existing sponsor entries continue their lifecycle — the graceful de-scope path if a legal concern surfaces post-launch.
- [ ] Communication plan: in-hub banner text pre-drafted; terms clause (gate 2) covers modification/discontinuation; earned-but-unpaid balances policy stated in the runbook (gate 9 decision).
- [ ] Named on-call authority for flipping the switch (superadmin roster) + expected time-to-effect: immediate on next request; no deploy required.

## 7. Monitoring & reconciliation cadence

- [ ] **Reconciliation report (7 points, `commission-definitions.md` §10)** scheduled **daily for the first 30 days**, then weekly. Executed via the cron-scheduler pattern (this deployment: `mini-services/expiry-scheduler`, port 3005; production equivalent: platform cron with the same POST contract; the lifecycle endpoint is `/api/cron/affiliate-tick`, the report itself is an admin GET). Zero-variance expected; any variance becomes an owned incident with a named finance owner.
- [ ] **Affiliate tick health:** `cron.affiliate_tick.last` Setting monitored for staleness (same observability pattern as `cron.expiry_sweep.last` / `cron.analytics.last`); scheduler alerts (`TICK_FAILED` class) routed to ops.
- [ ] **Fraud signal review (manual, per `security-and-fraud-rules.md` §9):** weekly review of the signal report — self-purchase exclusion rates, sponsor concentration, refund rates on attributed orders, 429 telemetry per affiliate bucket, conversion outliers. **No automated enforcement** — investigators act only via the audited controls (suspension, correction, payout hold).
- [ ] **Ledger invariants runner** on the production schedule alongside the existing finance checks (`runLedgerInvariants`).
- [ ] **Rate-limit store decision recorded:** if production is multi-instance, `RATE_LIMIT_REDIS_URL` must be configured AND verified in production (the Redis limiter path in `src/lib/rate-limit.ts` is implemented but unproven in staging — `architecture-audit.md` §3.16), or gateway-level limiting is documented as the compensating control. A single-instance deployment is documented explicitly with its scaling ceiling.
- [ ] Error monitoring on the new routes wired into the existing health surface (`/api/health`, `/api/admin/system/health`).
- [ ] First-month daily review roster assigned (finance + engineering alternates).

## 8. Data retention confirmation

- [ ] **Attribution touches align with analytics retention:** `AffiliateAttributionTouch` and `AffiliateReferralTouch` are purged on the same cadence as `AnalyticsEvent` (setting `analytics.retention_days`, executed by the analytics retention tick `/api/cron/analytics-tick`; the affiliate tick coordinates with it). Rationale: touches are behavioural evidence; once the orders they attributed are frozen, the durable evidence lives in the `OrderItem` snapshot columns (`affiliateLinkCode`, `affiliateAttributedAt`).
- [ ] **Financial records retained indefinitely:** `AffiliateCommission`, `AffiliateCommissionEntry`, `AffiliatePayout`, `AffiliateSponsorAudit`, all ledger transactions/lines, and refund reversal state are NEVER purged by any retention rule — matching the platform's existing posture, quoted from the registry description of `analytics.retention_days`: "Order, payment and refund records are NEVER deleted by this rule — sales history is authoritative and permanent." Verified: no affiliate financial table appears in any purge job.
- [ ] Audit logs (`AdminAuditLog`, `ActivityLog`) retained per the existing platform policy (purge is superadmin-only, password-re-verified — the `logs.purge` capability); **no affiliate-specific purge is added**.
- [ ] Touch purge age verified ≥ attribution window + payment window (30-day touch retention floor documented) so no in-flight cart can lose its attribution evidence mid-purchase.
- [ ] Recovery obligations (`recoveryMinor`) are financial records — indefinite retention, excluded from purges.

## 9. Rollback plan

- [ ] **Disable programme** (`affiliate.enabled=false`): immediate, no data loss, no repair on re-enable (drilled in §4.3 / §6). This is the primary rollback.
- [ ] **Scope rollback** (`affiliate.sponsor_enabled=false`): removes sponsor exposure while keeping the direct programme live — the legal-concern path.
- [ ] **Post-disable obligations honoured:** commissions already `available` at disable time are paid out through the manual runbook. Finance decision recorded before launch: **recommend pay-out-then-stop** (earned balances are honoured); the terms clause (gate 2) must state the chosen policy.
- [ ] **Schema rollback NOT planned:** affiliate tables/columns are additive; the rollback posture is feature-off, not migration-down. Any emergency migration reversal would require a dedicated finance-approved plan, because ledger lines referencing `PLATFORM:AFFILIATE_LIABILITY` must never be orphaned — the immutable-ledger discipline of `src/lib/ledger.ts` applies. Documented as out-of-scope for launch.
- [ ] Rollback decision owners named: product + finance for disable; legal + product for scope rollback; engineering is the executor, never the decider.
- [ ] Rollback rehearsal: the §4.3 kill-switch drill doubles as the rollback rehearsal; dated evidence archived.

## 10. Launch day sequence

1. [ ] Confirm gates 1–4 signed in §11 (the sponsor gate may legitimately remain OPEN — launch proceeds direct-only, `affiliate.sponsor_enabled=false`).
2. [ ] Confirm production deploy health: migrations applied (`prisma migrate` status clean); `/api/health` green; scheduler route map includes the affiliate tick and `cron.affiliate_tick.last` is populating.
3. [ ] Set production settings per §5 — `affiliate.enabled=true` LAST.
4. [ ] Read back settings (GET `/api/admin/settings`); archive the launch baseline snapshot.
5. [ ] Smoke test on production with a controlled test affiliate: activation → link → track → checkout → webhook → T1 4-line visible in the admin ledger explorer → commission row `pending`.
6. [ ] Announce per the communication plan; begin the daily reconciliation cadence (§7) and the first-month review roster.
7. [ ] Schedule the post-launch review (30 days): conversion/abuse signals, reconciliation variance history, payout runbook friction, decision on whether gate 1 has progressed for the sponsor override.

## 11. Sign-off register

| Gate | Owner (role) | Name | Date | Evidence reference |
|---|---|---|---|---|
| 1. Legal — sponsor override (**BLOCKER**) | Counsel | — | — | opinion ref + KPDN correspondence |
| 1b. Tax / PDPA notes | Counsel + Finance | — | — | joint note ref |
| 2. Affiliate terms | Counsel + Product | — | — | terms version string |
| 3. Financial ops runbook | Finance | — | — | runbook version + drill log |
| 4. Staging verification | Engineering lead | — | — | test-run IDs (per block §4.1–§4.5) |
| 5. Settings baseline | Ops / Superadmin | — | — | settings snapshot |
| 6. Kill-switch drill | Engineering + Ops | — | — | drill log |
| 7. Monitoring live | Ops | — | — | alert routing + roster |
| 8. Retention confirmed | Engineering + Data owner | — | — | purge config diff |
| 9. Rollback plan + pay-out policy | Product + Finance | — | — | this document §9 |
| 10. Launch sequence executed | Ops / Superadmin | — | — | smoke-test log |

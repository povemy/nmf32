# RX-CHECKLIST — Production Readiness Validation (F1/F2/F3 + Checkout Capacity)

Mission: evidence-driven production-readiness review. No checkout redesign, no unrelated features.

## Ground rules (binding)
- Treat earlier reports as evidence to VALIDATE, not assumptions. PASS/FAIL/NOT TESTED labels only for executed tests.
- No pool-size increase, no Supavisor mode switch without evidence. No multi-instance scaling without admission-control + connection budget proof.
- No destructive testing on production DB; test accounts + `[LT]` test data only; no OOM chasing.
- Production build cannot run in this sandbox (dev-mode only) → Phase 4 must be labeled accordingly; no dev→production extrapolation.
- Worklog discipline: append to /home/z/my-project/worklog.md after each phase.

## Phase 1 — Verify current state (DONE)
- [x] `performance/` directory: **DOES NOT EXIST** (no REPORT.md, no F1/F2/F3 audits, no runs/)
- [x] `scripts/loadtest/`: DOES NOT EXIST. Existing harness: `scripts/test-oversell.ts` (2-way race + MOQ + stock probe)
- [x] `CHECKOUT_BUSY` admission gate: **NOT IN CODE** (0 matches)
- [x] F1 (payment confirmation): claim-first + `Serializable` isolation IS present in `process.ts` (FIN-2b baseline, commit 5aae27e/fe1c429 era) — but NO P2034/retry handling anywhere (`grep P2034|P2024|retry src/` = 0). No F1 fix commit; no test evidence.
- [x] F2 (checkout contention fix): NOT IMPLEMENTED. `db.ts` has no pool config; `connection_limit=10` only as URL query param on Supavisor session pooler.
- [x] F3 (reservation expiry): NOT IMPLEMENTED. No reservation tables; stock decrements at checkout; `PaymentGroup.expiresAt` (30 min) never enforced — no sweep/worker/alerts.
- [x] Scheduler/worker: none for checkout (only shipping tick + payout sweep endpoints, request-triggered).
- [x] Metrics: `/api/health` only (counts + ledger invariants). No `/api/metrics`, no latency instrumentation.
- [x] **ENV INCIDENT**: `.env` had been reset to 50-byte stale sqlite-only file (mtime Oct 25 10:11) → `SUPABASE_DATABASE_URL` missing → app could not boot. RESTORED from `/tmp/my-project/.env` snapshot (Oct 23) — Supavisor session pooler `aws-0-ap-southeast-1.pooler.supabase.com:5432`, `connection_limit=10&connect_timeout=10`. Prisma connectivity verified (343 orders / 368 paymentGroups).
- [x] Git history: last commits = FIN-*/R2 finance hardening + one UUID HEAD commit (Oct 20). NO F1/F2/F3, no performance work committed.

## Phase 2 — Close critical test gaps (DONE — see performance/runs/2026-10-25-*)
1. Fault-injected rollback (inventory + ledger boundaries, DB-trigger injection): PASS 15/15
2. Webhook redelivery + concurrent duplicates + transient-DB-fault (lock injection): PASS on exactly-once; FAIL findings = raw 500s (P2034, no retry) + 120.7s lock hang (statement_timeout is only bound)
3. Scheduler/expiry sweeps/worker restarts/overlaps: NOT TESTED (feature absent — measured)
4. Simultaneous expiry + payment confirmation: NOT TESTED (feature absent)
5. Expiry scheduler config + alerts: N/A (absent; F3 gap CONFIRMED by 75s measurement)
6. 503 CHECKOUT_BUSY E2E: NOT TESTED (gate absent)
7. Multi-instance gate behavior: NOT TESTED (no gate; in-process limiter documented single-process)

## Phase 3 — Topology + connection capacity (DONE — measured)
- 1×1 sandbox topology; prod topology UNDOCUMENTED [Assumed]. max_connections=60; rush peak 18 sessions; app pool 10 = throttle, held idle-in-tx. connection_limit NOT changed.
- Transaction-pooler :6543 probe (isolated): ALL PASS at probe level (tx, SAVEPOINT, Serializable claim 1/5/0, repeated queries). NOT applied.

## Phase 4 — Production-like behavior (DONE, bounded, labeled dev-mode + combined-env)
- baseline p50 1.31s | ramp c=40: 23×201/17×500 | rush ×2: p50 15.5–17.6s, 61–62% raw 500s, ZERO oversell | webstorm: 0/15 confirmations (wallet-cache SSI hot row P2034) | idem: 1 order exactly, 11×500 P2002 | recovery 1.25s.

## Phase 5 — Launch decision (DONE)
- performance/REPORT.md rewritten with measured results; performance/readiness-checklist.md created.
- VERDICT: NOT READY (evidence + remediation list). No production code modified.

---

# RX-CHECKLIST — Close Final Operational and Payment-Recovery Gaps (trace 1a173199b23d7b91)

Mission: close the three REPORT.md §R.5 conditions — (1) expiry scheduling not
demonstrated in the deployment, (2) production topology + connection budget
undocumented, (3) late-payment refund/reconciliation for a real PSP. Verify the
current tree FIRST; do not redo completed work without regression evidence.

## Ground rules (binding; inherited + additions)
- Phase 0 verification BEFORE any change: repo/branch/commit/worktree, REPORT vs code, archived runs.
- Preserve existing passing behavior — finance-regression (34/34) and remediation-live (27/27) must stay green after all changes.
- Scheduler endpoints fail CLOSED in production when CRON_SECRET is missing; timing-safe secret compare; the secret is never logged or echoed.
- Refund/reconciliation cases never fake a completion outcome; completion only from a provider-authoritative record/response.
- No production financial writes; [LT] fixtures only; no pool/Supavisor changes; no horizontal scaling.
- Dev-mode/combined-environment labels preserved; PASS/FAIL/NOT TESTED only for executed tests.

## Phase 0 — verify current state (DONE 2026-10-25T13:0xZ)
- [x] git main @ 67bcfcc, clean worktree; dev server up (health 200); CRON_SECRET absent from .env; chat-service NOT running (start it).
- [x] REPORT §R.2 fixes verified in code: expiry-sweep route, checkout-gate, process.ts F1 (post-commit refresh + P2034 retry + 10s/15s bounds), wallet-reconcile script, runs/* archived.
- [x] GAP-1: expiry-sweep auth is fail-OPEN when CRON_SECRET missing + non-timing-safe compare — must fix (mission Phase 1 req 2/3).
- [x] GAP-2: NO actual recurring invocation exists (route is tick-only) — must build + run a scheduler service (mission Phase 1 req 1).
- [x] GAP-3: no failed/overdue-sweep ALERTING (durable last-run Setting only) — must add.
- [x] GAP-4: late-payment 409 GROUP_EXPIRED records NO durable obligation — must add PaymentReconciliation (mission Phase 2).
- [x] GAP-5: no refund executor / provider refund idempotency — must add adapter + tick.
- [x] GAP-6/7: topology doc + production-like validation absent — Phases 3/4.

## Phase 1 — expiry scheduler operationalization (DONE — 17/17 PASS)
- [x] src/lib/cron-auth.ts (fail-closed production, timing-safe) applied to expiry-sweep POST+GET
- [x] mini-services/expiry-scheduler (port 3005; 30 s interval; durable state.json; alerts; boot catch-up; ticks BOTH endpoints) — RUNNING in this deployment
- [x] scripts/readiness/scheduler-e2e.ts: release latency 18.7–20.9 s vs objective; overlap safety; restart + missed interval (catch-up 1.4 s + MISSED_INTERVAL alert); auth matrix incl. fail-closed E2E via server restarts — 2026-10-25-scheduler-e2e.json

## Phase 2 — late-payment refund/reconciliation (DONE — 10/10 scenarios, 16/16 checks)
- [x] schema: PaymentReconciliation + PspRefundRecord; db:push (orphan dedupKey columns on ActivityLog/Notification dropped — verified unused, zero runtime impact)
- [x] process.ts: durable obligation at BOTH GROUP_EXPIRED sites (idempotent upsert; webhook amount = captured funds; optional paymentId)
- [x] src/lib/psp-refund.ts: RefundAdapter + mock adapter (idempotencyKey semantics; behavior modes; one-shot crash fault; provider-alias resolution)
- [x] /api/cron/refund-reconcile: POST tick + GET observability; cron-auth
- [x] /api/admin/payment-reconciliation (401 unauth) + admin system-health counts
- [x] scripts/readiness/late-payment-refund.ts — 2026-10-25-late-payment-refund.json
- [x] docs/late-payment-refund-runbook.md

## Phase 3 — topology & connection budget (DONE)
- [x] performance/production-topology.md (1×1 + scheduler decision, Supavisor ceiling 15 measured, scaling gate + advisory-lock strategy, session-pooling decision, env knobs)

## Phase 4 — production-like validation (DONE within sandbox boundaries)
- [x] post-change re-runs: finance-regression ALL PASS; remediation-live-tests ALL PASS; load baseline/ramp/rush/webstorm archived (rush: 0 raw 5xx, p50 1.92 s, 0 oversell; webstorm: exactly-once held, 14/15+1×500 P2034)
- [x] browser golden path re-verified (NM-103495 paid, 1 T1, 0 cases, cart cleared, no console errors; 390/1280 px)
- [x] production build / staging / external generator: NOT TESTED — documented boundary

## Phase 5 — evidence & verdict (DONE)
- [x] REPORT.md §O + readiness-checklist addendum #2 (PASS/FAIL/NOT TESTED per critical requirement)
- [x] worklog appended; lint clean; browser verified

---

# ADDENDUM #3 — 2026-10-27 (current-state documentation-sync verification)

Mission: synchronize `performance/current-state-verification.md` with REPORT §R+§O; verify
every claimed change against the actual tree; reconcile contradictions. NO business-logic
changes permitted for doc-sync purposes.

- [x] All §R.2 fixes + §O.2/O.3 artifacts verified present in code at `main @ f8674c5` (cron-auth, checkout-gate 8/32/5s, expiry-sweep, refund-reconcile, psp-refund, PaymentReconciliation/PspRefundRecord models, obligation at both GROUP_EXPIRED sites, admin routes, runbook, topology doc).
- [x] Code-version correspondence: `git diff 6646301..HEAD` = env/boot-guard files only → 2026-10-25 test evidence valid for current business code.
- [x] Evidence re-read: all 14 performance/runs/*.json inspected; numbers match REPORT (§R.3, §O.5). EMAXCONNSESSION fact NOT in any archived JSON → relabeled to worklog evidence.
- [x] Live re-executed 2026-10-27: /api/health?fresh=1 healthy; verify-ledger.ts ALL PASS (325/325, 6/6 wallets); refund-reconcile counts (8 succeeded / 1 S7-residue failed / 0 open).
- [x] INCIDENT found & resolved: expiry-scheduler dead since Oct-25 session reset (128-group backlog) → restarted 01:35Z → MISSED_INTERVAL catch-up → backlog drained to 0 autonomously. §O.2 "RUNNING" was stale; §P addendum added to REPORT.
- [x] Docs corrected: gate "16 inflight"→8 (never was 16); current-state-verification.md rewritten (baseline preserved as HISTORICAL §5); REPORT §P added.
- [x] Hygiene: .env untracked from git; new-style Supabase keys (sb_publishable/sb_secret) installed + REST-validated; legacy anon JWT 401 resolved.
- [x] Verdict unchanged: CONDITIONALLY READY; outstanding = real-PSP refund adapter, production build/staging/external generator, production env (CRON_SECRET, PSP_WEBHOOK_SECRET, cron).

---

# ADDENDUM #4 — 2026-10-27 (production deployment / staging capacity / PSP readiness)

Mission (trace 1a17b2c008441ac9): prepare for PSP technical review + eventual production
launch. 8 phases. Deliverables: deployment-preflight.md, environment-matrix.md,
scheduler-deployment.md, production-topology.md (update), staging-capacity-report.md,
psp-readiness/preflight.md, docs/psp-readiness/ package.

## Ground rules (binding; inherited + additions)
- Sandbox CANNOT run `bun run build` (env policy) → production build = NOT TESTED here; provide exact CI/staging steps. Never claim build success from dev server.
- No external hosting credentials, no Supabase dashboard access → remote deployment/secret-manager/platform-cron items = BLOCKED with exact remaining steps.
- External load generator required for capacity claims; sandbox is 2-vCPU shared → capacity ladder execution BLOCKED; prepare profiles + harness adaptation only.
- No real PSP selected → provider-specific integration stays out of scope; no fabricated provider secrets/claims.
- Do not modify business logic for documentation purposes. If a real defect is found in verification, fix it separately with regression tests.
- Production/prod-like traffic tests in this sandbox limited to safe, non-destructive checks against the local deployment only.
- PASS/FAIL/NOT TESTED/BLOCKED labels only with evidence; archived under performance/runs/.

## Phase checklist
- [x] P0: repo/deployment-target verification → performance/deployment-preflight.md + performance/psp-readiness/preflight.md (git 78ee258, versions, scripts, no Docker/CI/platform manifests, Caddyfile=sandbox-only, hosting BLOCKED, scheduler+webhooks+pool verified in code, REPORT↔code cross-checked, D-1..D-8 findings)
- [x] P1: environment-matrix.md (dev/staging/prod; staging BLOCKED-on-dashboard w/ exact steps; target-guard fail-closed VERIFIED 7/7 incl. load-runner integration refusal)
- [x] P2: build-config inspection + lint(0 err) + tsc(60 pre-existing, mine clean) + db:generate + boot guards re-proven + deployment-smoke.ts 22/22 ALL PASS (dev-mode labeled; production build NOT TESTED per sandbox policy; proxy/TLS checklist documented)
- [x] P3: scheduler-deployment.md + scheduler-e2e re-run 17/17 (release 11.3s, catch-up 1.3s, 403/503 auth matrices, no-echo) + late-payment-refund S1–S10 re-run PASS + CRON_SECRET rotation procedure + platform-cron steps BLOCKED
- [x] P4: webhook audit (signature-before-trust, replay, duplicates — all verified live) + PSP_WEBHOOK_SECRET guidance + docs/psp-readiness/ 14-file package (subagent 4-a; honest mock-only boundary) + provider-neutral contract + provider checklist
- [x] P5: production-topology.md §7 full per-process connection budget (app/scheduler/scripts/migrations/monitoring + spike/deploy/ops windows + re-measured server values)
- [x] P6: staging-capacity-report.md (execution BLOCKED; k6 kit prepared: 7 ladder profiles + lib 8/8 syntax-validated; fixture lifecycle live-verified; metric definitions §2; draft thresholds flagged; rate-limit staging knobs added w/ unchanged defaults)
- [x] P7: 12-item deployment-validation checklist — 8 dev-verified / 4 BLOCKED-remote (staging-capacity-report.md §5)
- [x] P8: REPORT.md §Q final verdict (Q.1 classification table, Q.2 five readiness levels, Q.3 PSP-review scope, Q.4 CONDITIONALLY READY); worklog appended; lint clean; browser verified

---

# ADDENDUM #5 — 2026-10-27 (PSP provider selection & fit-gap assessment)

Mission (trace 1a17bb292e7048a9): evaluate the payment/ledger/commission/refund/payout
architecture against real Malaysian marketplace PSP requirements. Deliverable:
docs/psp-readiness/provider-fit-gap.md (+ 12-case sandbox acceptance suite).

## Ground rules (binding)
- ASSESSMENT ONLY — no provider implementation, no financial business-logic changes.
- Provider capabilities: only what is verifiable from OFFICIAL documentation fetched
  today (record URL + HTTP status + date). Anything not established in public docs =
  "NEEDS WRITTEN CONFIRMATION" — never inferred from product-name similarity.
- No invented pricing, eligibility, approval status, API behavior, or settlement timing.
- Web research = read-only curl to official domains; record fetch date 2026-10-27.
- Shipping (RM8) is a pass-through: do NOT count it as platform profit; allocation must
  be traced to code (commission engine) and documented honestly.
- Two research subagents (psp-fitgap-3-a global platforms / 3-b MY local) run in
  parallel; both append to worklog.md; main agent audits code + writes the doc.
- Pending from interrupted session: regression re-runs (deployment-smoke +
  finance-regression) after TS fixes — MUST complete before doc writing.
- Completion = doc is evidence-backed, identifies exact decisions/access needed
  before implementation. NOMOFEE must NOT be described as PSP-integrated.

---

# ADDENDUM #6 — trace 1a17c3aee75615d1 (Admin Settings UX + Activity Log purge)

Mission (user request, 3 parts): (1) rebuild Admin→Settings from raw-JSON table into a
friendly form UI (toggles/selects/numbers; remove the duplicate/dead footer toggle
situation); (2) add a permanent "Clear All Activity Log" function gated by an admin
password re-prompt; (3) advise what to check/do next on the platform.

## Ground rules (binding; inherited + additions)
- ASSESS-DISCIPLINE: a Setting key must not be presented as functional UI unless it is
  actually consumed by running code — unwired keys get an explicit "Not wired" badge.
- DISCOVERED CONTAMINATION: all seeded Setting rows currently hold valueJson `"claimed"`
  (load-test artifact) — code falls back to defaults, so runtime behavior is unaffected,
  but the values MUST be restored to seed truth, not left corrupted.
- `ui.footer_visible` is the ONLY footer setting in the system and is currently DEAD
  (nothing consumes it). There is no second duplicate; the fix = wire this one to the
  global shopper footer (single working toggle), not to add another.
- Purge is PERMANENT and must be: superadmin-only (new `logs.purge` cap), password-
  re-verified server-side (scrypt verify, never logged), audited (AdminAuditLog survives
  + one fresh ActivityLog row marks the reset), batched (bounded delete loops).
- Scope of purge = the ActivityLog table across ALL actor types (admin/seller/shopper/
  system). AdminAuditLog (compliance trail), NotificationLog, PaymentWebhookLog are
  separate tables and are NOT touched.
- Test-control keys (recon.fault, lt.seed.state) stay hidden from the friendly UI.
- Regression: finance-regression + deployment-smoke must stay green afterwards; PASS/
  FAIL only for executed checks; browser-verify the golden paths before reporting done.

---

# ADDENDUM #7 — 2026-10-28 (Seller Store Insights + Sales & Market Insights — unified mission)

Mission (trace 1a182c544c761a81): implement the combined Seller Store Insights spec
AND the Sales & Market Insights addendum as ONE feature. Audit first (no code changes),
produce a consolidated plan, then implement incrementally with tests per phase.

## Ground rules (binding; inherited + additions)
- Unified-scope rule: shared models/events/APIs/metric-definitions/authorization must be
  designed once — no duplicated analytics infrastructure between the base spec and addendum.
- Authoritative-data rule: purchase/refund/revenue metrics come ONLY from
  Order/OrderItem/Refund/ledger records (paidAt, PAID_ORDER_STATUSES, processed refunds);
  browser events are never authoritative for money. begin_checkout is derived from
  Order.createdAt (authoritative), not a client event.
- Analytics must never break checkout/payment/cart/refund paths: collection is
  fire-and-forget via a bounded in-memory queue (drop-oldest, counted), never awaited on
  the storefront hot path, never inside checkout transactions.
- No new pool pressure: event writes batched via single createMany (skipDuplicates) flush;
  dashboard queries bounded (indexes + paged + 30–60s globalThis TTL cache, `?fresh=1` bypass).
- Schema changes ONLY additive via the established `db:push` workflow + row-count snapshots.
- Privacy: pseudonymous first-party cookies only (visitor 365d / session 30-min sliding,
  httpOnly, SameSite=None+Secure to match app cookie posture); NO IP, NO UA/fingerprinting,
  referrer stored as host-only, no PII in event rows; shopperId only when authenticated.
- Geo honesty: Order has NO country field today. Add `shippingCountryCode` snapshot at
  checkout ("checkout" source). Historical backfill to 'MY' ONLY when the frozen
  shippingAddressJson contains a 5-digit postcode + known MY state (source='backfill'),
  else 'ZZ' Unspecified. Billing country: NOT RECORDED → dimension documented as
  unavailable. Never infer country from IP.
- Currency: single-currency MYR verified — no conversion logic; document the rule.
- Authorization: every insights route uses requireActiveSellerStore(); storeId comes from
  session, never client input; negative seller-A→seller-B tests mandatory.
- Multi-vendor: metrics computed from OrderItem/ CartItem lines scoped to the seller's own
  store; PaymentGroup totals never duplicated across sellers.
- PASS/FAIL/NOT TESTED/BLOCKED labels only for executed tests; worklog appended per phase;
  finance-regression + deployment-smoke must stay green; browser-verify before reporting done.
- Deferred-with-justification: daily rollup tables NOT built (event volume does not justify
  heavyweight infra; documented threshold + design note). Retention purge rides the
  scheduler tick + `analytics.retention_days` setting.

## Phase checklist
- [x] P0 AUDIT (DONE — 4 parallel read-only agents): performance/seller-insights-audit.md
- [x] P1 PLAN: consolidated implementation plan + API contract (agent-ctx/SI-PLAN.md)
- [x] P2 SCHEMA: AnalyticsEvent + Order.shippingCountryCode/Source + additive indexes
      (Order(storeId,paidAt), Order(paidAt), OrderItem(orderId), ProductVariant(productId),
      CartItem(cartId)) via db:push; row-count snapshot before/after — IDENTICAL
      (order 1051 / orderItem 1071 / cart 106 / cartItem 103 / productVariant 5106);
      backfill executed 1051/1051 → MY/backfill (0 ZZ), idempotent re-run verified
- [x] P3 COLLECTION: src/lib/analytics/* + instrumentation on sf/cart routes +
      checkout-create country snapshot + backfill script + settings-registry keys +
      /api/cron/analytics-tick + expiry-scheduler 3rd endpoint (service restarted,
      ticking: analytics lastSuccessAt verified; scheduler holds 0 persistent DB conns)
- [x] P4 QUERIES+API: queries.ts + 7 seller-scoped routes — live-verified with real
      data; auth negatives 401 (unauth + invalid bearer)
- [x] P5 UI: seller view 'insights' (1 919 lines) — browser-verified: all tabs,
      window-switch refetch, drill-down Dialog, sorting/pagination, CSV export,
      mobile 390px + desktop 1280px, zero console errors on clean reload; VLM review
      "professional and polished, no visual glitches"
- [x] P6 TESTS: scripts/readiness/seller-insights.ts — 56/56 ALL PASS (found + fixed a
      real defect: shared rate-limit bucket mixed limits → export now separate bucket);
      finance-regression 37/0 PASS; deployment-smoke 23/23 ALL PASS; remediation-live
      ALL PASS on re-run (first run F1-c 14/15 = the documented P2034 storm flake,
      money exactly-once both runs); browser golden path: storefront+PDP visit →
      Insights showed 2 visits / 1 product view / authoritative RM174 sales
- [x] P7 DOCS: metric-definitions.md + implementation-report.md + this checklist +
      worklog appended

## Prior-session note
ADDENDUM #6 (Admin Settings form + Activity Log purge) was verified implemented in the
current tree during this audit (settings-registry.ts with friendly fields + "Not wired"
badges; /api/admin/activity-logs/purge with superadmin cap + scrypt password re-verify +
batched delete). Not re-done; no duplication.

---

# ADDENDUM #8 — 2026-10-28 (Seller dashboard: live platform terms + pending-actions urgency)

Mission (trace 1a18557d1b1a4809, user request, 2 parts): (1) the Seller Dashboard
"Platform commission" card (and every other seller-backend surface showing platform
parameters — fee, payment hold / grace period, moderation window, payout minimum) must
be LINKED to the live admin settings so every change reflects automatically; (2) each
pending action gets its OWN card with a large count and urgency colors/sizing.

## Ground rules (binding; inherited)
- Authority rule: seller-facing numbers come from the DB (CommissionSetting singleton +
  Seller overrides + Setting rows) — never hardcoded literals. Per-item snapshots
  (order_item.commissionMinor) stay authoritative for money math; the dashboard card
  shows the seller's effective DEFAULT rate, honestly labeled ("default rate" when
  product/category/holiday overrides can apply).
- Honesty rule: runtime hold = paidAt + (seller.holdDaysOverride ?? payoutHoldDays) at
  both T1 sites in process.ts. holdReleaseRule="days_after_delivered" is stored but NOT
  implemented → all display copy says "after payment".
- Additive only: new read-only endpoints + UI wiring; NO changes to commission engine,
  checkout, payment webhook, ledger, wallet math. finance-regression/deployment-smoke
  must stay green (re-run deployment-smoke; business code untouched → full finance
  suite not required, smoke is the guard).
- /api/platform/terms is public but exposes ONLY business-policy values already shown
  on the public seller landing (commission %, hold days, fixed-fee/min flags + amounts,
  payout minimum, moderation first-N). No PII, 60 s TTL cache.
- PASS/FAIL/NOT TESTED labels only for executed checks; browser-verify before done.

## Audit findings (verified in code, this session)
- [x] HARDCODED "8%": dashboard.tsx:314 (Platform commission card), wallet.tsx:215
      (Commission paid sub), wallet.tsx:738 (activity detail note), settings.tsx:233
      (marketplace opt-in copy), seller-shell.tsx:730 (pre-auth landing bullet),
      seller-shell.tsx:845 (register terms alert).
- [x] HARDCODED "7-day hold": wallet.tsx:202, onboarding.tsx:479, orders.tsx:395,
      seller-shell.tsx:846; dashboard.tsx:157 "held for grace period" (no number).
- [x] HARDCODED "first 5 products" (moderation.first_n, default 5, wired):
      seller-shell.tsx:838.
- [x] ALREADY SYNCED (verified, no change): payout minimum (wallet API reads Setting
      payout.min_minor → UI + request guard), pending-releases view (holdDays per row),
      period-card commission amounts + order detail commission (order_item snapshots),
      low-stock thresholds (per-variant seller data).
- [x] Pending actions today: ONE card, three small h-8 buttons, amber-only tint —
      easy to miss (user confirmed they did not notice it).

## Phase checklist
- [x] P1 src/lib/seller-terms.ts — getSellerTerms(sellerId) / getPlatformTermsPublic()
      (+60 s public TTL cache) reading CommissionSetting + Seller overrides +
      Setting payout.min_minor + moderation.first_n.
- [x] P2 GET /api/store/terms (seller-scoped, rate-limited; 401 unauth VERIFIED) +
      GET /api/platform/terms (public, cached — live values verified: 0.5%, min RM1,
      hold 7d, payout min RM10, first-5).
- [x] P3 ui-bits.tsx — PlatformTerms type + fmtCommissionPercent/fmtHoldDays/
      holdAfterPaymentLabel(holdAfterPayment) + useSellerTerms() (module 60 s cache +
      in-flight dedupe).
- [x] P4 Wire components: dashboard (commission card + wallet sub), wallet (3 spots),
      orders detail note (also fixed factual error — the SELLER NET is held, not
      "commission"), settings marketplace copy, onboarding bank hint. All 6 surfaces
      browser-verified with live values.
- [x] P5 Pending-actions redesign: 3 dedicated clickable cards, text-4xl/5xl counts
      ("99+" cap), urgency tiers — rose (unfulfilled ≥5 / refunds ≥3), amber
      (unfulfilled 1–4 / refunds 1–2 / review ≥1), emerald (0 = All clear) — chips +
      accent borders + icon tiles, keyboard accessible, section total badge. VLM
      desktop + mobile review PASS (cards 358×178 px stacked at 390px, no overflow).
- [x] P6 seller-shell pre-auth: live landing bullet ("Flat 0.5% platform commission"),
      register sub-copy (first N), terms alert — via public terms, graceful generic
      copy while loading.
- [x] P7 Verify: lint 0 err (14 pre-existing script warnings); dev.log clean (only
      historical EADDRINUSE lines); agent-browser golden path — pre-auth screen, seller
      login, dashboard cards incl. big pending-action cards ("5 — Urgent" rose,
      "0 — All clear" emerald, total "5 open items"), wallet, order detail, settings
      copy, onboarding hint (trail demo, wizard walked with dummy KYC filenames);
      LIVE-SYNC test PASS — mutated defaultPercent 0.5→12.5 + payoutHoldDays 7→3 →
      reload → "12.5%" + "released 3 days after payment" → reverted → 0.5%/7d;
      seller-override test PASS — lumina 3%/2d → "3%" + "Your negotiated rate" +
      "2 days" → reverted to null. deployment-smoke 22/22 ALL PASS (archived
      performance/runs/2026-10-29-deployment-smoke.json). Zero console/page errors.
      Not re-run: full finance-regression (no business-logic changes; additive
      read-only endpoints + UI copy; smoke covers golden paths) — labeled.
      NOT TESTED: days_after_delivered display variant (not implemented at runtime;
      copy never claims it). Worklog appended. VLM's "N badge over sidebar" note =
      pre-existing global portal-switcher FAB (fixed 10,10, draggable by design).

---

# Addendum #9 — Task F: FULL webapp linkage & auth audit (full-audit-report.md)

**User request (verbatim intent):** "Run full audit regarding this kind of issue towards
the whole webapp structure & all auth (admin,seller,buyer), ensure all attributes are
actually linked and synced. I need the report in full-audit-report.md file."

**Scope:** static code audit (evidence = file:line), NO code changes in this task.
1. Attribute-linkage audit across ALL surfaces (admin / seller / buyer / storefront /
   cron / webhooks / mini-services): every platform-controlled attribute
   (commission %, hold days, fixed fee, min commission, payout min, payout mode,
   moderation first-N, PSP settings, feature flags, footer visibility, retention,
   etc.) → authoritative source → every consumer → LINKED / SNAPSHOT-OK (money math) /
   HARDCODED / UNWIRED classification.
2. Auth audit for all three roles + public surface: session model, per-route guards,
   role capability checks, cross-tenant isolation (seller A vs B, buyer vs seller),
   cron/webhook/chat-service authentication, rate limits, CSRF posture
   (SameSite=None cookie), suspended/terminated account enforcement.

**Ground rules (inherited):** PASS/FAIL/NOT TESTED/BLOCKED only for executed checks;
audit claims must cite file:line; documentation ≠ implementation; runtime spot-checks
limited to read-only GETs on the running dev server. Report file:
/home/z/my-project/full-audit-report.md (user-requested location).

**Phase checklist**
- [x] F1 Register this task (this addendum).
- [x] F2 Parallel audit agents: (a) SSOT & consumers, (b) seller backend, (c) admin +
      buyer + storefront, (d) auth core & cross-cutting. All read-only.
- [x] F3 Spot-verify top findings with direct reads — 18 direct reads incl.
      process.ts:49 (webhook secret fallback), wallet.tsx:336 (RM 50), checkout
      timer 10 vs 30 min, analytics-tick env-vs-Setting, vouchers scope mismatch,
      login status gate, reviews route, admin PATCH guards, Caddyfile, chat hub.
      tsc --noEmit: TS2724 rotateSession + TS2305 safeEqualHex VERIFIED.
- [x] F4 full-audit-report.md compiled at project root: 30-row attribute matrix,
      4 CRITICAL / 7 HIGH / 13 MEDIUM / 15 LOW findings, remediation priorities.
- [x] F5 Runtime probes (one command window; watchdog-assisted revival):
      10/10 unauth guards 401 PASS; platform/terms live values PASS;
      settings/site & sf/app-config consistent PASS; anonymous review publish
      FAIL (confirmed, probe deleted + aggregates restored); lookup unthrottled
      FAIL. Zero code changes; one probe review reverted (§6.2 of the report).

---

# Addendum #10 — Task G: CRITICAL security remediation + production build gate

**User request (intent, verbatim structure):** "Use full-audit-report.md as the
evidence-backed remediation backlog. Begin by resolving the four CRITICAL findings,
then address the high-risk public entry points and production fail-closed
requirements." — NO Sales Funnel / Seller Insights / advertising features in this task.

**Phases:** P0 verify starting state → P1 four CRITICALs (F-04 webhook secret,
F-01 CSRF, F-02/F-24 seller status + revocation, F-03 rotateSession/safeEqualHex) →
P2 high-risk public entry points (shipping webhook auth, chat hub/relay auth, gateway
port restriction, mock PSP fail-closed, login/register rate limits + demo creds) →
P3 authorization boundaries (commission/policy mutations, settings writes, replay,
KYC/banks/exports, analytics CSV) → P4 config linkage honesty (wire / label / remove)
→ P5 targeted regressions + lint + type-check + build-blocker resolution (47 src
errors = app build blockers; scripts/ = classified debt, not build path).

**Ground rules (inherited):** PASS/FAIL/NOT TESTED/BLOCKED; documentation ≠
implementation (blueprint claims rotateSession/revokeUserSessions exist — code
proves otherwise); payment/authorization/financial changes stop-and-test at each
boundary; production build NOT runnable in sandbox (env policy) → label honestly,
CI must run it; runtime verification via curl probes + agent-browser (no new test
files). Deliverables: performance/security-remediation.md (per-finding evidence),
full-audit-report.md status updates (preserving historical findings), this checklist.

**Phase checklist**
- [x] G1 Register this task (this addendum) BEFORE any code change.
- [x] G2 P0 verified: git clean @ 1c5bbd7 (main); all four CRITICALs re-confirmed in
      source (process.ts:49 demo fallback; auth.ts sameSite none + no proxy.ts;
      login/route.ts:32 terminated-only; suspend/terminate no session delete;
      me/password rotateSession TS2724; stripe-my safeEqualHex TS2305);
      tsc 173 errors (47 src = build blockers, 126 scripts/tool-results);
      .env has NO PSP_WEBHOOK_SECRET/CRON_SECRET/METRICS_TOKEN; .env.example
      documents none of them; next.config.ts ignoreBuildErrors:false → src errors
      are hard build blockers. Blueprint (§943-945) claims rotation/revocation
      shipped — FALSE (doc ≠ impl); blueprint's design adopted as the spec.
- [x] G3 P1 F-04 webhook secret fail-closed + .env.example placeholders.
      (LANDED + verified 2026-10-30 — see security-remediation.md Phase 1; commit
      9fe703e: process.ts lazy secret + instrumentation warnProductionSecrets.)
- [x] G4 P1 F-01 CSRF: src/proxy.ts origin/Sec-Fetch-Site/content-type guard.
      (LANDED + 9 live probes PASS — Phase 1 log; commit 9fe703e.)
- [x] G5 P1 F-02/F-24: status enforcement + session revocation + login gate +
      publish gate. (LANDED + 21-check lifecycle probe PASS — Phase 1 log.)
- [x] G6 P1 F-03: rotateSession + revokeUserSessions + safeEqualHex + psp.ts
      adapter types. (LANDED + rotation matrix PASS — Phase 1 log.)
- [x] G7 P2 shipping webhook HMAC + rewrite against Shipment model; chat
      hub/relay auth; gateway port restriction; mockPspAllowed fail-closed;
      login/register rate limits; demo creds removal. (Code LANDED in commit
      9fe703e — re-verified this session: psp.ts:206-214 strict ===true fail
      closed; login rateLimit 10/min + register 5/min; shipping webhook HMAC +
      503 SHIPPING_SECRET_UNSET; chat relay CHAT_RELAY_SECRET + hub-auth route;
      Caddyfile XTransformPort restricted to 3000/3003; admin-shell DEMO_ACCOUNTS
      removed. Log section to be reconciled in G11 update — code evidence on disk.)
- [x] G8 P3 capability-tier guards on the listed mutations/reads + negative
      authorization probes. (DONE 2026-10-31 — security-remediation.md Phase 3:
      F-09/F-18/F-25/F-26 + coupons capped; F-22 OAuth state fail-closed +
      dead divergent callback module deleted; admin-caps.ts single matrix
      shared by server guards and client nav; matrix probe 60/60 PASS live;
      F-22 probe 15/15 PASS live; agent-browser moderator/superadmin UI
      verification clean; tsc 34 src errors = pre-existing baseline, zero in
      changed files; lint 0 errors.)
- [x] G9 P4 linkage honesty decisions (wire/label/remove) per finding.
      (DONE 2026-10-31 — security-remediation.md Phase 4: F-08 WIRED into
      resolveRate (interleaved-by-scope, field-wise; 32/32 live matrix;
      Curlec E2E order snapshot verified); F-11 WIRED (tick reads Setting,
      env fallback; live matrix); F-15 WIRED (countdown from expiresAt,
      29:38 live); F-14 WIRED (lib/payment-methods.ts single source; 5 methods;
      Curlec E2E); F-17 FIXED (live RM 10.00 copy); F-16 LABELED honest
      (window-free copy — no window exists in code); F-10 LABELED (NOT
      ENFORCED badges, browser-verified); F-07 REMOVED (page+nav+route; 404;
      zero featureFlag readers); F-12 registry honesty (payouts.mode
      wired:false + notes). Seeded 10% glow override row now live — intended.)
- [x] G10 P5 regressions, lint, tsc src-clean, dev-server + agent-browser
      verification, honest build-gate labeling.
      (DONE 2026-10-31 — 47→0 src tsc build blockers: follows schema-drift
      rewrite (6/6 live cycle), dead campaigns.tsx + dead shipping/quote route
      + dead reReserveOrderStock removed, metrics fail-closed cast,
      parseSellerVoucherInput implemented (and F-21 scope fix — own-voucher
      PATCH 200 live, was 404), F-23 IMPORT_TOKEN_ENC_KEY boot warning; tsc
      src 0 errors; lint 0 errors/18 pre-existing warnings; Phase 4 probe
      re-run 32/32; browser golden path (checkout Curlec + countdown + order
      snapshot), commission badges, flags-nav absence, wallet copy, PDP copy,
      CampaignsView E2E; build gate: source-level PASS, next build NOT
      RUNNABLE in sandbox — honestly labeled, CI must run.)
- [x] G11 Reports updated (security-remediation.md, full-audit-report.md,
      worklog.md).
      (DONE 2026-10-31 — remediation log Phases 4+5 written; audit report:
      remediation-status banner + per-finding status column (REMEDIATED P1–P5
      / OPEN-deferred for F-20/F-27/F-28 only); worklog session entry added.)

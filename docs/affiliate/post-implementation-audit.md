# NOMOFEE Affiliate System — Post-Implementation Audit

**Audit date:** 2026-10-31
**Auditor:** Independent post-implementation audit (code-level, first-hand verification of every significant finding)
**Baseline audited:** repository `povemy/nomofeev22` @ `915aba8` (post Pull & Replace), Supabase Postgres schema as of the audit date, plus the fixes applied during this audit (each marked **[FIXED-this-audit]**).
**Method:** every requirement below was verified against the ACTUAL code (file + function), schema (model + field), and — where marked — against live runtime execution (HTTP requests against the running dev server and the live database). The prior implementation report was treated as evidence of intent, never as proof of correctness.

**Classification legend:**
- ✅ **Verified** — implemented and correct (evidence cited)
- 🟡 **Needs improvement** — implemented, works, but below spec quality
- 🟠 **Incomplete** — partially built
- 🔴 **Defective** — incorrect behaviour found
- ⚪ **Deferred** — deferred by design (user direction)
- ⛔ **Blocked** — blocked by legal/operational requirements

---

## 1. Executive summary

The affiliate implementation is **substantially sound**: the money path (checkout snapshot → payment posting → ledger T1 → lifecycle → payout → refund reversal → reconciliation) is real, invariant-checked, idempotent and correctly wired into the existing financial engine. The audit found **four genuine defects** (all fixed in this pass), **one high-priority policy gap** (sponsor-override determinism — fixed), **one rounding-policy contradiction** (fixed to the normative floor policy), and **one scope deferral to implement** (collections/showcase gating — implemented non-destructively). The migration folder was regenerated into a clean, reproducible, forward-only chain and proven in a clean-room disposable database (three times).

All fixes were surgical; no working financial logic was rewritten beyond the specific defect sites.

### Defects found and fixed in this audit

| # | Defect | Severity | Site | Fix |
|---|---|---|---|---|
| D1 | Sponsor-override eligibility read from the LIVE setting at payment posting — a settings change between checkout and payment silently rewrote an in-flight order's compensation arrangement | HIGH (violated the frozen-policy requirement) | `postAffiliateCommissionsForOrder` (src/lib/affiliate.ts L399 pre-fix) | **[FIXED]** `OrderItem.affiliateSponsorEnabled Boolean?` frozen at checkout (`api/checkout/create`), consumed at posting; NULL on legacy rows falls back to live setting. Migration `20261031000000`. Runtime-proven by the P3-freeze E2E (16/16): flip OFF before payment ⇒ order keeps 90/10 (direct=801/sponsor=89/pool=890); new checkout after flip ⇒ D=P, no sponsor entry |
| D2 | Pool rounding used half-up (`divHalfUp`) while the normative commission-definitions §9 mandates floor — one-sen drift, and the prior report itself was internally contradictory ("floor … half-up") | HIGH (documented policy violation) | `affiliatePoolMinor` (src/lib/affiliate.ts L114 pre-fix); same drift in the reversal proportional steps and the discover-page estimate | **[FIXED]** one canonical FLOOR policy: `P = floor(B×R/10^4)`; reversal item step `floor(alloc×P/gross)`; entry-split sponsor floor / direct residual; discover estimate clamped + floor via `affiliatePoolMinor` itself. Edge-case suite `scripts/test-affiliate-rounding.ts` (RM0.01…RM99.99 × 8 rates + divergence cases): ALL PASS |
| D3 | Reversal split assigned the rounding residual to the SPONSOR (`dRev=floor-proportional, sRev=residual`) — the normative doc §7.3 and the forward split both put the residual on DIRECT | MEDIUM | `reverseAffiliateForRefund` entry-split (first floor-fix attempt) | **[FIXED]** `sRev = floor(itemRev×S/P)`, `dRev = itemRev − sRev`. Runtime-proven: 50% refund of the 1990-sen pool ⇒ 896(direct, live) + 99(sponsor, paid→recovery) = 995 — spec §11 exact |
| D4 | Phantom relation: the public collection route includes `affiliate` on `AffiliateCollection`, but the schema never declared that relation (nor the DB FK) — the route would throw the moment the deferred collections feature is re-enabled | MEDIUM (latent runtime break) | `api/affiliate/pub/collection/[slug]/route.ts` vs schema | **[FIXED]** relation + FK declared (migration `20261031000001`); clean-room tested; tsc src/** now 0 errors |
| D5 | `trackReferralVisit` prior-touch check ignored `consumedAt` — a CONSUMED touch (already used by one activation) blocked a fresh referral attribution for a different visitor on the same browser, silently losing the new sponsor's attribution | MEDIUM (edge case: shared device) | `trackReferralVisit` (src/lib/affiliate-attribution.ts) | **[FIXED]** prior check now requires `consumedAt: null`; already-activated users keep their locked sponsor either way |
| D6 | `cron/affiliate-tick` payload referenced a non-existent `auth.by` field (tsc error, latent observability bug) | LOW | `api/cron/affiliate-tick/route.ts` | **[FIXED]** `authMode: auth.mode` |
| D7 | Admin commissions route GET: untyped empty-array branches (tsc errors) | LOW | `api/affiliate/links/route.ts` | **[FIXED]** explicit row types |

### Pre-existing limitations confirmed but NOT fixed (out of scope / documented)

- `scripts/fin-tests.ts` imports ~18 money helpers (`bpsOf`, `mulDivRound`, …) that do not exist anywhere in the tree — the legacy unit suite cannot execute. Documented as pre-existing drift in the prior report §17. Repairing it would mean inventing a new financial API surface (out of the no-rewrite mandate). Status: **Blocked (pre-existing)** — the financial invariants it used to guard are instead re-proven by `scripts/readiness/finance-regression.ts` (PASS), `scripts/verify-ledger.ts` (ALL PASS) and the affiliate E2E chain.
- Session tokens are stored raw (not hashed at rest) — a documented docs/code discrepancy (blueprint F-09 claims hashing). Preserved as-is; changing session representation is outside this mission's scope.

---

## 2. Requirement-by-requirement audit

### A. Registration, identity, profile

| Requirement | Status | Evidence |
|---|---|---|
| Shopper self-activation, auto-approve (no admin gate) | ✅ | `POST /api/affiliate/activate`; `AffiliateProfile.status @default("active")`; E2E stage 1 ✔ |
| Versioned terms acceptance | ✅ | `termsVersion/termsAcceptedAt`; server constant `AFFILIATE_TERMS_VERSION = 1`; terms TEXT itself ⛔ (rollout gate 2 open — no terms page exists yet) |
| Display-name-only public identity | ✅ | network API projection (`/api/affiliate/network`) — displayName/slug/status/activatedAt only |
| Concurrent activation → exactly one profile | ✅ | tx re-check + `ALREADY_AFFILIATE` 409; E2E ✔ ("sponsor relationship locked") |
| Suspension/reinstatement (reason, audited) | ✅ | `accounts/[id]/status`; reason ≥10 chars; `auditAdmin` |
| Profile/display-name editing endpoint | 🟠 | Not present (known gap in prior report §16.2 — read-only showcase identity). Left as-is: showcase surfaces are now deferred (P2), lowering priority |

### B. Seller opt-in, rates

| Requirement | Status | Evidence |
|---|---|---|
| Store opt-in `affiliateOptIn` default false | ✅ | schema L248; backfill-safe |
| Store default rate `affiliateDefaultRateBps` | ✅ | (the plan's `defaultRateBps` name divergence resolved in code as `affiliateDefaultRateBps`) |
| Per-product override (`affiliateEnabled`, `affiliateRateBps`) | ✅ | product beats store; `effectiveAffiliateRateBps` |
| Platform max-rate clamp BEFORE pool | ✅ | `effectiveAffiliateRateBps` `min(rate, maxRateBps)`; E2E enrolment at 10% ✔ |
| Opt-out future-only | ✅ | attribution resolution re-checks enrolment per checkout; frozen history untouched |
| Seller Centre programme UI + report | ✅ | `components/seller/affiliate.tsx` (3 tabs); `/api/store/affiliate*` |

### C. 90/10 model (P3 — high priority)

| Requirement | Status | Evidence |
|---|---|---|
| One sponsor max, self-FK | ✅ | `AffiliateProfile.sponsorId` nullable self-FK |
| Unlimited direct referrals | ✅ | E2E + scale probe (2,000 referrals under one sponsor, index-backed) |
| First valid sponsor touch wins, 30-day window | ✅ | `trackReferralVisit` first-touch + `AffiliateReferralTouch.expiresAt` (setting `sponsor_window_days`, default 30) |
| Sponsor permanently locked post-activation | ✅ | No mutation path except audited `correctSponsor` (`AffiliateSponsorAudit`); re-activation 409 E2E ✔ |
| No self-sponsorship | ✅ | `profile.userId !== input.userId` check + `SELF_REFERRAL` on manual code |
| No cycles | ✅ | Sponsors must pre-exist active (temporal ordering); admin correction walks up the chain (`SPONSOR_CYCLE` 409) |
| No automatic reassignment | ✅ | None exists |
| **Exactly one level; ≤2 beneficiaries per OrderItem** | ✅ | `@@unique([commissionId, role])`, roles exactly `direct|sponsor`; posting code creates ≤2 entries |
| No second-generation payout | ✅ | Posting reads `item.affiliateSponsorId` (the DIRECT affiliate's sponsor) only — never the sponsor's sponsor. E2E: A(sponsor of B) receives 10% of B's sale; no A-upward line |
| No recruitment-only / click rewards | ✅ | Money only via paid OrderItem pools |
| **Policy frozen at checkout; payment applies the FROZEN policy** | ✅ **[FIXED-this-audit D1]** | `OrderItem.affiliateSponsorEnabled` written at checkout; posting consumes it (NULL legacy fallback). Runtime: P3-freeze E2E 16/16 — see §1 D1 |
| Sponsor status at posting decides pending vs held ONLY (never who the beneficiary is) | ✅ | `sponsors.get(id).status` → held `sponsor_under_review` vs pending; beneficiary identity always the checkout snapshot |
| Override OFF at checkout ⇒ direct receives 100% for that order | ✅ | P3-freeze E2E step 5: D=P=890, no sponsor entry |
| `affiliate.sponsor_enabled=false` in production until legal | ⛔/✅ | Default false in registry + code DEFAULTS; sandbox demo rows enable it for verification (documented); legal gate open (rollout checklist §1) |

### D. Formula & rounding (P4 — high priority)

| Requirement | Status | Evidence |
|---|---|---|
| `P = floor(B × R / 10^4)`, integer sen | ✅ **[FIXED-this-audit D2]** | `affiliatePoolMinor` now floor; edge suite ALL PASS |
| `S = floor(P×10/100)`, `D = P−S`, `D+S=P` always | ✅ | `splitAffiliatePool`; E2E M1: 1791+199=1990 ✔; edge suite ✔ |
| No sponsor ⇒ `D=P, S=0` | ✅ | E2E: NM-103662 D=890=P ✔ |
| Allocations never exceed pool | ✅ | Construction + caps; edge suite asserts `D≤P ∧ S≤P` across all cases |
| Identical rounding across checkout/posting/ledger/reversal/reports | ✅ **[FIXED-this-audit]** | All sites now floor: checkout snapshot (`affiliatePoolMinor`), posting (reads frozen pool), ledger (posts frozen pool), reversal (`floor` steps + **D3 fix** residual-to-direct), discover estimate (clamped + floor); reconciliation recomputes from stored values |
| Edge amounts tested (RM0.01…RM99.99, uneven divisions) | ✅ | `scripts/test-affiliate-rounding.ts`: 8 amounts × 8 rates + divergence detectors (e.g. 9 sen × 500 bps ⇒ floor 0 vs half-up 1) — ALL PASS |
| Documented single policy | ✅ | This audit + updated implementation-report: **FLOOR everywhere in the affiliate path; the platform commission's own percent part keeps its historical half-up (separate ledger line, out of affiliate scope)** |

### E. Commissionable base & settlement invariant (P5 — high priority)

| Requirement | Status | Evidence |
|---|---|---|
| `B = lineSubtotal − sellerFundedDiscount` (excl. shipping/tax/platform fees) | ✅ | `computeOrderCommissions`: `affBase = max(0, lineSubtotal − discounts[i])`; `breakdown.affiliate_base` frozen in `breakdownJson` |
| Vouchers reach the ledger before commission math (correct base) | ✅ | Checkout computes commissions on VOUCHER-ADJUSTED totals (`applyVoucherOutcomesToGroups` → `computeOrderCommissions`) |
| `sellerNet + platformCommission + affiliatePool = orderTotal` | ✅ | `reconcileSplits` at checkout + `postTransaction` LEDGER_UNBALANCED guard + admin `invariantOk`; runtime: reconciliation E2E `invariantOk=true`; `verify-ledger` 431 txns ALL PASS |
| Affiliate pool carved from seller proceeds (not buyer surcharge) | ✅ | `sellerNet = gross − commission − affiliatePool`; buyer pays identical price with/without attribution |
| Platform-funded discounts/vouchers NOT in affiliate base | ✅ | Base subtracts the discount allocation regardless of funding side — the seller-recognised merchandise value; no invented values (verified against voucher outcome shapes) |
| `PLATFORM:AFFILIATE_LIABILITY` distinct liability account | ✅ | `ledger.ts` account; T1 4th line CR; never platform revenue; never in seller wallet |
| Unattributed orders keep 3-line T1 | ✅ | 4th line only when pool > 0 |

### F. Refund reversals (P5)

| Requirement | Status | Evidence |
|---|---|---|
| Order-level allocation proportional to customer-paid gross | ✅ | `reverseAffiliateForRefund` grossArr = subtotal − discount + shipping alloc (mirrors FIN-3a family) |
| `aRev_i = min(floor(alloc_i×P_i/gross_i), P_i−alreadyReversed_i)` double clamp | ✅ **[FIXED-this-audit D2]** | per-item min + order-level `min(total, refundAmount, remainingReversible)` |
| Entry split honours frozen 90/10; direct absorbs residual | ✅ **[FIXED-this-audit D3]** | E2E: 896/99 on 995 — spec §11 exact |
| Full refund reproduces stored composition | ✅ | alloc=gross ⇒ floor(P)=P (edge suite) |
| Combined reversals never exceed original allocation | ✅ | `remainingReversible` via `priorAffiliateReversalMinor` (Σ processed refunds' `Refund.affiliateReversalMinor`) |
| Late refund after payout: paid stays paid, recovery offsets future | ✅ | E2E: sponsor entry `st:'paid'` with rev 99 — recovery semantics; `requestableMinor = max(0, available − recovery)` |
| Shipping-only refunds: no product reversal | ✅ | Pool base excludes shipping by construction |
| Duplicate refund idempotent | ✅ | Refund status conditional claim + T5 dedupKey `refund:refund:{refundId}` (runtime: deployment-smoke C5 duplicate-webhook converges) |
| Pre-affiliate rows: zero reversal, no fallback | ✅ | `if (!commission) continue` — legacy path |
| Never silently debit affiliate bank account | ✅ | No such code path exists; runbook §3 documents the manual-transfer-only posture |

### G. Lifecycle (P6)

| Requirement | Status | Evidence |
|---|---|---|
| pending → approved → available → paid (+ held/reversed) | ✅ | Entry statuses; E2E stage 2 lifecycle ✔ (matured to available via cron tick) |
| Approval keyed on authoritative delivered/completed — NOT carrier timestamps | ✅ | `transitionOrder` states; deliver/receive routes + cron sweep; mock carrier rails documented non-authoritative |
| Review window `affiliate.review_days` configurable (default 14) | ✅ | Setting; `availableAt = approvedAt + reviewDays`; sandbox demo row uses 0 for E2E speed (documented) |
| Held cannot accidentally mature | ✅ | Sweep matures `status:"approved"` only; hold sets distinct status |
| Admin release establishes a FRESH review window | ✅ | Release sets `approved + new availableAt` (prior defect #4 fix retained, verified in code) |
| Same release conditions for direct & sponsor unless beneficiary-specific hold | ✅ | Hold applies to both roles' un-paid entries; sponsor-under-review holds only the sponsor share |

### H. Payouts (P7)

| Requirement | Status | Evidence |
|---|---|---|
| Manual bank transfer only | ✅ | `method:"manual_bank"`; no PSP payout wiring (correctly NOT claimed) |
| Available-balance derivation correct | ✅ | Ledger-lines truth; entries-based buckets; E2E payout 1089 sen = 890+199 ✔ |
| Pending not withdrawable | ✅ | Claim filters `status in [approved,available] AND availableAt <= now AND payoutId null` |
| One open request per affiliate | ✅ | In-tx re-check (E2E-verified in the original harness) |
| Min threshold respected | ✅ | `BELOW_MIN_PAYOUT` |
| Atomic claims | ✅ | `payoutId` binding in tx |
| Failed payouts release claims | ✅ | `fail` → T-A4f + payoutId cleared → available |
| Paid requires genuine reference | ✅ | 400 `REFERENCE_REQUIRED` on empty; E2E mark-paid with E2E-BANK-001 ✔ |
| Duplicates/retries cannot pay twice | ✅ | State-machine conditional claims + per-payout ledger dedup keys |
| Statement matches claimed entries | ✅ | `statementJson` built at request time from the claimed rows; `-3b` verified `statementBuilt:true` |
| Admin adjustments audited | ✅ | `auditAdmin` on every process/hold/status route |
| Recovery cannot create negative/duplicate liabilities | ✅ | `max(0, …)` offset at request time; T-A4f releases exactly once |
| **Payout runbook written** | ✅ **[NEW-this-audit]** | `docs/affiliate/payout-operations-runbook.md` (verification, review, transfer, authorisation, failure, reconciliation, recovery, fraud, SoD) — rehearsal still ⛔ pending (launch gate) |

### I. Attribution & links (P2 scope)

| Requirement | Status | Evidence |
|---|---|---|
| First-party tracking, httpOnly `nm_ins_vid`, no PII | ✅ | `resolveInsightsIdentity`; 365-day visitor cookie |
| Product-sale attribution: LAST eligible click per (visitor, product), 30-day | ✅ | `resolveAffiliateAttributionForCart` (≤200 unexpired touches, desc, first scope match) |
| Registration attribution: FIRST touch, 30-day, consumed once | ✅ | `trackReferralVisit` + consume-on-activate; **[FIXED-this-audit D5]** consumed-touch prior check |
| Link codes: 96-bit random, unique, fail-closed | ✅ | `randomToken(12)` hex; `@@unique`; 404 no-oracle |
| Product/store links functional | ✅ | E2E: links created, tracked, attributed, paid ✔ |
| **Channel metadata optional; never required; never commission-relevant** | ✅ | `LinkCreateDialog` channel defaults "other", always submittable; server coerces invalid → "other"; channel is reporting-only (snapshot on commission rows); no approval workflow exists |
| **Collections & showcase deferred non-destructively** | ✅ **[NEW-this-audit]** | Separate gates `affiliate.collections_enabled` / `affiliate.showcase_enabled` (default OFF, registry-rendered); creation/publishing/expanding PATCH fail closed 403; new collection/showcase links rejected 403; archived links cannot be reactivated while gated; public pages + link tracking fail closed (`found:false` / LINK_NOT_FOUND) with no private-data leak; schema/data/history preserved (GET remains readable for owners); runtime curl-verified |
| No coupons/tiers/invitations/pay-per-post/platform bonuses | ✅ | None exist (confirmed by search) |

### J. Fraud & security

| Requirement | Status | Evidence |
|---|---|---|
| Rate limits (activation 5, links 30, track 60, payout 3, admin 30) | ✅ | `rate-limit-affiliate` per-account/IP keyed; 429 with retryAfter |
| Kill switch `affiliate.enabled` | ✅ | E2E: disabled ⇒ no attribution touch recorded; links still navigate; re-enable resumes; checkout stops snapshotting; posting returns 0 |
| Self-purchase exclusion | ✅ | `affiliate.userId === shopperId` filter in cart resolution |
| Session-scoped queries; no cross-affiliate leak | ✅ | E2E: A's earnings exclude B's rows ✔ |
| Server-side sponsor assignment only | ✅ | Activation body has no sponsor field effect beyond validated one-time code |
| Admin caps `affiliate.manage` (superadmin+ops) / `affiliate.finance` (superadmin+finance) — separated | ✅ | `admin-caps.ts`; routes gate accordingly (commissions: either; payouts/reconciliation: finance; accounts/hold: manage) |
| No MFA exists (documented platform posture) | ℹ️ | None found; unified login preserves the existing password re-verification pattern for sensitive ops (logs.purge) — nothing weakened |

### K. Migration & reproducibility (P8)

| Requirement | Status | Evidence |
|---|---|---|
| Reproducible forward-only migration chain | ✅ **[FIXED-this-audit]** | `20261030000000_affiliate_system_baseline` (430-line drift DDL captured from `migrate diff --from-migrations --to-schema-datamodel`), `20261031000000` (sponsor-policy snapshot column), `20261031000001` (collection→profile FK). Baseline marked applied via `migrate resolve` (no destructive re-run) |
| Clean-room reproducibility tested | ✅ | THREE independent clean databases deployed from scratch (migtest, migtest2, perftest): all migrations apply, re-run idempotent (`No pending migrations`), `migrate diff --from-url --to-schema-datamodel` = EMPTY (perfect parity) |
| No data loss on live deploy | ✅ | Live DB: baseline resolve + single additive column deploy; affiliate rows and all business data intact afterwards (counts verified) |
| No destructive statements in generated DDL | ✅ | Grep-verified: zero DROP/TRUNCATE/DELETE |
| Production deployment sequence documented | ✅ | See `post-implementation-verification.md` §6 |

### L. Admin usability (P9)

| Requirement | Status | Evidence |
|---|---|---|
| Server-side order-number search | ✅ **[FIXED-this-audit]** | `?orderNumber=` contains-insensitive; browser-verified (12 → 1 commission, scope totals update) |
| Store filter | ✅ **[NEW]** | `?storeId=` + Select fed by `/api/admin/stores` |
| Affiliate filter | ✅ | Pre-existing (`affiliateId`, deep-link from accounts) |
| Date range filter | ✅ **[NEW]** | `?from=&to=` |
| Status filter | ✅ | Pre-existing, validated enum |
| Pagination server-side | ✅ | Pre-existing |
| Correct scope totals | ✅ **[NEW]** | SQL `aggregate` over the FULL filter scope (`totals.poolMinor/baseMinor`), echoed filters; UI shows "Scope: N commissions · Pool RM … · Base RM …" |
| Query-efficient (no full-table browser loads) | ✅ | All filtering/pagination/aggregation server-side in SQL |

---

## 3. Cross-document divergence reconciliation (auditor watchlist)

| # | Divergence (docs vs docs / docs vs code) | Resolution |
|---|---|---|
| 1 | Rounding: defs §9 floor vs report §7 "half-up" | Code WAS half-up → **defect D2, fixed to floor** (defs is normative) |
| 2 | Caps: `affiliate.manage` alone vs + `affiliate.finance` | Code: BOTH exist, correctly separated (15 caps total — the count discrepancy was doc-level only) |
| 3 | Kill-switch breadth: "every route 403" vs "links still resolve" | Code: links still NAVIGATE but stop recording (fail-closed attribution); hub APIs 403/paused — the security-relevant behaviour is fail-closed; doc wording harmonised in the updated report |
| 4 | Snapshot column sets (plan vs report naming) | Code is authoritative: `OrderItem.affiliate{DirectId,SponsorId,LinkId,RateBps,PoolMinor}` (+ **SponsorEnabled** this audit); `AnalyticsEvent.affiliate{Id,LinkId}` |
| 5 | Link URL params | As-built family confirmed: `?al=` (link), `?ref=` (join), `?aff=`/`?affc=` (deferred public pages) |
| 6 | Adjustment recipe (defs §8.5) not built | Confirmed NOT implemented — recorded 🟠 Incomplete (audited manual reconciliation covers the interim; recipe remains a finance-tooling TODO) |
| 7 | `affiliate.max_public_collections` setting | Not implemented (moot while collections deferred) |
| 8 | Migration status "db push only" | **Fixed this audit** (§2.K) |
| 9 | "10k affiliates" performance claim | No doc ever claimed it; this audit adds the first honest scale evidence (§4) |
| 10 | Doc lineage (6 vs 10 defects, "never existed" vs "interrupted implementation") | Historical; git history is the record. This audit adds 7 more findings (D1–D7) on top of the report's 10 |

---

## 4. Performance & scale evidence (P10)

**Class of evidence: LOCAL-DEV SANDBOX against a DISPOSABLE Supabase database — NOT production capacity.** All latencies include ~35–40 ms sandbox→pooler network RTT.

- Dataset: 2,001 synthetic shoppers + 2,001 affiliate profiles (one mega-sponsor with 2,000 direct referrals) + 400 synthetic entries — created and destroyed inside a disposable database (`nomofee_perftest`), never in the dev/shared database. Seeding: 1.88 s.
- Referral-code lookup (`findUnique` by `code`, unique index): ~39 ms round-trip ≈ RTT-bound.
- Network pagination, 20 rows/page over 2,000 referrals: min 39.3 / median 39.5 / max 77.2 ms; **deep page (skip 2,980) = 39.6 ms — no pagination degradation**.
- Earnings `groupBy` over the sponsor's entries: 85.6 ms.
- `EXPLAIN` on the network query: **Index Scan using `AffiliateProfile_sponsorId_idx`** (no sequential scan); top-N sort of 20 rows.
- Registration writes during E2E: single-row inserts, no contention observed.
- Structural scale analysis (code review): posting is 1 sponsor lookup + ≤2 inserts per attributed item inside the existing payment transaction; commission/balance queries are per-affiliate bounded (`[beneficiaryAffiliateId, status]`, `[status, availableAt]` indexes); dashboard `hubOverview` aggregates per-affiliate; the cron sweep is batched (50 orders/tick). No recursive traversal anywhere.
- 10,000-affiliate influencer scenario: structurally supported (flat one-level network; all hot paths index-backed and per-sponsor bounded). **Not load-tested at 10k in this sandbox** — deliberately, per the mission's guardrail against overloading the shared environment. Remaining risk to verify in staging: sustained concurrent checkout bursts share the platform-wide checkout capacity (already covered by the existing checkout-capacity suite, out of affiliate scope).

---

## 5. Remaining blockers (unchanged unless noted)

1. ⛔ **Legal (KPDN / Direct Sales and Anti-Pyramid Scheme Act 1993 opinion)** — `affiliate.sponsor_enabled` stays FALSE in production until documented clearance. (Technical capability verified with the gate ON only in sandbox.)
2. ⛔ Affiliate terms text + version bump + public terms page (rollout gate 2).
3. ⛔ Payout runbook rehearsal incl. deliberate fail-path + finance sign-off (gate 3) — runbook itself now written ✅.
4. ⛔ Staging E2E + sign-off register (gate 4) — sandbox E2E is NOT staging.
5. ⛔ Production deployment of the migration chain (sequence documented; not executed against any production environment — there is none yet).
6. ⛔ Settings baseline snapshot + monitoring cadence + kill-switch drill (gates 5–7).
7. 🟠 Adjustment recipe (defs §8.5) tooling.
8. 🟠 Legacy `scripts/fin-tests.ts` unrunnable (pre-existing drift; superseded by readiness suites).

## 6. Verdict

The affiliate system is **implementation-complete and internally consistent for a sandbox/staging posture**, with all audit defects remediated and re-verified at runtime. It is **NOT production-ready** — the launch gates above (legal, terms, runbook rehearsal, staging sign-off, production migration execution, monitoring) remain open, exactly as the rollout checklist requires.

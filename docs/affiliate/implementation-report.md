# Affiliate System — Implementation Report

**Date:** 2026-10-30 · **Scope:** complete NOMOFEE Affiliate System + one-level sponsor referral (90/10 split)
**Authoritative companions:** `commission-definitions.md` (money rules), `security-and-fraud-rules.md` (controls), `rollout-checklist.md` (launch gates), `architecture-audit.md` + `implementation-plan.md` (pre-build audit/plan).

## 1. Initial architecture audit

Phase 0 was executed against the live tree (three parallel read-only audits: backend, frontend, docs/schema/config). Headline findings: datasource is **Supabase PostgreSQL** (not SQLite — `db/custom.db` is a stale leftover); 13 subsystems reusable as-is, 7 reusable-with-extension; the affiliate footprint (10 Prisma models, 26 route files, 3 lib modules) already existed from an interrupted implementation, with the entire shopper-side Affiliate Hub UI and admin console missing, plus six backend defects (below). No fabricated order states, refund signals or payout capabilities were assumed: no PSP payout exists (manual-only), carrier delivery timestamps are not authoritative (delivery confirmation is the completion evidence).

## 2. Reused systems (and why)

| System | Reuse |
|---|---|
| Sessions/auth (`lib/auth.ts` — cookie+Bearer, `requireShopper`) | Affiliate = shopper identity; no new auth plane |
| Settings registry (`Setting` rows) | Programme kill switch + 6 limits; rendered in admin System → Settings |
| RBAC caps (`admin-caps.ts`) | `affiliate.manage` / `affiliate.finance` gate all admin routes |
| Immutable ledger (`lib/ledger.ts`) | Distinct `PLATFORM:AFFILIATE_LIABILITY` account; T1 4-line, T5 reversal, T-A3/A4/A4f payout recipes; `dedupKey` idempotency |
| Payment webhook pipeline | Commission posting runs inside the Serializable claim tx (exactly-once) |
| Analytics identity (`nm_ins_vid`) | Attribution touches keyed to the same first-party visitor cookie |
| Seller settlement (`lib/commission.ts`) | `sellerNet = gross − platformCommission − affiliatePool` at checkout |
| Cron scheduler (`mini-services/expiry-scheduler`) | `affiliate-tick` registered as 4th tick (30 s cadence) |

## 3. Database models (10 new + extensions)

`AffiliateProfile` (code/slug unique, self-FK sponsor, terms version), `AffiliateSponsorAudit`, `AffiliateReferralTouch` (first-touch 30 d), `AffiliateLink` (product/store/collection/showcase + channel), `AffiliateCollection`/`AffiliateCollectionItem` (versioned), `AffiliateAttributionTouch` (per-scope last-click, 30 d), `AffiliateCommission` (unique orderItemId; frozen base/rate/pool; productId/linkType/channel snapshot), `AffiliateCommissionEntry` (unique commissionId+role; direct|sponsor; lifecycle+holds), `AffiliatePayout` (manual state machine + ledger-derived `statementJson`).
**Extensions:** `Store.affiliateOptIn/affiliateDefaultRateBps`, `Product.affiliateEnabled/affiliateRateBps`, `OrderItem.affiliate{DirectId,SponsorId,LinkId,RateBps,PoolMinor}` (checkout snapshot), `Refund.affiliateReversalMinor`, `AnalyticsEvent.affiliateId/affiliateLinkId`.
**Relations added during completion:** `AffiliateCommission.affiliate/.order`, `AffiliatePayout.affiliate`, `AffiliateCollectionItem.product` (read-model joins). Schema pushed to Supabase via `prisma db push` (migrations folder not regenerated — see §19).

## 4. API routes

**Affiliate (shopper):** `/api/affiliate/{activate,me,overview,discover,links,links/[id],collections,collections/[id],network,earnings,payouts,track,track-referral,pub/showcase/[slug],pub/collection/[slug]}` — session-scoped, rate-limited, no buyer PII.
**Seller:** `/api/store/affiliate` (settings/report) + `/products` + `/products/[id]` — `requireActiveSellerStore`.
**Admin:** `/api/admin/affiliate/{overview,accounts,accounts/[id],accounts/[id]/status,accounts/[id]/sponsor,commissions,commissions/[id]/hold,payouts,payouts/[id]/process,reconciliation}` — cap-gated, audited, manual-payout-only wording.
**Cron:** `/api/cron/affiliate-tick` (POST cron-auth; GET status now cron-auth too).

## 5. UI sections

**Affiliate Hub (shopper surface, new):** bottom-nav "Earn" + Me-hub entries; guest/activation gate (terms + permanent-sponsor confirmation + one-time code entry); tabs Overview (estimated-vs-ledger badges, 30/60/90), Discover (filters + per-card link creation), Links (4 types, channel labels, copy URLs, click stats, archive), Collections (CRUD, reorder, publish, scope-versioned), Showcase (public-page manager), Network (direct-only), Earnings (90/10 segmented), Payouts (9-bucket balances, request, history). **Public views:** `?aff=slug` showcase, `?affc=` collection, `?al=` link landing (server-tracked), `?ref=code` join attribution — all clearly labelled "affiliate recommendations, not a store".
**Seller Centre:** Programme/Products/Report tabs (opt-in, default rate ≤ platform cap, per-product override/pause, 30-180 d performance + liability).
**Admin console (new):** Programme (read-only settings + KPIs + launch-gate callout), Accounts (status actions, audited sponsor correction by code), Commissions (hold/release with reason), Payouts (manual bank-transfer state machine), Reconciliation (7-point + ledger invariant + CSV/JSON copy).

## 6. Attribution rules implemented

Registration: **first valid referral touch wins** (30 d cookie-backed, consumed exactly once at activation, locked forever, admin correction audited). Product sales: **last eligible click per product** (30 d, per-OrderItem; scopes product/store/collection-snapshot/showcase-restricted), self-purchase blocked, seller eligibility re-validated at checkout, frozen on `OrderItem`. Campaign/UTM attribution untouched (`SellerCampaign` separate).

## 7. Commission calculation & rounding

`P = floor(B × R / 10⁴)` (integer sen; half-up), `B = lineSubtotal − sellerFundedDiscount` (shipping/taxes excluded by construction); `S = floor(P × 10/100)`, `D = P − S` (D+S=P always; no sponsor ⇒ D=P); split computed at POSTING time from then-current sponsor flag/eligibility; rate changes are future-only. **E2E-verified exact:** RM 89.00 @10% → P=890, no-sponsor D=890; RM 199.00 @10% → P=1990, D=1791 + S=199.

## 8. Sponsor eligibility rules

Sponsor must be active at referred affiliate's activation; suspended/terminated sponsor ⇒ their 10% is **held** (`sponsor_under_review`), never redirected to the direct promoter; permanent disqualification leaves the share unallocated (never redistributed); sponsor override is a Setting (default **OFF** pending legal clearance) and can be disabled without corrupting past records (split frozen at posting).

## 9. Seller settlement integration

The pool is carved out of seller proceeds **inside `computeOrderCommissions`** (checkout) — `sellerNet + platformCommission + affiliatePool = orderTotal` invariant holds; the liability is credited to `PLATFORM:AFFILIATE_LIABILITY` (type liability, never platform revenue) at payment confirmation; settled via the seller wallet without touching available balances.

## 10. Refund & reversal integration

Proportional-to-customer-paid-gross, floor + remainder-to-largest, double-clamped to remaining reversible pool; within-pool split honours the frozen 90/10; full reversal flips live entries to `reversed`; **paid entries stay paid** with `reversedMinor` recovery offsets (never silently debited); shipping-only refunds book no product reversal; duplicate refunds idempotent. **E2E-verified:** 50% refund of RM 199.00 → 995 sen reversal split 896 (direct) + 99 (sponsor, paid→recovery).

## 11. Payout integration & provider capability

**Manual bank transfer only** (documented platform capability — no automated PSP payout is claimed). State machine: requested → approve/processing (T-A3) → mark-paid with mandatory transfer reference (T-A4 + entries paid + parent commissions advanced when fully settled) / fail (T-A4f + claims released) / reject. Single open request per affiliate; claims are per-entry (`payoutId`) inside a tx with min-payout gate; `statementJson` built from claimed entries at request time.

## 12. Security controls

Session-scoped queries everywhere; server-side sponsor assignment + attribution (httpOnly cookies; client input never trusted in money paths); CSRF via `src/proxy.ts` (all mutations carry `X-SM-Client` marker + same-origin Fetch Metadata); rate limits (activation 5/min, links 30/min, track 60/min-IP, payouts 3/min, admin 30/min); public surfaces expose display names/slugs only; network view is direct-referrals-only (no downline enumeration); kill switch gates activation/posting/payout/discovery/attribution-touch (links still resolve so shared URLs never break — verified); tampered/invalid codes fail closed 404.

## 13. Performance considerations

At most one direct lookup + one sponsor lookup + ≤2 allocation rows per sale (no recursive traversal); indexed hot paths (affiliateId+createdAt, sponsorId+createdAt, status+availableAt, visitorId+productId+clickedAt); batched sweeps (50 orders/tick); posting runs inside the existing payment tx (no extra transaction scope); pagination everywhere in hub/admin lists.

## 14. Test suites & archived results

Durable harness kept in `tool-results/e2e-affiliate*.sh` (rerunnable). **Stage 1 (14/14):** settings, sponsor chain (first-touch, 409 re-activation lock), seller enrolment @10% cap, product links, cookie-backed attribution, one multi-store checkout, payment. **Stage 2 (exact math):** P=D+S, sponsor=⌊P/10⌉, ledger liability ≥ posted pools, duplicate-webhook no-op, deliver→approve→tick mature. **Stage 3:** payout state machine (entries + parent commissions + statement), proportional reversal with recovery, reconciliation `invariantOk=true`, kill-switch no-touch + resume.

## 15. Browser verification evidence

Agent-browser across all surfaces (mobile 390px + desktop): Affiliate Hub renders all 8 tabs with real ledger figures (Personal 90% RM 8.90 / Sponsor RM 1.00 / Paid RM 10.89 / recovery RM 0.99); Discover/Links/Collections/Network/Earnings/Payouts live; public showcase disclosure page; admin Programme (pool RM 86.40 = 3 E2E runs × RM 28.80, reversals RM 9.95, liability invariant OK), Accounts, Commissions (hold actions), Payouts ("never sent automatically"), Reconciliation; Seller Programme/Products/Report (pool RM 26.70 = 10% of RM 267). Zero console errors on clean reloads.

## 16. Remaining limitations

1. QR codes not provided (no existing qrcode dependency; spec said "if straightforward").
2. Showcase display-name/bio editing is read-only (no profile-update endpoint yet).
3. Commissions inspector: order-number search is current-page client-side; no store filter (backend returns no store column).
4. Hub Overview series is a plain-div chart (no recharts dependency).
5. `prisma/migrations/` not regenerated for affiliate DDL (schema applied via `db push`).
6. Carrier delivery timestamps remain non-authoritative — commission approval keys on delivered/completed states only (documented, per spec §10).

## 17. Known risks & unresolved decisions

1. **Legal (BLOCKER):** the one-level sponsor override requires Direct Sales Act 1993 / KPDN review — `affiliate.sponsor_enabled` ships **false** by default and must stay false in production until cleared (rollout Gate 1). Sandbox demo rows enable it for verification only.
2. `affiliate.max_rate_bps` default 1000 / `review_days` 14 now match `commission-definitions.md`/`rollout-checklist.md`; existing environments with old Setting rows keep their values.
3. Buyer-self-purchase block relies on session identity; shared household accounts remain a manual-review fraud vector (no automatic IP bans, per spec §5).
4. Pre-existing `scripts/fin-*.ts` typecheck drift unrelated to this feature (not touched).

## 18. Production deployment instructions

1. Apply schema: `bunx prisma db push` (or regenerate a migration first — §19.5).
2. Configure env (`SUPABASE_DATABASE_URL`, `CRON_SECRET` fail-closed, PSP secrets); scheduler service runs `affiliate-tick` automatically.
3. Keep Settings: `affiliate.enabled=false` until Gate 5; `affiliate.sponsor_enabled=false` until Gate 1 (legal); review the other five keys.
4. Smoke: activate an affiliate, create a link, run one sandbox checkout end-to-end, confirm commission + ledger line, then disable.
5. Launch sequence per `rollout-checklist.md` Gates 8–10 (retention, rollback = disable switch, monitoring: daily reconciliation ×30 d).

## 19. Legal & operational launch blockers

1. KPDN / Direct Sales and Anti-Pyramid Scheme Act 1993 opinion on the sponsor override (Gate 1) — programme is designed so the override can stay permanently disabled (direct-only 100%) without data corruption.
2. Affiliate terms text + version bump (Gate 2).
3. Finance payout runbook + bank-verification process for affiliates (Gate 3).
4. Staging E2E + sign-off register (Gate 4/11); migration-folder regeneration for reproducible deploys (§16.5).

## 20. Defects found & fixed during completion (2026-10-30)

1. **`resolveReferralCookie` selected no `status` column** → sponsor attach silently never worked; fixed (E2E-caught).
2. Deliver route corrupted by an in-progress affiliate edit (`shipment.findUnique` args destroyed) → every seller "mark delivered" 500; restored.
3. Phantom Prisma relations in 5 routes (admin commissions/payouts, public collection/showcase, hub collections) → PrismaClientValidationError at runtime; real relations added.
4. Hold-release/reinstate flipped held→approved without `availableAt` → funds stuck forever; fresh review window now set.
5. `AffiliateCommission.productId/linkType/channel` never written at posting → now snapshotted (link metadata resolved in-tx).
6. `AffiliatePayout.statementJson` never built → built at request time; payout mark-paid now advances parent commissions.
7. Scheduler `freshState()` omitted the affiliate tick; cron-tick GET unauthenticated — both fixed.
8. `discoverProducts` ignored `maxPriceMinor` — applied.
9. Settings defaults were demo-unsafe (`sponsor_enabled=true`, 30% cap, 7-day review) → fail-closed launch posture (false / 1000 bps / 14 d).
10. Four admin affiliate routes imported `auditAdmin` from a module that doesn't export it → corrected to `@/lib/api`.

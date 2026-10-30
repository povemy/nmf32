# Affiliate Programme — Phased Implementation Plan

**Project:** NOMOFEE affiliate system (shopper-activated affiliates, one-level sponsor referral, seller-funded commission pool)
**Basis:** Phase-0 audit (`architecture-audit.md`); financial definitions in `commission-definitions.md`; controls in `security-and-fraud-rules.md`; gates in `rollout-checklist.md`.
**Repo root:** `/home/z/my-project`. All file paths below are repo-relative. No affiliate code exists today; every artefact in this plan is new unless explicitly marked as an extension of an existing file.

> **STATUS (2026-10-30, post-implementation).** This plan was written before any code existed. As built (see `implementation-report.md` for the authoritative as-built record): Phases 1–7 are IMPLEMENTED and runtime-verified (schema pushed to Supabase; engine, attribution, checkout/webhook/refund integrations, seller centre, Affiliate Hub UI, admin console, cron). Phase 8 E2E money-path verification passed on 2026-10-30 (90/10 math exact, idempotent posting, reversal split, payout state machine, kill switch, reconciliation invariant). The "no affiliate code exists" note below is retained for historical context only. Production launch remains gated by `rollout-checklist.md` (legal clearance for the sponsor override, terms, payout runbook, staging sign-off).

---

## 0. Programme invariants (bind every phase)

1. **Single generation only.** One nullable sponsor FK per `AffiliateProfile`, immutable after activation. No MLM depth, no recruitment bonuses, no click rewards. Nothing in any phase may add a second-level share.
2. **Seller-funded pool.** Commission is carved from seller proceeds at checkout; platform commission is untouched. Invariant after Phase 4: `Σ sellerNet + Σ commission + Σ affiliatePool === orderTotal` per order.
3. **Server-recorded attribution only.** Affiliate identity in money paths comes from server-side touch records keyed by the httpOnly `nm_ins_vid` visitor cookie (`src/lib/analytics/identity.ts`). No client-supplied affiliate ids.
4. **Frozen snapshots.** Rate, pool, attribution are frozen per `OrderItem` at checkout create and never recomputed — same discipline as the existing commission snapshots (`src/lib/commission.ts`, `computeOrderCommissions`).
5. **Immutable ledger.** All money movement goes through `src/lib/ledger.ts` recipes with `dedupKey` idempotency; affiliate state is derived, never authoritative over the ledger.
6. **Manual payouts only.** No automated PSP payout exists or is assumed (`architecture-audit.md` §3.10).
7. **Kill switch.** `affiliate.enabled` (Setting) gates every affiliate route and the checkout integration; false = programme inert, existing records preserved.

---

## 1. Data model design (consolidated)

New Prisma models (added to `prisma/schema.prisma`; migration via the existing Prisma workflow). Field-level design:

### 1.1 AffiliateProfile
```prisma
model AffiliateProfile {
  id                    String    @id @default(cuid())
  shopperId             String    @unique            // FK ShopperUser — the principal
  status                String    @default("active") // active | suspended | terminated
  displayName           String                          // public-facing name (privacy rule: network view shows this only)
  // Sponsor: nullable, IMMUTABLE after activation (enforced in service layer + audit table)
  sponsorProfileId      String?   @unique            // self-FK AffiliateProfile
  sponsorLockedAt       DateTime?                      // set at activation; null = not yet locked
  activatedAt           DateTime?
  // Terms acceptance (versioned — rollout gate §2)
  termsVersion          String?                       // e.g. "2026-11-v1"
  termsAcceptedAt       DateTime?
  // Cache mirrors of ledger-derived balances (truth = PLATFORM:AFFILIATE_LIABILITY lines)
  pendingMinor          Int       @default(0)
  availableMinor        Int       @default(0)
  lifetimeEarnedMinor   Int       @default(0)
  lifetimePaidMinor     Int       @default(0)
  suspendedReason       String?
  suspendedAt           DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@index([status])
}
```
Notes: balance columns are caches refreshed on ledger writes, mirroring the seller `Wallet` pattern (`src/lib/ledger.ts` `refreshWalletCache`); a reconciliation job recomputes them from ledger truth (`commission-definitions.md` §8).

### 1.2 AffiliateSponsorAudit
```prisma
model AffiliateSponsorAudit {
  id            String   @id @default(cuid())
  profileId     String                        // the affected AffiliateProfile
  action        String                        // locked_at_activation | admin_correction
  oldSponsorId  String?
  newSponsorId  String?
  adminId       String?                       // null for system (activation lock)
  adminEmail    String?
  reason        String?                       // REQUIRED for admin_correction
  createdAt     DateTime @default(now())

  @@index([profileId, createdAt])
}
```
Admin-only corrections are the sole mutation path post-activation; every correction writes a row here AND an `AdminAuditLog` row (`auditAdmin`, `src/lib/api.ts`) AND an `ActivityLog` row (`logActivity`).

### 1.3 AffiliateReferralTouch (registration attribution)
```prisma
model AffiliateReferralTouch {
  id             String   @id @default(cuid())
  visitorId      String                        // nm_ins_vid (httpOnly, 365d)
  affiliateId    String                        // FK AffiliateProfile — the referring affiliate
  landedAt       DateTime @default(now())
  consumedAt     DateTime?                     // set when a registration consumes this touch
  consumedUserId String?

  @@index([visitorId, landedAt])
  @@index([affiliateId, landedAt])
}
```
First-touch-wins: on shopper registration, the EARLIEST unconsumed touch within `affiliate.sponsor_window_days` (default 30) binds the new affiliate's sponsor; the touch is marked consumed (one consumption per touch — no re-binding). Written by the referral landing route (Phase 1), read by the activation service.

### 1.4 AffiliateLink
```prisma
model AffiliateLink {
  id            String   @id @default(cuid())
  affiliateId   String                        // FK AffiliateProfile
  code          String   @unique              // randomToken(12) — unpredictable, URL-safe
  type          String                        // product | store | collection | showcase
  productId     String?
  storeSlug     String?
  collectionId  String?                       // FK AffiliateCollection (type=collection)
  channel       String?                       // free label: tiktok | whatsapp | blog | … (≤60 chars)
  label         String?                       // affiliate's own note (≤120 chars)
  isActive      Boolean  @default(true)
  clickCount    Int      @default(0)          // denormalized counter for hub display
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([affiliateId, isActive])
}
```
Codes resolve server-side with fail-closed ownership checks (pattern: `resolveCampaignToken` in `src/lib/analytics/attribution.ts`). Deep links reuse the SPA pattern: `/?sf={store}&sp={product}&af={code}` / `/?af={code}` for showcase/collection.

### 1.5 AffiliateCollection + AffiliateCollectionItem
```prisma
model AffiliateCollection {
  id           String   @id @default(cuid())
  affiliateId  String
  slug         String                        // unique per affiliate
  title        String
  description  String?
  isPublic     Boolean  @default(false)      // showcase exposure limit gate (Phase 2)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([affiliateId, slug])
  @@index([affiliateId])
}

model AffiliateCollectionItem {
  id           String   @id @default(cuid())
  collectionId String
  productId    String
  sortOrder    Int      @default(0)
  note         String?                        // affiliate's blurb for the product card (≤200 chars)

  @@unique([collectionId, productId])
}
```

### 1.6 AffiliateAttributionTouch (product-sale attribution)
```prisma
model AffiliateAttributionTouch {
  id           String   @id @default(cuid())
  visitorId    String                        // nm_ins_vid
  affiliateId  String                        // FK AffiliateProfile
  productId    String
  linkCode     String?                       // AffiliateLink.code that produced the click
  clickedAt    DateTime @default(now())
  // Server-side validation flags (fraud controls §5/§9)
  valid        Boolean  @default(true)

  @@index([visitorId, productId, clickedAt])
  @@index([productId, clickedAt])
}
```
Last eligible click per (visitor, product) within `affiliate.attr_window_days` (default 30). Written by the track endpoint on affiliate-link landings that reach a product context; read at checkout create. Self-purchase exclusion compares the touch's affiliate against the buyer's own profile.

### 1.7 AffiliateCommission + AffiliateCommissionEntry
```prisma
model AffiliateCommission {
  id                String    @id @default(cuid())
  orderItemId       String    @unique          // ONE commission row per OrderItem — idempotency anchor
  orderId           String
  affiliateId       String                     // the DIRECT affiliate (attribution winner)
  storeId           String
  // Frozen snapshot (copied from OrderItem affiliate columns — defence in depth)
  rateBps           Int
  baseMinor         Int                        // commissionable base B
  poolMinor         Int                        // P = B × R, integer minor units
  currency          String    @default("MYR")
  // Lifecycle: pending → approved → available → paid; side states held | reversed
  status            String    @default("pending")
  approvedAt        DateTime?                  // set when order authoritative state = delivered|completed
  availableAt       DateTime?                  // approvedAt + affiliate.review_days (clock for available)
  paidAt            DateTime?
  payoutId          String?                    // FK AffiliatePayout when paid
  reversedMinor     Int       @default(0)      // cumulative reversal against this commission
  recoveryMinor     Int       @default(0)      // late-refund recovery re-credited (offsets future earnings)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@index([affiliateId, status])
  @@index([orderId])
}

model AffiliateCommissionEntry {
  id            String   @id @default(cuid())
  commissionId  String
  beneficiaryId String                       // AffiliateProfile.id receiving the share
  role          String                       // "direct" | "sponsor" — EXACTLY the two allowed values
  shareMinor    Int
  status        String   @default("pending") // pending | approved | available | paid | held | reversed
  heldReason    String?
  paidAt        DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([commissionId, role])              // max 2 rows per commission, one per role
  @@index([beneficiaryId, status])
}
```
- `@@unique([commissionId, role])` structurally enforces "2 beneficiary rows max".
- Split is computed **at posting** (webhook T1 time), not at checkout: sponsor eligibility is evaluated against sponsor status at posting (`commission-definitions.md` §4). No sponsor / sponsor ineligible / `affiliate.sponsor_enabled=false` → single `direct` row with `shareMinor = poolMinor`.
- Entry status can diverge from commission status ONLY for `held` (sponsor under review — sponsor share held, direct 90% unaffected) and manual admin states.

### 1.8 AffiliatePayout
```prisma
model AffiliatePayout {
  id             String    @id @default(cuid())
  affiliateId    String
  referenceNo    String    @unique
  amountMinor    Int                          // sum of entry shareMinor in "available" selected for payout
  currency       String    @default("MYR")
  status         String    @default("requested") // requested → processing → paid | failed | rejected
  method         String    @default("manual_transfer")
  bankRef        String?                      // admin-supplied transfer reference at mark-paid
  failReason     String?
  entryIdsJson   String    @default("[]")     // frozen list of entry ids covered
  requestedAt    DateTime  @default(now())
  approvedAt     DateTime?
  paidAt         DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([affiliateId, status])
}
```
Mirrors the seller `Payout` manual workflow (`src/app/api/admin/payouts/**`, `src/lib/payout-state.ts` transition discipline) with its own rows and its own ledger recipes T-A3/T-A4/T-A4f. One open request per affiliate (Serializable tx + bounded P2034 retry — same enforcement shape as `POST /api/store/payouts`).

### 1.9 Extensions to existing models

- **OrderItem** (new snapshot columns, frozen at checkout create — written in `src/app/api/checkout/create/route.ts`):
  - `affiliateId String?` — direct attribution winner's profile id (null = unattributed/excluded)
  - `affiliateRateBps Int?` — resolved rate R actually applied
  - `affiliatePoolMinor Int @default(0)` — P frozen
  - `affiliateBaseMinor Int @default(0)` — B frozen
  - `affiliateLinkCode String?` — winning touch's link code
  - `affiliateAttributedAt DateTime?` — winning touch's clickedAt (evidence)
  - `affiliateExclusion String?` — null | `self_purchase` | `not_enabled` | `no_touch` | `store_opt_out`
  - `sellerNetMinor` semantics CHANGE: becomes net-of-pool (the carve). Migration for existing rows: none needed (pool 0 ⇒ unchanged).
- **Store**: `affiliateOptIn Boolean @default(false)`, `defaultRateBps Int?` (≤ `affiliate.max_rate_bps`).
- **Product**: `affiliateEnabled Boolean @default(false)`, `affiliateRateBps Int?` (overrides store default; both capped).
- **AnalyticsEvent** (additive): `affiliateLinkCode String?`, and new event type value `affiliate_link_click` for the touch endpoint (retention-aligned).

### 1.10 Settings keys (registered in `src/lib/settings-registry.ts`, group `affiliate`)

| Key | Field | Default | Wired by |
|---|---|---|---|
| `affiliate.enabled` | boolean | false | every affiliate route + checkout integration (kill switch) |
| `affiliate.sponsor_enabled` | boolean | false | split computation at posting (legal blocker before true) |
| `affiliate.max_rate_bps` | integer (0–3000) | 1000 (10%) | rate resolution clamp |
| `affiliate.min_payout_minor` | integer, major-rendered MYR | 1000 (RM10) | payout request validation |
| `affiliate.review_days` | integer 0–90 | 14 | availableAt clock |
| `affiliate.attr_window_days` | integer 1–90 | 30 | product attribution |
| `affiliate.sponsor_window_days` | integer 1–90 | 30 | registration attribution |

Registry honesty rule applies: each key ships `wired: true` only when the reading code exists in the same phase.

---

## 2. Phase 1 — Foundation: schema, activation, sponsor

**Goal:** an ordinary shopper can activate as an affiliate with terms acceptance; sponsor binding works end-to-end (with the override itself still disabled by setting).

**Models:** `AffiliateProfile`, `AffiliateSponsorAudit`, `AffiliateReferralTouch`; `Store`/`Product` affiliate columns (land early, inert); settings keys land with `affiliate.enabled` gated **false**.

**Routes (new, all under `/api/affiliate/`, all CSRF-gated by `src/proxy.ts` via the SPA client headers):**
- `GET /api/affiliate/status` — activation state, terms version, sponsor (display name only).
- `POST /api/affiliate/activate` — body `{ displayName, termsVersion }`. Guards: `requireShopper` + `requireAffiliate` wrapper; rate limit **5/min per account**; rejects re-activation, suspended shoppers; freezes sponsor from an unconsumed `AffiliateReferralTouch` (first-touch-wins, window `affiliate.sponsor_window_days`); self-referral check (touch's affiliate === own id → reject binding); writes `AffiliateSponsorAudit(lock at activation)` + `logActivity`.
- `POST /api/affiliate/landing` — referral landing beacon `?af={code}` equivalent for registration attribution: records `AffiliateReferralTouch` from the httpOnly `nm_ins_vid` cookie (server-side, fail-closed). Rate limit **60/min per IP**. Called by the SPA on `?af=` deep-link mount (pattern: the `nmcl` beacon in `src/components/shopper/shopper-shell.tsx` → `POST /api/analytics/landing`).
- `PUT /api/affiliate/profile` — display name only (not sponsor, not money fields).

**Admin routes:** `POST /api/admin/affiliate/sponsors/correct` — sponsor correction; caps `affiliate.manage`; requires `reason`; writes `AffiliateSponsorAudit` + `AdminAuditLog` + `ActivityLog`. `POST /api/admin/affiliate/suspend` / `reinstate` — suspension with `suspendedReason`.

**Lib:** `src/lib/affiliate/auth.ts` (`requireAffiliate` — session-scoped, status-checked), `src/lib/affiliate/settings.ts` (cached setting reads, fail-closed defaults), `src/lib/affiliate/activation.ts` (activation + sponsor binding tx), `src/lib/affiliate/rate-limit-affiliate.ts` — **the rate-limit refactor** (per-account keying wrapper; unify over `src/lib/rate-limit.ts`, see audit §3.16).

**UI:** Shopper me-hub: "Affiliate" card → activation dialog (terms text + version, display-name input). No seller/admin UI yet.

**Dependencies:** Prisma migration; settings registry group; `randomToken` for nothing yet (links are Phase 2).

**Exit criteria:** activation + sponsor binding + admin correction auditable; `affiliate.enabled=false` leaves every route inert (403 `AFFILIATE_DISABLED`).

---

## 3. Phase 2 — Promotional tools: discovery, links, collections, showcase

**Goal:** affiliates create promotional links and curated collections; public showcase pages exist with exposure limits.

**Models:** `AffiliateLink`, `AffiliateCollection`, `AffiliateCollectionItem`.

**Routes:**
- `POST /api/affiliate/links` — `{ type, productId?/storeSlug?/collectionId?, channel?, label? }`; rate limit **30/min per account**; validates the target exists and is affiliate-eligible (store opted in; product enabled); returns the shareable deep link built on the SPA pattern (`/?sf=…&sp=…&af={code}`, `/?af={code}`).
- `GET /api/affiliate/links` / `PATCH|DELETE /api/affiliate/links/[id]` — list/toggle/delete (soft: `isActive=false`).
- `POST/GET /api/affiliate/collections`, `PUT /api/affiliate/collections/[id]`, `POST|DELETE /api/affiliate/collections/[id]/items` — curation CRUD; product eligibility re-validated on add.
- `GET /api/affiliate/track?code=…&redirectTo=…` — **safe-method** landing endpoint (CSRF-exempt by being GET): resolves the code (fail-closed ownership checks), records an `AffiliateAttributionTouch` when the redirect target includes a product context, bumps `clickCount`, 302s to the SPA deep link. Rate limit **60/min per IP** (this is the "track" bucket). Idempotent-ish by design (touches are append-only evidence; attribution resolves "last" at checkout).
- `GET /api/affiliate/showcase/[slug]` — public showcase payload (collection + product cards + affiliate display name); exposure limits: max public collections per affiliate (setting `affiliate.max_public_collections`, default 3), max items per collection (50), no PII beyond display name, nofollow on external links.

**UI:** Shopper affiliate hub (new `ShopperView` member `affiliate` in `src/components/shopper/ui-bits.tsx` union + hub component under `src/components/shopper/`): link builder (type picker → target picker → channel label → copy link), collections manager, showcase toggle. Public showcase renders for anonymous visitors through the SPA root (`/?af={code}` deep link handled in `shopper-shell.tsx` alongside `?sf=`/`?claim_job=`).

**Dependencies:** Phase 1 (profiles exist); `AnalyticsEvent.affiliateLinkCode` column + `affiliate_link_click` event type for click analytics (retention-aligned with `analytics.retention_days`).

**Exit criteria:** link → landing → touch recorded, verifiable in staging with the httpOnly visitor cookie; showcase reachable anonymously with limits enforced server-side.

---

## 4. Phase 3 — Attribution + checkout integration

**Goal:** product-sale attribution resolved server-side per item at checkout; snapshots frozen; self-purchase excluded.

**Models:** `AffiliateAttributionTouch` (if not landed in Phase 2 with the track endpoint — it does), `OrderItem` affiliate snapshot columns.

**Code changes (the only existing-file edits in the programme):**
1. `src/app/api/checkout/create/route.ts` — inside `runCheckout`, after `computeGroupPricing` and before the transaction: resolve affiliate attribution **per line**:
   - eligible = `affiliate.enabled` AND store `affiliateOptIn` AND (product `affiliateEnabled` OR store default applies) AND an attribution touch exists within `affiliate.attr_window_days`;
   - resolve the LAST valid touch per (visitorId, productId) — one query per distinct product, `orderBy clickedAt desc, take 1`;
   - self-purchase exclusion: touch.affiliateId === buyer's `AffiliateProfile.id` → exclude with reason `self_purchase`;
   - rate: `Product.affiliateRateBps ?? Store.defaultRateBps`, clamped to `affiliate.max_rate_bps`; 0 or none → `not_enabled`/`store_opt_out` exclusion;
   - compute `B` (commissionable base — the item's voucher/coupon-adjusted merchandise value, EXCLUDING shipping/tax/platform fees; see `commission-definitions.md` §2) and `P = B × R / 10000` (integer, floor at the pool step per definitions §3);
   - pass the affiliate parts into the commission computation so `OrderItem.sellerNetMinor` is written **net of P** and the affiliate snapshot columns are written in the same `orderItem.createMany`.
2. `src/lib/commission.ts` — `computeOrderCommissions` input gains an optional per-item `affiliate` block; the reconciliation target becomes `Σ sellerNet + Σ commission + Σ affiliatePool === orderTotal` (`reconcileSplits` extended — drift assignment to largest line unchanged).
3. **Per-OrderItem independence in multi-seller checkout:** the PaymentGroup groups lines per SELLER, but attribution is per PRODUCT. Two items from the same seller may attribute to different affiliates (or one attributed, one not); items from different sellers never share attribution by construction. Attribution resolution therefore runs per `pricing.items` line, NOT per seller group, and the snapshot is written per `OrderItem`. This is the deliberate divergence from the seller-grouped money math — it is safe because every downstream consumer (commission row creation, T1 4th line, T5 reversal) reads the per-item snapshot, never a group aggregate.

**Routes:** none new (checkout is the integration point). `GET /api/affiliate/attributions` (hub view of recent touches) is optional here or Phase 7.

**UI:** none (checkout UX unchanged — attribution is invisible to the buyer).

**Dependencies:** Phase 1+2; the visitor cookie must be readable server-side at checkout (`cookies()` — same mechanism as `resolveAttribution()` in `src/lib/analytics/attribution.ts`).

**Exit criteria (staging):** multi-seller cart with mixed attribution/self-purchase/non-eligible items → `OrderItem` rows carry correct frozen snapshots; `Σ sellerNet + Σ commission + Σ pool === total` holds for every order (script assertion, pattern: `scripts/test-commission-parity.ts`).

---

## 5. Phase 4 — Commission accounting

**Goal:** money moves correctly. Ledger account, T1 4th line, commission rows + entries, lifecycle clocks.

**Models:** `AffiliateCommission`, `AffiliateCommissionEntry`.

**Code changes:**
1. `src/lib/ledger.ts`:
   - `ACCOUNTS.affiliateLiability = "PLATFORM:AFFILIATE_LIABILITY"` + `ACCOUNT_META` entry (liability);
   - `postOrderPaid` (T1) gains `affiliatePoolMinor` input and a 4th line `CR PLATFORM:AFFILIATE_LIABILITY` (with `availableAt = review-clock anchor`, see below); **sellerNet input is already net-of-pool** from Phase 3 snapshots — the recipe just posts what it is given; the invariant check becomes `sellerNet + commission + affiliatePool === total` (`runLedgerInvariants` updated);
   - new recipes **T-A3** `postAffiliatePayoutInitiated` (DR `AFFILIATE_LIABILITY` | CR `PAYOUT_CLEARING`, dedupKey `affiliate_payout_initiated:payout:{id}`), **T-A4** `postAffiliatePayoutConfirmed` (DR `PAYOUT_CLEARING` | CR `BANK_MAIN`, dedupKey `affiliate_payout_confirmed:payout:{id}`), **T-A4f** `postAffiliatePayoutFailed` (DR `PAYOUT_CLEARING` | CR `AFFILIATE_LIABILITY`, dedupKey `affiliate_payout_failed:payout:{id}`) — mirroring T3/T4/T4f lines 373–425 exactly.
2. `src/app/api/webhooks/payments/process.ts` — inside the existing Serializable success transaction, per order AFTER `postOrderPaid`: create `AffiliateCommission` (unique `orderItemId` — replay-safe under the claim + dedupKey discipline already present) + entries:
   - compute the split AT POSTING (`commission-definitions.md` §3): sponsor exists AND `affiliate.sponsor_enabled` AND sponsor profile `active` → `S = floor(P×10/100)`, `D = P−S`, two entries; else single direct entry `D = P`;
   - sponsor suspended/under verification → still two entries, sponsor entry status `held` (direct unaffected);
   - `AffiliateCommission.availableAt` = approved-clock is NOT yet known at T1 — the pending row stores null; the approval tick fills it.
   - post-commit: refresh affiliate balance caches (best-effort, pattern: wallet-cache refresh).
3. Lifecycle engine `src/lib/affiliate/lifecycle.ts` + `POST /api/cron/affiliate-tick` (cron-secret auth, idempotent, claim-first transitions):
   - `pending → approved`: order reached `delivered` or `completed` (authoritative order status via `Order.status`; NOT carrier timestamps — audit §3.6);
   - `approved → available`: `approvedAt + affiliate.review_days` elapsed AND no open (non-rejected) refund on the order; sets `availableAt` effective date and releases the ledger line's `availableAt` semantics for balance derivation;
   - sponsor `held → available|reversed` on reinvestigation outcome.
   - Add the endpoint to `mini-services/expiry-scheduler/index.ts` route map (port 3005) and record `cron.affiliate_tick.last` in Settings (observability pattern: `cron.expiry_sweep.last`).

**Routes:** none public in this phase (hub reads come in Phase 7); admin read-only `GET /api/admin/affiliate/commissions` (filters by affiliate/order/status; caps `affiliate.manage`).

**UI:** none.

**Dependencies:** Phases 1–3; ledger invariant test updates (`scripts/verify-ledger.ts`, `scripts/fin-tests.ts` patterns).

**Exit criteria:** staging payment webhook → T1 posts 4 balanced lines; commission + entries exist exactly once per item (replayed webhook = no duplicates — claim + `orderItemId` unique + dedupKey triple guard); tick walks pending→approved→available with correct clocks.

---

## 6. Phase 5 — Refunds + payouts

**Goal:** refund reversals proportional against original snapshots; manual affiliate payout workflow with references.

**Models:** `AffiliatePayout`.

**Code changes:**
1. `src/app/api/admin/refunds/[id]/process/route.ts` — alongside T5: affiliate reversal derived from the order's `AffiliateCommission` rows using the SAME proportional allocation of the order-level refund amount across items (family: `allocateProportionally`, `src/lib/money.ts`), clamped so cumulative reversals never exceed each commission's remaining balance:
   - `reversalItem = min(remainingItem, proportionalShare)`; residual re-clamped across items with remaining balance;
   - entry-level reversal mirrors the commission-level split proportionally (`direct`/`sponsor` each reversed `round_half_up(reversal × share / pool)`, sponsor residual clamped, final residual to direct so `Σ reversals === commission reversal`);
   - fully reversed → status `reversed`; partially reversed → status stays with `reversedMinor` tracking; `available`/`approved` entries may go negative-equivalent only via the recovery mechanism below;
   - **late-refund recovery**: reversal against an already-`paid` commission creates a negative `recoveryMinor` obligation on the affiliate profile that offsets FUTURE earnings at posting time (never claws back money already transferred — finance-ops decision documented in `commission-definitions.md` §7).
2. `src/lib/ledger.ts` — T5 `postRefund` gains `affiliateReversalMinor` and a DR line on `AFFILIATE_LIABILITY`; the seller-share DR shrinks accordingly so the transaction stays balanced against CR `GATEWAY:{p}` (see definitions §6.2).
3. Payout workflow (mirrors `src/app/api/store/payouts/route.ts` + `src/app/api/admin/payouts/**`):
   - `POST /api/affiliate/payouts` — request; rate limit **3/min per account**; validates amount ≥ `affiliate.min_payout_minor`, ≤ available balance (ledger-derived), one open request (Serializable + bounded P2034 retry); NO ledger movement yet;
   - `POST /api/admin/affiliate/payouts/[id]/approve` — T-A3 posted inside the claim tx (requested→processing); caps `affiliate.manage`; audit;
   - `POST /api/admin/affiliate/payouts/[id]/mark-paid` — requires `bankRef`; T-A4 inside the claim tx (processing→paid); entries → `paid`; audit;
   - `POST /api/admin/affiliate/payouts/[id]/fail` / `reject` — T-A4f (failed) / plain reject (requested→rejected, no ledger); audit.

**UI:** hub payout section (Phase 7 lands the UI; the API is complete here).

**Dependencies:** Phase 4; refund flows already require admin approve→process ordering (enforced in the existing route — affiliate reversal rides the same ordering).

**Exit criteria:** staging full-refund of an attributed order → T5 balanced with affiliate DR line; entries reversed exactly proportional to the original split; payout request→approve→mark-paid posts T-A3/T-A4 once each (replays converge).

---

## 7. Phase 6 — Seller centre

**Goal:** sellers control participation and rates; see affiliate-driven sales.

**Models:** none new (`Store`/`Product` columns landed in Phase 1).

**Routes (extend the `/api/store/**` family, all `requireActiveSellerStore`):**
- `GET/PUT /api/store/affiliate/settings` — `affiliateOptIn`, `defaultRateBps` (clamped to `affiliate.max_rate_bps` server-side; UI shows the cap).
- `GET/PUT /api/store/products/[id]/affiliate` — per-product `affiliateEnabled`/`affiliateRateBps` (folded into the existing product edit payload is acceptable; separate route keeps it explicit).
- `GET /api/store/insights/affiliate` — attributed-sales report: per product, attributed order items, pool paid out, net proceeds after pool; period filters. Follows the insights route family shape (`src/app/api/store/insights/**`).

**UI:** Seller centre — new `SellerViewName` entry `affiliate` (or a Settings tab + an Insights sub-report; decision at build time, both additive) in `src/components/seller/ui-bits.tsx` + a component under `src/components/seller/`.

**Dependencies:** Phases 3–4 (snapshots exist for reporting).

**Exit criteria:** opt-out stops new attribution for that store's items at the NEXT checkout (frozen snapshots on past orders are unaffected — by design); rate changes never mutate frozen historical commissions.

---

## 8. Phase 7 — Affiliate hub + admin UI

**Goal:** the affiliate's working surface and the admin programme console.

**Routes:**
- Hub reads: `GET /api/affiliate/summary` (balances pending/available/lifetime, cache-backed by ledger truth), `GET /api/affiliate/commissions` (paged, status filter), `GET /api/affiliate/payouts`, `GET /api/affiliate/network` (**sponsor + direct referrals — display name only**, counts and aggregate earned-from-them figures, no emails/phones — privacy rule §7).
- Admin console: `GET /api/admin/affiliate/overview` (programme totals, liability vs paid), `GET /api/admin/affiliate/profiles`, suspension/reinstate (Phase 1 routes), sponsor corrections (Phase 1), payout queue (`Phase 5` routes), `GET /api/admin/affiliate/reconciliation` — the 7-point report (`commission-definitions.md` §8).
- Rate limits on all admin affiliate mutations: **30/min per admin account**.

**UI:**
- Shopper: full affiliate hub view (`ShopperView` member `affiliate`): overview cards, links, collections, commissions table with lifecycle badges, payout request + history, network view, terms re-acceptance banner on version bump.
- Admin: new `NAV_GROUPS` entry in `src/components/admin/admin-shell.tsx` (group "Affiliate", items capped `affiliate.manage`), components under `src/components/admin/`: Profiles, Payouts, Programme Controls (settings registry renders the `affiliate` group automatically in System→Settings — no bespoke settings UI needed), Reconciliation report.

**Dependencies:** Phases 1–6.

**Exit criteria:** an affiliate can run the entire programme surface without any other portal; an admin can operate every control with audit trail.

---

## 9. Phase 8 — Verification + launch gates

**Goal:** prove correctness, then gate launch.

**Verification artefacts (staging):**
1. Full lifecycle E2E: activate → link → click → checkout (multi-seller, mixed attribution, self-purchase line) → webhook → T1 4-line → tick approvals → review window → available → payout request → approve → mark-paid → T-A3/T-A4; then a partial refund and a post-payout (late) refund on the same order.
2. Concurrency: replayed webhooks, double-activation attempts, concurrent payout requests, P2034 retry paths (extend `scripts/fin-concurrency.ts` / `scripts/fin-tests.ts` patterns).
3. Ledger invariants extended and green (`runLedgerInvariants` + `scripts/verify-ledger.ts`).
4. Reconciliation report zero-variance run (`commission-definitions.md` §8).
5. Kill-switch drill: flip `affiliate.enabled=false` mid-staging → every route inert, checkout stops creating snapshots (existing frozen rows untouched), scheduler idles.
6. Rate-limit refactor verification per account/IP buckets.

**Launch gates:** see `rollout-checklist.md` — legal (BLOCKER for `affiliate.sponsor_enabled`), terms versioning, financial ops sign-off, settings at launch, kill-switch procedure, monitoring cadence, retention confirmation, rollback plan.

---

## 10. Phase dependency graph

```
P1 Foundation ──┬──> P2 Promotional tools ──> P3 Attribution+checkout ──> P4 Commission accounting
                │                                                        │
                │                                                        ├──> P5 Refunds+Payouts
                │                                                        └──> P6 Seller centre
                └────────────────────────────────────> P7 Hub+Admin UI (needs P1–P6 APIs)
                                                                             │
P8 Verification (needs P4 minimum; full pass needs P1–P7) ──────────────────┘
```

Phases 5 and 6 may run in parallel after Phase 4. Phase 3 is the only phase that edits existing money-path code (`checkout/create/route.ts`, `commission.ts`, `webhooks/payments/process.ts`, `ledger.ts`) — schedule it with the most review weight; every other phase is additive.

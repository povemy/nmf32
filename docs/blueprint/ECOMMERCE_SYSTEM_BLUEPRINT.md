# ECOMMERCE_SYSTEM_BLUEPRINT.md
## NOMOFEE Multi-Vendor Marketplace — Complete System Blueprint (Discovery & Documentation, Read-Only)

**Prepared for**: independent architectural review.
**Method**: evidence-based static inspection of the actual repository (no implementation changes; no scripts executed; live DB read via read-only SQLite connection).
**Evidence labels**: **[VERIFIED]** directly established from code/schema/config or safe read-only DB inspection · **[INFERRED]** reasonable interpretation needing confirmation · **[PARTIAL]** some components verified, full behaviour not · **[MISSING]** not found after appropriate search · **[UNVERIFIED]** cannot be confirmed with available access.
**Scope note**: all findings reflect the repository as inspected; secrets are redacted by policy; financial examples are anonymised.

---

## 0. Document map

This is the master index. Detailed material lives in ten supporting documents (same directory, `docs/blueprint/`); a single-file concatenation exists as `PlatformCompleteBlueprint.txt` at the repository root.

| # | Supporting document | Blueprint parts covered |
|---|---|---|
| 1 | `01-architecture-repository.md` | **B** repository/file map · **C** architecture & dependency map (diagrams) |
| 2 | `02-frontend-ux.md` | **D** frontend & user experience (all three portals) |
| 3 | `03-backend-api.md` | **E** backend, API & business logic (~120 routes + end-to-end traces) |
| 4 | `04-database-model.md` | **F** database schema & data model (76 models, money storage map, seeds, live DB spot-check) |
| 5 | `05-domain-marketplace-lifecycle.md` | **G** order lifecycle · **I** multi-vendor architecture · **S** system flows (sequence diagrams) |
| 6 | `06-financial-engine.md` | **H** financial engine & money precision · **V** master financial data-flow map |
| 7 | `07-security-auth.md` | **J** authN/authZ/tenancy · **K** security review (findings register F-01…F-18) |
| 8 | `08-integrations-reliability-performance.md` | **L** integrations · **M** performance · **N** reliability & recovery |
| 9 | `09-testing-config-admin.md` | **O** testing & QA · **P** configuration/deployment · **Q** administration & ops |
| 10 | `10-unwired-techdebt-openquestions.md` | **R** hard-coded/mocked/unwired · **T** technical debt · **W** open questions |

Part **A** (executive inventory) is below; part **U** (feature matrix) is §7 here.

## 1. Table of contents

1. Document map (§0)
2. Executive system inventory — Part A (§2)
3. Architecture & repository map — Parts B, C (Support 01)
4. Frontend & UX — Part D (Support 02)
5. Backend & API — Part E (Support 03)
6. Database & data model — Part F (Support 04)
7. Master feature & requirement matrix — Part U (§7)
8. Order lifecycle, marketplace & flows — Parts G, I, S (Support 05)
9. Financial engine & integrity map — Parts H, V (Support 06)
10. Authentication, authorization & security — Parts J, K (Support 07)
11. Integrations, performance, reliability — Parts L, M, N (Support 08)
12. Testing, configuration, administration — Parts O, P, Q (Support 09)
13. Unwired functionality, technical debt, open questions — Parts R, T, W (Support 10)
14. Glossary (§8)
15. Important source files for review (§9)
16. Limitations & verification checklist (§10)

---

## 2. PART A — Executive system inventory

### 2.1 What the product is (plain English)

NOMOFEE (formerly branded SHOPMESH; rebrand completed including DB email sweep via `scripts/rebrand-db.ts`) is a **multi-vendor marketplace platform demo** for the Malaysian market (MYR, en-MY copy): shoppers buy from multiple independent sellers in one cart/checkout; sellers onboard through KYC, run storefronts built with a drag-and-drop page builder, manage products/orders/wallets; admins operate the whole platform (moderation, commission engine, wallets/ledger/payouts, campaigns, support). **Payment is deliberately a sandbox mock** of a licensed-PSP split model (Option B): one buyer charge per checkout, platform commission as the PSP application fee, sellers settled via an internal double-entry ledger and payout batches. Chat is realtime via a tiny socket.io sidecar. Everything runs as **one Next.js app + one SQLite database + one chat micro-service**, behind a single Caddy port.

### 2.2 Confirmed facts vs inferences

| Dimension | Finding | Label |
|---|---|---|
| Application type | Modular monolith: single Next.js 16 App Router app (UI + ~120 API route handlers) + separate 90-line chat relay service + Caddy gateway. Not microservices, not serverless. | [VERIFIED] |
| Languages/frameworks | TypeScript 5 strict-ish (`noImplicitAny:false`; build TS gate disabled), Next.js 16.1.1, React 19, Tailwind 4 (+legacy v3-style config), shadcn/ui New York, Prisma 6.11.1 + SQLite, zustand 5, socket.io 4.8.4, bun runtime/toolchain | [VERIFIED] |
| Frontend tech | Single-route SPA (`/`), three client-side portals switched by zustand; no URL routing except `?sf/?sp/?claim_*`; all data client-fetched; framer-motion, recharts, dnd-kit; **no dark mode mounted, no i18n wired** | [VERIFIED] |
| Backend tech | Route handlers only (zero server actions); business logic in `src/lib` (money, commission, ledger, vouchers, shipping mock, PSP mock, marketplaces, import, chat relay client); `{data}` envelope; manual validation (zod in 3 routes) | [VERIFIED] |
| Database | SQLite (`db/custom.db`, journal_mode=delete) via Prisma; **76 models, 0 enums** (String + app validation); **no migration ledger** — schema synced by `db push --accept-data-loss`; money = Int sen, rates = Int bps post-M-FIN-1 | [VERIFIED] |
| AuthN/AuthZ | Custom cookie+Bearer dual-channel sessions (scrypt passwords, CSPRNG tokens, 7-day DB sessions); RBAC cap matrix for admin (11 caps); ownership scoping app-level; **no MFA, no email verification, no password reset, no rate limiting** | [VERIFIED] |
| Payments | Mock PSP ("NomoPay Checkout (sandbox)"); PaymentGroup = one PSP session; webhook HMAC with **hardcoded demo secret**; stripe_my/curlec/ipay88 documented stubs; auto-settle hard-blocked 409 | [VERIFIED] |
| External services | Shopee/TikTok import connectors (real network clients, env-gated, inactive in sandbox), fixture connector (works), nothing else — no email/SMS/storage/AI SDK usage | [VERIFIED] |
| Background processing | **None** — simulated inline workers (webhook fan-out writes success rows; notifications are DB rows; mock shipments advance lazily on buyer reads); no cron/queue | [VERIFIED] |
| Environments | Sandbox/dev only; standalone build exists (`next build` + `bun .next/standalone/server.js`); harness scripts in `.zscripts/`; **no CI/CD, no staging/prod distinction** | [VERIFIED] |
| Test posture | No test runner/CI; financial unit suite (56 tests) + live-DB reconcile suite (25 invariants) exist as manual bun scripts; results not re-executed during this blueprint | [VERIFIED posture / UNVERIFIED results] |
| Intended-for-production notes | Worklog declares single-route SPA as sandbox adaptation; production intent = separate hosts; PSP swap documented as config-level at 4 plug-in points | [INFERRED from code comments/worklog] |

### 2.3 Major internal modules

`src/lib/money.ts` (POLICY P1 arithmetic) · `commission.ts` (rate resolution + fee holidays) · `ledger.ts` (double-entry T1–T6 + wallet truth) · `psp.ts` (PSP abstraction/scaffold) · `vouchers.ts` · `shipping.ts` (mock courier) · `api.ts` (envelope/audit/notify/transition) · `auth.ts`/`password.ts`/`secretbox.ts` · `marketplaces/*` + `import/*` (catalogue import/claim) · `campaigns.ts` · `sections.ts` (15 builder sections) · `chat.ts` — all cited file:line in the support documents.

### 2.4 Headline architectural conclusions

1. The **financial core is disciplined and centralised** (integer sen/bps, single rounding point, frozen commission snapshots, ledger-derived statements, independent reconcile suite) — but carries **10 ranked residual risks** (Support 06 §H.11), the top being dead admin override config (FIN-01) and non-atomic, status-only-idempotent webhook posting (FIN-02).
2. **Security is demo-grade by intent in payment paths** (hardcoded webhook secret, public simulate) and missing baseline controls elsewhere (rate limiting, CSRF protection with SameSite=None cookies, security headers, git-tracked DB/PII) — 18-item register (Support 07 §K.1).
3. **Marketplace isolation is solid at the request layer** (70/70 admin guards, zero IDOR found in store/me routes, portal escalation blocked) while DB-level constraints are minimal (SQLite reality).
4. **Operational completeness gaps**: no real notifications, no background jobs, no backups, no CI, unwired endpoints, one broken admin button — all catalogued with evidence (Support 10).

---

## 7. PART U — Master feature and requirement matrix

Status legend: ✅ Verified implemented · 🟡 Partially implemented · 🎨 UI only · ⚙️ Backend only · 🧪 Mocked/hardcoded (intentional sandbox) · ❓ Referenced but unverified · ❌ Not found.

| Feature | Frontend location | Backend implementation | Database | External | Validation/permissions | Test coverage | Status |
|---|---|---|---|---|---|---|---|
| Shopper register/login/session | `shopper-shell.tsx` auth dialog | `auth/shopper/*` | ShopperUser, Session | — | cross-portal email check; suspended 403 | none | ✅ |
| Seller register/onboarding/KYC | `seller-shell`, `onboarding.tsx` | `auth/register`, `store/onboarding`, `admin/sellers/*` | Seller, Store, KycDocument, BankAccount | — | RBAC caps; audited | none | ✅ |
| Admin RBAC back office | `admin/*` (26 views) | `admin/**` 70 routes | full model set | — | 70/70 guarded; audited mutations | none | ✅ |
| Catalogue browsing/search/sort | `market.tsx` | `market/*` | Product, Category, Store | — | live-store scope | none | ✅ |
| Product detail/variants/reviews | `pdp.tsx` | `sf/[slug]/products/[pSlug]` | Product, ProductVariant, Review | — | live+published only | none | ✅ (reviews POST unauthenticated — 🟡) |
| Page-builder storefronts (15 sections) | `builder.tsx`, `builder-render.tsx`, `storefront.tsx` | `store/pages*`, `store/theme`, `sf/[slug]` | CmsPage (draft/published versions), Store.themeJson | — | owner-scoped | none | ✅ (renderer duplicated — see T) |
| Cart (multi-store) | `shopper-shell` CartDrawer | `cart/*` | Cart, CartItem | — | session; stock guards | none | ✅ |
| Checkout quote (shipping/coupon/voucher) | `checkout.tsx` phases 1–2 | `checkout/quote`, `checkout/pricing.ts` | read-only | — | server-truth pricing | fin-tests (primitives) | ✅ |
| Multi-store order creation + frozen commission | `checkout.tsx` phase 3 | `checkout/create` ($transaction) | Order, OrderItem, PaymentGroup, CouponRedemption, InventoryLog | — | Idempotency-Key; hard voucher mode; stock re-check | reconcile B/C/E | ✅ |
| Payment (mock PSP) + webhook + ledger T1 | `checkout.tsx` PayView | `payments/[ref]/*`, `webhooks/payments/*`, `psp.ts`, `ledger.ts` | PaymentGroup/Intent, PaymentWebhookLog, LedgerTransaction | mock | HMAC (hardcoded secret); status idempotency | reconcile D/M; fin-tests T5/splits | 🧪 core ✅ (FIN-02 race) |
| Seller order fulfilment + mock logistics | `seller/orders.tsx` + dialogs | `store/orders/*`, `lib/shipping.ts` | Order, Shipment, ShipmentEvent | mock courier | store-scoped | none | ✅/🧪 |
| Vouchers & coupons (platform/store scope) | me-hub vouchers, seller vouchers/coupons | `me/vouchers*`, `store/vouchers|coupons`, `lib/vouchers.ts`, `pricing.ts` | Voucher, UserVoucher, Coupon, CouponRedemption | — | atomic redemption; quota; region | fin-tests (discount math) | ✅ |
| Commission engine (chain + fee holidays) | admin finance/commission | `lib/commission.ts`, `admin/commission/*` | CommissionSetting, OrderItem.commissionBps, FeeHoliday | — | rateBpsFrom reject-don't-round | fin-tests §9; reconcile A/K | ✅ |
| Admin commission overrides | `finance.tsx` OverridesView | `admin/commission/overrides` | CommissionOverride | — | RBAC; audited | — | ⚙️ (engine never reads it — FIN-01) |
| Commission exports (historical snapshots) | admin commission Reports tab | `admin/commission/exports*`, `lib/commission-export.ts` | CommissionExport.snapshotJson (v1 pct/v2 bps) | — | RBAC; byte-stable downloads | fin-tests §10; reconcile L | ✅ |
| Ledger & wallets (seller) | seller wallet, admin wallets-ledger | `lib/ledger.ts`, `store/wallet*`, `admin/wallets*` | LedgerAccount/Transaction/Line, Wallet | — | ownership-scoped reads | reconcile D/I | ✅ |
| Payout batches + statements | admin payouts | `admin/payout-batches`, `admin/payouts/*`, `ledger.ts` statements | PayoutBatch, Payout | — | dry-run; RBAC; audited | reconcile H | ✅ (loop non-transactional — FIN-08) |
| Refunds (seller→admin) | admin refunds/orders | `store/orders/[id]/refund-request`, `admin/refunds/*` | Refund, Order, Ledger T5 | — | RBAC; status guards | reconcile D/G | ✅ (attribution heuristic FIN-05) |
| Disputes/returns | me-hub, admin disputes | `me/orders/[n]/return-request`, `admin/disputes` | Dispute | — | open-dispute guard | none | 🟡 (no money movement; no exchange flow) |
| Realtime chat | shopper/seller messages | `chat/*`, `lib/chat.ts`, mini-service | ChatThread, ChatMessage | socket.io hub | thread XOR ownership; **no socket auth** | none | ✅ |
| Catalogue import (Shopee/TikTok/fixture) + claim | `generate.tsx`, `imports.tsx` | `import/*`, `marketplaces/*`, `claim/bind` | ImportJob(+Items), MarketplaceConnection, StoreClaim | real clients env-gated | SSRF guard; hashed claim tokens | none | 🟡 (fixture works; real platforms need env) |
| Campaigns (themed marketplace takeovers) | admin marketing, market.tsx layer | `admin/campaigns`, `campaigns/active`, `lib/campaigns.ts` | Campaign, MarketplaceBanner | — | RBAC; cache invalidation | none | ✅ (cosmetic layer) |
| Notifications (in-app) | bell, me-hub | `me/notifications*`, `lib/api.ts notify` | Notification, NotificationLog, templates | **no email/SMS** | owner-scoped | none | 🟡 (DB rows only) |
| Guest order lookup/receipt | checkout Orders/Lookup views | `orders/lookup`, `orders/receipt` | Order (+pdf-lib) | — | email+orderNumber pair | none | ✅ (enumeration risk F-08) |
| NomoPay buyer wallet/coins/PayLater | me-hub (hidden UI) | `me/wallet`, `me/coins/claim` | ShopperWallet | — | feature-flag dormant; 403 | none | 🎨/⚙️ dormant (licensing gate) |
| Feature flags / settings / audit logs / health | admin system | `admin/feature-flags|settings|audit-logs|activity-logs|system/health` | Setting, FeatureFlag, AdminAuditLog, ActivityLog | — | RBAC; audited | none | ✅ |
| Membership tiers | me-hub profile | `me/profile` auto-upgrade | ShopperUser.membershipLevel | — | never downgrades | none | 🟡 (display tier only) |
| SEO/sitemap | layout, pdp JSON-LD | `sitemap.ts`, `lib/seo.ts` | SeoMeta, Store/Product slugs | — | — | none | 🟡 (client-injected meta only) |
| Storefront domains | seller domains UI | `store/domains/*` (verify simulated) | StoreDomain | none | owner-scoped | none | 🧪 |
| Outbound store webhooks + API keys | seller integrations | `store/webhooks*`, `store/integrations`, `lib/api.ts dispatch` | WebhookEndpoint, WebhookDelivery, ApiKey | **simulated** | secrets plaintext (F-15) | none | 🧪 |
| Shipping tick cron | — | `shipping/tick` | Shipment | — | intentionally open | none | ⚙️ (no caller) |
| Exchange workflows / partial-return lines | — | — | — | — | — | — | ❌ (Dispute text only) |
| Vendor staff/roles | — | — | — | — | — | — | ❌ (ApiKey scaffold only) |
| MFA / email verification / password reset | — | — | — | — | — | — | ❌ |

---

## 8. Glossary (project-specific terms)

| Term | Meaning |
|---|---|
| **NOMOFEE / SHOPMESH** | Platform name now / former brand (DB rebrand via `scripts/rebrand-db.ts`; residue listed in Support 10) |
| **Portal / surface** | Shopper, Seller, or Admin client-side SPA surface switched on `/` by zustand |
| **NomoPay Checkout (sandbox)** | Label of the mock PSP provider; also the brand of the dormant buyer-wallet suite behind `NOMO_FINANCE_ENABLED=false` |
| **Option B** | Approved payment architecture: licensed PSP split — PSP collects, deducts commission as application fee, settles sellers; platform never custodies funds (FSA 2013 s.17 note in `psp.ts`) |
| **PaymentGroup / PaymentIntent** | One PSP checkout session covering N per-store orders / legacy single-order charge |
| **M-FIN-1** | Executed one-off migration (2026-10-18): Float percent columns → integer bps; guarded by frozen script + `FinMigrationBackup` + dropped columns; verified by `scripts/verify-migration-freeze.ts` |
| **POLICY P1** | Money policy in `money.ts`: integer sen storage, integer bps rates, single ROUND_HALF_UP rounding point via `bpsOf`, largest-remainder splits, BigInt overflow path, digit-exact input parsing, display-only formatting |
| **sen / minor units** | 1/100 MYR; all money stored as integers |
| **bps** | Basis points; 10,000 = 100% (`BPS_DENOM`); 835 = 8.35% |
| **FeeHoliday** | Commission promotion window; `bps` = rate CHARGED during window (0 = full waiver); clamped ≤ normal; invalid ⇒ ignored with audit flag |
| **Frozen commission snapshot** | Per-OrderItem `commissionBps` + `breakdownJson` fixed at checkout; never recomputed; refunds reverse from it |
| **CommissionOverride (dead config)** | Admin-managed override table the engine never reads (FIN-01) |
| **T1…T6** | Ledger posting recipes: order paid / gateway settlement / payout initiated / confirmed / failed / refund / admin adjustment |
| **Ledger mirror** | T1 is bookkeeping of PSP sub-balances, not custody |
| **Wallet cache / wallet truth** | Denormalised pending/available columns vs ledger-derived `walletTruth()`; refreshed on write; drift checked by invariants |
| **Payout statement** | `Payout.statementJson` built by `buildLedgerStatementFromLedger` — ledger-derived with balancing "retained" line (post-fix; pre-fix seed decorated numbers) |
| **Caddy XTransformPort** | Gateway query param routing internal service ports through the single exposed port |
| **mini-service** | Independent bun process under `mini-services/` (chat hub :3003/:3103) |
| **Fixture connector** | Local demo marketplace source used by the import wizard |
| **Claim token** | SHA-256-hashed single-use token binding an imported store to a seller |
| **fin-tests / fin-reconcile** | Manual financial unit suite (56) / live-DB invariant suite (25, sections A–M) |
| **FIN-xx / F-xx** | Financial risk register (Support 06 §H.11) / security findings register (Support 07 §K.1) |

## 9. Important source files for subsequent review

**Money & finance**: `src/lib/money.ts` · `src/lib/commission.ts` · `src/lib/ledger.ts` · `src/lib/psp.ts` · `src/lib/commission-export.ts` · `src/lib/vouchers.ts` · `src/app/api/checkout/pricing.ts` · `src/app/api/checkout/create/route.ts` · `src/app/api/webhooks/payments/process.ts` · `src/app/api/admin/refunds/[id]/process/route.ts` · `src/app/api/admin/payout-batches/route.ts`
**Identity & security**: `src/lib/auth.ts` · `src/lib/password.ts` · `src/lib/secretbox.ts` · `src/lib/session-client.ts` · `src/app/api/auth/**` · `src/app/api/admin/_helpers.ts`
**Data**: `prisma/schema.prisma` · `prisma/seed.ts` · `scripts/migrate-money-bps.ts` (frozen) · `scripts/verify-migration-freeze.ts` · `scripts/fin-tests.ts` · `scripts/fin-reconcile.ts` · `db/backup/fin-migration-2026-10-18T08-25-00-334Z.json`
**Architecture keystones**: `src/components/app-root.tsx` · `src/lib/app-store.ts` · `src/app/page.tsx` · `next.config.ts` · `Caddyfile` · `mini-services/chat-service/index.ts` · `src/lib/shipping.ts` · `src/lib/import/runner.ts` · `src/lib/marketplaces/shopee.ts`
**Debt hotspots**: `src/components/shopper/checkout.tsx` · `src/components/shopper/me-hub.tsx` · `src/components/admin/stores.tsx:64` (broken call) · `src/lib/marketplaces/callback.ts` (dead/duplicated)

## 10. Limitations & verification checklist

**Verified in this engagement**: all 76 models read from schema; all ~120 API routes inventoried with guards; financial/security/auth/config code read in full; live DB spot-checked read-only (row counts, rate formats, export snapshot v1/v2, FinMigrationBackup 31 rows, PO-100001 statement); frontend portals mapped with endpoint cross-greps; 18 security findings + 10 financial risks registered with file:line evidence; no application file modified; only documentation artifacts created (`docs/blueprint/*` + `PlatformCompleteBlueprint.txt`).

**Not verified (read-only mandate)**: execution of fin-tests/fin-reconcile/lint/tsc; runtime behaviours (races, locking, performance); real PSP/connector behaviour; production env/infra; `bun audit` dependency posture. See Support 10 §W (W1–W13).

**Checklist confirmation** (per task instructions): actual repository inspected beyond top level ✅ · major modules and business-critical flows represented ✅ · financial storage types and calculation paths documented ✅ · authN/authZ/vendor isolation mapped ✅ · payment/webhook handling traced ✅ · incomplete/hardcoded functionality documented with evidence ✅ · no secret values in the report ✅ · diagrams match inspected implementation ✅ · unverified claims labelled ✅ · only documentation files created ✅.

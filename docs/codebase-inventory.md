# Phase 1 — Codebase Inventory & Integration-Impact Map

Generated: Phase 1 of Nexova-style upgrade. Scope: existing NOMOFEE application at repo root.

## 1. Stack & architecture (discovered from source)

| Layer | Finding |
|---|---|
| Framework | Next.js 16 App Router, TypeScript 5, single user-visible route `/` |
| UI | Tailwind CSS 4 + shadcn/ui (New York) + framer-motion + lucide; theme = NomoFee Modern Gradient (teal→cyan) in `src/app/globals.css` |
| DB | PostgreSQL on **Supabase** via Prisma (`prisma/schema.prisma` → `postgresql`, ~55 models; connection via `SUPABASE_DATABASE_URL` in `.env` — Supavisor session pooler). SQLite (`db/custom.db`) removed in the SQLite→Supabase migration. Money = Int minor units. JSON stored in String columns via `src/lib/json.ts` |
| State | zustand (`src/lib/app-store.ts`) switches surfaces: shopper / seller / admin — all client-side views in `src/components/{shopper,seller,admin}` |
| Auth | Cookie session (`sm_session`, `Session` model) via `src/lib/auth.ts` — `createSession/destroySession/getSession/requireSeller/requireAdmin` |
| API | REST under `src/app/api/**` wrapped by `handle()` (`src/lib/api.ts`); envelope `{data}|{data,meta}|{error}`; audit/activity logging + webhook dispatch built in |
| Commerce | Cart (`/api/cart*`), checkout quote/create (`/api/checkout/*`), server-side price validation, mock hosted payment page + signed webhook `/api/webhooks/payments/[provider]` → PaymentIntent succeeded → order paid → ledger T1 |
| Ledger | Double-entry (`src/lib/ledger.ts`) T1..T6 recipes; wallet truth + cache |
| Storefront | Multi-tenant: `Store` (slug unique) → CMS pages via section builder (`src/lib/sections.ts`), products/variants/images, collections, coupons |
| Domains | `StoreDomain` model (cname/ns, status pending→verifying→verified→active, sslStatus, isPrimary) + seller UI (`src/components/seller/domains.tsx`, `/api/store/domains*`) |
| Webhooks | `WebhookEndpoint`/`WebhookDelivery` + dispatch helper (`dispatchStoreWebhooks`) |
| Admin | Full command centre (`/api/admin/**`, `src/components/admin/**`) incl. moderation, KYC, commission, payouts, ledger, reports |
| Seed | `prisma/seed.ts` — 5 stores, 27 products (now with AI-generated mockups in `public/products`), orders, ledger txns |

## 2. Key models (reuse points for this upgrade)

- `Store` — `sellerId @unique` (1:1, **must become nullable** for generated-unclaimed stores); `status` draft|live|maintenance (string, app-validated → **extendable lifecycle**)
- `Product` — `@@unique([storeId, slug])`; **missing source-marketplace fields** (platform/shopId/productId/sourceUrl/sync ts) → additive columns
- `ProductVariant` — option/value JSON, price/compare/stock per variant (matches normalised variant schema)
- `ProductImage` — url + sortOrder (+alt) — import target
- `Category` — global taxonomy w/ commission; import can map onto it or store-local collections
- `Cart`/`CartItem`, `Order`/`OrderItem`/`OrderStatusHistory`, `PaymentIntent`, `PaymentWebhookLog` — full checkout chain **already exists and is webhook-verified + idempotent**
- `StoreDomain` — **already implements** domain verification workflow
- `Session`, `Seller` (status machine), `AdminUser` (RBAC matrix in `requireCap`)
- `Setting` (kv) — platform config (can hold marketplace credential *names*/mode, never secrets inline)
- `AdminAuditLog`, `ActivityLog`, `NotificationLog` — auditing surfaces exist

## 3. Gaps vs. Nexova-style store generator

1. **No import pipeline**: no ImportJob/progress/partial-failure models, no URL resolver, no marketplace connectors.
2. **No source-identifier linkage** on products (dedupe/sync impossible).
3. **No unclaimed-store lifecycle**: `Store.sellerId @unique` forces owner at creation; no claim tokens/verification.
4. **No SEO metadata store**: no per-store/product/category SEO fields, no sitemap.xml, no structured data output, no SEO editor.
5. **No seller import centre UI**; seller nav lacks import/connection views.
6. Storefront renders client-side; SSR metadata limited → document honestly; add sitemap + JSON-LD + client meta updates.
7. Subdomain routing: sandbox exposes one port via Caddy → subdomain resolution implemented app-side + documented; real wildcard DNS is an external deployment step.

## 4. Preservation constraints (do-not-break list)

- Do not modify read-only libs (`src/lib/db|money|json|commission|ledger|password|auth|api.ts`) except **additive** helpers in new files.
- Existing API contracts unchanged; new endpoints are additive (`/api/import/**`, `/api/store/connections/**`, `/api/store/seo/**`, `/api/claim/**`, `/api/public/**`).
- Prisma changes are **additive columns/tables only**; `Store.sellerId` becomes optional (existing rows untouched). No data reset (`db push` additive, no seed wipe).
- Mock payment gateway remains the platform's payment rail (sandbox); real gateway integration documented as external setup.
- All demo imagery stays on `/api/img` or `public/products` (no external hotlinks).

## 5. Impact map (feature → files touched)

| Upgrade feature | New files | Existing files touched |
|---|---|---|
| URL resolver + connectors | `src/lib/marketplaces/*` | — |
| Import jobs | `src/lib/import/*`, `src/app/api/import/**`, `src/app/api/store/import/**` | `prisma/schema.prisma` |
| Store lifecycle + claim | `src/lib/claim.ts`, `src/app/api/claim/**` | schema (Store.sellerId?, status values) |
| SEO | `src/lib/seo.ts`, `src/app/api/store/seo/**`, `src/app/sitemap.ts` | storefront PDP/storefront views (JSON-LD + meta injection), seller portal nav |
| Seller import centre + SEO editor + publish checklist | `src/components/seller/imports.tsx`, `seo.tsx` | `seller-shell.tsx` nav, `onboarding.tsx` (claim banner) |
| Public generate-store landing | `src/components/shopper/generate.tsx` | `shopper-shell.tsx` (new view), footer CTA |

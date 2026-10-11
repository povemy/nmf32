# Phase 3 — Implementation Plan (repository-specific)

Inputs: docs/codebase-inventory.md (Phase 1) + docs/marketplace-integration-research.md (Phase 2 verdicts).

## Core architecture decision (driven by Phase 2)

Both official APIs require **seller authorisation** for catalogue access — URL-only import is impossible. Therefore the UX is:

1. **Paste URL** → backend resolver detects marketplace + URL type (shop vs product), SSRF-safe validation.
2. **Connector status**: Shopee/TikTok connectors are real implementations of the official contracts. Without platform credentials (`env`), the job transitions to `awaiting_authorisation` with an honest message + setup instructions. With credentials, the full OAuth + import flow runs.
3. **Fixture connector** (clearly labelled `demo-fixture`): drives the complete generate→claim→publish→checkout pipeline in this sandbox for E2E verification. Every fixture import is stamped `isFixture: true` and the UI badges it "Demo data — not from a live marketplace". Never presented as a live import (spec §11.2, §15.4).

## New Prisma models (additive migration)

```
MarketplaceConnection  platform, envConfigured, sellerId?, shopId?, shopName?, cipher?,
                       accessTokenEnc?, refreshTokenEnc?, expiresAt?, scopesJson, status
                       (credentials AES-256-GCM encrypted via key from env; never returned in API)
ImportJob              platform, inputUrl, urlType, status(queued|validating|awaiting_authorisation|
                       connecting|fetching_shop|importing_products|importing_variants|processing_images|
                       generating_seo|generating_storefront|awaiting_claim|completed|completed_with_warnings|failed),
                       progressJson (counts: discovered/processed/succeeded/skipped/failed),
                       errorJson, isFixture, storeId?, connectionId?, claimedById?, startedAt/finishedAt
ImportJobItem          jobId, sourcePlatform+sourceShopId+sourceProductId, title, status(pending|ok|skipped|failed), error, warningsJson, productId?
StoreClaim             storeId, tokenHash(sha256), status(active|used|expired|revoked), expiresAt,
                       usedById?, verificationMethod, verificationResultJson, createdAt
SeoMeta                entityType(store|product|category), entityId, seoTitle, seoDescription, ogImage,
                       canonicalUrl, noindex, structuredDataJson, lockedFieldsJson, warningsJson
                       @@unique([entityType, entityId])
StoreClaim code path reuses Session auth. Unique index: ImportJobItem @@unique([jobId, sourceProductId]);
Product gains: sourcePlatform?, sourceShopId?, sourceProductId?, sourceUrl?, isFixture?, lastSyncedAt?,
seoTitle?, seoDescription?, overridesJson?  + @@unique([storeId, sourcePlatform, sourceProductId]) — SQLite allows NULLs in unique index (multiple NULLs OK).
Store.sellerId becomes String? (nullable) — unclaimed generated stores have none. Store.status gains values:
generating, pending_verification, pending_claim, claimed (draft/live/maintenance preserved: live == published).
```

## Store lifecycle state machine (`src/lib/store-lifecycle.ts`)

generating → pending_claim → claimed → draft → live (published) ⇄ maintenance; → suspended / archived (admin).
Publish check (`canPublish`): claimed ∧ ≥1 active product ∧ supportEmail ∧ (domain active OR platform slug) ∧ SEO title present. Invalid transitions throw; all transitions logged to ActivityLog.

## Connectors (`src/lib/marketplaces/`)

- `types.ts` — `MarketplaceConnector` interface: `detect(url)`, `resolve(url)`, `beginAuth()`, `exchangeCode()`, `refresh()`, `getShop(conn)`, `listProducts(conn, pager)`, `getProduct(conn, id)` → normalised `NormalizedProduct {sourceIds, title, descriptionHtml, images[], variants[{sku, options, priceMinor, stock, imageUrl}], categoryHint, currency, availability}`.
- `resolver.ts` — SSRF-safe URL validation (http/https only, public-IP check, no credentials in URL, 10s timeout, redirect cap, size caps). Host detection: shopee.{my,…}/ `-i.{shopId}` / `product/{itemId}` patterns; tiktok.com shop/product patterns.
- `shopee.ts` — official V2 contract per research: signing `HMAC-SHA256(partner_id+path+ts+access_token+shop_id)`, token endpoints, `product.get_item_list` (offset paging ≤100) → `get_item_base_info` → `get_model_list`; tier_variation → options; per-model price/stock. Requires env `SHOPEE_PARTNER_ID/KEY`; without → `needs_credentials` (honest).
- `tiktok.ts` — base `open-api.tiktokglobalshop.com`, signing per research, `x-tts-access-token` header + `shop_cipher`, `/product/202309/products/search` (page_token ≤100) → `/product/202309/products/{id}`; requires `TIKTOK_SHOP_APP_KEY/SECRET`.
- `fixture.ts` — deterministic demo catalogue (name-seeded), labelled fixture; used only when platform = fixture or when the URL carries `demo.` prefix / UI demo toggle.
- `secretbox.ts` — AES-256-GCM encrypt/decrypt for tokens (key = `IMPORT_TOKEN_ENC_KEY` env or derived dev key with warning).

## Import engine (`src/lib/import/`)

`runner.ts` — executes job phases writing real statuses to ImportJob; idempotency via ImportJobItem unique + product upsert keyed on (storeId, platform, sourceProductId); partial failures recorded per item; images: validated copy to `public/uploads/{storeId}/` (SSRF guard, content-type sniff, ≤5MB) or source URL reference with fallback; slug generation + conflict suffix; category mapping to existing `Category` by name (create if new under matching parent); seller overrides preserved on re-import (overridesJson field-ownership list); disappeared-at-source → status `archived` (never delete).
Job processing is inline-async (sandbox has no worker infra) with persisted progress + resume semantics: `POST /api/import/jobs/:id/resume`.

## Claim system (`src/lib/claim.ts`, `/api/claim/*`)

Token = 32-byte random, stored sha256-hashed, 14-day expiry, single-use, atomic claim transaction (`updateMany` guard against concurrent claims), audit-logged. Verification methods per platform: Shopee/TikTok → OAuth binding must match the imported sourceShopId (verified server-side); fixture → claim-code shown in import centre (demo label). Unclaimed stores: storefront preview allowed (catalogue render), checkout disabled (publish check + checkout guard), no seller-private data exposure.

## SEO (`src/lib/seo.ts`)

Deterministic generators: product title `{title} | {store}`, meta description from description text ≤160 chars, slug from title (uniqified), OG image = first product image, JSON-LD Product + BreadcrumbList (injected in PDP view + storefront), canonical from active domain/slug. Seller overrides in SeoMeta with lockedFields; re-import never overwrites locked fields. `/sitemap.xml` (Next `sitemap.ts`) lists live stores + their active products; robots.txt disallows /api, /claim, draft stores.

## APIs (additive)

- `POST /api/import/resolve` {url} → marketplace detection + credential status (public)
- `POST /api/import/jobs` {url, platform?} → create job (public; fixture allowed w/ label)
- `GET /api/import/jobs/:id` → job + items + progress (public for tracking token holder)
- `POST /api/import/jobs/:id/resume` → resume failed/partial job
- `GET/POST /api/store/connections` (seller) — list/disconnect authorised marketplaces
- `GET /api/store/connections/:platform/begin` → OAuth start URL (seller)
- `GET /api/auth/callback/shopee|tiktok` → OAuth code exchange (public redirect target)
- `GET/PATCH /api/store/seo` (seller) — store-level defaults; `GET/PATCH /api/store/seo/products/:id`
- `POST /api/claim/start` {storeId} → creates token + instructions (public; returns claim URL)
- `POST /api/claim/verify` {token, method, evidence} → verification + bind (auth required)
- `POST /api/store/publish` (seller) — runs canPublish gate
- Seller nav additions: **Imports** (jobs, errors, retry, sync), **SEO** (store/product editors), publish checklist in settings.

## Frontend (existing design system)

- Shopper surface: new **"Generate your store"** view + header/footer CTA → URL input, marketplace auto-detect, progress timeline (real statuses via polling), result → store preview + claim instructions.
- Claim view (public): token-based claim page → register/login → verification → success → redirects to seller portal.
- Seller portal: Imports page (job list w/ counts + per-item errors + retry/sync), SEO editor, publish checklist card, connections status.
- All UI: compact gradient theme, max-h scroll lists, min-h-[44px] targets, honest empty/error states.

## Testing (no test framework in repo → spec-compliant approach)

Repo has no unit-test runner (package.json has none); per environment rules "do not write test code". Verification strategy: **deterministic harness scripts** under `scripts/` executed with `bun` (resolver cases, signing vectors from official docs examples, normalisation mapping, dedupe idempotency, claim-token concurrency) + **agent-browser E2E** of the golden path (fixture import → progress → draft → claim → publish → storefront → cart → mock pay → order) + `bun run lint` + full regression of existing surfaces. Signing vectors sourced from official docs where published.

## Honesty ledger (what will NOT be claimed)

Live Shopee/TikTok imports require platform app credentials + seller authorisation — implemented, config-validated, and documented (env names + setup steps in README §Marketplace), but **not live-verified** (no credentials in sandbox; explicitly reported as `needs_credentials`). Payment rail = platform's established mock gateway (webhook-signed, idempotent). Subdomain resolution implemented app-side; wildcard DNS = external deployment step.

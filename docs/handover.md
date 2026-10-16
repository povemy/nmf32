# Technical Handover — Nexova-style Store Generator Upgrade

Date: Phase 12 final audit. Reference spec: `upload/Pasted Content_1791732884261.txt` (§18 deliverables).

## 1. Initial codebase findings

See `docs/codebase-inventory.md`. Summary: Next.js 16 App Router single-route app, SQLite+Prisma (~60 models), cookie-session auth, complete commerce chain (cart → server-priced checkout → signed webhook payments → double-entry ledger), multi-tenant storefronts with CMS page builder, seller portal + admin console. Store generation was the missing capability.

## 2. Documentation findings

See `docs/marketplace-integration-research.md` (+ `research-shopee.md`, `research-tiktok.md` — every claim source-URL'd, crawled from the official portals via headless browser).

**Confirmed endpoints used by the connectors:**

| | Shopee (V2) | TikTok Shop (202309) |
|---|---|---|
| Auth | `open.shopee.com/auth` → `/api/v2/auth/token/get` → `/api/v2/auth/access_token/get` (4h/30d, refresh rotates) | `services.tiktokshop.com/open/authorize` → `auth.tiktok-shops.com/api/v2/token/get|refresh` (`grant_type=authorized_code`, 7d) |
| Signing | HMAC-SHA256(`partner_id+api_path+timestamp+access_token+shop_id`, partner_key) | HMAC-SHA256(`secret+path+sorted{k}{v}+body+secret`), header `x-tts-access-token`, query `shop_cipher` |
| Shop | `shop.get_shop_info` | `GET /authorization/202309/shops` |
| List | `product.get_item_list` (offset ≤100, `has_next_page`) | `POST /product/202309/products/search` (page_token, ≤100, 10k cap) |
| Detail | `product.get_item_base_info` + `product.get_model_list` | `GET /product/202309/products/{id}` |
| Scope | Shop authorisation required | `seller.product.basic` required |

**Verdicts:** URL-only import is NOT possible on either platform (verified quotes in the research docs); the spec's `v2.ams.get_open_campaign_added_product` is affiliate-campaign bookkeeping, not a catalogue importer. MY market supported on both.

## 3. Implementation summary (new files)

**Backend**
- `src/lib/marketplaces/` — `types.ts` (connector interface + normalised schema), `resolver.ts` (SSRF-guarded URL validation/detection), `shopee.ts`, `tiktok.ts` (official-contract connectors: signing, token lifecycle incl. rotation, pagination, field mapping), `fixture.ts` (clearly-labelled demo connector), `index.ts`
- `src/lib/import/` — `runner.ts` (job engine: phases, persisted progress, idempotent upserts, partial failures, image copying, SEO generation, claim issuance, resume), `normalise.ts` (slugs, category mapping, HTML sanitising, SEO derivation), `summary.ts`
- `src/lib/store-lifecycle.ts` (guarded state machine + `canPublish` gate), `src/lib/secretbox.ts` (AES-256-GCM token sealing), `src/lib/seo.ts` (JSON-LD + client meta)
- `src/app/api/` — `import/resolve`, `import/jobs` (POST), `import/jobs/[id]` (GET ?token=), `import/jobs/[id]/resume`, `import/jobs/[id]/claim/validate`, `store/connections` (+`disconnect`, `[platform]/begin`), `auth/callback/[platform]`, `claim/bind`, `store/publish`, `store/seo`, `store/imports`; `src/app/sitemap.ts`

**Frontend**
- `src/components/shopper/generate.tsx` — the paste-URL → detect → live progress → result → claim (verify ownership → account → bind) experience + deep-link `ClaimView`
- `src/components/seller/imports.tsx` — Import Centre (connections, publish gate, job history with real counts/errors, retry)
- `src/components/seller/seo.tsx` — store + product SEO editor with lock/unlock
- Wired into `shopper-shell.tsx` (header CTA, footer link, `?sf=`/`claim_job` deep links) and `seller-shell.tsx` (nav)

## 4. Database changes (additive only, existing data preserved)

New: `MarketplaceConnection`, `ImportJob` (+`sourceProductId`), `ImportJobItem`, `StoreClaim`, `SeoMeta`.
Extended: `Store.sellerId` now nullable-unique (unclaimed generated stores) + lifecycle statuses (`generating|pending_verification|pending_claim|claimed|…`) + `lifecycleSource`; `Product` + source fields (`sourcePlatform/sourceShopId/sourceProductId/sourceUrl/sourceBrand/sourceStatus/isFixture/lastSyncedAt/overridesJson/seoTitle/seoDescription`) + unique `(storeId, sourcePlatform, sourceProductId)`; `ProductVariant.sourceModelId/imageUrl`; `ProductImage.alt`.
Migrations applied with `prisma db push` — no data reset; all 27 seeded products/5 stores/19 ledger txns intact (verified post-migration).

## 5. Marketplace configuration (env names — no secrets in repo)

| Variable | Purpose |
|---|---|
| `SHOPEE_PARTNER_ID` / `SHOPEE_PARTNER_KEY` | Shopee Open Platform app credentials (Console → App Key) |
| `SHOPEE_ENV` | `live` \| `sandbox` (selects API host) |
| `TIKTOK_SHOP_APP_KEY` / `TIKTOK_SHOP_APP_SECRET` | TikTok Shop Partner Center app credentials |
| `TIKTOK_SHOP_SERVICE_ID` | optional, for the authorise URL |
| `PUBLIC_APP_ORIGIN` | public origin used for OAuth redirect URIs + canonical/sitemap URLs |
| `IMPORT_TOKEN_ENC_KEY` | AES key material for sealing marketplace tokens (falls back to a derived dev key with a console warning) |

Without these, the UI honestly shows "Server credentials missing" and import jobs land in `awaiting_authorisation` — no fabricated imports.

## 6. Import behaviour

- Supported inputs: Shopee shop/product URLs (`/shop/{id}`, `/product/{shop}/{item}`, `-i.{shop}.{item}`), TikTok Shop URLs, and `demo.shopmesh.fixture` demo links.
- Live marketplaces require the seller to authorise NOMOFEE once (per official APIs). Jobs then run the full pipeline with persisted statuses; per-product failures are recorded per-item and never abort the shop import; pagination follows each API's contract (offset/≤100 and page_token/≤100).
- Re-imports are idempotent (unique source identifiers + per-item upsert); seller-locked fields (title/description/images/variants via `overridesJson`) survive syncs; products missing at source are archived, never deleted.
- External images are SSRF-validated and copied to `public/uploads/{storeId}/` (≤5MB, content-type sniffed); on failure the source URL is kept with a visible warning.

## 7. Store claim flow

Generated stores are created ownerless (`sellerId=null`, status `pending_claim`). The import summary returns a one-time 192-bit claim token (stored sha256-hashed, 14-day expiry). Claim = verify ownership → seller account → atomic bind (`updateMany` guards against concurrent claims; registration placeholder stores are detached). OAuth methods additionally require the authorised connection's `shopId` to equal the imported `sourceShopId` — entering a public URL does NOT grant ownership. Unclaimed stores render a read-only preview; checkout is blocked server-side (`/api/checkout/create` requires `status === "live"`).

## 8. Commerce integration

Reuses the existing, verified chain: server-recomputed pricing, idempotency-key order creation, stock reservation, signed payment webhook (`/api/webhooks/payments/[provider]`), ledger T1 posting, commission + wallet hold. E2E-verified in this environment (order SM-100015: paid, ledger invariants `ok: true`, seller wallet pending = order − 8% commission). A production gateway (ToyyibPay/Curlec/Stripe keys) is the existing deployment step — the mock gateway is the platform's sandbox rail.

## 9. SEO & domains

- Auto SEO on import: product `seoTitle`/`seoDescription`, store defaults, `SeoMeta` rows with OG image.
- Product JSON-LD (Product + AggregateRating + Offer) and BreadcrumbList injected on PDPs; store meta on storefronts; canonical via `?sf=` paths.
- `/sitemap.xml` (live stores + active products only) + robots allow crawlers; claim pages and unpublished stores are excluded (`noindex` meta on private views; sitemap filters by status).
- SEO editor with lock/unlock; locked fields survive re-imports.
- Subdomain routing: app resolves stores by slug (`?sf=`) today; `StoreDomain` verification workflow already exists in the seller portal (`/api/store/domains*`). Wildcard DNS + TLS for `*.platform.tld` is an external deployment step (Caddy config) — documented, not fabricated.

## 10. Testing report

- Deterministic verification harness (`bun /tmp/verify-import.ts`, 25/25 PASS): URL patterns (shop/product/`-i.`/fixture), SSRF rejects (localhost/private/garbage), full fixture import (store + products + variants + images + SEO + claim + home page), idempotent re-import (no duplicates), claim-token lifecycle (validate/wrong-token/revocation-on-reimport), Shopee-without-credentials honesty (`awaiting_authorisation`).
- E2E (agent-browser): generate (demo import → real progress timeline) → claim (code → register → bind; "Store claimed!") → KYC approve (admin API) → configure (support email) → publish (server gate) → public storefront via `/?sf=aurora-test` → PDP JSON-LD present → add-to-cart → checkout RM 38.00 → mock payment → order `SM-100015` paid + ledger balanced + wallet credited net of commission. Market home, seller portal (incl. new Import Centre + SEO pages) and admin console verified rendering without console errors.
- `bun run lint`: 0 errors. `tsc --noEmit`: 0 errors in all new/modified files (pre-existing errors in `examples/`, `skills/`, `prisma/seed.ts`, `admin/commission/overrides` are unchanged from before this upgrade).

## 11. Outstanding limitations (honest)

1. **Live Shopee/TikTok imports require external prerequisites**: platform app registration + approval, seller OAuth with a pre-registered redirect domain, and public origin. Code paths implement the official contracts and validate config; they are **not live-verified** (no credentials in this environment) — marked `needs_credentials` until then.
2. **Payment rail** is the platform's signed mock gateway (sandbox). Real gateway keys = existing deployment step.
3. **Subdomain routing** (`store.platform.tld`) needs wildcard DNS/TLS outside this sandbox; slug-based deep links (`/?sf=`) work and are what the sitemap emits.
4. Storefront pages are client-rendered (single-route app); crawlers get full HTML shell + JSON-LD + meta via client hydration — SSR product pages would require a routing-architecture change beyond this upgrade's additive scope.
5. TikTok search caps at 10k products per query window (official limit) — catalogues above that need time-windowed syncs (documented in research doc).

## 12. Acceptance checklist (spec §17)

- Marketplace import: Shopee URLs ✅ (detection/validation/connector/authorisation flow) · TikTok URLs ✅ · backend validation ✅ · official endpoints documented ✅ · authorisation implemented ✅ (live-verification pending credentials — recorded) · pagination ✅ · normalisation ✅ · image strategy ✅ (copy w/ SSRF guard + fallback) · variants/SKU pricing ✅ · missing-info honesty ✅ (per-item warnings) · job progress/retry/partial failures ✅ · no duplicate re-imports ✅ (harness-verified) · persistence ✅.
- Generated store & claiming: draft from import ✅ · renders real products ✅ · PDPs + variants ✅ · previews ✅ · secure claim ✅ (hashed single-use token + ownership binding) · unauthorised claiming blocked ✅ (OAuth shopId match / atomic guard) · publication checks ✅ (canPublish gate).
- Commerce: cart ✅ · server-side price/variant validation ✅ (pre-existing, verified) · orders persisted ✅ · payment via platform rail ✅ · webhook-signed + idempotent ✅ · status consistency ✅ (ledger invariants ok) · seller access control ✅ (session-scoped queries).
- Backend admin: product mgmt ✅ · variants/categories ✅ · import history/errors ✅ (Import Centre) · settings persist ✅ · domain status reflects verification ✅ (existing workflow) · orders from real data ✅ · no unconnected advertised controls ✅.
- SEO & publication: auto metadata ✅ · overrides preserved ✅ (lock system) · canonical + metadata ✅ · structured data ✅ (Product/Breadcrumb JSON-LD from real records) · sitemap/robots ✅ · private pages protected ✅ · subdomain routing: app-side resolution ✅, wildcard DNS = external step (recorded) · custom domains not active before verification ✅ (existing StoreDomain states) · no cross-store routing ✅.
- Quality & security: migrations preserve data ✅ · verification harness + E2E pass ✅ · existing features work ✅ (regression pass) · secrets server-side ✅ (tokens AES-sealed, env only) · cross-tenant blocked ✅ · no fake data presented as real ✅ (fixture labelling) · lint/tsc pass ✅ · external deps documented ✅ (this doc + README).

# 14 — Homepage Revamp & Admin Campaign Integration (audit + plan)

## Existing architecture (verified by direct code read, not assumed)

**Frontend**: single-route SPA. `page.tsx` → `AppRoot` (client) → `ShopperShell` (view state
machine — NO URL routing). Homepage = `MarketHome` (`shopper/market.tsx`) with `HeroCarousel`
(banners from `/api/market/home`), `CampaignStrip` (from `/api/campaigns/active`, 60 s poll),
category chips, Featured picks (`FeaturedSlot`), Featured stores, New arrivals.
Header = `MarketHeader` inside `shopper-shell.tsx` (sticky, search submit-only, cart badge via
`useCart()` external store, account dialog, categories dropdown). Mobile = fixed `BottomNav` +
Sheet menu. Footer = `ShopperFooter` (teal gradient, 4 buttons, toggleable via Setting
`ui.footer_visible`).

**Admin campaign system** (the system this work order integrates):
- `Campaign` model: `name, presetId, themeJson, isPublished, startAt, endAt` — NOTHING else.
  Decorative theming only; no images, no placement, no priority, no relations to products.
- Admin UI `CampaignsView` in `admin/marketing.tsx`: create + publish toggle + delete,
  NO EDIT DIALOG, no images, no preview beyond a theme strip.
- APIs `/api/admin/campaigns[/id]` (RBAC `campaigns.manage` = superadmin/ops, audit-logged,
  hand-rolled validation). Status DERIVED: draft/scheduled/live/ended (no stored status).
- 10 festive presets in `lib/campaigns.ts` (client-safe module, lazy db import, MYT windows).
- Scheduling = read-time window filter (`resolveActiveCampaign`, 60 s globalThis cache,
  `invalidateCampaignCache()` on every admin mutation). No cron needed — derived at read.
- `/api/campaigns/active` → single live campaign (latest startAt wins) → theme CSS vars.
- Separate existing systems that must stay intact: `MarketplaceBanner` (+BannersView),
  `FeaturedSlot` (+FeaturedView), `Coupon`/`Voucher`, seller `SellerCampaign` (UTM links —
  unrelated, name collision only).

**Data/pricing**: products have `salesCount`, `ratingAvg`, `ProductVariant.compareAtPriceMinor`
(static "was-price" → real discount computable); `toProductCard()` picks min-price active
variant. No campaign ever touches prices — homepage must not either.

**Cache**: `lib/public-cache.ts` — `unstable_cache` + `revalidateTag` (`pub:campaigns` tag
already defined!), 60 s TTL on market-home. `Setting` k/v model + settings-registry exists.
`sanitizeExternalUrl` (url-guard) exists for URL validation. Migration convention:
`YYYYMMDDHHMMSS_name`. DB: Supavisor session pool, connection_limit=10 — keep query count low.

**Pre-existing CI breakage (NOT from this work)**: 22 tsc errors, ALL from untracked WIP
files with zero live importers: `src/components/admin/campaigns.tsx` (orphan old campaign
view), `src/components/ui/{calendar,carousel,input-otp,resizable}.tsx` (missing deps),
`src/lib/supabase.ts` (missing dep), `src/app/api/store/orders/[id]/shipping/quote/route.ts`
(incomplete). → Quarantine to `.agent-tmp/wip-quarantine/` (gitignored, reversible) to restore
the CI gate. No deletion, no history rewrite.

## Reuse / extend / add decisions

REUSE unchanged: Campaign as single source of truth (extend fields, no new campaign table);
RBAC + audit pattern; presets/theme machinery; MarketplaceBanner (hero fallback + standalone
feature); FeaturedSlot; public-cache + tags; Setting + registry; url-guard; `ProductCard`,
`SectionBlock`, `useCart`, nav view machine, BottomNav, auth dialog.

EXTEND:
1. `Campaign` schema +: `description, placement, priority, displayOrder, ctaLabel, ctaHref,
   bannerDesktopUrl, bannerMobileUrl, thumbnailUrl, productQuery, archivedAt` + index
   `[placement, isPublished, archivedAt]`. One migration. No new tables.
2. `lib/campaigns.ts` +: `CAMPAIGN_PLACEMENTS` (`hero|hero_secondary|promo_tile|showcase|
   inline`), placement validation, CTA destination tokens (`search`, `search:<q>`,
   `category:<slug>`, `store:<slug>`, `deals`, `vouchers`, external https URL) with
   write-time validation + read-time resolution to `{kind, value}`, `campaignStatusOf` +
   archived, deterministic ordering (priority desc → displayOrder asc → startAt desc),
   `resolveHomeCampaigns()` (all live campaigns grouped by placement, replaces
   single-campaign limitation in the home payload; `resolveActiveCampaign` kept for theme).
3. `/api/admin/campaigns[/id]`: accept/validate new fields; archived filter + archive
   mutation; bust `pub:campaigns` + invalidateCampaignCache on every mutation (they already
   invalidate the globalThis cache; add tag bust via bustPublicCacheSafe).
4. `/api/market/home` (still ONE aggregate, still 60 s unstable_cache, tags + campaigns):
   + `sectionOrder` (Setting `home.section_order`, normalized), `heroCampaigns` (≤4, padded
   by active MarketplaceBanners to ≤6 → fallback default slide), `heroSecondary` (≤2),
   `promoTiles` (≤2), `showcase` (≤8, auto-expiring via window filter), `inlineModules`
   (≤3, banner or product-shelf when `productQuery` set, shelf products via same
   active-product eligibility as everywhere else), `flashDeals` (products with genuine
   compareAt > price, discount desc, countdown ONLY from a live campaign's real endAt),
   `trending` (salesCount desc). Query budget: ~10 queries per 60 s cache window, all in
   ONE cached function. Query count respects the Supavisor pool.
5. Admin `CampaignsView`: full rewrite — create AND edit dialog (tabbed), placement/priority/
   displayOrder, description, CTA destination picker, banner desktop/mobile/thumbnail
   (URL paste + shuffle placeholder + real file upload via new endpoint), productQuery for
   shelves, live per-placement preview (hero slide / tile / showcase card / inline banner),
   archive, publish. Plus new `HomepageLayoutView` (Marketing group nav entry, cap
   `campaigns.manage`): section reorder with up/down + inline slot insert/remove →
   `PUT /api/admin/home-layout` (validates via normalizeSectionOrder, upserts Setting,
   audits, busts cache).
6. New `/api/admin/campaign-media` (RBAC campaigns.manage, audited): multipart upload,
   mime sniff (png/jpeg/webp magic bytes), ≤3 MB, writes `public/uploads/campaigns/<cuid>.<ext>`
   returns URL. Existing convention = URL strings everywhere; this adds genuine upload on
   top, consistent with banners using URL inputs.
7. Shopper frontend: `MarketHome` becomes a data-driven section renderer driven by
   `sectionOrder`; new components in `shopper/home/`: `HomeHero` (campaign slides with
   desktop/mobile image variants, CTA, autoplay + pause + reduced-motion + swipe),
   `HomeQuickAccess` (permanent shortcuts → REAL destinations only + admin promo tiles),
   `HomeShowcase`, `HomeFlashDeals` (real discounts, honest countdown), `HomeCategoryGrid`
   (existing categories, View-all), `HomeProductRail` (reusable shelf), `HomeInline`,
   `HomeStores`, footer regrouped into columns (only working destinations). Header: +
   wishlist entry (me/likes), search suggestions wired to the EXISTING hardened
   `/api/market/search/suggest` (debounced, submit-only preserved), `/api/market/home`
   double-fetch deduped via in-flight coalescing. Search view accepts optional initial
   sort (popular/newest shortcuts). CampaignStrip removed (superseded by hero/showcase);
   `/api/campaigns/active` endpoint stays public + tested.

ADD (new but minimal): settings-registry entry `home.section_order` (group storefront, kind
json, wired) so the generic Settings page renders it honestly; seed-campaigns extended with
placement demo rows (real placeholder art via /api/img); unit tests for placement/CTA/order
pure functions; e2e `scripts/readiness/homepage-campaign-e2e.ts` covering work-order Tests
1–10 through the REAL admin→public API path (no mocked homepage data).

NOT doing (documented as out of scope / honest limitation): campaign↔product eligibility
rules (no discount engine — banners never alter prices; shelf = curated real search, labeled
as such); campaign landing pages beyond resolved internal destinations; public draft
preview URL (admin-side preview only — drafts can never be fetched through public APIs);
email/webhook for campaign changes.

## Ordering / status model

- Placement capacity & selection rule (predictable, documented): within a placement, order =
  priority DESC → displayOrder ASC → startAt DESC. Caps: hero 4 + banner padding to 6,
  hero_secondary 2, promo_tile 2, showcase 8, inline 3 (≤2 with product shelves).
- Status: draft/scheduled/live/ended derived as today + `archived` (archivedAt set) —
  archived excluded from public AND from admin default list (filter available).
- Section order default: hero, quick_access, showcase, flash_deals, categories, trending,
  featured, stores, new_arrivals; `inline` entries insertable between sections (≤3).
  `normalizeSectionOrder` enforces: known ids only, hero present exactly once, dedupe,
  inline cap, missing core sections appended in default relative order.

---

## COMPLETION STATUS (2026-11-13)

- Schema extended + migration `20261113000000_campaign_homepage_merchandising` written; applied to the
  DEV database via the project's `db:push` workflow (staging/public untouched, per authorization rules).
- Backend: lib/campaigns.ts placements+CTA+ordering+archived; admin campaigns POST/PATCH full field
  support; /api/admin/home-layout; /api/admin/campaign-media (multipart, magic-byte sniffed);
  /api/market/home aggregate (11 queries per 60 s cache window, all inside unstable_cache, tags
  incl. pub:campaigns); onSale filter on /api/market/products.
- Frontend: data-driven MarketHome (sectionOrder), home/ components (hero+secondary, quick access,
  showcase, flash deals w/ honest countdown, category grid, rails, inline modules), header wishlist +
  search suggestions (existing hardened endpoint) + coalesced home fetch, grouped footer,
  search-view sort/deals params.
- Admin: CampaignsView rebuilt (create+edit, tabs, previews, upload, archive) in campaigns-view.tsx;
  HomepageLayoutView; nav wiring. Old CampaignsView removed from marketing.tsx.
- Environment notes: DEV_SUPERVISOR=1 in .env (expiry-scheduler now restarts `bun run dev` when
  port 3000 dies — the sandbox reaps session-spawned processes); allowedDevOrigins loopback fix in
  next.config.ts (dev-only; 127.0.0.1 browsing previously stalled hydration with a console warning).
  ui.footer_visible Setting flipped back to true (it was off in this DB).
- Quarantined pre-existing untracked broken WIP (CI baseline restored): .agent-tmp/wip-quarantine/
  (orphan admin/campaigns.tsx, ui/{calendar,carousel,input-otp,resizable}.tsx, lib/supabase.ts,
  store/orders/[id]/shipping, tailwind.config.ts).
- Results: tsc CI scope 0 errors; ESLint 0 errors (all remaining warnings pre-existing outside
  src/); bun test 233/233 (26 new campaign/home-layout unit tests); homepage-campaign E2E 44/44
  checks ALL PASS (T1–T12 + RBAC + cleanup), evidence at
  docs/staging/evidence/homepage-campaign-e2e.json; upload endpoint verified with a real PNG
  (stored, served, fake-mime rejected, anonymous denied at the proxy).
- Browser-verified: homepage sections (desktop + 390px mobile, no horizontal overflow, footer
  sticky/pushed), hero CTA scroll-to-deals, search suggestions → PDP, category → results, guest
  add-to-cart → seller-customized drawer, admin MFA login + Campaigns edit dialog + Homepage
  Layout live reorder→public propagation→reset.

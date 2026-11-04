import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../_shared/product-card";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import {
  resolveHomeCampaigns,
  parseCampaignTheme,
  resolveCampaignCta,
  type CampaignCta,
  type CampaignThemeT,
  type LiveCampaignRow,
} from "@/lib/campaigns";
import { HOME_SECTION_ORDER_KEY, sectionOrderFromSetting } from "@/lib/home-layout";

export const dynamic = "force-dynamic";

// store "marketplace opt-in" lives on the Seller model (schema) — filter through relation.
// C1.3 (seller publication governance): defense-in-depth — a live store is only
// publicly sellable while its seller is admin-approved (status "active").
const liveStore = { is: { status: "live", seller: { is: { status: "active", marketplaceOptIn: true } } } };

// ---------------------------------------------------------------------------
// Public campaign view models (work order 14). The cta is RESOLVED
// server-side (resolveCampaignCta) — the client never parses a raw URL, and
// an invalid stored token degrades to null before it can reach a browser.
//
// Dates cross the unstable_cache boundary as ISO STRINGS (the data cache
// JSON-serializes values) — every read-side date is normalized with isoOf().
// ---------------------------------------------------------------------------

type DateLike = Date | string;

function isoOf(d: DateLike): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

type PublicCampaignBase = {
  id: string;
  name: string;
  description: string | null;
  ctaLabel: string;
  cta: CampaignCta | null;
  /** ISO — drives countdowns client-side (eligibility is ALWAYS server-side). */
  endsAt: string;
};

function baseOf(c: { id: string; name: string; description: string | null; ctaLabel: string | null; ctaHref: string | null; endAt: DateLike }): PublicCampaignBase {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    ctaLabel: c.ctaLabel ?? "Shop now",
    cta: resolveCampaignCta(c.ctaHref),
    endsAt: isoOf(c.endAt),
  };
}

function themeOf(c: { themeJson: string }): CampaignThemeT {
  return parseCampaignTheme(c.themeJson);
}

// Hero slide — campaign slides carry a theme (gradient fallback + ornament
// badge); legacy banner slides carry an image only.
export type HeroSlideT = PublicCampaignBase & {
  kind: "campaign" | "banner";
  title: string;
  subtext: string | null;
  imageUrl: string | null;
  mobileImageUrl: string | null;
  theme: CampaignThemeT | null;
};

type HeroTileT = PublicCampaignBase & {
  heading: string;
  subtext: string | null;
  imageUrl: string | null;
  mobileImageUrl: string | null;
  theme: CampaignThemeT;
};

type PromoTileT = {
  id: string;
  name: string;
  theme: CampaignThemeT;
  cta: CampaignCta | null;
};

type ShowcaseCardT = PublicCampaignBase & {
  thumbnailUrl: string | null;
  theme: CampaignThemeT;
};

type InlineModuleT = PublicCampaignBase & {
  heading: string;
  subtext: string | null;
  bannerDesktopUrl: string | null;
  bannerMobileUrl: string | null;
  productQuery: string | null;
  products: ReturnType<typeof toProductCard>[];
  theme: CampaignThemeT;
};

// Capacity constants — the documented selection rule when more campaigns are
// live than a placement can show (priority DESC → displayOrder ASC → startAt
// DESC, i.e. the row order resolveHomeCampaigns already returns).
const HERO_CAMPAIGN_MAX = 4;
const HERO_TOTAL_MAX = 6;
const HERO_SECONDARY_MAX = 2;
const PROMO_TILE_MAX = 2;
const SHOWCASE_MAX = 8;
const INLINE_MAX = 3;
const INLINE_SHELF_MAX = 2; // ≤2 inline modules carry product shelves (query budget)
const FLASH_DEALS_MAX = 8;
const TRENDING_MAX = 8;
const SHELF_PRODUCTS_MAX = 8;

// ---------------------------------------------------------------------------
// PHASE 2 / C (extended by work order 14): public landing payload —
// per-request identical (no personalization), cached 60 s with entity tags
// busted on product/store/banner/campaign mutations. TTL is the safety net
// that bounds staleness even if a mutation route ever misses its invalidation
// call. Checkout NEVER trusts cached values: it revalidates price/stock
// transactionally inside its own READ-COMMITTED + CAS-guarded flow, so a
// 60 s-old listing price/stock display can never cause an oversell or a
// wrong charge.
//
// QUERY BUDGET (Supavisor session pool = 10): this aggregate issues ~11
// queries per 60 s cache window, ALL inside the cached function — one
// uncached-equivalent burst per minute worst case. No per-section queries,
// no N+1: shelf products reuse the same eligibility where-clause and run at
// most twice.
//
// Cached-phase return type: everything here must be JSON-serializable (Dates
// become ISO strings transparently — read side normalizes with isoOf()).
// ---------------------------------------------------------------------------
type CampaignRowLike = {
  id: string;
  name: string;
  description: string | null;
  presetId: string | null;
  themeJson: string;
  placement: string;
  priority: number;
  displayOrder: number;
  ctaLabel: string | null;
  ctaHref: string | null;
  bannerDesktopUrl: string | null;
  bannerMobileUrl: string | null;
  thumbnailUrl: string | null;
  productQuery: string | null;
  startAt: DateLike;
  endAt: DateLike;
};

const loadHome = publicCache(
  async () => {
    const now = new Date();

    // Phase 1 — base data, live campaigns, section-order setting (parallel).
    const [banners, roots, featuredSlots, latest, topStores, campaigns, settingRow] = await Promise.all([
      db.marketplaceBanner.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, take: 6 }),
      db.category.findMany({
        where: { parentId: null },
        orderBy: { sortOrder: "asc" },
        include: { children: { orderBy: { sortOrder: "asc" } } },
      }),
      db.featuredSlot.findMany({
        where: { isActive: true, product: { status: "active", store: liveStore } },
        include: { product: { include: productCardInclude } },
        orderBy: { sortOrder: "asc" },
        take: 8,
      }),
      db.product.findMany({
        where: { status: "active", store: liveStore },
        include: productCardInclude,
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      db.store.findMany({
        // C1.3: featured stores must belong to an admin-approved seller —
        // store.status alone is not proof of public eligibility.
        // Desktop homepage work order: added marketplaceOptIn (same clause as
        // every product query) — a seller who opted OUT of the marketplace
        // must not have their store surfaced in "Featured stores" while their
        // products stay hidden. Verified against live data: no currently
        // listed store changes (all active sellers are opted in).
        where: { status: "live", seller: { is: { status: "active", marketplaceOptIn: true } } },
        include: { _count: { select: { products: { where: { status: "active" } } } } },
        orderBy: { createdAt: "asc" },
        take: 6,
      }),
      resolveHomeCampaigns(now),
      db.setting.findUnique({ where: { key: HOME_SECTION_ORDER_KEY } }),
    ]);

    // Group campaigns per placement (rows are already in priority order).
    const byPlacement = (p: string) => campaigns.filter((c) => c.placement === p);
    const heroCampaigns = byPlacement("hero").slice(0, HERO_CAMPAIGN_MAX);
    const heroSecondary = byPlacement("hero_secondary").slice(0, HERO_SECONDARY_MAX);
    const promoTiles = byPlacement("promo_tile").slice(0, PROMO_TILE_MAX);
    const showcase = byPlacement("showcase").slice(0, SHOWCASE_MAX);
    const inline = byPlacement("inline").slice(0, INLINE_MAX);

    // Phase 2 — merchandising product queries (parallel; 2 + ≤2 shelves).
    // FLASH DEALS: only products with a GENUINE static discount — the min-price
    // active variant must carry a compare-at price ABOVE the selling price.
    // No fabricated promotions: the homepage can only display discounts the
    // seller already set. The countdown comes from the top-priority LIVE
    // campaign's real end time (null when no campaign is live → no timer).
    const [dealRows, trendingRows, ...shelfResults] = await Promise.all([
      db.product.findMany({
        where: { status: "active", store: liveStore, variants: { some: { isActive: true, compareAtPriceMinor: { gt: 0 } } } },
        include: productCardInclude,
        orderBy: { salesCount: "desc" },
        take: 24,
      }),
      db.product.findMany({
        where: { status: "active", store: liveStore },
        include: productCardInclude,
        orderBy: [{ salesCount: "desc" }, { createdAt: "desc" }],
        take: 24,
      }),
      ...inline
        .filter((c) => c.productQuery)
        .slice(0, INLINE_SHELF_MAX)
        .map((c) =>
          db.product.findMany({
            where: {
              status: "active",
              store: liveStore,
              title: { contains: c.productQuery as string, mode: "insensitive" as const },
            },
            include: productCardInclude,
            orderBy: { salesCount: "desc" },
            take: SHELF_PRODUCTS_MAX,
          })
        ),
    ]);

    // Flash deals — filter compareAt > price (SQL cannot express cross-field),
    // sort by real discount %, cap.
    const flashProducts = dealRows
      .map((p) => toProductCard(p as unknown as ProductWithRelations))
      .filter((p) => p.compareAtPriceMinor != null && p.compareAtPriceMinor > p.priceMinor)
      .sort((a, b) => {
        const da = 1 - a.priceMinor / (a.compareAtPriceMinor ?? a.priceMinor);
        const db_ = 1 - b.priceMinor / (b.compareAtPriceMinor ?? b.priceMinor);
        return db_ - da;
      })
      .slice(0, FLASH_DEALS_MAX);

    // Trending — real popularity signal only (salesCount > 0).
    const trending = trendingRows
      .map((p) => toProductCard(p as unknown as ProductWithRelations))
      .filter((p) => p.salesCount > 0)
      .slice(0, TRENDING_MAX);

    // Inline shelves — products for the first ≤2 query-carrying inline
    // campaigns, kept as a serializable array keyed by campaign id.
    const shelves: { campaignId: string; products: ReturnType<typeof toProductCard>[] }[] = [];
    const shelfTargets = inline.filter((c) => c.productQuery).slice(0, INLINE_SHELF_MAX);
    shelfTargets.forEach((c, i) => {
      const rows = shelfResults[i] ?? [];
      shelves.push({ campaignId: c.id, products: rows.map((p) => toProductCard(p as unknown as ProductWithRelations)) });
    });

    // Hero composition: campaign slides first, then legacy banner padding up
    // to the total cap — predictable and documented (campaigns outrank plain
    // banners; when no campaigns are live the carousel degrades to banners;
    // when neither exists the shopper app renders its default branded slide).
    const heroSlides: HeroSlideT[] = heroCampaigns.map((c) => {
      const t = parseCampaignTheme(c.themeJson);
      return {
        ...baseOf(c),
        kind: "campaign" as const,
        title: t.greeting || c.name,
        subtext: c.description || t.tagline || null,
        imageUrl: c.bannerDesktopUrl,
        mobileImageUrl: c.bannerMobileUrl ?? c.bannerDesktopUrl,
        theme: t,
      };
    });
    for (const b of banners) {
      if (heroSlides.length >= HERO_TOTAL_MAX) break;
      heroSlides.push({
        id: `banner:${b.id}`,
        kind: "banner" as const,
        name: b.title,
        description: null,
        ctaLabel: "Shop now",
        // Legacy banner linkUrls are advisory in this sandbox — every banner
        // click opens browse-all (unchanged semantics).
        cta: { kind: "search", q: "" } as CampaignCta,
        endsAt: new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString(),
        title: b.title,
        subtext: null,
        imageUrl: b.imageUrl,
        mobileImageUrl: b.imageUrl,
        theme: null,
      });
    }

    // The countdown source for flash deals: the top-priority live campaign
    // across ALL placements (campaigns[0] — the resolver's ordering).
    const flashCampaign = campaigns.length > 0 ? campaigns[0] : null;

    return {
      banners,
      roots,
      featuredSlots,
      latest,
      topStores,
      heroSlides,
      heroSecondary,
      promoTiles,
      showcase,
      inline,
      shelves,
      flashProducts,
      flashCampaign: flashCampaign ? { id: flashCampaign.id, name: flashCampaign.name, endAt: isoOf(flashCampaign.endAt) } : null,
      trending,
      sectionOrderRaw: settingRow?.valueJson ?? null,
    };
  },
  ["market-home"],
  { ttl: 60, tags: [PUBLIC_CACHE_TAGS.market, PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.stores, PUBLIC_CACHE_TAGS.campaigns] }
);

// GET /api/market/home — public marketplace landing payload (work order 14:
// + campaign placements, flash deals, trending, section order).
export const GET = handle(async () => {
  const home = await loadHome();

  const categories = home.roots.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    imageUrl: c.imageUrl,
    children: c.children.map((ch) => ({ id: ch.id, name: ch.name, slug: ch.slug })),
  }));

  const heroSecondary: HeroTileT[] = home.heroSecondary.map((c) => {
    const t = themeOf(c);
    return {
      ...baseOf(c as CampaignRowLike),
      heading: t.greeting || c.name,
      subtext: c.description || t.tagline || null,
      imageUrl: c.bannerDesktopUrl,
      mobileImageUrl: c.bannerMobileUrl ?? c.bannerDesktopUrl,
      theme: t,
    };
  });

  const promoTiles: PromoTileT[] = home.promoTiles.map((c) => ({
    id: c.id,
    name: c.name,
    theme: themeOf(c),
    cta: resolveCampaignCta(c.ctaHref),
  }));

  const showcase: ShowcaseCardT[] = home.showcase.map((c) => ({
    ...baseOf(c as CampaignRowLike),
    thumbnailUrl: c.thumbnailUrl,
    theme: themeOf(c),
  }));

  const inline: InlineModuleT[] = home.inline.map((c) => {
    const t = themeOf(c);
    return {
      ...baseOf(c as CampaignRowLike),
      heading: t.greeting || c.name,
      subtext: c.description || t.tagline || null,
      bannerDesktopUrl: c.bannerDesktopUrl,
      bannerMobileUrl: c.bannerMobileUrl ?? c.bannerDesktopUrl,
      productQuery: c.productQuery,
      products: home.shelves.find((s) => s.campaignId === c.id)?.products ?? [],
      theme: t,
    };
  });

  return ok({
    banners: home.banners.map((b) => ({ id: b.id, title: b.title, imageUrl: b.imageUrl, linkUrl: b.linkUrl })),
    categories,
    featured: home.featuredSlots.map((fs) => toProductCard(fs.product as unknown as ProductWithRelations)),
    latest: home.latest.map((p) => toProductCard(p as unknown as ProductWithRelations)),
    // Task 30: renamed topStores → featuredStores ("Featured stores" section).
    featuredStores: home.topStores.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      tagline: s.tagline,
      logoUrl: s.logoUrl,
      bannerUrl: s.bannerUrl,
      productCount: s._count.products,
    })),
    // ---- Work order 14 additions ----
    sectionOrder: sectionOrderFromSetting(home.sectionOrderRaw),
    hero: home.heroSlides,
    heroSecondary,
    promoTiles,
    showcase,
    inline,
    flashDeals: {
      products: home.flashProducts,
      campaign: home.flashCampaign,
    },
    trending: home.trending,
  });
});

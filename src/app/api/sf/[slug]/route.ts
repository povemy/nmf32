import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { assembleStorefrontSections, parsePageDoc, parseTheme } from "@/lib/sections";
import { parseSocial, cardStyleFor } from "../../_shared/product-card";
import { trackStoreView } from "@/lib/analytics/track";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

export const dynamic = "force-dynamic";

// PHASE 2 / C: storefront home payload — cached 45 s per slug; stores tag
// busted on store/theme/page mutations. CRITICAL PURITY BOUNDARY: the store
// view TRACKER (trackStoreView) reads+writes cookies on the LIVE response and
// therefore stays OUTSIDE the cached loader — only the pure data load below
// is cacheable.
const loadStorefront = publicCache(
  async (slug: string) => {
    // C1.3 (seller publication governance): store.status "live" alone is not
    // proof of eligibility — the store's seller must be admin-approved. An
    // inactive seller's storefront 404s (fail closed), exactly like a non-live
    // store. slug stays the key; the extra terms only narrow the match.
    const store = await db.store.findFirst({ where: { slug, status: "live", seller: { is: { status: "active" } } } });
    if (!store) return { notFound: "store" as const };

    let home = await db.cmsPage.findFirst({ where: { storeId: store.id, slug: "home" } });
    if (!home) home = await db.cmsPage.findFirst({ where: { storeId: store.id, pageType: "home" } });
    if (!home || !home.publishedJson) return { notFound: "published" as const };

    const followers = await db.storeFollow.count({ where: { storeId: store.id } }); // Task 10-d
    const cardStyle = await cardStyleFor(store.id);
    // Seller store settings work order — the store's own categories drive the
    // inline chip row injected below the hero.
    const categories = await db.storeCategory.findMany({
      where: { storeId: store.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, sortOrder: true },
    });
    return { notFound: null, store, home, followers, cardStyle, categories };
  },
  ["sf-home"],
  { ttl: 45, tags: [PUBLIC_CACHE_TAGS.stores, PUBLIC_CACHE_TAGS.market] }
);

// GET /api/sf/[slug] — public storefront home (published page + theme + store info).
export const GET = handle(async (req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const result = await loadStorefront(slug);
  if (result.notFound === "store") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");
  if (result.notFound === "published") throw new ApiError(404, "STORE_NOT_PUBLISHED", "Storefront has no published home page");
  const { store, home, followers, cardStyle, categories } = result;

  // Seller Insights — store_view (once per session per store per hour; awaited so
  // the pseudonymous identity cookie lands on THIS response; enqueue itself is
  // synchronous — the DB write happens in a background batch flush).
  // Deliberately OUTSIDE the cached loader (cookie write on this response).
  await trackStoreView(req, store.id);

  const doc = parsePageDoc(home.publishedJson);
  // Seller store settings work order — system-managed home sections: replace
  // seller-authored latest/featured grids with the toggle-controlled Featured /
  // Fresh arrivals sections and inject the category chip row below the hero.
  const sections = assembleStorefrontSections(doc, {
    homeShowFeatured: store.homeShowFeatured,
    homeShowFresh: store.homeShowFresh,
    homeFeaturedFirst: store.homeFeaturedFirst,
    hasCategories: categories.length > 0,
  });

  return ok({
    store: {
      id: store.id,
      name: store.name,
      slug: store.slug,
      tagline: store.tagline,
      logoUrl: store.logoUrl,
      bannerUrl: store.bannerUrl,
      description: store.description,
      theme: parseTheme(store.themeJson),
      whatsapp: store.whatsapp,
      supportEmail: store.supportEmail,
      supportPhone: store.supportPhone,
      social: parseSocial(store.socialJson),
      followers,
      cardStyle,
      // Seller store settings work order — per-store card display config
      // (stars on/off + views-or-sold badge) and the category chip row data.
      display: { showStars: store.cardShowStars, metric: store.cardMetric },
      categories,
    },
    page: {
      id: home.id,
      title: home.title,
      slug: home.slug,
      sections,
      publishedVersion: home.publishedVersion,
    },
  });
});

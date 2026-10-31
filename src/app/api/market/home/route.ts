import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../_shared/product-card";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

export const dynamic = "force-dynamic";

// store "marketplace opt-in" lives on the Seller model (schema) — filter through relation.
const liveStore = { is: { status: "live", seller: { is: { marketplaceOptIn: true } } } };

// PHASE 2 / C: public landing payload — per-request identical (no
// personalization), cached 60 s with entity tags busted on product/store/
// banner mutations. TTL is the safety net that bounds staleness even if a
// mutation route ever misses its invalidation call. Module scope: the cached
// wrapper's identity (function source + keyParts) must be stable.
const loadHome = publicCache(
  async () => {
    const [banners, roots, featuredSlots, latest, topStores] = await Promise.all([
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
        where: { status: "live" },
        include: { _count: { select: { products: { where: { status: "active" } } } } },
        orderBy: { createdAt: "asc" },
        take: 6,
      }),
    ]);
    return { banners, roots, featuredSlots, latest, topStores };
  },
  ["market-home"],
  { ttl: 60, tags: [PUBLIC_CACHE_TAGS.market, PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.stores] }
);

// GET /api/market/home — public marketplace landing payload.
export const GET = handle(async () => {
  const { banners, roots, featuredSlots, latest, topStores } = await loadHome();

  const categories = roots.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    imageUrl: c.imageUrl,
    children: c.children.map((ch) => ({ id: ch.id, name: ch.name, slug: ch.slug })),
  }));

  return ok({
    banners: banners.map((b) => ({ id: b.id, title: b.title, imageUrl: b.imageUrl, linkUrl: b.linkUrl })),
    categories,
    featured: featuredSlots.map((fs) => toProductCard(fs.product as ProductWithRelations)),
    latest: latest.map((p) => toProductCard(p as ProductWithRelations)),
    // Task 30: renamed topStores → featuredStores ("Featured stores" section).
    featuredStores: topStores.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      tagline: s.tagline,
      logoUrl: s.logoUrl,
      bannerUrl: s.bannerUrl,
      productCount: s._count.products,
    })),
  });
});

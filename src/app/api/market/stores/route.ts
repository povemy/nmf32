import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

export const dynamic = "force-dynamic";

// PHASE 2 / C: public store directory — cached 60 s; stores tag busted on
// store mutations (settings/profile/publish). TTL bounds the rest.
const loadStores = publicCache(
  async () =>
    db.store.findMany({
      // C1.3 (seller publication governance): the public directory lists only
      // live stores of admin-approved sellers — store.status "live" alone is
      // not proof of public eligibility.
      where: { status: "live", seller: { is: { status: "active" } } },
      include: { _count: { select: { products: { where: { status: "active" } } } } },
      orderBy: { createdAt: "asc" },
    }),
  ["market-stores"],
  { ttl: 60, tags: [PUBLIC_CACHE_TAGS.stores, PUBLIC_CACHE_TAGS.products] }
);

// GET /api/market/stores — public directory of live stores.
export const GET = handle(async () => {
  const stores = await loadStores();
  return ok(
    stores.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      tagline: s.tagline,
      logoUrl: s.logoUrl,
      bannerUrl: s.bannerUrl,
      productCount: s._count.products,
    }))
  );
});

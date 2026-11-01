import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../../_shared/product-card";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import { normalizeSearchQuery } from "@/lib/search-normalize";

export const dynamic = "force-dynamic";

// PHASE 2 / C: storefront product listing — cached 45 s per (slug, search,
// collection, source, limit); products+stores tags busted on mutations.
// Advisory listing data only — checkout revalidates transactionally.
const loadSfProducts = publicCache(
  async (slug: string, search: string, collectionSlug: string, source: string, limit: number) => {
    const store = await db.store.findUnique({ where: { slug } });
    if (!store || store.status !== "live") return { notFound: true as const };

    const where: Record<string, unknown> = { storeId: store.id, status: "active" };
    if (search) where.title = { contains: search };

    if (collectionSlug) {
      const collection = await db.collection.findFirst({ where: { storeId: store.id, slug: collectionSlug } });
      if (!collection) {
        return { notFound: false as const, products: [] as unknown[] };
      }
      const memberships = await db.collectionProduct.findMany({
        where: { collectionId: collection.id },
        select: { productId: true },
      });
      where.id = { in: memberships.map((m) => m.productId) };
    } else if (source === "featured") {
      where.isFeatured = true;
    }

    // Mutable array type — `as const` (readonly) is not assignable to Prisma's
    // orderBy input, and the resulting generic poisoning stripped the include
    // types off the findMany result below.
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      source === "featured" ? [{ salesCount: "desc" }, { createdAt: "desc" }] : [{ createdAt: "desc" }];

    const products = await db.product.findMany({
      where,
      include: productCardInclude,
      orderBy,
      take: limit,
    });
    return { notFound: false as const, products };
  },
  ["sf-products"],
  { ttl: 45, tags: [PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.stores] }
);

// GET /api/sf/[slug]/products?search=&collection=&source=latest|featured&limit=
export const GET = handle(async (req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  // PHASE 2.1 (§9-B): normalized BEFORE the cache key — bounded cardinality,
  // no junk entries; the storefront search box is submit-only (see
  // storefront.tsx SfHeader) so keys arrive one per completed keyword.
  const search = normalizeSearchQuery(url.searchParams.get("search"));
  const collectionSlug = url.searchParams.get("collection")?.trim() ?? "";
  const source = url.searchParams.get("source") ?? "latest";
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "8", 10) || 8));

  const result = await loadSfProducts(slug, search, collectionSlug, source, limit);
  if (result.notFound) throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");
  return ok(result.products.map((p) => toProductCard(p as ProductWithRelations)));
});

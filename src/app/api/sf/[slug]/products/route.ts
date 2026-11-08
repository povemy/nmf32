import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../../_shared/product-card";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import { normalizeSearchQuery } from "@/lib/search-normalize";
import { tokenize } from "../../../market/_shared/search";
import type { SfProductCard } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// PHASE 2 / C: storefront product listing — cached 45 s per (slug, search,
// collection, source, limit); products+stores tags busted on mutations.
// Advisory listing data only — checkout revalidates transactionally.
const loadSfProducts = publicCache(
  async (slug: string, search: string, collectionSlug: string, source: string, limit: number, categoryId: string) => {
    // C1.3 (seller publication governance): store.status "live" alone is not
    // proof of eligibility — the store's seller must be admin-approved, so an
    // inactive seller's storefront listing 404s (fail closed).
    const store = await db.store.findFirst({ where: { slug, status: "live", seller: { is: { status: "active" } } } });
    if (!store) return { notFound: true as const };

    const where: Record<string, unknown> = { storeId: store.id, status: "active" };
    // X-3 (stage-gate verification): tokenized case-INSENSITIVE search — the
    // same engine as the market route (market/_shared/search.ts). Postgres
    // `contains` is case-sensitive without mode:"insensitive", so "pulse"
    // could not find "Pulse ANC Earbuds" here (the exact C2.2 bug class the
    // market route already fixed). Multi-word queries are AND-of-token ORs
    // across title/description/category — the market field set minus
    // store-name (inside ONE store a store-name token would match the whole
    // catalog). Submit-only UX + 45 s cache wrapper unchanged.
    if (search) {
      const tokens = tokenize(search);
      if (tokens.length > 0) {
        where.AND = tokens.map((t) => ({
          OR: [
            { title: { contains: t, mode: "insensitive" as const } },
            { description: { contains: t, mode: "insensitive" as const } },
            { category: { is: { name: { contains: t, mode: "insensitive" as const } } } },
          ],
        }));
      }
    }

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

    // Seller store settings work order — storefront category chip filter (the
    // store's OWN StoreCategory, not the global marketplace Category). The
    // client sends it for the system-managed latest/featured grids.
    if (categoryId) where.storeCategoryId = categoryId;

    // Mutable array type — `as const` (readonly) is not assignable to Prisma's
    // orderBy input, and the resulting generic poisoning stripped the include
    // types off the findMany result below.
    // X-3: {id:"asc"} tiebreaker — deterministic pagination for tied sort
    // keys (same fix the market route applied to all its SQL sorts).
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      source === "featured"
        ? [{ salesCount: "desc" }, { createdAt: "desc" }, { id: "asc" }]
        : [{ createdAt: "desc" }, { id: "asc" }];

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

// GET /api/sf/[slug]/products?search=&collection=&source=latest|featured&category=&limit=
export const GET = handle(async (req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  // PHASE 2.1 (§9-B): normalized BEFORE the cache key — bounded cardinality,
  // no junk entries; the storefront search box is submit-only (see
  // storefront.tsx SfHeader) so keys arrive one per completed keyword.
  const search = normalizeSearchQuery(url.searchParams.get("search"));
  const collectionSlug = url.searchParams.get("collection")?.trim() ?? "";
  const source = url.searchParams.get("source") ?? "latest";
  const categoryId = url.searchParams.get("category")?.trim() ?? "";
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "8", 10) || 8));

  const result = await loadSfProducts(slug, search, collectionSlug, source, limit, categoryId);
  if (result.notFound) throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");
  const payload: SfProductCard[] = result.products.map((p) => toProductCard(p as ProductWithRelations));
  return ok(payload);
});

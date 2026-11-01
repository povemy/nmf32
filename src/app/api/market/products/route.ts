import { db } from "@/lib/db";
import { handle, okPaged, getPagination } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../_shared/product-card";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import { normalizeSearchQuery } from "@/lib/search-normalize";

export const dynamic = "force-dynamic";

// store "marketplace opt-in" lives on the Seller model (schema) — filter through relation.
const liveStore = { is: { status: "live", seller: { is: { marketplaceOptIn: true } } } };

// PHASE 2 / C: public product listing — cached 45 s per (search, category,
// sort, page, size) tuple; the products tag is busted on every product
// mutation. Listing price/stock displays are ADVISORY ONLY — checkout
// revalidates both transactionally (CAS-guarded) and can never be served from
// this cache.
const loadProducts = publicCache(
  async (search: string, categorySlug: string, sort: string, page: number, size: number) => {
    const skip = (page - 1) * size;
    const where: Record<string, unknown> = { status: "active", store: liveStore };
    if (search) where.title = { contains: search };
    if (categorySlug) {
      const cat = await db.category.findUnique({ where: { slug: categorySlug } });
      if (cat) {
        const children = await db.category.findMany({ where: { parentId: cat.id }, select: { id: true } });
        where.categoryId = { in: [cat.id, ...children.map((c) => c.id)] };
      } else {
        where.categoryId = "__none__";
      }
    }
    let orderBy: Record<string, string> = { createdAt: "desc" };
    if (sort === "price_asc") orderBy = { priceMinor: "asc" };
    else if (sort === "price_desc") orderBy = { priceMinor: "desc" };
    else if (sort === "popular") orderBy = { salesCount: "desc" };
    const [rows, total] = await Promise.all([
      db.product.findMany({ where, include: productCardInclude, orderBy, skip, take: size }),
      db.product.count({ where }),
    ]);
    return { rows, total };
  },
  ["market-products"],
  { ttl: 45, tags: [PUBLIC_CACHE_TAGS.products] }
);

// GET /api/market/products?search=&category=&sort=newest|price_asc|price_desc|popular&page=&size=
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const { page, size } = getPagination(url);
  // PHASE 2.1 (§9-B): normalize BEFORE the value becomes a cache key — bounded
  // cardinality, no entries for whitespace/control-char/over-length junk.
  const search = normalizeSearchQuery(url.searchParams.get("search"));
  const categorySlug = url.searchParams.get("category")?.trim() ?? "";
  const sort = url.searchParams.get("sort") ?? "newest";

  const { rows, total } = await loadProducts(search, categorySlug, sort, page, size);

  return okPaged(rows.map((p) => toProductCard(p as ProductWithRelations)), { page, size, total });
});

import { db } from "@/lib/db";
import { handle, okPaged, getPagination } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../_shared/product-card";

export const dynamic = "force-dynamic";

// store "marketplace opt-in" lives on the Seller model (schema) — filter through relation.
const liveStore = { is: { status: "live", seller: { is: { marketplaceOptIn: true } } } };

// GET /api/market/products?search=&category=&sort=newest|price_asc|price_desc|popular&page=&size=
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const search = url.searchParams.get("search")?.trim();
  const categorySlug = url.searchParams.get("category")?.trim();
  const sort = url.searchParams.get("sort") ?? "newest";

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
    db.product.findMany({ where, include: productCardInclude, orderBy, skip, take }),
    db.product.count({ where }),
  ]);

  return okPaged(rows.map((p) => toProductCard(p as ProductWithRelations)), { page, size, total });
});

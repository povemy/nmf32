import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../../_shared/product-card";

export const dynamic = "force-dynamic";

// GET /api/sf/[slug]/products?search=&collection=&source=latest|featured&limit=
export const GET = handle(async (req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim();
  const collectionSlug = url.searchParams.get("collection")?.trim();
  const source = url.searchParams.get("source") ?? "latest";
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "8", 10) || 8));

  const store = await db.store.findUnique({ where: { slug } });
  if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  const where: Record<string, unknown> = { storeId: store.id, status: "active" };
  if (search) where.title = { contains: search };

  if (collectionSlug) {
    const collection = await db.collection.findFirst({ where: { storeId: store.id, slug: collectionSlug } });
    if (!collection) {
      return ok([]);
    }
    const memberships = await db.collectionProduct.findMany({
      where: { collectionId: collection.id },
      select: { productId: true },
    });
    where.id = { in: memberships.map((m) => m.productId) };
  } else if (source === "featured") {
    where.isFeatured = true;
  }

  const orderBy = source === "featured" ? ([{ salesCount: "desc" }, { createdAt: "desc" }] as const) : ({ createdAt: "desc" } as const);

  const products = await db.product.findMany({
    where,
    include: productCardInclude,
    orderBy,
    take: limit,
  });

  return ok(products.map((p) => toProductCard(p as ProductWithRelations)));
});

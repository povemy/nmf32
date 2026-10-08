import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/store/collections/[id]/products {productIds: []} — replace membership.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const collection = await db.collection.findFirst({ where: { id, storeId: store.id } });
  if (!collection) throw new ApiError(404, "NOT_FOUND", "Collection not found");

  const body = (await req.json().catch(() => ({}))) as { productIds?: unknown };
  if (!Array.isArray(body.productIds)) {
    throw new ApiError(400, "VALIDATION", "productIds must be an array of product ids");
  }
  const productIds = [...new Set(body.productIds.map((p) => String(p)))].filter(Boolean);

  // Only products owned by this store may join the collection.
  const owned = await db.product.findMany({ where: { id: { in: productIds }, storeId: store.id }, select: { id: true } });
  const ownedIds = owned.map((p) => p.id);

  await db.$transaction([
    db.collectionProduct.deleteMany({ where: { collectionId: collection.id } }),
    ...ownedIds.map((productId) =>
      db.collectionProduct.create({ data: { collectionId: collection.id, productId } })
    ),
  ]);

  return ok({ id: collection.id, slug: collection.slug, productIds: ownedIds });
});

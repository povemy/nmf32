import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

// POST /api/sf/[slug]/products/[pSlug]/reviews {customerName, rating 1..5, title?, body?}
export const POST = handle(async (req: Request, ctx: { params: Promise<{ slug: string; pSlug: string }> }) => {
  const { slug, pSlug } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const customerName = String(body.customerName ?? "").trim();
  const rating = Math.round(Number(body.rating));
  if (!customerName) throw new ApiError(400, "VALIDATION", "customerName is required");
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new ApiError(400, "VALIDATION", "rating must be an integer between 1 and 5");
  }

  const store = await db.store.findUnique({ where: { slug } });
  if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  const product = await db.product.findFirst({ where: { slug: pSlug, storeId: store.id } });
  if (!product || product.status !== "active") throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");

  const review = await db.review.create({
    data: {
      productId: product.id,
      customerName,
      rating,
      title: body.title != null ? String(body.title) : null,
      body: body.body != null ? String(body.body) : null,
      status: "published",
    },
  });

  // Recompute product rating aggregates from published reviews.
  const agg = await db.review.aggregate({
    where: { productId: product.id, status: "published" },
    _avg: { rating: true },
    _count: { rating: true },
  });
  await db.product.update({
    where: { id: product.id },
    data: {
      ratingAvg: Math.round((agg._avg.rating ?? 0) * 100) / 100,
      ratingCount: agg._count.rating,
    },
  });

  return ok(
    {
      id: review.id,
      customerName: review.customerName,
      rating: review.rating,
      title: review.title,
      body: review.body,
      createdAt: review.createdAt,
      ratingAvg: Math.round((agg._avg.rating ?? 0) * 100) / 100,
      ratingCount: agg._count.rating,
    },
    { status: 201 }
  );
});

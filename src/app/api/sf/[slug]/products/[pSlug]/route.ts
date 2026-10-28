import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { productCardInclude, toProductCard, minVariant, cardStyleFor, type ProductWithRelations } from "../../../../_shared/product-card";
import { trackProductView } from "@/lib/analytics/track";

export const dynamic = "force-dynamic";

// GET /api/sf/[slug]/products/[pSlug] — full product detail page payload.
export const GET = handle(async (req: Request, ctx: { params: Promise<{ slug: string; pSlug: string }> }) => {
  const { slug, pSlug } = await ctx.params;

  const store = await db.store.findUnique({ where: { slug } });
  if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  const product = await db.product.findFirst({
    where: { slug: pSlug, storeId: store.id },
    include: {
      ...productCardInclude,
      reviews: { where: { status: "published" }, orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!product || product.status !== "active") throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");

  // Seller Insights — product_view (once per session per product per hour).
  // Only THIS route counts: catalogue grids and the related-products payload below
  // are not product views.
  await trackProductView(req, store.id, product.id);

  const related = await db.product.findMany({
    where: { storeId: store.id, status: "active", id: { not: product.id } },
    include: productCardInclude,
    orderBy: { salesCount: "desc" },
    take: 6,
  });

  const mv = minVariant(product.variants);
  const cardStyle = await cardStyleFor(store.id);

  return ok({
    product: {
      id: product.id,
      title: product.title,
      slug: product.slug,
      description: product.description,
      priceMinor: mv ? mv.priceMinor : product.priceMinor,
      compareAtPriceMinor: mv?.compareAtPriceMinor ?? null,
      ratingAvg: product.ratingAvg,
      ratingCount: product.ratingCount,
      salesCount: product.salesCount,
      categoryId: product.category?.id ?? null,
      categoryName: product.category?.name ?? null,
      images: product.images.map((i) => i.url),
      variants: product.variants.map((v) => ({
        id: v.id,
        name: v.name,
        optionName: v.optionName,
        optionValue: v.optionValue,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor,
        stock: v.stock,
        moq: Math.max(1, v.moq),
        sku: v.sku,
        isActive: v.isActive,
      })),
    },
    reviews: product.reviews.map((r) => ({
      id: r.id,
      customerName: r.customerName,
      rating: r.rating,
      title: r.title,
      body: r.body,
      reply: r.reply,
      createdAt: r.createdAt,
    })),
    related: related.map((p) => toProductCard(p as ProductWithRelations)),
    store: {
      id: store.id,
      name: store.name,
      slug: store.slug,
      tagline: store.tagline,
      logoUrl: store.logoUrl,
      whatsapp: store.whatsapp,
      cardStyle,
    },
  });
});

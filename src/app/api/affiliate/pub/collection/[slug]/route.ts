import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/affiliate/pub/collection/[slug] — PUBLIC curated collection page.
// Published collections only; products filtered to active/live. Attribution
// for products clicked from here records PRODUCT-scope touches via the
// tracking endpoint (the showcase scope rule, spec §6).
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const collection = await db.affiliateCollection.findUnique({
    where: { slug: slug.toLowerCase() },
    include: {
      affiliate: { select: { id: true, displayName: true, slug: true, status: true, user: { select: { avatarUrl: true } } } },
      items: {
        orderBy: { position: "asc" },
        take: 60,
        include: {
          product: {
            select: {
              id: true, title: true, slug: true, priceMinor: true, status: true,
              affiliateEnabled: true, affiliateRateBps: true,
              store: { select: { slug: true, name: true, status: true, affiliateOptIn: true, affiliateDefaultRateBps: true } },
              images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
            },
          },
        },
      },
    },
  });
  if (!collection || collection.status !== "published" || collection.affiliate.status !== "active") {
    return ok({ found: false });
  }
  return ok({
    found: true,
    collection: {
      title: collection.title,
      description: collection.description,
      curatedBy: collection.affiliate.displayName,
      curatorSlug: collection.affiliate.slug,
      curatorAvatar: collection.affiliate.user.avatarUrl ?? null,
      pageType: "affiliate_collection",
      products: collection.items
        .filter((it) => it.product.status === "active" && it.product.store.status === "live")
        .map((it) => ({
          productId: it.product.id,
          title: it.product.title,
          slug: it.product.slug,
          priceMinor: it.product.priceMinor,
          storeName: it.product.store.name,
          storeSlug: it.product.store.slug,
          image: it.product.images[0]?.url ?? null,
        })),
    },
  });
});

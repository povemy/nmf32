import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/affiliate/pub/showcase/[slug] — PUBLIC affiliate showcase page
// (spec §3.E). Only explicitly public information: display name, bio, avatar,
// published collections with their products. NO email, phone, payout data,
// network members or earnings. Rendered as an affiliate recommendation page,
// clearly not a seller store.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const profile = await db.affiliateProfile.findUnique({
    where: { slug: slug.toLowerCase() },
    include: {
      user: { select: { avatarUrl: true } },
    },
  });
  if (!profile || profile.status !== "active") {
    return ok({ found: false }, { status: 200 });
  }
  const collections = await db.affiliateCollection.findMany({
    where: { affiliateId: profile.id, status: "published" },
    orderBy: { publishedAt: "desc" },
    include: {
      items: {
        orderBy: { position: "asc" },
        take: 60,
        include: {
          product: {
            select: {
              id: true, title: true, slug: true, priceMinor: true, status: true,
              store: { select: { slug: true, name: true, status: true } },
              images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
            },
          },
        },
      },
    },
  });
  return ok({
    found: true,
    showcase: {
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.user.avatarUrl ?? null,
      slug: profile.slug,
      // Clear affiliate-page framing, never a seller storefront.
      pageType: "affiliate_recommendations",
      collections: collections.map((c) => ({
        id: c.id, title: c.title, description: c.description, slug: c.slug,
        products: c.items
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
      })),
    },
  });
});

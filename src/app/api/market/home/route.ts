import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../_shared/product-card";

export const dynamic = "force-dynamic";

// store "marketplace opt-in" lives on the Seller model (schema) — filter through relation.
const liveStore = { is: { status: "live", seller: { is: { marketplaceOptIn: true } } } };

// GET /api/market/home — public marketplace landing payload.
export const GET = handle(async () => {
  const [banners, roots, featuredSlots, latest, topStores] = await Promise.all([
    db.marketplaceBanner.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, take: 6 }),
    db.category.findMany({
      where: { parentId: null },
      orderBy: { sortOrder: "asc" },
      include: { children: { orderBy: { sortOrder: "asc" } } },
    }),
    db.featuredSlot.findMany({
      where: { isActive: true, product: { status: "active", store: liveStore } },
      include: { product: { include: productCardInclude } },
      orderBy: { sortOrder: "asc" },
      take: 8,
    }),
    db.product.findMany({
      where: { status: "active", store: liveStore },
      include: productCardInclude,
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    db.store.findMany({
      where: { status: "live" },
      include: { _count: { select: { products: { where: { status: "active" } } } } },
      orderBy: { createdAt: "asc" },
      take: 6,
    }),
  ]);

  const categories = roots.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    imageUrl: c.imageUrl,
    children: c.children.map((ch) => ({ id: ch.id, name: ch.name, slug: ch.slug })),
  }));

  return ok({
    banners: banners.map((b) => ({ id: b.id, title: b.title, imageUrl: b.imageUrl, linkUrl: b.linkUrl })),
    categories,
    featured: featuredSlots.map((fs) => toProductCard(fs.product as ProductWithRelations)),
    latest: latest.map((p) => toProductCard(p as ProductWithRelations)),
    topStores: topStores.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      tagline: s.tagline,
      logoUrl: s.logoUrl,
      bannerUrl: s.bannerUrl,
      productCount: s._count.products,
    })),
  });
});

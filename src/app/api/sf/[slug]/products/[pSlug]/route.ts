import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { productCardInclude, toProductCard, minVariant, cardStyleFor, type ProductWithRelations } from "../../../../_shared/product-card";
import { trackProductView } from "@/lib/analytics/track";
import { reviewsSchemaReady } from "@/lib/reviews";
import { sanitizeReviewTextForDisplay } from "@/lib/review-text";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import type { PdpData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// PHASE 2 / C: PDP payload — cached 30 s per (slug, pSlug); products/reviews/
// stores tags busted on the corresponding mutations. The product-view TRACKER
// (cookie write) and the raw IMPRESSIONS counter both stay OUTSIDE the cached
// loader. Displayed variant stock is ADVISORY — checkout revalidates stock
// transactionally (CAS decrement).
const loadPdp = publicCache(
  async (slug: string, pSlug: string) => {
    // C1.3 (seller publication governance): store.status "live" alone is not
    // proof of eligibility — the store's seller must be admin-approved, so an
    // inactive seller's PDP 404s (fail closed).
    const store = await db.store.findFirst({ where: { slug, status: "live", seller: { is: { status: "active" } } } });
    if (!store) return { ok: false as const, reason: "store" as const };

    // Phase 1 (B1): EXPLICIT review projection — the previous bare include
    // selected every Review scalar, which after the schema change includes the
    // new shopperId/orderId columns → P2022 on every PDP fetch until the
    // migration lands. With an explicit select we control the column set:
    // post-migration the projection carries orderId (Verified-purchase badge);
    // pre-migration (probe cached per process) it falls back to the legacy
    // column set with orderId: null — identical response shape either way, so
    // public browsing NEVER breaks during the deploy window.
    const schemaReady = await reviewsSchemaReady();
    const reviewSelect = {
      id: true,
      ...(schemaReady ? { orderId: true } : {}),
      customerName: true,
      rating: true,
      title: true,
      body: true,
      reply: true,
      createdAt: true,
    } as const;

    const product = await db.product.findFirst({
      where: { slug: pSlug, storeId: store.id },
      include: {
        ...productCardInclude,
        reviews: { where: { status: "published" }, orderBy: { createdAt: "desc" }, take: 20, select: reviewSelect },
      },
    });
    if (!product || product.status !== "active") return { ok: false as const, reason: "product" as const };

    const related = await db.product.findMany({
      where: { storeId: store.id, status: "active", id: { not: product.id } },
      include: productCardInclude,
      orderBy: { salesCount: "desc" },
      take: 6,
    });

    // PDP makeover: accurate rating DISTRIBUTION over ALL published reviews
    // (the loaded list is capped at 20 — a client-side histogram would lie
    // whenever ratingCount > 20). Same reviews cache tag as the list above.
    const distRows = await db.review.groupBy({
      by: ["rating"],
      where: { productId: product.id, status: "published" },
      _count: { _all: true },
    });
    const ratingDist = [1, 2, 3, 4, 5].map((star) => distRows.find((r) => r.rating === star)?._count._all ?? 0);

    const cardStyle = await cardStyleFor(store.id);
    return { ok: true as const, store, product, related, ratingDist, cardStyle };
  },
  ["sf-pdp"],
  { ttl: 30, tags: [PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.reviews, PUBLIC_CACHE_TAGS.stores] }
);

// GET /api/sf/[slug]/products/[pSlug] — full product detail page payload.
export const GET = handle(async (req: Request, ctx: { params: Promise<{ slug: string; pSlug: string }> }) => {
  const { slug, pSlug } = await ctx.params;

  const result = await loadPdp(slug, pSlug);
  if (!result.ok) {
    throw result.reason === "store"
      ? new ApiError(404, "STORE_NOT_FOUND", "Store not found")
      : new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");
  }
  const { store, product, related, ratingDist, cardStyle } = result;

  // Seller Insights — product_view (once per session per product per hour).
  // Only THIS route counts: catalogue grids and the related-products payload below
  // are not product views. Deliberately OUTSIDE the cached loader (cookie write).
  await trackProductView(req, store.id, product.id);

  // IMPRESSIONS counter (buyer work order): raw per-GET increment — no dedup
  // by design ("refresh 100,000 times → 100K"). Also OUTSIDE the cached loader
  // so cache hits still count, and the returned value is the post-increment
  // count, exact for this render. A failed increment never breaks the PDP:
  // the cached loader's copy of the field is the fallback.
  let viewCount = product.viewCount;
  try {
    const bumped = await db.product.update({
      where: { id: product.id },
      data: { viewCount: { increment: 1 } },
      select: { viewCount: true },
    });
    viewCount = bumped.viewCount;
  } catch {
    viewCount = (viewCount ?? 0) + 1; // advisory display — never fail the page
  }

  const mv = minVariant(product.variants);

  const payload: PdpData = {
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
      // Raw impressions (post-increment for THIS render — see above).
      viewCount,
      categoryId: product.category?.id ?? null,
      categoryName: product.category?.name ?? null,
      images: product.images.map((i) => i.url),
      // index i = star (i+1); counts of ALL published reviews (not just the
      // latest 20 loaded below) — powers the honest rating histogram.
      ratingDist,
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
        // PDP makeover: seller-uploaded per-variant imagery (schema field —
        // null when unset, in which case the gallery stays product-level)
        // and the seller's real low-stock threshold for urgency display.
        imageUrl: v.imageUrl ?? null,
        lowStockThreshold: v.lowStockThreshold,
      })),
    },
    reviews: product.reviews.map((r) => ({
      id: r.id,
      // orderId != null ⇒ verified purchase (B1) — drives the shopper-facing
      // "Verified purchase" badge. Public list stays published-only (filter
      // above) and never exposes shopperId/email (moderator-only context).
      // Pre-migration the legacy projection omits the column — null keeps the
      // response shape identical.
      orderId: (r as { orderId?: string | null }).orderId ?? null,
      customerName: r.customerName,
      rating: r.rating,
      // Display-side guard: a stored text that still carries a script/HTML
      // payload (legacy row, seeded fixture) is auto-blanked by the system —
      // "shown blank" instead of the payload. React still escapes whatever
      // remains; this is defense-in-depth, not the only barrier.
      title: sanitizeReviewTextForDisplay(r.title),
      body: sanitizeReviewTextForDisplay(r.body),
      reply: sanitizeReviewTextForDisplay(r.reply),
      // Cached loader: Date on first load, ISO string after a cache
      // round-trip — normalize to ISO either way (identical JSON).
      createdAt: new Date(r.createdAt).toISOString(),
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
  };
  return ok(payload);
});

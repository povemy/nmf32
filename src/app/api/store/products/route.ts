import { db } from "@/lib/db";
import { handle, ok, okPaged, ApiError, getPagination, logActivity } from "@/lib/api";
import { toJson } from "@/lib/json";
import { requireActiveSellerStore } from "@/lib/auth";
import { matchFlags, moderationStatus, sanitizeProductImages, uniqueSlug, validateVariants } from "./helpers";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import type {
  SellerProductsQuery,
  SellerProductFull,
  SellerProductCreateBody,
} from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/products?search=&status=&page=&size=
export const GET = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const search: SellerProductsQuery["search"] = url.searchParams.get("search")?.trim();
  const status: SellerProductsQuery["status"] = url.searchParams.get("status")?.trim();

  const where: Record<string, unknown> = { storeId: store.id };
  if (search) where.title = { contains: search };
  if (status && status !== "all") where.status = status;

  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      include: {
        images: { orderBy: { sortOrder: "asc" } },
        variants: { orderBy: { createdAt: "asc" } },
        category: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.product.count({ where }),
  ]);

  const payload: SellerProductFull[] = rows.map((p) => ({
    id: p.id,
    storeId: p.storeId,
    categoryId: p.categoryId,
    title: p.title,
    slug: p.slug,
    description: p.description,
    status: p.status,
    rejectReason: p.rejectReason,
    priceMinor: p.priceMinor,
    commissionPercentOverride: p.commissionPercentOverride,
    flagsJson: p.flagsJson,
    reportsCount: p.reportsCount,
    salesCount: p.salesCount,
    viewCount: p.viewCount,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    isFeatured: p.isFeatured,
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    storeCategoryId: p.storeCategoryId,
    isFixture: p.isFixture,
    sourcePlatform: p.sourcePlatform,
    sourceShopId: p.sourceShopId,
    sourceProductId: p.sourceProductId,
    sourceUrl: p.sourceUrl,
    sourceBrand: p.sourceBrand,
    sourceStatus: p.sourceStatus,
    lastSyncedAt: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
    overridesJson: p.overridesJson,
    affiliateEnabled: p.affiliateEnabled,
    affiliateRateBps: p.affiliateRateBps,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    images: p.images.map((i) => ({
      id: i.id,
      productId: i.productId,
      url: i.url,
      sortOrder: i.sortOrder,
      alt: i.alt,
    })),
    variants: p.variants.map((v) => ({
      id: v.id,
      productId: v.productId,
      name: v.name,
      optionName: v.optionName,
      optionValue: v.optionValue,
      priceMinor: v.priceMinor,
      compareAtPriceMinor: v.compareAtPriceMinor,
      stock: v.stock,
      moq: v.moq,
      lowStockThreshold: v.lowStockThreshold,
      sku: v.sku,
      isActive: v.isActive,
      imageUrl: v.imageUrl,
      sourceModelId: v.sourceModelId,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    })),
    category: p.category,
  }));

  return okPaged(payload, { page, size, total });
});

// POST /api/store/products — create with images[] + variants[].
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as SellerProductCreateBody;

  const title = String(body.title ?? "").trim();
  if (!title) throw new ApiError(400, "VALIDATION", "title is required");
  const description = body.description != null ? String(body.description) : null;
  const variants = validateVariants(body.variants);
  // D2 — every persisted image passes the URL guard (http(s) or site-relative).
  const images = Array.isArray(body.images) ? sanitizeProductImages(body.images) : [];

  // Moderation: first N products need review; banned keywords force review.
  let status = await moderationStatus(store.id);
  const flags = matchFlags(`${title} ${description ?? ""}`);
  if (flags.length > 0) status = "pending_review";

  const priceMinor = Math.min(...variants.map((v) => v.priceMinor));
  const slug = await uniqueSlug(store.id, title);

  const categoryId = body.categoryId != null ? String(body.categoryId) : null;
  if (categoryId) {
    const cat = await db.category.findUnique({ where: { id: categoryId } });
    if (!cat) throw new ApiError(400, "VALIDATION", "Category not found");
  }

  // Storefront organization (seller store settings work order) — create-time
  // category assignment + featured flag, same validation as the PATCH route.
  const storeCategoryId =
    body.storeCategoryId != null && String(body.storeCategoryId) !== "" ? String(body.storeCategoryId) : null;
  if (storeCategoryId) {
    const storeCat = await db.storeCategory.findFirst({ where: { id: storeCategoryId, storeId: store.id } });
    if (!storeCat) throw new ApiError(400, "VALIDATION", "Category not found");
  }
  const isFeatured = !!body.isFeatured;

  const product = await db.product.create({
    data: {
      storeId: store.id,
      categoryId,
      storeCategoryId,
      isFeatured,
      title,
      slug,
      description,
      status,
      priceMinor,
      flagsJson: flags.length > 0 ? toJson(flags) : "[]",
      publishedAt: status === "active" ? new Date() : null,
      images: { create: images.map((url, i) => ({ url, sortOrder: i })) },
      variants: { create: variants.map((v) => ({ ...v })) },
    },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      variants: { orderBy: { createdAt: "asc" } },
      category: { select: { id: true, name: true, slug: true } },
    },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "product.created",
    entityType: "product",
    entityId: product.id,
    meta: { title, status, flags },
  });

  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.market, PUBLIC_CACHE_TAGS.stores);
  const payload: SellerProductFull = {
    id: product.id,
    storeId: product.storeId,
    categoryId: product.categoryId,
    title: product.title,
    slug: product.slug,
    description: product.description,
    status: product.status,
    rejectReason: product.rejectReason,
    priceMinor: product.priceMinor,
    commissionPercentOverride: product.commissionPercentOverride,
    flagsJson: product.flagsJson,
    reportsCount: product.reportsCount,
    salesCount: product.salesCount,
    viewCount: product.viewCount,
    ratingAvg: product.ratingAvg,
    ratingCount: product.ratingCount,
    isFeatured: product.isFeatured,
    publishedAt: product.publishedAt ? product.publishedAt.toISOString() : null,
    storeCategoryId: product.storeCategoryId,
    isFixture: product.isFixture,
    sourcePlatform: product.sourcePlatform,
    sourceShopId: product.sourceShopId,
    sourceProductId: product.sourceProductId,
    sourceUrl: product.sourceUrl,
    sourceBrand: product.sourceBrand,
    sourceStatus: product.sourceStatus,
    lastSyncedAt: product.lastSyncedAt ? product.lastSyncedAt.toISOString() : null,
    overridesJson: product.overridesJson,
    affiliateEnabled: product.affiliateEnabled,
    affiliateRateBps: product.affiliateRateBps,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    images: product.images.map((i) => ({
      id: i.id,
      productId: i.productId,
      url: i.url,
      sortOrder: i.sortOrder,
      alt: i.alt,
    })),
    variants: product.variants.map((v) => ({
      id: v.id,
      productId: v.productId,
      name: v.name,
      optionName: v.optionName,
      optionValue: v.optionValue,
      priceMinor: v.priceMinor,
      compareAtPriceMinor: v.compareAtPriceMinor,
      stock: v.stock,
      moq: v.moq,
      lowStockThreshold: v.lowStockThreshold,
      sku: v.sku,
      isActive: v.isActive,
      imageUrl: v.imageUrl,
      sourceModelId: v.sourceModelId,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    })),
    category: product.category,
  };
  return ok(payload, { status: 201 });
});

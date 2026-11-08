import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { toJson } from "@/lib/json";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { matchFlags, ownProduct, recomputePrice, sanitizeProductImages, uniqueSlug, validateVariants } from "../helpers";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import type {
  SellerProductFull,
  SellerProductPatchBody,
  SellerProductDeleteData,
} from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/products/[id]
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const product = await ownProduct(store.id, id);
  const payload: Omit<SellerProductFull, "category"> = {
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
  };
  return ok(payload);
});

// PATCH /api/store/products/[id] — update fields; status stays unless resubmitted.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const product = await ownProduct(store.id, id);
  const body = (await req.json().catch(() => ({}))) as SellerProductPatchBody;

  const data: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) throw new ApiError(400, "VALIDATION", "title cannot be empty");
    data.title = title;
    // keep slug stable unless explicitly regenerated
    if (body.regenerateSlug === true) data.slug = await uniqueSlug(store.id, title);
  }
  if (body.description !== undefined) data.description = body.description == null ? null : String(body.description);
  if (body.categoryId !== undefined) {
    const categoryId = body.categoryId == null ? null : String(body.categoryId);
    if (categoryId) {
      const cat = await db.category.findUnique({ where: { id: categoryId } });
      if (!cat) throw new ApiError(400, "VALIDATION", "Category not found");
    }
    data.categoryId = categoryId;
  }
  // Storefront organization (seller store settings work order): assign the
  // product to one of the store's OWN categories (chip row under the hero)
  // and/or feature it in the home Featured section.
  if (body.storeCategoryId !== undefined) {
    const storeCategoryId =
      body.storeCategoryId == null || body.storeCategoryId === "" ? null : String(body.storeCategoryId);
    if (storeCategoryId) {
      const cat = await db.storeCategory.findFirst({ where: { id: storeCategoryId, storeId: store.id } });
      if (!cat) throw new ApiError(400, "VALIDATION", "Category not found");
    }
    data.storeCategoryId = storeCategoryId;
  }
  if (body.isFeatured !== undefined) data.isFeatured = !!body.isFeatured;
  if (Array.isArray(body.images)) {
    // D2 — every persisted image passes the URL guard (http(s) or site-relative).
    const images = sanitizeProductImages(body.images);
    data.images = { deleteMany: {}, create: images.map((url, i) => ({ url, sortOrder: i })) };
  }
  if (Array.isArray(body.variants)) {
    const incoming = validateVariants(body.variants);
    // Update existing variants in order, create the rest (never delete — orders may reference).
    const existing = [...product.variants];
    const updates = incoming.slice(0, existing.length);
    const creates = incoming.slice(existing.length);
    for (let i = 0; i < updates.length; i++) {
      await db.productVariant.update({ where: { id: existing[i].id }, data: { ...updates[i] } });
    }
    if (creates.length > 0) {
      data.variants = { create: creates.map((v) => ({ ...v })) };
    }
  }

  // Resubmit for moderation (e.g. after rejection).
  let statusNote: string | null = null;
  if (body.resubmit === true) {
    data.status = "pending_review";
    data.rejectReason = null;
    statusNote = "resubmitted";
  }

  await db.product.update({ where: { id: product.id }, data });

  const after = await db.product.findUnique({
    where: { id: product.id },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });
  if (!after) throw new ApiError(404, "NOT_FOUND", "Product not found");

  // Keep product.priceMinor = cheapest active variant.
  const patch: Record<string, unknown> = {};
  const priceMinor = recomputePrice(after.variants);
  if (priceMinor !== after.priceMinor) patch.priceMinor = priceMinor;

  // Re-flag banned keywords when title/description changed.
  const flags = matchFlags(`${after.title} ${after.description ?? ""}`);
  const currentFlags = parseJson<string[]>(after.flagsJson, []);
  if (flags.length > 0 && JSON.stringify(flags) !== JSON.stringify(currentFlags)) {
    patch.flagsJson = toJson(flags);
    patch.status = "pending_review";
    statusNote = statusNote ?? "flagged";
  }
  if (Object.keys(patch).length > 0) {
    await db.product.update({ where: { id: after.id }, data: patch });
  }

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: statusNote ? `product.${statusNote}` : "product.updated",
    entityType: "product",
    entityId: product.id,
    meta: { fields: Object.keys(data) },
  });

  const fresh = await db.product.findUnique({
    where: { id: product.id },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      variants: { orderBy: { createdAt: "asc" } },
      category: { select: { id: true, name: true, slug: true } },
    },
  });
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.market);
  // Storefront home assembly (sf-home payload) is tagged with the stores tag —
  // a category re-assignment or featured toggle changes which sections render.
  if (data.storeCategoryId !== undefined || data.isFeatured !== undefined) {
    bustPublicCacheSafe(PUBLIC_CACHE_TAGS.stores);
  }
  // Post-update re-read: the row was just updated above, so findUnique's
  // null branch is unreachable here.
  const row = fresh!;
  const payload: SellerProductFull = {
    id: row.id,
    storeId: row.storeId,
    categoryId: row.categoryId,
    title: row.title,
    slug: row.slug,
    description: row.description,
    status: row.status,
    rejectReason: row.rejectReason,
    priceMinor: row.priceMinor,
    commissionPercentOverride: row.commissionPercentOverride,
    flagsJson: row.flagsJson,
    reportsCount: row.reportsCount,
    salesCount: row.salesCount,
    viewCount: row.viewCount,
    ratingAvg: row.ratingAvg,
    ratingCount: row.ratingCount,
    isFeatured: row.isFeatured,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    storeCategoryId: row.storeCategoryId,
    isFixture: row.isFixture,
    sourcePlatform: row.sourcePlatform,
    sourceShopId: row.sourceShopId,
    sourceProductId: row.sourceProductId,
    sourceUrl: row.sourceUrl,
    sourceBrand: row.sourceBrand,
    sourceStatus: row.sourceStatus,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    overridesJson: row.overridesJson,
    affiliateEnabled: row.affiliateEnabled,
    affiliateRateBps: row.affiliateRateBps,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    images: row.images.map((i) => ({
      id: i.id,
      productId: i.productId,
      url: i.url,
      sortOrder: i.sortOrder,
      alt: i.alt,
    })),
    variants: row.variants.map((v) => ({
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
    category: row.category,
  };
  return ok(payload);
});

// DELETE /api/store/products/[id] — soft archive.
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const product = await ownProduct(store.id, id);
  const updated = await db.product.update({ where: { id: product.id }, data: { status: "archived" } });
  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "product.archived",
    entityType: "product",
    entityId: product.id,
    meta: { title: product.title },
  });
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.market);
  const payload: SellerProductDeleteData = { id: updated.id, status: updated.status };
  return ok(payload);
});

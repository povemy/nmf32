import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireAffiliate } from "@/lib/affiliate";

export const dynamic = "force-dynamic";

const MAX_ITEMS = 60;

// PATCH /api/affiliate/collections/[id] — edit metadata, publish/unpublish,
// add/remove/reorder products (spec §3.D). Membership edits bump `version`
// so attribution touches keep validating against their click-time snapshot.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const aff = await requireAffiliate();
  const { id } = await ctx.params;
  const collection = await db.affiliateCollection.findFirst({ where: { id, affiliateId: aff.id } });
  if (!collection) throw new ApiError(404, "NOT_FOUND", "Collection not found");
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (body.title != null) {
    const title = String(body.title).trim();
    if (title.length < 3 || title.length > 80) throw new ApiError(400, "VALIDATION", "Title must be 3-80 characters");
    data.title = title;
  }
  if (body.description != null) data.description = String(body.description).slice(0, 500);

  // Product membership — every added product must be affiliate-eligible.
  const addProductIds = Array.isArray(body.addProductIds) ? body.addProductIds.map(String).slice(0, MAX_ITEMS) : [];
  const removeProductIds = Array.isArray(body.removeProductIds) ? body.removeProductIds.map(String) : [];
  if (addProductIds.length > 0) {
    const products = await db.product.findMany({
      where: { id: { in: addProductIds } },
      include: { store: { select: { affiliateOptIn: true, status: true } } },
    });
    for (const p of products) {
      if (p.status !== "active" || !p.store.affiliateOptIn || p.store.status !== "live" || !p.affiliateEnabled) {
        throw new ApiError(400, "NOT_ENROLLED", `"${p.title}" is not eligible for affiliate promotion`);
      }
    }
    if (products.length !== addProductIds.length) throw new ApiError(404, "NOT_FOUND", "One or more products were not found");
    const currentCount = await db.affiliateCollectionItem.count({ where: { collectionId: collection.id } });
    if (currentCount + addProductIds.length - removeProductIds.length > MAX_ITEMS) {
      throw new ApiError(400, "LIMIT", `Collections hold at most ${MAX_ITEMS} products`);
    }
  }

  const result = await db.$transaction(async (tx) => {
    if (addProductIds.length > 0) {
      const maxPos = await tx.affiliateCollectionItem.findFirst({
        where: { collectionId: collection.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      let pos = (maxPos?.position ?? 0) + 1;
      for (const pid of addProductIds) {
        await tx.affiliateCollectionItem.upsert({
          where: { collectionId_productId: { collectionId: collection.id, productId: pid } },
          create: { collectionId: collection.id, productId: pid, position: pos++ },
          update: {},
        });
      }
    }
    if (removeProductIds.length > 0) {
      await tx.affiliateCollectionItem.deleteMany({
        where: { collectionId: collection.id, productId: { in: removeProductIds } },
      });
    }
    // Reorder: explicit ordered product id list.
    if (Array.isArray(body.order)) {
      const order = (body.order as unknown[]).map(String).slice(0, MAX_ITEMS);
      for (let i = 0; i < order.length; i++) {
        await tx.affiliateCollectionItem.updateMany({
          where: { collectionId: collection.id, productId: order[i] },
          data: { position: i },
        });
      }
    }
    if (body.status != null) {
      const status = String(body.status);
      if (!["draft", "published", "archived"].includes(status)) {
        throw new ApiError(400, "VALIDATION", "status must be draft | published | archived");
      }
      if (status === "published") {
        const itemCount = await tx.affiliateCollectionItem.count({ where: { collectionId: collection.id } });
        if (itemCount === 0) throw new ApiError(400, "EMPTY", "Add products before publishing");
        data.status = "published";
        data.publishedAt = new Date();
      } else if (status === "archived") {
        data.status = "archived";
        data.archivedAt = new Date();
        // Archive links pointing at this collection.
        await tx.affiliateLink.updateMany({
          where: { collectionId: collection.id, status: "active" },
          data: { status: "archived", archivedAt: new Date() },
        });
      } else {
        data.status = "draft";
      }
    }
    // Membership/status changes bump the version (attribution snapshots).
    const membershipChanged = addProductIds.length > 0 || removeProductIds.length > 0 || Array.isArray(body.order) || body.status != null;
    if (membershipChanged) data.version = { increment: 1 };
    return tx.affiliateCollection.update({ where: { id: collection.id }, data });
  });

  return ok({ collection: { id: result.id, title: result.title, slug: result.slug, status: result.status, version: result.version } });
});

// DELETE /api/affiliate/collections/[id] — archive (never hard-delete:
// historical attribution + share links must keep resolving their state).
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const aff = await requireAffiliate();
  const { id } = await ctx.params;
  const collection = await db.affiliateCollection.findFirst({ where: { id, affiliateId: aff.id } });
  if (!collection) throw new ApiError(404, "NOT_FOUND", "Collection not found");
  await db.$transaction(async (tx) => {
    await tx.affiliateCollection.update({
      where: { id: collection.id },
      data: { status: "archived", archivedAt: new Date(), version: { increment: 1 } },
    });
    await tx.affiliateLink.updateMany({
      where: { collectionId: collection.id, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
  });
  return ok({ archived: true });
});

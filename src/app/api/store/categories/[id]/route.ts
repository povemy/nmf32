import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

export const dynamic = "force-dynamic";

// SELLER STORE SETTINGS WORK ORDER — rename / reorder / delete one of the
// store's own storefront categories. Deleting keeps the products (their
// storeCategoryId falls back to null via the schema's SetNull).

async function ownCategory(storeId: string, id: string) {
  const category = await db.storeCategory.findFirst({ where: { id, storeId } });
  if (!category) throw new ApiError(404, "NOT_FOUND", "Category not found");
  return category;
}

// PATCH /api/store/categories/[id] — { name? } and/or { direction: "up" | "down" }.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const category = await ownCategory(store.id, id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().replace(/\s+/g, " ");
    if (!name) throw new ApiError(400, "VALIDATION", "Category name cannot be empty");
    if (name.length > 40) throw new ApiError(400, "VALIDATION", "Category name must be 40 characters or fewer");
    const dupe = await db.storeCategory.findFirst({
      where: { storeId: store.id, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (dupe && dupe.id !== category.id) {
      throw new ApiError(400, "VALIDATION", "A category with this name already exists");
    }
    data.name = name;
  }

  if (body.direction === "up" || body.direction === "down") {
    // Swap sortOrder with the nearest neighbor in that direction; already at
    // the end is a silent no-op (not an error — idempotent UI clicks).
    const neighbor = await db.storeCategory.findFirst({
      where: {
        storeId: store.id,
        id: { not: category.id },
        sortOrder: body.direction === "up" ? { lt: category.sortOrder } : { gt: category.sortOrder },
      },
      orderBy: body.direction === "up" ? { sortOrder: "desc" } : { sortOrder: "asc" },
      select: { id: true, sortOrder: true },
    });
    if (neighbor) {
      await db.storeCategory.update({ where: { id: neighbor.id }, data: { sortOrder: category.sortOrder } });
      data.sortOrder = neighbor.sortOrder;
    }
  }

  if (Object.keys(data).length === 0) {
    throw new ApiError(400, "VALIDATION", "Nothing to update");
  }

  const updated = await db.storeCategory.update({ where: { id: category.id }, data });
  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.category.updated",
    entityType: "store",
    entityId: store.id,
    meta: { name: updated.name },
  });
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.stores, PUBLIC_CACHE_TAGS.market);
  return ok({ id: updated.id, name: updated.name, sortOrder: updated.sortOrder });
});

// DELETE /api/store/categories/[id] — products survive (category unassigned).
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const category = await ownCategory(store.id, id);
  await db.storeCategory.delete({ where: { id: category.id } });
  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.category.deleted",
    entityType: "store",
    entityId: store.id,
    meta: { name: category.name },
  });
  // sf-home payload (stores tag) shows the chip row; sf-products listings
  // (products tag) may have filtered on this category until now.
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.stores, PUBLIC_CACHE_TAGS.market, PUBLIC_CACHE_TAGS.products);
  return ok({ id: category.id, deleted: true });
});

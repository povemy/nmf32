import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import type {
  SellerCollectionPatchBody,
  SellerCollectionPatchData,
  SellerCollectionDeleteData,
} from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

async function ownCollection(storeId: string, id: string) {
  const collection = await db.collection.findFirst({ where: { id, storeId } });
  if (!collection) throw new ApiError(404, "NOT_FOUND", "Collection not found");
  return collection;
}

// PATCH /api/store/collections/[id] {name?, description?}
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const collection = await ownCollection(store.id, id);
  const body = (await req.json().catch(() => ({}))) as SellerCollectionPatchBody;

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new ApiError(400, "VALIDATION", "name cannot be empty");
    data.name = name;
  }
  if (body.description !== undefined) data.description = body.description == null ? null : String(body.description);

  const updated = await db.collection.update({ where: { id: collection.id }, data });
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.products);
  const payload: SellerCollectionPatchData = {
    id: updated.id,
    storeId: updated.storeId,
    name: updated.name,
    slug: updated.slug,
    description: updated.description,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
  return ok(payload);
});

// DELETE /api/store/collections/[id]
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const collection = await ownCollection(store.id, id);
  await db.collection.delete({ where: { id: collection.id } });
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.products);
  const payload: SellerCollectionDeleteData = { id: collection.id, deleted: true };
  return ok(payload);
});

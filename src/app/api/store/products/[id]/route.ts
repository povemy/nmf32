import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { toJson } from "@/lib/json";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { matchFlags, ownProduct, recomputePrice, uniqueSlug, validateVariants } from "../helpers";

export const dynamic = "force-dynamic";

// GET /api/store/products/[id]
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const product = await ownProduct(store.id, id);
  return ok(product);
});

// PATCH /api/store/products/[id] — update fields; status stays unless resubmitted.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const product = await ownProduct(store.id, id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

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
  if (Array.isArray(body.images)) {
    const images = body.images.map((u) => String(u)).filter(Boolean);
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
  return ok(fresh);
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
  return ok({ id: updated.id, status: updated.status });
});

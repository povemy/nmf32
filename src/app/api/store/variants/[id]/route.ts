import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { recomputePrice } from "../../products/helpers";

export const dynamic = "force-dynamic";

async function ownVariant(storeId: string, id: string) {
  const variant = await db.productVariant.findUnique({
    where: { id },
    include: { product: { select: { id: true, storeId: true, priceMinor: true } } },
  });
  if (!variant || variant.product.storeId !== storeId) throw new ApiError(404, "NOT_FOUND", "Variant not found");
  return variant;
}

// PATCH /api/store/variants/[id] — price/stock/etc.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const variant = await ownVariant(store.id, id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = String(body.name);
  if (body.optionName !== undefined) data.optionName = body.optionName == null ? null : String(body.optionName);
  if (body.optionValue !== undefined) data.optionValue = body.optionValue == null ? null : String(body.optionValue);
  if (body.priceMinor !== undefined) {
    const priceMinor = Math.round(Number(body.priceMinor));
    if (!Number.isFinite(priceMinor) || priceMinor < 0) throw new ApiError(400, "VALIDATION", "priceMinor must be >= 0");
    data.priceMinor = priceMinor;
  }
  if (body.compareAtPriceMinor !== undefined) {
    data.compareAtPriceMinor = body.compareAtPriceMinor == null ? null : Math.max(0, Math.round(Number(body.compareAtPriceMinor)));
  }
  if (body.stock !== undefined) {
    data.stock = Math.max(0, Math.round(Number(body.stock)) || 0);
  }
  if (body.lowStockThreshold !== undefined) {
    data.lowStockThreshold = Math.max(0, Math.round(Number(body.lowStockThreshold)) || 0);
  }
  if (body.sku !== undefined) data.sku = body.sku == null ? null : String(body.sku);
  if (body.isActive !== undefined) data.isActive = !!body.isActive;

  const updated = await db.productVariant.update({ where: { id: variant.id }, data });

  // Keep product.priceMinor = cheapest active variant.
  const all = await db.productVariant.findMany({ where: { productId: variant.productId } });
  const price = recomputePrice(all);
  if (price !== variant.product.priceMinor) {
    await db.product.update({ where: { id: variant.productId }, data: { priceMinor: price } });
  }

  return ok(updated);
});

// DELETE /api/store/variants/[id] — soft deactivate (orders may reference it).
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const variant = await ownVariant(store.id, id);
  const updated = await db.productVariant.update({ where: { id: variant.id }, data: { isActive: false } });
  return ok({ id: updated.id, isActive: updated.isActive });
});

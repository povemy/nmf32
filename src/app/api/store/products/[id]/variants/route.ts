import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { ownProduct, recomputePrice } from "../../helpers";

export const dynamic = "force-dynamic";

// POST /api/store/products/[id]/variants — add a variant.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const product = await ownProduct(store.id, id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const priceMinor = Math.round(Number(body.priceMinor));
  if (!Number.isFinite(priceMinor) || priceMinor < 0) {
    throw new ApiError(400, "VALIDATION", "priceMinor must be >= 0");
  }

  const variant = await db.productVariant.create({
    data: {
      productId: product.id,
      name: body.name ? String(body.name) : "Default",
      optionName: body.optionName != null ? String(body.optionName) : null,
      optionValue: body.optionValue != null ? String(body.optionValue) : null,
      priceMinor,
      compareAtPriceMinor: body.compareAtPriceMinor != null ? Math.max(0, Math.round(Number(body.compareAtPriceMinor))) : null,
      stock: Math.max(0, Math.round(Number(body.stock ?? 0)) || 0),
      lowStockThreshold: body.lowStockThreshold != null ? Math.max(0, Math.round(Number(body.lowStockThreshold))) : 5,
      sku: body.sku != null ? String(body.sku) : null,
    },
  });

  // Keep product.priceMinor = cheapest active variant.
  const all = await db.productVariant.findMany({ where: { productId: product.id } });
  const price = recomputePrice(all);
  if (price !== product.priceMinor) {
    await db.product.update({ where: { id: product.id }, data: { priceMinor: price } });
  }

  return ok(variant, { status: 201 });
});

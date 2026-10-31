import { db } from "@/lib/db";
import { handle, ok, ApiError, notify } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

export const dynamic = "force-dynamic";

// POST /api/store/inventory/adjust {variantId, delta, reason}
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const variantId = String(body.variantId ?? "");
  const delta = Math.round(Number(body.delta));
  const reason = String(body.reason ?? "manual adjustment");
  if (!variantId) throw new ApiError(400, "VALIDATION", "variantId is required");
  if (!Number.isFinite(delta) || delta === 0) throw new ApiError(400, "VALIDATION", "delta must be a non-zero integer");

  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    include: { product: { select: { storeId: true, title: true } } },
  });
  if (!variant || variant.product.storeId !== store.id) throw new ApiError(404, "NOT_FOUND", "Variant not found");

  const newStock = variant.stock + delta;
  if (newStock < 0) {
    throw new ApiError(400, "INSUFFICIENT_STOCK", `Stock cannot go below 0 (current ${variant.stock}, delta ${delta})`);
  }

  const [updated] = await db.$transaction([
    db.productVariant.update({ where: { id: variant.id }, data: { stock: newStock } }),
    db.inventoryLog.create({ data: { variantId: variant.id, delta, reason } }),
  ]);

  if (newStock <= variant.lowStockThreshold) {
    await notify({
      event: "stock.low",
      channel: "inapp",
      recipient: me.email,
      subject: `Low stock: ${variant.product.title}${variant.optionValue ? ` (${variant.optionValue})` : ""}`,
    });
  }

  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.products);
  return ok({ id: updated.id, stock: updated.stock, lowStock: newStock <= updated.lowStockThreshold });
});

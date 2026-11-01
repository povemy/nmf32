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
  const rawDelta = body.delta;
  const reason = String(body.reason ?? "manual adjustment");
  if (!variantId) throw new ApiError(400, "VALIDATION", "variantId is required");
  // C3: strict delta validation — the old Math.round(Number(...)) coercion
  // silently accepted numeric strings and rounded fractional deltas; only a
  // genuine safe integer (typeof number, no NaN/Infinity, |x| ≤ 2^53-1) is a
  // sane stock delta. The 1,000,000 magnitude cap keeps the applied delta
  // (and current stock + delta) well inside Prisma's Int stock column.
  if (typeof rawDelta !== "number" || !Number.isSafeInteger(rawDelta) || rawDelta === 0) {
    throw new ApiError(400, "VALIDATION", "delta must be a non-zero integer");
  }
  if (Math.abs(rawDelta) > 1_000_000) {
    throw new ApiError(400, "VALIDATION", "delta magnitude must not exceed 1,000,000");
  }
  const delta = rawDelta;

  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    include: { product: { select: { storeId: true, title: true } } },
  });
  if (!variant || variant.product.storeId !== store.id) throw new ApiError(404, "NOT_FOUND", "Variant not found");

  // C3: read-modify-write → atomic CAS (same pattern as the checkout/create
  // oversell guard). The old JS computation (variant.stock + delta) let two
  // concurrent adjustments overwrite each other and made the negative-stock
  // guard a TOCTOU on the stale read. Instead ONE conditional UPDATE — a
  // decrement additionally requires stock >= -delta on the row-locked
  // predicate — so the guard and the write are indivisible: exactly one of
  // the racing adjustments matches, Postgres evaluates the condition under
  // the row lock, and stock can never go negative. count === 0 → the guard
  // failed (or a concurrent adjustment changed the outcome) → 409, and the
  // InventoryLog is created in the SAME transaction, recording only the
  // delta that actually applied.
  const updated = await db.$transaction(async (tx) => {
    const moved = await tx.productVariant.updateMany({
      where: { id: variant.id, ...(delta < 0 ? { stock: { gte: -delta } } : {}) },
      data: { stock: { increment: delta } },
    });
    if (moved.count === 0) {
      // variant.stock is the last observed value — under concurrency the
      // authoritative check was the CAS predicate above, not this number.
      throw new ApiError(409, "INSUFFICIENT_STOCK", `Stock cannot go below 0 (current ${variant.stock}, delta ${delta})`);
    }
    await tx.inventoryLog.create({ data: { variantId: variant.id, delta, reason } });
    // Read-back INSIDE the transaction — count > 0 guarantees the row exists,
    // so the response reports the stock THIS adjustment produced.
    return tx.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
      select: { id: true, stock: true, lowStockThreshold: true },
    });
  });

  if (updated.stock <= updated.lowStockThreshold) {
    await notify({
      event: "stock.low",
      channel: "inapp",
      recipient: me.email,
      subject: `Low stock: ${variant.product.title}${variant.optionValue ? ` (${variant.optionValue})` : ""}`,
    });
  }

  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.products);
  return ok({ id: updated.id, stock: updated.stock, lowStock: updated.stock <= updated.lowStockThreshold });
});

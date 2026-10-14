import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { createCartForShopper, findCartForShopper, loadAddableVariant, shapeCart } from "../cart";

export const dynamic = "force-dynamic";

// POST /api/cart/items {variantId, qty>0} — SIGN-IN REQUIRED. The cart is the
// shopper's account cart (one active cart, many sellers allowed — Option A
// splits per-seller orders at checkout behind ONE platform payment).
export const POST = handle(async (req: Request) => {
  const me = await requireShopper(); // 401 SHOPPER_LOGIN_REQUIRED for guests — the client opens the auth dialog

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const variantId = String(body.variantId ?? "");
  const qty = Math.round(Number(body.qty ?? 1));
  if (!variantId) throw new ApiError(400, "VALIDATION", "variantId is required");
  if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, "VALIDATION", "qty must be a positive integer");
  if (qty > 99) throw new ApiError(400, "VALIDATION", "qty cannot exceed 99");

  const variant = await loadAddableVariant(variantId);
  if (!variant) throw new ApiError(400, "VARIANT_UNAVAILABLE", "This item is not available for purchase");
  if (variant.stock <= 0) throw new ApiError(409, "OUT_OF_STOCK", "This item is out of stock");

  let cart = await findCartForShopper(me.id);
  if (!cart) {
    await createCartForShopper(me.id);
    cart = (await findCartForShopper(me.id))!;
  }

  let notice: string | null = null;

  // Merge duplicates: same variant → increment qty (capped at 99 AND at available stock).
  const existing = cart.items.find((it) => it.variantId === variant.id);
  if (existing) {
    const capped = Math.min(99, existing.qty + qty, variant.stock);
    if (capped === existing.qty) {
      notice = `Only ${variant.stock} in stock — quantity unchanged`;
    } else {
      if (capped < existing.qty + qty) notice = `Only ${variant.stock} in stock — quantity adjusted`;
      await db.cartItem.update({ where: { id: existing.id }, data: { qty: capped } });
    }
  } else {
    const capped = Math.min(qty, variant.stock);
    if (capped < qty) notice = `Only ${variant.stock} in stock — quantity adjusted`;
    await db.cartItem.create({ data: { cartId: cart.id, variantId: variant.id, qty: capped } });
  }

  const fresh = await findCartForShopper(me.id);
  return ok({ cart: shapeCart(fresh), notice }, { status: 201 });
});

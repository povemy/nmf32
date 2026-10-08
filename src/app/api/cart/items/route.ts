import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { createCart, findCartByToken, getCartToken, loadAddableVariant, setCartToken, shapeCart } from "../cart";

export const dynamic = "force-dynamic";

// POST /api/cart/items {variantId, qty>0} — add item; cart is locked to one store.
export const POST = handle(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const variantId = String(body.variantId ?? "");
  const qty = Math.round(Number(body.qty ?? 1));
  if (!variantId) throw new ApiError(400, "VALIDATION", "variantId is required");
  if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, "VALIDATION", "qty must be a positive integer");
  if (qty > 99) throw new ApiError(400, "VALIDATION", "qty cannot exceed 99");

  const variant = await loadAddableVariant(variantId);
  if (!variant) throw new ApiError(400, "VARIANT_UNAVAILABLE", "This item is not available for purchase");
  const storeId = variant.product.store.id;

  const token = await getCartToken();
  let cart = await findCartByToken(token);

  // One cart per store: switching stores replaces the cart.
  if (cart && cart.storeId !== storeId) {
    await db.cart.delete({ where: { id: cart.id } }).catch(() => null);
    cart = null;
  }
  if (!cart) {
    cart = await createCart(storeId);
    cart = (await findCartByToken(cart.token))!;
  }
  await setCartToken(cart.token);

  // Merge duplicates: same variant → increment qty (capped at 99).
  const existing = cart.items.find((it) => it.variantId === variant.id);
  if (existing) {
    await db.cartItem.update({
      where: { id: existing.id },
      data: { qty: Math.min(99, existing.qty + qty) },
    });
  } else {
    await db.cartItem.create({ data: { cartId: cart.id, variantId: variant.id, qty } });
  }

  const fresh = await findCartByToken(cart.token);
  return ok({ cart: shapeCart(fresh) }, { status: 201 });
});

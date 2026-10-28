import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { findCartForShopper, shapeCart } from "../../cart";
import { trackRemoveFromCart } from "@/lib/analytics/track";

export const dynamic = "force-dynamic";

async function requireShopperCartItem(cartId: string | null, itemId: string) {
  if (!cartId) throw new ApiError(404, "NOT_FOUND", "Cart is empty");
  const item = await db.cartItem.findUnique({ where: { id: itemId }, include: { variant: { include: { product: true } } } });
  if (!item || item.cartId !== cartId) throw new ApiError(404, "NOT_FOUND", "Cart item not found");
  return item;
}

// PATCH /api/cart/items/[id] {qty?, selected?} — qty 0 removes the item;
// selected toggles the buyer's checkout selection (unchecked = kept in cart).
// Sign-in required; the cart is resolved from the SESSION, so a shopper can
// never touch another account's items (no ids in the wild beyond the session's
// own cart).
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const hasQty = body.qty !== undefined;
  const hasSelected = body.selected !== undefined;
  if (!hasQty && !hasSelected) throw new ApiError(400, "VALIDATION", "qty or selected is required");
  if (hasSelected && typeof body.selected !== "boolean") throw new ApiError(400, "VALIDATION", "selected must be a boolean");

  let qty = 0;
  if (hasQty) {
    qty = Math.round(Number(body.qty));
    if (!Number.isFinite(qty) || qty < 0) throw new ApiError(400, "VALIDATION", "qty must be >= 0");
    if (qty > 99) throw new ApiError(400, "VALIDATION", "qty cannot exceed 99");
  }

  const cart = await findCartForShopper(me.id);
  const item = await requireShopperCartItem(cart?.id ?? null, id);

  if (hasQty && qty === 0) {
    await db.cartItem.delete({ where: { id: item.id } });
    // Seller Insights — remove_from_cart (qty → 0 removes the whole line).
    await trackRemoveFromCart({
      storeId: item.variant.product.storeId,
      productId: item.variant.productId,
      variantId: item.variantId,
      cartItemId: item.id,
      qty: item.qty,
      shopperId: me.id,
    });
  } else {
    if (hasQty && qty > item.variant.stock) {
      throw new ApiError(409, "OUT_OF_STOCK", `Only ${item.variant.stock} in stock`);
    }
    // Seller's minimum order quantity for THIS item — qty 0 (remove) stays
    // allowed above, but any kept line must respect the MOQ.
    if (hasQty && qty < Math.max(1, item.variant.moq)) {
      throw new ApiError(409, "MOQ_NOT_MET", `Seller minimum for this item is ${Math.max(1, item.variant.moq)}`);
    }
    await db.cartItem.update({
      where: { id: item.id },
      data: { ...(hasQty ? { qty } : {}), ...(hasSelected ? { selected: body.selected as boolean } : {}) },
    });
  }

  const fresh = await findCartForShopper(me.id);
  return ok({ cart: shapeCart(fresh) });
});

// DELETE /api/cart/items/[id]
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const me = await requireShopper();
  const cart = await findCartForShopper(me.id);
  const item = await requireShopperCartItem(cart?.id ?? null, id);

  await db.cartItem.delete({ where: { id: item.id } });
  // Seller Insights — remove_from_cart (explicit line removal).
  await trackRemoveFromCart({
    storeId: item.variant.product.storeId,
    productId: item.variant.productId,
    variantId: item.variantId,
    cartItemId: item.id,
    qty: item.qty,
    shopperId: me.id,
  });

  const fresh = await findCartForShopper(me.id);
  return ok({ cart: shapeCart(fresh) });
});

import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { findCartForShopper, shapeCart } from "../../cart";

export const dynamic = "force-dynamic";

async function requireShopperCartItem(cartId: string | null, itemId: string) {
  if (!cartId) throw new ApiError(404, "NOT_FOUND", "Cart is empty");
  const item = await db.cartItem.findUnique({ where: { id: itemId }, include: { variant: { include: { product: true } } } });
  if (!item || item.cartId !== cartId) throw new ApiError(404, "NOT_FOUND", "Cart item not found");
  return item;
}

// PATCH /api/cart/items/[id] {qty} — qty 0 removes the item. Sign-in required;
// the cart is resolved from the SESSION, so a shopper can never touch another
// account's items (no ids in the wild beyond the session's own cart).
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const qty = Math.round(Number(body.qty));
  if (!Number.isFinite(qty) || qty < 0) throw new ApiError(400, "VALIDATION", "qty must be >= 0");
  if (qty > 99) throw new ApiError(400, "VALIDATION", "qty cannot exceed 99");

  const cart = await findCartForShopper(me.id);
  const item = await requireShopperCartItem(cart?.id ?? null, id);

  if (qty === 0) {
    await db.cartItem.delete({ where: { id: item.id } });
  } else {
    if (qty > item.variant.stock) {
      throw new ApiError(409, "OUT_OF_STOCK", `Only ${item.variant.stock} in stock`);
    }
    await db.cartItem.update({ where: { id: item.id }, data: { qty } });
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

  const fresh = await findCartForShopper(me.id);
  return ok({ cart: shapeCart(fresh) });
});

import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { findCartByToken, getCartToken, shapeCart } from "../../cart";

export const dynamic = "force-dynamic";

async function requireCartItem(cartId: string | null, itemId: string) {
  if (!cartId) throw new ApiError(404, "NOT_FOUND", "Cart is empty");
  const item = await db.cartItem.findUnique({ where: { id: itemId }, include: { variant: { include: { product: true } } } });
  if (!item || item.cartId !== cartId) throw new ApiError(404, "NOT_FOUND", "Cart item not found");
  return item;
}

// PATCH /api/cart/items/[id] {qty} — qty 0 removes the item.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const qty = Math.round(Number(body.qty));
  if (!Number.isFinite(qty) || qty < 0) throw new ApiError(400, "VALIDATION", "qty must be >= 0");
  if (qty > 99) throw new ApiError(400, "VALIDATION", "qty cannot exceed 99");

  const token = await getCartToken();
  const cart = await findCartByToken(token);
  const item = await requireCartItem(cart?.id ?? null, id);

  if (qty === 0) {
    await db.cartItem.delete({ where: { id: item.id } });
  } else {
    await db.cartItem.update({ where: { id: item.id }, data: { qty } });
  }

  const fresh = token ? await findCartByToken(token) : null;
  return ok({ cart: shapeCart(fresh) });
});

// DELETE /api/cart/items/[id]
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const token = await getCartToken();
  const cart = await findCartByToken(token);
  const item = await requireCartItem(cart?.id ?? null, id);

  await db.cartItem.delete({ where: { id: item.id } });

  const fresh = token ? await findCartByToken(token) : null;
  return ok({ cart: shapeCart(fresh) });
});

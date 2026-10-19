import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { findCartForShopper, shapeCart } from "../cart";

export const dynamic = "force-dynamic";

// PATCH /api/cart/selection {itemIds, selected} — bulk checkout-selection
// toggle for the cart drawer ("select all / none from this seller"). Only
// items inside the SESSION's own cart can be touched: the updateMany is
// scoped by both id list and cartId, so foreign ids are silently ignored.
export const PATCH = handle(async (req: Request) => {
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof body.selected !== "boolean") throw new ApiError(400, "VALIDATION", "selected must be a boolean");
  const ids = Array.isArray(body.itemIds) ? body.itemIds.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  if (ids.length === 0) throw new ApiError(400, "VALIDATION", "itemIds must be a non-empty array of item ids");
  if (ids.length > 99) throw new ApiError(400, "VALIDATION", "itemIds cannot exceed 99 items");

  const cart = await findCartForShopper(me.id);
  if (!cart) throw new ApiError(404, "NOT_FOUND", "Cart is empty");

  await db.cartItem.updateMany({
    where: { id: { in: ids }, cartId: cart.id },
    data: { selected: body.selected },
  });

  const fresh = await findCartForShopper(me.id);
  return ok({ cart: shapeCart(fresh) });
});

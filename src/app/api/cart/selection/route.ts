import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { findCartForCaller, resolveCartCaller, shapeCart } from "../cart";
import type { CartSelectionBody, CartSelectionData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// PATCH /api/cart/selection {itemIds, selected} — bulk checkout-selection
// toggle for the cart drawer ("select all / none from this seller"). PHASE 2.2
// GUEST CHECKOUT RESTORATION: guests manage their token-keyed cart's selection
// too. Only items inside the CALLER's own cart (session OR device token) can be
// touched: the updateMany is scoped by both id list and cartId, so foreign ids
// are silently ignored.
export const PATCH = handle(async (req: Request) => {
  const { shopperId: meId } = await resolveCartCaller();
  const body = (await req.json().catch(() => ({}))) as CartSelectionBody;

  if (typeof body.selected !== "boolean") throw new ApiError(400, "VALIDATION", "selected must be a boolean");
  const ids = Array.isArray(body.itemIds) ? body.itemIds.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  if (ids.length === 0) throw new ApiError(400, "VALIDATION", "itemIds must be a non-empty array of item ids");
  if (ids.length > 99) throw new ApiError(400, "VALIDATION", "itemIds cannot exceed 99 items");

  const cart = await findCartForCaller(meId);
  if (!cart) throw new ApiError(404, "NOT_FOUND", "Cart is empty");

  await db.cartItem.updateMany({
    where: { id: { in: ids }, cartId: cart.id },
    data: { selected: body.selected },
  });

  const fresh = await findCartForCaller(meId);
  const payload: CartSelectionData = { cart: shapeCart(fresh) };
  return ok(payload);
});

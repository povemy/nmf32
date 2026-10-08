import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { findCartByToken, getCartToken, shapeCart } from "./cart";

export const dynamic = "force-dynamic";

// GET /api/cart — current guest cart (null-safe when empty).
export const GET = handle(async () => {
  const token = await getCartToken();
  const cart = await findCartByToken(token);
  return ok({ cart: shapeCart(cart) });
});

import { getSession } from "@/lib/auth";
import { handle, ok } from "@/lib/api";
import { findCartForShopper, shapeCart } from "./cart";

export const dynamic = "force-dynamic";

// GET /api/cart — the signed-in shopper's cart. Guests get an empty cart
// (200, no error): carts require an account, the UI shows a sign-in prompt.
export const GET = handle(async () => {
  const sess = await getSession();
  const cart = sess?.userType === "shopper" ? await findCartForShopper(sess.userId) : null;
  return ok({ cart: shapeCart(cart ?? null), requiresAuth: sess?.userType !== "shopper" });
});

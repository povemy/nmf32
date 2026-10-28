import { getSession } from "@/lib/auth";
import { handle, ok } from "@/lib/api";
import { findCartForShopper, shapeCart } from "./cart";
import { trackViewCart } from "@/lib/analytics/track";

export const dynamic = "force-dynamic";

// GET /api/cart — the signed-in shopper's cart. Guests get an empty cart
// (200, no error): carts require an account, the UI shows a sign-in prompt.
export const GET = handle(async (req: Request) => {
  const sess = await getSession();
  const cart = sess?.userType === "shopper" ? await findCartForShopper(sess.userId) : null;

  // Seller Insights — view_cart, one event PER STORE present in the cart
  // (once per cart+store per minute). Nothing recorded for empty/guest carts.
  if (cart && cart.items.length > 0) {
    const perStore = new Map<string, number>();
    for (const it of cart.items) {
      perStore.set(it.variant.product.store.id, (perStore.get(it.variant.product.store.id) ?? 0) + 1);
    }
    await trackViewCart(
      req,
      cart.id,
      [...perStore.entries()].map(([storeId, itemCount]) => ({ storeId, itemCount })),
      sess?.userType === "shopper" ? sess.userId : null
    );
  }

  return ok({ cart: shapeCart(cart ?? null), requiresAuth: sess?.userType !== "shopper" });
});

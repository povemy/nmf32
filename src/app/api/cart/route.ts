import { handle, ok } from "@/lib/api";
import { findCartForCaller, resolveCartCaller, shapeCart } from "./cart";
import { trackViewCart } from "@/lib/analytics/track";
import type { CartView, GetCartData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/cart — the caller's cart. PHASE 2.2 GUEST CHECKOUT RESTORATION:
// signed-in shoppers read their ACCOUNT cart exactly as before; unauthenticated
// visitors read the token-keyed guest cart ("sm_cart" cookie — created lazily
// by add-to-cart, so a GET without one is simply an empty cart). The legacy
// `requiresAuth` flag is kept for backwards compatibility and is now always
// false (guest carts exist).
export const GET = handle(async (req: Request) => {
  const { shopperId } = await resolveCartCaller();
  const cart = await findCartForCaller(shopperId);

  // Seller Insights — view_cart, one event PER STORE present in the cart
  // (once per cart+store per minute). Nothing recorded for empty carts.
  if (cart && cart.items.length > 0) {
    const perStore = new Map<string, number>();
    for (const it of cart.items) {
      perStore.set(it.variant.product.store.id, (perStore.get(it.variant.product.store.id) ?? 0) + 1);
    }
    await trackViewCart(
      req,
      cart.id,
      [...perStore.entries()].map(([storeId, itemCount]) => ({ storeId, itemCount })),
      shopperId
    );
  }

  const cartView: CartView = shapeCart(cart ?? null);
  const payload: GetCartData = { cart: cartView, requiresAuth: false };
  return ok(payload);
});

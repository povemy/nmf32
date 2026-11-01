import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { ensureCartForCaller, findCartForCaller, resolveCartCaller, loadAddableVariant, shapeCart } from "../cart";
import { trackAddToCart } from "@/lib/analytics/track";

export const dynamic = "force-dynamic";

// POST /api/cart/items {variantId, qty>0} — PHASE 2.2 GUEST CHECKOUT
// RESTORATION: works for signed-in shoppers (account cart, exactly as before)
// AND for unauthenticated visitors (token-keyed guest cart, created lazily on
// this first add — the "sm_cart" cookie is minted by ensureCartForCaller).
// Multi-seller: one cart, many sellers — Option A splits per-seller orders at
// checkout behind ONE platform payment.
export const POST = handle(async (req: Request) => {
  // Shopper sessions keep the exact requireShopper() semantics (invalid /
  // suspended account → 401); guests resolve to { shopperId: null }.
  const { shopperId: meId } = await resolveCartCaller();

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const variantId = String(body.variantId ?? "");
  const qty = Math.round(Number(body.qty ?? 1));
  if (!variantId) throw new ApiError(400, "VALIDATION", "variantId is required");
  if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, "VALIDATION", "qty must be a positive integer");
  if (qty > 99) throw new ApiError(400, "VALIDATION", "qty cannot exceed 99");

  const variant = await loadAddableVariant(variantId);
  if (!variant) throw new ApiError(400, "VARIANT_UNAVAILABLE", "This item is not available for purchase");
  if (variant.stock <= 0) throw new ApiError(409, "OUT_OF_STOCK", "This item is out of stock");

  // Seller-set minimum order quantity for THIS item. Enforced here so the cart
  // can never hold a below-MOQ line (checkout re-validates it as well).
  const moq = Math.max(1, variant.moq);

  let cart = await findCartForCaller(meId);
  if (!cart) {
    cart = await ensureCartForCaller(meId);
  }

  let notice: string | null = null;

  // Merge duplicates: same variant → increment qty (capped at 99 AND at available stock).
  const existing = cart.items.find((it) => it.variantId === variant.id);
  if (existing) {
    const capped = Math.min(99, existing.qty + qty, variant.stock);
    if (capped === existing.qty) {
      notice = `Only ${variant.stock} in stock — quantity unchanged`;
    } else {
      if (capped < existing.qty + qty) notice = `Only ${variant.stock} in stock — quantity adjusted`;
      await db.cartItem.update({ where: { id: existing.id }, data: { qty: capped } });
      // Seller Insights — add_to_cart with the APPLIED delta (post − pre).
      await trackAddToCart({
        storeId: variant.product.store.id,
        productId: variant.product.id,
        variantId: variant.id,
        cartItemId: existing.id,
        preQty: existing.qty,
        postQty: capped,
        shopperId: meId,
      });
    }
  } else {
    // Respect the seller's MOQ: a smaller ask is adjusted UP to the minimum
    // (same friendly "adjusted" contract as the stock cap). If even the MOQ
    // exceeds available stock the line simply cannot exist — refuse honestly.
    if (variant.stock < moq) {
      throw new ApiError(409, "MOQ_EXCEEDS_STOCK", `Seller minimum is ${moq} but only ${variant.stock} in stock`);
    }
    const wanted = Math.max(qty, moq);
    const capped = Math.min(wanted, 99, variant.stock);
    if (capped < qty) notice = `Only ${variant.stock} in stock — quantity adjusted`;
    else if (capped > qty) notice = `Seller minimum is ${moq} — quantity adjusted`;
    const created = await db.cartItem.create({ data: { cartId: cart.id, variantId: variant.id, qty: capped } });
    // Seller Insights — add_to_cart (new line; pre = 0).
    await trackAddToCart({
      storeId: variant.product.store.id,
      productId: variant.product.id,
      variantId: variant.id,
      cartItemId: created.id,
      preQty: 0,
      postQty: capped,
      shopperId: meId,
    });
  }

  const fresh = await findCartForCaller(meId);
  return ok({ cart: shapeCart(fresh), notice }, { status: 201 });
});

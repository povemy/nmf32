import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { createCartForShopper, findCartForShopper } from "@/app/api/cart/cart";
import type { ReorderData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/me/orders/[orderNumber]/reorder — one-tap re-order.
// For each order item: top the shopper's active cart up to
//   newQty = min(99, cartQty + itemQty, stock)
// and report {added:[{title,qty}], skipped:[{title,reason}]} with reasons:
// "Out of stock", "Already at the maximum in your cart", "No longer available".
// Availability is re-checked live from Product/Variant (never the old order).
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ orderNumber: string }> }) => {
  const me = await requireShopper();
  const { orderNumber } = await ctx.params;

  const order = await db.order.findFirst({
    where: { orderNumber: orderNumber.trim().toUpperCase(), shopperId: me.id },
    select: {
      id: true, orderNumber: true,
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true, title: true, qty: true, variantId: true,
          variant: {
            select: {
              id: true, isActive: true, stock: true,
              product: { select: { id: true, title: true, status: true, storeId: true, store: { select: { status: true } } } },
            },
          },
        },
      },
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "No order with that number on your account");

  const added: ReorderData["added"] = [];
  const skipped: ReorderData["skipped"] = [];

  const lines = order.items.filter((i) => i.variantId && i.variant);
  if (lines.length === 0) {
    const payload: ReorderData = { added, skipped: [{ title: "Items from this order", reason: "No longer available" }] };
    return ok(payload);
  }

  // Active cart for this shopper (multi-seller: one cart, many stores).
  let cart = await findCartForShopper(me.id);
  if (!cart) {
    await createCartForShopper(me.id);
    cart = await findCartForShopper(me.id);
  }
  if (!cart) throw new ApiError(500, "INTERNAL", "Could not load your cart");
  const cartItemByVariant = new Map(cart.items.map((it) => [it.variantId, it]));

  for (const line of lines) {
    const v = line.variant!;
    const title = line.title;
    const unavailable =
      !v.isActive || v.product.status !== "active" || v.product.store.status !== "live";
    if (unavailable) {
      skipped.push({ title, reason: "No longer available" });
      continue;
    }
    if (v.stock <= 0) {
      skipped.push({ title, reason: "Out of stock" });
      continue;
    }

    const cartQty = cartItemByVariant.get(v.id)?.qty ?? 0;
    const newQty = Math.min(99, cartQty + Math.max(1, Math.floor(line.qty)), v.stock);
    if (newQty <= cartQty) {
      skipped.push({ title, reason: "Already at the maximum in your cart" });
      continue;
    }

    const delta = newQty - cartQty;
    const existing = cartItemByVariant.get(v.id);
    if (existing) {
      await db.cartItem.update({ where: { id: existing.id }, data: { qty: newQty } });
    } else {
      await db.cartItem.create({ data: { cartId: cart.id, variantId: v.id, qty: delta } });
    }
    added.push({ title, qty: delta });
  }

  const payload: ReorderData = { added, skipped };
  return ok(payload);
});

// Cart helpers — carts are ACCOUNT-scoped (shopperId) and require sign-in.
// There is no guest cart any more: "add to cart" is the login gate, so items,
// totals and checkout always belong to a real SHOPMESH account and follow the
// buyer across devices. The legacy device-token path (X-Cart-Token header /
// "sm_cart" cookie) is kept only to read old rows for reconciliation
// (order.cartToken clearing) — it can never create or expose a live cart.
import { cookies, headers } from "next/headers";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { randomToken } from "@/lib/password";

export const CART_COOKIE = "sm_cart";
const CART_TTL_S = 60 * 60 * 24 * 30; // 30 days
const FALLBACK_IMG = "/api/img/fallback?w=600&h=600";
const CART_TOKEN_RE = /^[a-f0-9]{8,64}$/i;

export function isValidCartToken(t: string | null | undefined): t is string {
  return !!t && CART_TOKEN_RE.test(t);
}

export async function getCartToken(): Promise<string | null> {
  const h = await headers();
  const fromHeader = h.get("x-cart-token");
  if (isValidCartToken(fromHeader)) return fromHeader;
  const store = await cookies();
  const fromCookie = store.get(CART_COOKIE)?.value ?? null;
  return isValidCartToken(fromCookie) ? fromCookie : null;
}

export async function setCartToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(CART_COOKIE, token, {
    httpOnly: false,
    // SameSite=None + Secure: survives cross-site iframe embeds (preview panel).
    // Chromium/Firefox allow Secure cookies on http://localhost (trustworthy origin).
    sameSite: "none",
    secure: true,
    path: "/",
    maxAge: CART_TTL_S,
  });
}

const CART_INCLUDE = {
  items: {
    include: {
      variant: {
        include: {
          product: {
            include: {
              store: { select: { id: true, name: true, slug: true, status: true } },
              images: { orderBy: { sortOrder: "asc" }, take: 1 },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.CartInclude;

/** Legacy lookup by device token — kept ONLY for reconciliation of rows that
 *  predate account-scoped carts (e.g. clearing the cart after payment). */
export async function findCartByToken(token: string | null) {
  if (!token) return null;
  return db.cart.findUnique({ where: { token }, include: CART_INCLUDE });
}

/** The signed-in shopper's active cart (at most one). */
export async function findCartForShopper(shopperId: string) {
  return db.cart.findUnique({ where: { shopperId }, include: CART_INCLUDE });
}

/** Create a cart for a shopper; a fresh internal token is minted for
 *  order.cartToken reconciliation. Never called without a shopper account. */
export async function createCartForShopper(shopperId: string, storeId: string) {
  return db.cart.create({ data: { token: randomToken(16), shopperId, storeId } });
}

type CartWithItems = NonNullable<Awaited<ReturnType<typeof findCartByToken>>>;

export function shapeCart(cart: CartWithItems | null) {
  if (!cart) {
    return { id: null, storeSlug: null, storeName: null, storeId: null, items: [] };
  }
  return {
    id: cart.id,
    storeId: cart.storeId,
    storeSlug: cart.items[0]?.variant.product.store.slug ?? null,
    storeName: cart.items[0]?.variant.product.store.name ?? null,
    items: cart.items.map((it) => {
      const v = it.variant;
      const p = v.product;
      const variantLabel = [v.optionName, v.optionValue].filter(Boolean).join(": ") || v.name;
      return {
        id: it.id,
        variantId: v.id,
        productId: p.id,
        title: p.title,
        productSlug: p.slug,
        variantLabel,
        unitPriceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor,
        qty: it.qty,
        stock: v.stock,
        lineTotalMinor: v.priceMinor * it.qty,
        imageUrl: p.images[0]?.url ?? FALLBACK_IMG,
        storeSlug: p.store.slug,
        storeName: p.store.name,
      };
    }),
  };
}

/** Validate a variant for adding to cart: variant + product active, store live. */
export async function loadAddableVariant(variantId: string) {
  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    include: {
      product: {
        include: { store: { select: { id: true, name: true, slug: true, status: true } } },
      },
    },
  });
  if (!variant || !variant.isActive) return null;
  if (variant.product.status !== "active") return null;
  if (variant.product.store.status !== "live") return null;
  return variant;
}

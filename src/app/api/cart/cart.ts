// Cart helpers — token identity via X-Cart-Token header (localStorage-backed on
// the client) with the "sm_cart" cookie as fallback. The header path keeps the
// cart working in cross-site iframes, where browsers drop SameSite cookies.
import { cookies, headers } from "next/headers";
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

export async function findCartByToken(token: string | null) {
  if (!token) return null;
  return db.cart.findUnique({
    where: { token },
    include: {
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
    },
  });
}

/** Create a cart; adopts the client-supplied token when valid so the same
 *  device keeps seeing its cart even if cookies are unavailable. */
export async function createCart(storeId: string, preferredToken?: string | null) {
  const token = isValidCartToken(preferredToken) ? preferredToken : randomToken(16);
  return db.cart.create({ data: { token, storeId } });
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

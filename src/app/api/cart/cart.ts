// Cart helpers — PHASE 2.2 GUEST CHECKOUT RESTORATION.
// Carts are ACCOUNT-scoped (shopperId) for signed-in shoppers and
// TOKEN-keyed (Cart.token via the "sm_cart" cookie / X-Cart-Token header) for
// guests. A guest cart is created lazily on the first add-to-cart; on login it
// is merged into the shopper's account cart (lib/shopper-merge.ts) and the
// device token is retired, so items follow the buyer into the account. The
// token is ALSO recorded on orders (Order.cartToken) so the payment webhook can
// clear purchased items from the guest cart once payment is verified.
import { cookies, headers } from "next/headers";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { randomToken } from "@/lib/password";
import { getSession } from "@/lib/auth";
import { ApiError } from "@/lib/api";

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

/** Retire the device cart token (login merge / logout hygiene). */
export async function clearCartToken(): Promise<void> {
  const store = await cookies();
  store.delete(CART_COOKIE);
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

/** Legacy lookup by device token — reads the token-keyed cart. PHASE 2.2:
 *  this is the GUEST cart path again (created lazily by ensureCartForCaller);
 *  callers must treat a row with shopperId != null as NOT guest-visible. */
export async function findCartByToken(token: string | null) {
  if (!token) return null;
  return db.cart.findUnique({ where: { token }, include: CART_INCLUDE });
}

/** The signed-in shopper's active cart (at most one). */
export async function findCartForShopper(shopperId: string) {
  return db.cart.findUnique({ where: { shopperId }, include: CART_INCLUDE });
}

/** Create a cart for a shopper; a fresh internal token is minted for
 *  order.cartToken reconciliation. Never called without a shopper account.
 *  Multi-seller: one cart, many stores — no storeId lock any more. */
export async function createCartForShopper(shopperId: string) {
  return db.cart.create({ data: { token: randomToken(16), shopperId, storeId: null } });
}

type CartWithItems = NonNullable<Awaited<ReturnType<typeof findCartByToken>>>;

/** PHASE 2.2 — resolve the CART CALLER for this request. Signed-in shoppers
 *  keep EXACTLY the requireShopper() gate semantics (invalid/suspended account
 *  → the same 401); everyone else is a guest ({ shopperId: null }). */
export async function resolveCartCaller(): Promise<{ shopperId: string | null }> {
  const sess = await getSession();
  if (!sess || sess.userType !== "shopper") return { shopperId: null };
  const shopper = await db.shopperUser.findUnique({ where: { id: sess.userId } });
  if (!shopper || shopper.status !== "active") {
    throw new ApiError(401, "UNAUTHORIZED", "Shopper account unavailable");
  }
  return { shopperId: shopper.id };
}

/** PHASE 2.2 — the caller's active cart WITHOUT creating one: account cart for
 *  shoppers, token-keyed guest cart for guests. A token row that has been
 *  re-bound to an account (post-login merge keeps no such rows, but legacy
 *  device-era rows may exist) is never exposed to a guest caller. */
export async function findCartForCaller(shopperId: string | null): Promise<CartWithItems | null> {
  if (shopperId) return findCartForShopper(shopperId);
  const token = await getCartToken();
  const cart = token ? await findCartByToken(token) : null;
  return cart && cart.shopperId == null ? cart : null;
}

/** PHASE 2.2 — the caller's active cart, creating it lazily when absent:
 *  • shopper → the account cart (legacy createCartForShopper path);
 *  • guest  → the token-keyed cart; the "sm_cart" cookie is minted on first
 *    creation so subsequent requests (and the payment webhook's cart clearing,
 *    via Order.cartToken) address the same cart.
 *  A stale cookie token that collides with an ACCOUNT-bound row can never leak
 *  it — a fresh guest token is minted instead. */
export async function ensureCartForCaller(shopperId: string | null): Promise<CartWithItems> {
  if (shopperId) {
    const existing = await findCartForShopper(shopperId);
    if (existing) return existing;
    await createCartForShopper(shopperId);
    return (await findCartForShopper(shopperId))!;
  }

  let token = await getCartToken();
  if (token) {
    const existing = await findCartByToken(token);
    if (existing && existing.shopperId == null) return existing;
    if (existing && existing.shopperId != null) {
      // Defensive: the cookie names an account-bound row (legacy device-era
      // cart re-bound by an old merge). Never expose it — start a fresh guest
      // cart under a new token.
      token = null;
    }
  }
  if (!token) {
    token = randomToken(16);
    await setCartToken(token);
  }
  try {
    await db.cart.create({ data: { token, shopperId: null, storeId: null } });
  } catch {
    // Unique-race on token (concurrent first add) — fall through to re-read.
  }
  const fresh = await findCartByToken(token);
  if (fresh && fresh.shopperId == null) return fresh;
  // Unreachable barring pathological races — fail loudly rather than null.
  throw new ApiError(500, "CART_UNAVAILABLE", "The cart could not be initialized");
}

export type ShapedCartItem = {
  id: string;
  variantId: string;
  productId: string;
  title: string;
  productSlug: string;
  variantLabel: string;
  unitPriceMinor: number;
  compareAtPriceMinor: number | null;
  qty: number;
  stock: number;
  /** Seller-set minimum order quantity for THIS item (variant-level). */
  moq: number;
  lineTotalMinor: number;
  imageUrl: string;
  storeId: string;
  storeSlug: string;
  storeName: string;
  selected: boolean;
};

export function shapeCart(cart: CartWithItems | null) {
  if (!cart) {
    return { id: null, storeId: null, storeSlug: null, storeName: null, token: null, stores: [] as ShapedCartStore[], items: [] as ShapedCartItem[] };
  }
  const items: ShapedCartItem[] = cart.items.map((it) => {
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
      moq: Math.max(1, v.moq),
      lineTotalMinor: v.priceMinor * it.qty,
      imageUrl: p.images[0]?.url ?? FALLBACK_IMG,
      storeId: p.store.id,
      storeSlug: p.store.slug,
      storeName: p.store.name,
      selected: it.selected,
    };
  });

  // Multi-seller grouping — the drawer and checkout render one section per store.
  const storeMap = new Map<string, ShapedCartStore>();
  for (const it of items) {
    const g = storeMap.get(it.storeId);
    if (g) {
      g.itemCount += 1;
      g.subtotalMinor += it.lineTotalMinor;
    } else {
      storeMap.set(it.storeId, {
        storeId: it.storeId,
        storeSlug: it.storeSlug,
        storeName: it.storeName,
        itemCount: 1,
        subtotalMinor: it.lineTotalMinor,
      });
    }
  }
  const stores = [...storeMap.values()];
  // Legacy single-store fields: only meaningful when everything comes from one store.
  const single = stores.length === 1 ? stores[0] : null;
  return {
    id: cart.id,
    storeId: cart.storeId,
    storeSlug: single?.storeSlug ?? null,
    storeName: single?.storeName ?? null,
    // PHASE 2.2 guest checkout restoration — echo the cart token ONLY for
    // guest carts (shopperId null). The client mirrors it into its
    // X-Cart-Token header identity (syncCartToken), which self-heals the
    // defensive stale-token rotation in ensureCartForCaller: a header naming
    // an account-bound row mints a FRESH guest token here, and the client
    // must adopt that token to keep addressing this cart. Account carts never
    // echo theirs — the token of a signed-in shopper's cart is irrelevant to
    // the guest identity and must not leak into it.
    token: cart.shopperId == null ? cart.token : null,
    stores,
    items,
  };
}

export type ShapedCartStore = {
  storeId: string;
  storeSlug: string;
  storeName: string;
  itemCount: number;
  subtotalMinor: number;
};

/** Validate a variant for adding to cart: variant + product active, store live,
 *  seller admin-approved (C1.3 defense-in-depth, V-F6 fix — the cart-ADD tier
 *  agrees with the checkout pricing tier: an inactive seller's items are not
 *  addable, so the drawer never shows an unpurchasable added line). */
export async function loadAddableVariant(variantId: string) {
  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    include: {
      product: {
        include: { store: { select: { id: true, name: true, slug: true, status: true, seller: { select: { status: true } } } } },
      },
    },
  });
  if (!variant || !variant.isActive) return null;
  if (variant.product.status !== "active") return null;
  if (variant.product.store.status !== "live") return null;
  if (variant.product.store.seller?.status !== "active") return null;
  return variant;
}

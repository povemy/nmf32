"use client";
// ============================================================================
// Shopper surface — shared UI bits, types + cart plumbing (Task 2-e).
// All money values are integer minor units; always format via formatMinor.
// Task 10/11 rebuild: shipment-event timeline (StatusTimeline) + ViewProofButton
// (POD photo dialog) shared by the buyer order detail / purchases surfaces.
// ============================================================================
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { formatMinor } from "@/lib/money";
import { deviceHeaders, syncCartToken } from "@/lib/session-client";
import { signalSessionExpired } from "@/lib/session-events";
import { useApp } from "@/lib/app-store";
import { fontStack, nameSizePx, priceSizePx, fontLinkHref, type CardStyleTokens } from "@/lib/fonts";
import {
  AlertTriangle,
  Bike,
  Camera,
  ClipboardCheck,
  Heart,
  Home,
  Loader2,
  MapPin,
  PackageCheck,
  PackageOpen,
  Minus,
  Plus,
  RotateCcw,
  ShoppingCart,
  Star,
  StarHalf,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Shopper state-machine view + nav context (shared by all shopper views)
// ---------------------------------------------------------------------------

export type ShopperView =
  | { name: "market" }
  | { name: "category"; categorySlug: string; label?: string }
  | { name: "search"; q: string; sort?: "relevance" | "newest" | "price_asc" | "price_desc" | "popular"; deals?: boolean }
  | { name: "storefront"; slug: string }
  | { name: "pdp"; slug: string; pSlug: string }
  | { name: "checkout" }
  | { name: "pay"; ref: string }
  | { name: "order-status"; orderNumber: string }
  | { name: "orders" }
  | { name: "lookup" }
  | { name: "messages"; threadId?: string }
  | { name: "store-page"; slug: string; pageSlug: string }
  | { name: "generate" }
  | { name: "me"; tab?: string }
  | { name: "affiliate"; tab?: string }
  | { name: "aff-showcase"; slug: string; linkCode?: string }
  | { name: "aff-collection"; slug: string; linkCode?: string };

export type ShopperCtx = {
  nav: (v: ShopperView) => void;
  /** Pop the internal history stack (back navigation on every page). */
  back: () => void;
  /** Open the global cart drawer; pass the store slug to load that seller's
   *  customized cart experience (Shopify-style auto-open after add-to-cart). */
  openCart: (storeSlug?: string) => void;
};

export function openProduct(ctx: ShopperCtx, p: { storeSlug: string; slug: string }) {
  ctx.nav({ name: "pdp", slug: p.storeSlug, pSlug: p.slug });
}

// ---------------------------------------------------------------------------
// Types (match /api/market/**, /api/sf/**, /api/cart, /api/orders/lookup)
// ---------------------------------------------------------------------------

export type ProductCardT = {
  id: string;
  slug: string;
  title: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  /** Cheapest ACTIVE variant id (desktop homepage work order) — powers the
   *  quick add-to-cart affordance. Optional/absent on legacy payloads: the
   *  client simply hides quick-add then. The cart API re-validates the
   *  variant, stock and MOQ on every add — this is never a purchase promise. */
  variantId?: string | null;
  imageUrl: string;
  storeName: string;
  storeSlug: string;
  ratingAvg: number;
  ratingCount: number;
  salesCount: number;
  categoryName: string | null;
};

export type StoreCardT = {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  productCount: number;
};

export type CategoryT = {
  id: string;
  name: string;
  slug: string;
  imageUrl?: string | null;
  children: { id: string; name: string; slug: string }[];
};

export type CartItemT = {
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
  /** Seller-set minimum order quantity for this item (client-side clamp). */
  moq: number;
  lineTotalMinor: number;
  imageUrl: string;
  storeId: string;
  storeSlug: string;
  storeName: string;
  /** Buyer's checkout selection — unchecked lines stay in the cart. */
  selected: boolean;
};

export type CartStoreT = {
  storeId: string;
  storeSlug: string;
  storeName: string;
  itemCount: number;
  subtotalMinor: number;
};

export type CartT = {
  id: string | null;
  storeId: string | null;
  storeSlug: string | null;
  storeName: string | null;
  /** PHASE 2.2 guest checkout restoration — the guest cart's token, echoed by
   *  the server ONLY for guest-owned carts (null for account carts). Mirrored
   *  into the X-Cart-Token header identity via syncCartToken so the client
   *  always addresses the cart the server just returned. */
  token?: string | null;
  stores?: CartStoreT[];
  items: CartItemT[];
};

export type LookupResultT = {
  orderNumber: string;
  status: string;
  totalMinor: number;
  storeName: string;
  storeId?: string;
  storeSlug?: string;
  createdAt: string;
  items: { title: string; qty: number; variantLabel?: string | null; unitPriceMinor?: number; lineTotalMinor?: number; imageUrl?: string | null }[];
  history: { toStatus: string; createdAt: string }[];
};

// ---------------------------------------------------------------------------
// Buyer order detail (GET /api/me/orders/[orderNumber]) + shipment timeline
// types (Task 10/11). All optional except the lookup core — the guest lookup
// payload (/api/orders/lookup) satisfies OrderDetailT too, so one render path
// can serve both and upgrade itself when the account detail arrives.
// ---------------------------------------------------------------------------

export type ShipmentEventT = {
  id?: string;
  status: string;
  description: string | null;
  location: string | null;
  occurredAt: string;
  proofImageUrl?: string | null;
};

export type ShipmentT = {
  status: string;
  providerId?: string;
  courierName: string | null;
  awbNumber: string | null;
  labelUrl?: string | null;
  etaFrom?: string | null;
  etaTo?: string | null;
  bookedAt?: string | null;
  deliveredAt?: string | null;
  events: ShipmentEventT[];
};

export type OrderDetailT = LookupResultT & {
  currency?: string;
  subtotalMinor?: number;
  discountMinor?: number;
  shippingMinor?: number;
  taxMinor?: number;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerNote?: string | null;
  shippingAddress?: { line1?: string; city?: string; state?: string; postcode?: string } | null;
  paymentProvider?: string | null;
  paidAt?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  completedAt?: string | null;
  trackingNumber?: string | null;
  shipment?: ShipmentT | null;
  shipmentStatus?: string | null;
  shippingCourierName?: string | null;
  dispute?: { id: string; reason: string; status: string; resolution?: string | null; createdAt: string } | null;
};

// ---------------------------------------------------------------------------
// fetch helper — unwraps the {data} | {error} envelope
// ---------------------------------------------------------------------------

export class ApiFail extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    // Device identity headers (cart + shopper token) — keeps guest state working
    // where cookies are unavailable (cross-site iframe preview panels).
    headers: { ...deviceHeaders(), ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  const b = body as { data?: T; error?: { code?: string; message?: string } } | null;
  if (!res.ok || !b || b.error) {
    // 401 → the shopper session is gone (signed out elsewhere / expired /
    // revoked). Signal app-root to re-check identity; guests stay guests.
    if (res.status === 401) signalSessionExpired();
    throw new ApiFail(res.status, b?.error?.code ?? "ERROR", b?.error?.message ?? `Request failed (${res.status})`);
  }
  return (b.data ?? ({} as T)) as T;
}

/** Like fetchJson but also returns the paged meta envelope. */
export async function fetchEnvelope<T>(
  url: string,
  init?: RequestInit
): Promise<{ data: T; meta?: { page: number; size: number; total: number } }> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: { ...deviceHeaders(), ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  const b = body as { data?: T; meta?: { page: number; size: number; total: number }; error?: { code?: string; message?: string } } | null;
  if (!res.ok || !b || b.error) {
    if (res.status === 401) signalSessionExpired();
    throw new ApiFail(res.status, b?.error?.code ?? "ERROR", b?.error?.message ?? `Request failed (${res.status})`);
  }
  return { data: (b.data ?? ({} as T)) as T, meta: b.meta };
}

export function postJson<T>(url: string, payload: unknown, headers?: Record<string, string>): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(payload),
  });
}

export function patchJson<T>(url: string, payload: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteJson<T>(url: string): Promise<T> {
  return fetchJson<T>(url, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Cart plumbing — "sm-cart-updated" window event keeps every badge in sync.
// ---------------------------------------------------------------------------

export const CART_EVENT = "sm-cart-updated";

export function notifyCartUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CART_EVENT));
}

// ---------------------------------------------------------------------------
// Local order tracking — this device's order refs (email + orderNumber only,
// hydrated through the ownership-safe /api/orders/lookup endpoint).
// ---------------------------------------------------------------------------

export type OrderRefT = { orderNumber: string; email: string; at: number };
export const ORDER_REFS_KEY = "sm_order_refs";

export function trackOrderRef(orderNumber: string, email: string) {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.parse(window.localStorage.getItem(ORDER_REFS_KEY) ?? "[]") as OrderRefT[];
    const clean = raw.filter((r) => r.orderNumber !== orderNumber);
    clean.unshift({ orderNumber, email: email.toLowerCase(), at: Date.now() });
    window.localStorage.setItem(ORDER_REFS_KEY, JSON.stringify(clean.slice(0, 25)));
  } catch {
    /* corrupted list — ignore */
  }
}

export function readOrderRefs(): OrderRefT[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(ORDER_REFS_KEY) ?? "[]") as OrderRefT[];
    return Array.isArray(raw) ? raw.filter((r) => r && r.orderNumber && r.email) : [];
  } catch {
    return [];
  }
}

/** Fetch the caller's cart and live-refresh on sm-cart-updated events + on any
 *  sign-in / sign-out change. PHASE 2.2 guest checkout restoration: carts are
 *  account-scoped for signed-in shoppers and TOKEN-keyed ("sm_cart" cookie /
 *  X-Cart-Token header) for guests — one hook serves both.
 *
 *  Task 28: cart state lives in a MODULE-LEVEL shared store, so every useCart()
 *  instance (drawer, header badge, checkout) renders from the same snapshot —
 *  one fetch per event instead of one per instance — and checkout-selection
 *  toggles can mutate it optimistically (mutateCartItems): the UI updates in
 *  the same frame the user clicks while the PATCH rides in the background.
 *  Zero network in the render path — same philosophy as the client-side
 *  Messages list filter. */
const EMPTY_CART: CartT = { id: null, storeId: null, storeSlug: null, storeName: null, items: [] };

type CartState = { cart: CartT; loading: boolean };
let cartState: CartState = { cart: EMPTY_CART, loading: true };
const CART_SERVER_STATE: CartState = { cart: EMPTY_CART, loading: true };
const cartSubs = new Set<() => void>();

function emitCart() {
  for (const fn of cartSubs) fn();
}

function subscribeCart(fn: () => void) {
  cartSubs.add(fn);
  return () => {
    cartSubs.delete(fn);
  };
}

/** Optimistically mutate the shared cart state — no network, no refetch.
 *  Consumers must keep the failure path honest: revert via mutateCartItems
 *  (guarded so it only undoes its own change) and surface a toast. */
export function mutateCartItems(mutate: (items: CartItemT[]) => CartItemT[]) {
  const cur = cartState.cart;
  if (!cur) return;
  cartState = { ...cartState, cart: { ...cur, items: mutate(cur.items) } };
  emitCart();
}

/** Adopt a server cart payload directly into the shared store (no refetch).
 *  Add-to-cart responses already carry the fresh cart — feeding it here keeps
 *  every consumer (badge, drawer, checkout) in sync in the same frame without
 *  the event-driven /api/cart refetch storm. PHASE 2.2 guest checkout
 *  restoration: a GUEST cart payload also mirrors its token into the device
 *  identity (syncCartToken), keeping the X-Cart-Token header pointed at the
 *  cart the server just returned (self-healing token rotation). */
export function applyServerCart(cart: CartT | null | undefined) {
  if (!cart) return;
  syncCartToken(cart.token);
  cartState = { cart, loading: false };
  emitCart();
}

/** Read-only snapshot of the shared cart (for non-render code paths, e.g. the
 *  drawer's stock probe building the variant-id list). */
export function cartSnapshot(): CartT {
  return cartState.cart;
}

export function useCart() {
  const me = useApp((s) => s.me);
  const authed = Boolean(me.loaded && me.shopper);
  const { cart, loading } = useSyncExternalStore(
    subscribeCart,
    () => cartState,
    () => CART_SERVER_STATE
  );

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJson<{ cart: CartT }>("/api/cart");
      // PHASE 2.2: mirror an echoed GUEST cart token (account carts send null)
      // so the next request addresses the same cart the server just returned.
      syncCartToken(data.cart?.token);
      cartState = { cart: data.cart ?? EMPTY_CART, loading: false };
    } catch {
      cartState = { cart: EMPTY_CART, loading: false };
    }
    emitCart();
  }, []);

  useEffect(() => {
    // Show the loader only when there is nothing to paint yet — data-bearing
    // re-syncs (mounts, sign-in flips, sm-cart-updated events) stay silent so
    // no surface ever flashes a skeleton over live data.
    if (cartState.cart.items.length === 0) {
      cartState = { ...cartState, loading: true };
      emitCart();
    }
    void refresh();
    const onEvt = () => void refresh();
    window.addEventListener(CART_EVENT, onEvt);
    return () => window.removeEventListener(CART_EVENT, onEvt);
  }, [refresh, authed]);

  const count = cart.items.reduce((s, i) => s + i.qty, 0);
  const subtotal = cart.items.reduce((s, i) => s + i.lineTotalMinor, 0);
  // Selection-aware figures — only checked lines proceed to checkout.
  const selectedItems = cart.items.filter((i) => i.selected);
  const selectedCount = selectedItems.reduce((s, i) => s + i.qty, 0);
  const selectedSubtotal = selectedItems.reduce((s, i) => s + i.lineTotalMinor, 0);
  return { cart, count, subtotal, selectedCount, selectedSubtotal, loading, refresh };
}

// ---------------------------------------------------------------------------
// Seller card typography — fonts for product name/price on a seller's OWN
// storefront (Feature: product card customization). Defaults keep the
// platform look; the store payload carries cardStyle only when configured.
// ---------------------------------------------------------------------------

export type { CardStyleTokens };

/** Idempotently inject a Google Fonts stylesheet for the given font ids. */
export function ensureFontsLoaded(ids: (string | null | undefined)[]) {
  if (typeof document === "undefined") return;
  const href = fontLinkHref(ids);
  if (!href) return;
  if (!document.querySelector(`link[data-sm-fonts="${href}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.smFonts = href;
    document.head.appendChild(link);
  }
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

export function Stars({ rating, count, className }: { rating: number; count?: number; className?: string }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.25 && rating - full < 0.75;
  const rounded = rating - full >= 0.75 ? full + 1 : full;
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label={`Rated ${rating.toFixed(1)} out of 5`}>
      {[0, 1, 2, 3, 4].map((i) =>
        i < full || (i === full && rounded > full && !half) ? (
          <Star key={i} className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
        ) : i === full && half ? (
          <span key={i} className="relative inline-flex">
            <Star className="h-3.5 w-3.5 text-muted-foreground/40" />
            <StarHalf className="h-3.5 w-3.5 absolute inset-0 fill-amber-400 text-amber-400" />
          </span>
        ) : (
          <Star key={i} className="h-3.5 w-3.5 text-muted-foreground/40" />
        )
      )}
      <span className="text-xs text-muted-foreground ml-1 tabular-nums">
        {rating > 0 ? rating.toFixed(1) : "New"}
        {typeof count === "number" && count > 0 ? ` (${count})` : ""}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ProductCard
// ---------------------------------------------------------------------------

/** Desktop homepage work order — quick actions (wishlist heart + add-to-cart)
 *  rendered ABOVE the full-card open hit-area (overlay pattern: the card body
 *  is plain markup, an invisible button covers it for open-on-click, and the
 *  action buttons sit at a higher z-index — no nested <button>, valid HTML).
 *  Visible at md+ ONLY: mobile product cards stay exactly as they were before
 *  this work order (mobile homepage is a separate work order).
 *
 *  Everything reuses EXISTING platform flows — no second cart, no second
 *  wishlist: add → POST /api/cart/items (guest token carts included; server
 *  re-validates variant/stock/MOQ and is the sole authority), heart →
 *  POST /api/me/activity LIKE (idempotent upsert; guests get the sign-in
 *  dialog with intent resume). */
function QuickCardActions({ p, mobileActions }: { p: ProductCardT; mobileActions?: "full" | "wishlist" }) {
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const [busy, setBusy] = useState(false);
  const [liked, setLiked] = useState(false);

  async function like() {
    if (!me.loaded || !me.shopper) {
      openShopperAuth(() => void like());
      return;
    }
    setLiked(true); // optimistic — the server LIKE upsert is idempotent
    try {
      await postJson("/api/me/activity", { productId: p.id, activityType: "LIKE" });
      toast.success("Saved to My Likes", { description: p.title });
    } catch {
      setLiked(false);
      toast.error("Could not save to wishlist");
    }
  }

  async function addToCart() {
    if (!p.variantId || busy) return;
    setBusy(true);
    try {
      const res = await postJson<{ cart: CartT; notice: string | null }>("/api/cart/items", {
        variantId: p.variantId,
        qty: 1,
      });
      // Same-frame badge/drawer update via the shared cart store — no refetch.
      applyServerCart(res.cart);
      if (res.notice) toast.warning("Cart updated", { description: res.notice });
      else toast.success("Added to cart", { description: p.title });
    } catch (e) {
      // Same honest contract as the PDP: an invalid shopper session gets the
      // sign-in-first flow; genuine availability errors surface verbatim
      // (the cart API is the authority — it re-validates stock + MOQ).
      if (e instanceof ApiFail && (e.status === 401 || e.code === "SHOPPER_LOGIN_REQUIRED")) {
        openShopperAuth(() => void addToCart());
        return;
      }
      toast.error(e instanceof Error ? e.message : "Could not add to cart");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* wishlist heart — top-right of the image, above the open hit-area */}
      <button
        type="button"
        onClick={() => void like()}
        aria-label={liked ? `${p.title} — in your wishlist` : `Save ${p.title} to wishlist`}
        aria-pressed={liked}
        className={cn(
          "absolute right-1.5 top-1.5 z-20 h-8 w-8 max-md:h-9 max-md:w-9 items-center justify-center rounded-full border bg-background/90 shadow-sm backdrop-blur transition-all hover:scale-105",
          mobileActions ? "inline-flex" : "hidden md:inline-flex",
          liked ? "border-rose-200 text-rose-500" : "border-border text-muted-foreground hover:text-rose-500"
        )}
      >
        <Heart className={cn("h-4 w-4", liked && "fill-rose-500")} aria-hidden="true" />
      </button>

      {/* add-to-cart — full-width row under the card body (md+ by default;
          mobile when the rail opts in with "full" — reference flash-deal
          cards). Hidden when the payload carries no purchasable variant id —
          never a blind add the server would refuse. */}
      {p.variantId ? (
        <div
          className={cn(
            "relative z-20 px-2.5 pb-2.5 pt-1",
            mobileActions === "full" ? "block" : "hidden md:block"
          )}
        >
          <button
            type="button"
            onClick={() => void addToCart()}
            disabled={busy}
            aria-label={`Add ${p.title} to cart`}
            className="inline-flex h-8 max-md:h-9 min-h-[32px] w-full items-center justify-center gap-1.5 rounded-lg bg-brand-gradient text-xs font-semibold text-white shadow-sm transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/50 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ShoppingCart className="h-3.5 w-3.5" aria-hidden="true" />}
            {busy ? "Adding…" : "Add to cart"}
          </button>
        </div>
      ) : null}
    </>
  );
}

export function ProductCard({
  p,
  onOpen,
  // Task 28: vendor name no longer renders on product cards by default —
  // cards are cleaner and the seller is always one tap away (store link in
  // the cart groups, storefront header). Pass true to opt back in.
  showStore = false,
  hidePrice = false,
  cardStyle,
  quickActions = false,
  mobileActions,
}: {
  p: ProductCardT;
  onOpen: (p: ProductCardT) => void;
  showStore?: boolean;
  hidePrice?: boolean;
  /** Seller-customized typography — only passed on the seller's own storefront. */
  cardStyle?: CardStyleTokens | null;
  /** Desktop homepage work order: render wishlist + add-to-cart quick actions
   *  (visible md+ by default). Off by default so every existing consumer
   *  (search grid, storefront, PDP related…) is unchanged. */
  quickActions?: boolean;
  /** Mobile homepage work order 2: surface the quick actions on MOBILE too.
   *  "full" = wishlist + add-to-cart (flash deals rail — reference layout);
   *  "wishlist" = heart only (trending rail). Requires quickActions. */
  mobileActions?: "full" | "wishlist";
}) {
  const discount =
    p.compareAtPriceMinor && p.compareAtPriceMinor > p.priceMinor
      ? Math.round(100 - (p.priceMinor / p.compareAtPriceMinor) * 100)
      : null;
  const nameCss: React.CSSProperties = cardStyle
    ? { fontFamily: fontStack(cardStyle.nameFont), fontSize: `${nameSizePx(cardStyle.nameSize)}px`, textAlign: cardStyle.nameAlign as React.CSSProperties["textAlign"] }
    : {};
  const priceCss: React.CSSProperties = cardStyle
    ? { fontFamily: fontStack(cardStyle.priceFont), fontSize: `${priceSizePx(cardStyle.priceSize)}px`, textAlign: cardStyle.priceAlign as React.CSSProperties["textAlign"] }
    : {};

  // ---- quick mode (homepage flash deals / trending rails, md+) --------------
  if (quickActions) {
    return (
      <div className="group relative text-left rounded-[8px] border bg-card shadow-soft overflow-hidden hover:shadow-md hover:border-teal-600/40 hover:-translate-y-0.5 transition-all">
        <div className="relative aspect-square overflow-hidden bg-muted">
          {/* plain <img> (product mockups / placeholder service) — never next/image here */}
          <img
            src={p.imageUrl}
            alt={p.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
          {discount ? (
            <span className="absolute top-1.5 left-1.5 rounded-full bg-rose-600 text-white text-[10px] font-bold px-1.5 py-0.5">
              -{discount}%
            </span>
          ) : null}
        </div>
        <div className="p-2.5 space-y-0.5">
          <h3 className="font-normal leading-snug line-clamp-2 min-h-[2rem] text-xs">{p.title}</h3>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="font-bold text-teal-700 text-sm">{formatMinor(p.priceMinor)}</span>
            {p.compareAtPriceMinor && p.compareAtPriceMinor > p.priceMinor ? (
              <span className="text-[11px] text-muted-foreground line-through">{formatMinor(p.compareAtPriceMinor)}</span>
            ) : null}
          </div>
          {showStore ? <p className="text-[11px] text-muted-foreground truncate">{p.storeName}</p> : null}
          <div className="flex items-center justify-between gap-1 pt-0.5">
            <Stars rating={p.ratingAvg} />
            <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{p.salesCount} sold</span>
          </div>
        </div>
        {/* full-card open hit-area (sits BELOW the quick-action buttons) */}
        <button
          type="button"
          onClick={() => onOpen(p)}
          className="absolute inset-0 z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600/50 rounded-[8px]"
          aria-label={`${p.title} from ${p.storeName}, ${formatMinor(p.priceMinor)}`}
        />
        <QuickCardActions p={p} mobileActions={mobileActions} />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(p)}
      className="group text-left rounded-[8px] border bg-card shadow-soft overflow-hidden hover:shadow-md hover:border-teal-600/40 hover:-translate-y-0.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/50"
      aria-label={`${p.title} from ${p.storeName}, ${formatMinor(p.priceMinor)}`}
    >
      <div className="relative aspect-square overflow-hidden bg-muted">
        {/* plain <img> (product mockups / placeholder service) — never next/image here */}
        <img
          src={p.imageUrl}
          alt={p.title}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
        />
        {discount ? (
          <span className="absolute top-1.5 left-1.5 rounded-full bg-rose-600 text-white text-[10px] font-bold px-1.5 py-0.5">
            -{discount}%
          </span>
        ) : null}
      </div>
      <div className="p-2.5 space-y-0.5">
        <h3 className={cn("font-normal leading-snug line-clamp-2 min-h-[2rem]", !cardStyle && "text-xs")} style={nameCss}>{p.title}</h3>
        {!hidePrice ? (
          <div className="flex items-baseline gap-1.5 flex-wrap" style={cardStyle?.priceAlign === "center" ? { justifyContent: "center" } : cardStyle?.priceAlign === "right" ? { justifyContent: "flex-end" } : undefined}>
            <span className={cn("font-bold text-teal-700", !cardStyle && "text-sm")} style={priceCss}>{formatMinor(p.priceMinor)}</span>
            {p.compareAtPriceMinor && p.compareAtPriceMinor > p.priceMinor ? (
              <span className="text-[11px] text-muted-foreground line-through">{formatMinor(p.compareAtPriceMinor)}</span>
            ) : null}
          </div>
        ) : null}
        {showStore ? <p className="text-[11px] text-muted-foreground truncate">{p.storeName}</p> : null}
        <div className="flex items-center justify-between gap-1 pt-0.5">
          <Stars rating={p.ratingAvg} />
          <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{p.salesCount} sold</span>
        </div>
      </div>
    </button>
  );
}

export function ProductGridSkeleton({ n = 12 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-square rounded-xl" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QtyStepper
// ---------------------------------------------------------------------------

export function QtyStepper({
  value,
  onChange,
  min = 1,
  max = 99,
  small = false,
  xs = false,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  small?: boolean;
  /** Cart-drawer minimalist size (Task 29): 24px buttons, 11px digits. */
  xs?: boolean;
}) {
  const btn = xs ? "h-6 w-6" : small ? "h-8 w-8" : "h-10 w-10";
  const icon = xs ? "h-3 w-3" : "h-3.5 w-3.5";
  const field = xs ? "w-6" : small ? "w-8" : "w-10";
  return (
    <div className={cn("inline-flex items-center border", xs ? "rounded-md" : "rounded-lg")} role="group" aria-label="Quantity">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(btn, "rounded-r-none")}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label="Decrease quantity"
      >
        <Minus className={icon} />
      </Button>
      <span
        className={cn(
          "flex items-center justify-center font-semibold tabular-nums",
          xs ? "w-6 text-[11px]" : "text-sm",
          field
        )}
        aria-live="polite"
      >
        {value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(btn, "rounded-l-none")}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-label="Increase quantity"
      >
        <Plus className={icon} />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

export function EmptyState({
  icon: Icon = PackageOpen,
  title,
  hint,
  action,
}: {
  icon?: typeof PackageOpen;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
      <div className="rounded-full bg-muted p-6">
        <Icon className="h-10 w-10 text-muted-foreground" />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {hint ? <p className="text-sm text-muted-foreground max-w-sm">{hint}</p> : null}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViewProofButton — shared POD affordance: opens a dialog with the courier's
// proof-of-delivery photo (proofImageUrl from the DELIVERED shipment event).
// ---------------------------------------------------------------------------

export function ViewProofButton({
  url,
  label = "View proof",
  compact = false,
}: {
  url: string;
  label?: string;
  /** compact → smaller chip used inside timeline rows */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className={cn(
          "gap-1.5 border-teal-700/40 text-teal-800 hover:bg-teal-50",
          compact ? "h-7 min-h-[28px] px-2 text-[11px]" : "min-h-[36px] px-3 text-xs"
        )}
        aria-haspopup="dialog"
      >
        <Camera className="h-3.5 w-3.5" aria-hidden />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Proof of delivery</DialogTitle>
            <DialogDescription>Captured by the courier when your parcel was delivered.</DialogDescription>
          </DialogHeader>
          {/* POD photos are data-URLs / same-origin placeholder images — plain <img>, never next/image */}
          <img
            src={url}
            alt="Proof of delivery photo captured by the courier"
            className="max-h-[60vh] w-full rounded-lg border bg-muted object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shipment tracking timeline (Shopee-style, Task 10/11) — vertical event log
// from shipment.events: icon + status + description + location + time, newest
// first; the DELIVERED row carries the View-proof affordance when a POD photo
// exists. The older order-flow progress stepper lives below as
// OrderFlowTimeline (both are exported).
// ---------------------------------------------------------------------------

const SHIPMENT_EVENT_ICON: Record<string, typeof Truck> = {
  BOOKED: ClipboardCheck,
  PICKED_UP: PackageCheck,
  IN_TRANSIT: Truck,
  OUT_FOR_DELIVERY: Bike,
  DELIVERED: Home,
  EXCEPTION: AlertTriangle,
  RETURNED: RotateCcw,
};

const SHIPMENT_EVENT_LABEL: Record<string, string> = {
  BOOKED: "Label created",
  PICKED_UP: "Picked up by courier",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  EXCEPTION: "Delivery exception",
  RETURNED: "Returned to sender",
};

export function shipmentEventLabel(s: string): string {
  return SHIPMENT_EVENT_LABEL[s] ?? s.replace(/_/g, " ").toLowerCase();
}

export function StatusTimeline({ events, className }: { events: ShipmentEventT[]; className?: string }) {
  if (!events || events.length === 0) return null;
  const ordered = [...events].reverse(); // newest first, Shopee-style
  return (
    <ol className={cn("space-y-0", className)} aria-label="Shipment tracking timeline">
      {ordered.map((e, i) => {
        const Icon = SHIPMENT_EVENT_ICON[e.status] ?? PackageCheck;
        const isLatest = i === 0;
        const hasProof = e.status === "DELIVERED" && !!e.proofImageUrl;
        return (
          <li key={e.id ?? `${e.status}-${e.occurredAt}-${i}`} className="relative flex gap-3 pb-6 last:pb-0">
            {i < ordered.length - 1 ? (
              <span className="absolute bottom-0 left-[15px] top-9 w-px bg-border" aria-hidden />
            ) : null}
            <span
              className={cn(
                "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2",
                isLatest ? "border-teal-600 bg-teal-600 text-white shadow-sm" : "border-teal-600/25 bg-teal-50 text-teal-700"
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className={cn("text-sm leading-6", isLatest ? "font-bold text-foreground" : "font-semibold text-muted-foreground")}>
                  {shipmentEventLabel(e.status)}
                </p>
                {hasProof && e.proofImageUrl ? <ViewProofButton url={e.proofImageUrl} compact /> : null}
              </div>
              {e.description ? <p className="text-xs leading-snug text-muted-foreground">{e.description}</p> : null}
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                {e.location ? (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" aria-hidden />
                    {e.location}
                  </span>
                ) : null}
                <span>{fmtDateTime(e.occurredAt)}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Order status timeline (order-flow progress stepper, shared by order-status
// + lookup views) — named OrderFlowTimeline to free `StatusTimeline` for the
// shipment-event log above.
// ---------------------------------------------------------------------------

const FLOW = ["payment_pending", "paid", "processing", "shipped", "delivered"];

const STATUS_LABEL: Record<string, string> = {
  payment_pending: "Awaiting payment",
  paid: "Payment confirmed",
  processing: "Being prepared",
  shipped: "Shipped",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s.replace(/_/g, " ");
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "delivered" || status === "completed"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : status === "cancelled" || status === "refunded"
        ? "bg-rose-100 text-rose-800 border-rose-200"
        : status === "payment_pending" || status === "failed"
          ? "bg-amber-100 text-amber-800 border-amber-200"
          : "bg-teal-100 text-teal-800 border-teal-200";
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", tone)}>
      {statusLabel(status)}
    </span>
  );
}

export function OrderFlowTimeline({ history, current }: { history: { toStatus: string; createdAt: string }[]; current: string }) {
  const special = ["cancelled", "refunded", "partially_refunded"].includes(current);
  const reachedAt = new Map<string, string>();
  for (const h of history) reachedAt.set(h.toStatus, h.createdAt);
  const flow = special ? [] : FLOW;
  const currentIdx = flow.indexOf(current === "completed" ? "delivered" : current);

  return (
    <ol className="space-y-0" aria-label="Order status timeline">
      {flow.map((step, i) => {
        const done = currentIdx >= i && currentIdx !== -1;
        const ts = reachedAt.get(step);
        const isLast = i === flow.length - 1;
        return (
          <li key={step} className="relative flex gap-3 pb-5 last:pb-0">
            {!isLast ? <span className={cn("absolute left-[9px] top-5 bottom-0 w-px", done ? "bg-teal-600" : "bg-border")} /> : null}
            <span
              className={cn(
                "relative z-10 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                done ? "border-teal-600 bg-teal-600" : "border-muted-foreground/30 bg-background"
              )}
            >
              {done ? (
                <svg viewBox="0 0 10 8" className="h-2.5 w-2.5 fill-none stroke-white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M1 4l2.5 2.5L9 1" />
                </svg>
              ) : null}
            </span>
            <div className="min-w-0">
              <p className={cn("text-sm font-medium leading-5", done ? "text-foreground" : "text-muted-foreground")}>
                {statusLabel(step)}
              </p>
              {ts ? (
                <p className="text-xs text-muted-foreground">{new Date(ts).toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short" })}</p>
              ) : null}
            </div>
          </li>
        );
      })}
      {special ? (
        <li className="flex items-center gap-2">
          <StatusBadge status={current} />
          <span className="text-xs text-muted-foreground">This order was closed with status above.</span>
        </li>
      ) : null}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export function dateShort(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
}

/** "12 Oct 2026, 2:56 pm" — used by chat timestamps. */
export function fmtDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" }).format(new Date(iso));
}

export function discountPercent(price: number, compareAt: number | null | undefined): number | null {
  if (compareAt && compareAt > price) return Math.round(100 - (price / compareAt) * 100);
  return null;
}

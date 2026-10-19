"use client";
// ============================================================================
// Shopper surface — shared UI bits, types + cart plumbing (Task 2-e).
// All money values are integer minor units; always format via formatMinor.
// Task 10/11 rebuild: shipment-event timeline (StatusTimeline) + ViewProofButton
// (POD photo dialog) shared by the buyer order detail / purchases surfaces.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import { formatMinor } from "@/lib/money";
import { deviceHeaders } from "@/lib/session-client";
import { useApp } from "@/lib/app-store";
import { fontStack, nameSizePx, priceSizePx, fontLinkHref, type CardStyleTokens } from "@/lib/fonts";
import {
  AlertTriangle,
  Bike,
  Camera,
  ClipboardCheck,
  Home,
  MapPin,
  PackageCheck,
  PackageOpen,
  Minus,
  Plus,
  RotateCcw,
  Star,
  StarHalf,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Shopper state-machine view + nav context (shared by all shopper views)
// ---------------------------------------------------------------------------

export type ShopperView =
  | { name: "market" }
  | { name: "category"; categorySlug: string; label?: string }
  | { name: "search"; q: string }
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
  | { name: "me"; tab?: string };

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
  lineTotalMinor: number;
  imageUrl: string;
  storeId: string;
  storeSlug: string;
  storeName: string;
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

/** Fetch the account cart and live-refresh on sm-cart-updated events + on any
 *  sign-in / sign-out change (carts are account-scoped — guests have none). */
export function useCart() {
  const me = useApp((s) => s.me);
  const authed = Boolean(me.loaded && me.shopper);
  const [cart, setCart] = useState<CartT | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJson<{ cart: CartT }>("/api/cart");
      setCart(data.cart ?? { id: null, storeId: null, storeSlug: null, storeName: null, items: [] });
    } catch {
      setCart({ id: null, storeId: null, storeSlug: null, storeName: null, items: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const onEvt = () => refresh();
    window.addEventListener(CART_EVENT, onEvt);
    return () => window.removeEventListener(CART_EVENT, onEvt);
  }, [refresh, authed]);

  const count = cart?.items.reduce((s, i) => s + i.qty, 0) ?? 0;
  const subtotal = cart?.items.reduce((s, i) => s + i.lineTotalMinor, 0) ?? 0;
  return { cart, count, subtotal, loading, refresh };
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

export function ProductCard({
  p,
  onOpen,
  showStore = true,
  hidePrice = false,
  cardStyle,
}: {
  p: ProductCardT;
  onOpen: (p: ProductCardT) => void;
  showStore?: boolean;
  hidePrice?: boolean;
  /** Seller-customized typography — only passed on the seller's own storefront. */
  cardStyle?: CardStyleTokens | null;
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
  return (
    <button
      type="button"
      onClick={() => onOpen(p)}
      className="group text-left rounded-xl border bg-card shadow-soft overflow-hidden hover:shadow-md hover:border-teal-600/40 hover:-translate-y-0.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/50"
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
      <div className="p-2.5 space-y-1">
        <h3 className={cn("font-medium leading-snug line-clamp-2 min-h-[2rem]", !cardStyle && "text-xs")} style={nameCss}>{p.title}</h3>
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
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  small?: boolean;
}) {
  const btn = small ? "h-8 w-8" : "h-10 w-10";
  return (
    <div className="inline-flex items-center rounded-lg border" role="group" aria-label="Quantity">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(btn, "rounded-r-none")}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label="Decrease quantity"
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <span
        className={cn("flex items-center justify-center text-sm font-semibold tabular-nums", small ? "w-8" : "w-10")}
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
        <Plus className="h-3.5 w-3.5" />
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

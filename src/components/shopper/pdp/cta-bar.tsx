"use client";
// ============================================================================
// PDP makeover — TikTok-style product CTA bar (replaces the bottom navigation
// on the product page, mobile only).
//
// BUYER WORK ORDER UPDATE:
//   • The Shop (storefront) icon is REPLACED by the Chat icon — the bar is
//     [ Chat ] [ − qty + ] [ Add to cart ] [ Buy now ], matching the TikTok
//     reference (the store stays one tap away via the seller card/breadcrumb).
//   • A small −/+ quantity stepper sits NEXT TO the Add to cart button —
//     same state machine as the in-flow controls (MOQ floor, stock ceiling,
//     pdp qty_changed analytics via the parent's onChange).
//   • Theme colors: the Buy now pill and the Add to cart circle follow the
//     platform brand (teal/brand-gradient) — no TikTok coral, no amber.
//
// EVERY action rides the EXISTING server-validated architecture — no parallel
// logic: Chat → the product-scoped chat thread (auth-gated with intent
// resume) · Add to cart / Buy now → the SAME handlers as the in-flow controls
// (variant sheet opens when an option is required; server re-checks stock on
// every add; Buy Now = validated add + checkout). Desktop keeps the in-flow
// purchase column + the desktop sticky bar — this bar is strictly the mobile
// product canvas.
// ============================================================================
import { Loader2, MessageCircle, Minus, Plus, ShoppingCart, Zap } from "lucide-react";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";

export function PdpCtaBar({
  storeName,
  price,
  freeShipping,
  qty,
  qtyMin,
  qtyMax,
  onQtyChange,
  chatBusy,
  adding,
  disabled,
  actionLabel,
  onOpenStore,
  onChat,
  onAddToCart,
  onBuyNow,
}: {
  storeName: string;
  /** Current effective unit price (selected SKU or product base). */
  price: number;
  /** Real state: line total ≥ the platform's free-standard-delivery threshold. */
  freeShipping: boolean;
  /** Cart quantity for THIS add (MOQ floor already applied by the parent). */
  qty: number;
  /** Lowest allowed qty (MOQ). */
  qtyMin: number;
  /** Highest allowed qty (selected variant stock, or a display cap). */
  qtyMax: number;
  onQtyChange: (v: number) => void;
  chatBusy: boolean;
  /** A cart mutation is in flight (disables both purchase buttons). */
  adding: boolean;
  /** Hard purchase block (single-variant product out of stock). */
  disabled: boolean;
  /** Label describing the pending choice (e.g. "Choose an option"). */
  actionLabel: string | null;
  onChat: () => void;
  onAddToCart: () => void;
  onBuyNow: () => void;
}) {
  const btn =
    "flex h-11 w-11 min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

  return (
    <nav
      aria-label="Product actions"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-lg items-center gap-1.5 px-3 py-2">
        {/* Chat — product-scoped thread with the seller. Buyer work order:
            this REPLACED the Shop icon (the storefront stays reachable via
            the seller card + breadcrumb). */}
        <button type="button" onClick={onChat} className={btn} aria-label={`Chat with ${storeName}`} disabled={chatBusy}>
          {chatBusy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <MessageCircle className="h-5 w-5" aria-hidden="true" />}
          <span className="text-[10px] font-semibold leading-none">Chat</span>
        </button>

        {/* Small quantity stepper — NEXT TO the Add to cart (buyer work
            order). Same clamps as the in-flow QtyStepper: MOQ floor, stock
            ceiling. Sized compactly (h-9 controls) so the bar keeps the
            TikTok rhythm. */}
        <div
          role="group"
          aria-label="Quantity"
          className={cn("mx-0.5 flex h-9 shrink-0 items-center rounded-full border border-slate-200 bg-card dark:border-muted", disabled && "opacity-50")}
        >
          <button
            type="button"
            onClick={() => onQtyChange(Math.max(qtyMin, qty - 1))}
            disabled={disabled || qty <= qtyMin}
            aria-label="Decrease quantity"
            className="flex h-9 w-8 items-center justify-center rounded-l-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Minus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span className="w-7 text-center text-xs font-bold tabular-nums" aria-live="polite" aria-label={`Quantity ${qty}`}>
            {qty}
          </span>
          <button
            type="button"
            onClick={() => onQtyChange(Math.min(qtyMax, qty + 1))}
            disabled={disabled || qty >= qtyMax}
            aria-label="Increase quantity"
            className="flex h-9 w-8 items-center justify-center rounded-r-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Add to cart — theme-colored circle (platform teal; was TikTok pink) */}
        <button
          type="button"
          onClick={onAddToCart}
          disabled={adding || disabled}
          aria-label={actionLabel ?? `Add ${qty > 1 ? `${qty} ` : ""}to cart`}
          className={cn(
            "mx-1 flex h-12 w-12 min-h-[48px] shrink-0 items-center justify-center rounded-full bg-teal-700 text-white shadow-sm transition-all hover:bg-teal-800 active:scale-95 disabled:opacity-50",
            adding && "animate-pulse"
          )}
        >
          {adding ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <ShoppingCart className="h-5 w-5" aria-hidden="true" />}
        </button>

        {/* Buy now — BRAND-GRADIENT pill with the real price (and real
            free-shipping state). Platform theme colors (was #FE2C55 coral). */}
        <button
          type="button"
          onClick={onBuyNow}
          disabled={adding || disabled}
          aria-label={actionLabel ?? `Buy now for ${formatMinor(price)}`}
          className="flex h-12 min-h-[48px] min-w-0 flex-1 flex-col items-center justify-center rounded-full bg-brand-gradient px-4 text-white shadow-md transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
        >
          <span className="flex items-center gap-1.5 text-base font-bold leading-tight">
            <Zap className="h-4 w-4" aria-hidden="true" />
            {disabled ? "Out of stock" : "Buy now"}
          </span>
          <span className="text-[11px] font-medium leading-tight text-white/90">
            {formatMinor(price)}
            {freeShipping ? " · FREE delivery" : ""}
          </span>
        </button>
      </div>
    </nav>
  );
}

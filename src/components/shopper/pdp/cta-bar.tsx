"use client";
// ============================================================================
// PDP makeover — TikTok-style product CTA bar (replaces the bottom navigation
// on the product page, mobile only).
//
// Reference layout (buyer's TikTok Shop screenshot):
//   [ Shop ]  [ Chat ]  [ (pink circle: cart+) ]  [ Buy now — big red pill ]
//                                                  └ price + free-shipping
//
// EVERY action rides the EXISTING server-validated architecture — no parallel
// logic: Shop → storefront view · Chat → the product-scoped chat thread
// (auth-gated with intent resume) · Add to cart / Buy now → the SAME handlers
// as the in-flow controls (variant sheet opens when an option is required;
// server re-checks stock on every add; Buy Now = validated add + checkout).
// Desktop keeps the in-flow purchase column + the desktop sticky bar — this
// bar is strictly the mobile product canvas.
// ============================================================================
import { Loader2, MessageCircle, ShoppingCart, Store, Zap } from "lucide-react";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";

export function PdpCtaBar({
  storeName,
  price,
  freeShipping,
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
  chatBusy: boolean;
  /** A cart mutation is in flight (disables both purchase buttons). */
  adding: boolean;
  /** Hard purchase block (single-variant product out of stock). */
  disabled: boolean;
  /** Label describing the pending choice (e.g. "Choose an option"). */
  actionLabel: string | null;
  onOpenStore: () => void;
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
      <div className="mx-auto flex max-w-lg items-center gap-2 px-3 py-2">
        {/* Shop — the seller's storefront */}
        <button type="button" onClick={onOpenStore} className={btn} aria-label={`Visit ${storeName} store`}>
          <Store className="h-5 w-5" aria-hidden="true" />
          <span className="text-[10px] font-semibold leading-none">Shop</span>
        </button>

        {/* Chat — product-scoped thread with the seller */}
        <button type="button" onClick={onChat} className={btn} aria-label={`Chat with ${storeName}`} disabled={chatBusy}>
          {chatBusy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <MessageCircle className="h-5 w-5" aria-hidden="true" />}
          <span className="text-[10px] font-semibold leading-none">Chat</span>
        </button>

        {/* Add to cart — pink circle (TikTok reference) */}
        <button
          type="button"
          onClick={onAddToCart}
          disabled={adding || disabled}
          aria-label={actionLabel ?? "Add to cart"}
          className={cn(
            "mx-1 flex h-12 w-12 min-h-[48px] shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 shadow-sm transition-all hover:bg-rose-200 active:scale-95 disabled:opacity-50",
            adding && "animate-pulse"
          )}
        >
          {adding ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <ShoppingCart className="h-5 w-5" aria-hidden="true" />}
        </button>

        {/* Buy now — vivid coral pill with the real price (and real free-
            shipping state) as the TikTok reference shows. #FE2C55 is reserved
            for conversion actions + promo indicators, exactly as specified. */}
        <button
          type="button"
          onClick={onBuyNow}
          disabled={adding || disabled}
          aria-label={actionLabel ?? `Buy now for ${formatMinor(price)}`}
          className="flex h-12 min-h-[48px] min-w-0 flex-1 flex-col items-center justify-center rounded-full bg-[#FE2C55] px-4 text-white shadow-md transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
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

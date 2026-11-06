"use client";
// ============================================================================
// PDP makeover — primary sticky purchase action bar (Phase 4).
// ONE persistent purchase bar (no competing sticky variant preview): it
// appears via IntersectionObserver when the in-flow purchase controls scroll
// out of the viewport (no arbitrary scroll thresholds), and hides again when
// they return.
//
// Stacking contract: the mobile bottom navigation is fixed z-40 at the screen
// bottom — this bar floats ABOVE it (bottom = nav height + safe-area inset),
// never covering it; on md+ (no bottom nav) it docks to the viewport bottom.
// Cart/sheet overlays (Radix z-50) always cover it.
// ============================================================================
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ShoppingCart, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";

export function PdpStickyBar({
  anchorRef,
  price,
  compareAt,
  selectedLabel,
  requiresVariant,
  adding,
  outOfStock,
  onAddToCart,
  onBuyNow,
}: {
  /** Ref of the in-flow purchase controls — visibility drives this bar. */
  anchorRef: React.RefObject<HTMLElement | null>;
  price: number;
  compareAt: number | null;
  /** e.g. "Size: M" — current selection summary (null while unselected). */
  selectedLabel: string | null;
  /** Product needs a variant choice and none is selected → CTAs open the sheet. */
  requiresVariant: boolean;
  adding: boolean;
  outOfStock: boolean;
  onAddToCart: () => void;
  onBuyNow: () => void;
}) {
  const [visible, setVisible] = useState(false);

  // Visibility = element-viewport geometry: the bar shows while the in-flow
  // purchase controls sit FULLY above the viewport (rect.bottom < 0) and
  // hides the moment any part re-enters. A plain IntersectionObserver cannot
  // handle this: an anchor that JUMPS from below the viewport to above it
  // (scroll restoration, keyboard End, anchor links) never passes through an
  // "intersecting" state, so its isIntersecting boolean never changes and no
  // callback fires. A rAF-throttled rect check is equally element-relative
  // (no arbitrary scroll thresholds) and robust to jumps AND gradual scrolls.
  useEffect(() => {
    const el = anchorRef?.current ?? null;
    if (!el || typeof window === "undefined") return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      setVisible(r.bottom < 0);
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [anchorRef]);

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          initial={{ y: "110%" }}
          animate={{ y: 0 }}
          exit={{ y: "110%" }}
          transition={{ type: "tween", duration: 0.22, ease: "easeOut" }}
          className="fixed inset-x-0 z-40 border-t bg-background/95 shadow-[0_-4px_16px_rgb(0_0_0/0.08)] backdrop-blur supports-[backdrop-filter]:bg-background/85 md:bottom-0!"
          style={{ bottom: "calc(4.25rem + env(safe-area-inset-bottom))" }}
          role="region"
          aria-label="Quick purchase"
        >
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-3 py-2 md:px-4">
            <div className="min-w-0 shrink-0 leading-tight">
              <div className="flex items-baseline gap-1.5">
                <span className={cn("text-lg font-extrabold tracking-tight", compareAt && compareAt > price ? "text-[#FE2C55]" : "text-teal-700")}>
                  {formatMinor(price)}
                </span>
                {compareAt && compareAt > price ? <span className="text-xs text-muted-foreground line-through">{formatMinor(compareAt)}</span> : null}
              </div>
              {selectedLabel ? (
                <p className="max-w-[38vw] truncate text-[11px] text-muted-foreground md:max-w-none">{selectedLabel}</p>
              ) : requiresVariant ? (
                <p className="text-[11px] font-medium text-amber-600">Select options first</p>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-2 md:gap-2.5">
              <Button
                size="lg"
                disabled={adding || outOfStock}
                onClick={onAddToCart}
                className="h-11 min-h-[44px] gap-1.5 border-teal-700/40 bg-card px-3 text-teal-800 hover:bg-teal-50 md:px-5"
                variant="outline"
                aria-label={requiresVariant ? "Add to cart — select options" : "Add to cart"}
              >
                <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">{adding ? "Adding…" : "Add to cart"}</span>
                <span className="sm:hidden">{adding ? "…" : "Add"}</span>
              </Button>
              <Button
                size="lg"
                disabled={adding || outOfStock}
                onClick={onBuyNow}
                className="h-11 min-h-[44px] min-w-[110px] gap-1.5 bg-amber-500 px-4 text-white hover:bg-amber-600 md:px-6"
                aria-label={requiresVariant ? "Buy now — select options" : "Buy now"}
              >
                <Zap className="h-4 w-4" aria-hidden="true" />
                Buy now
              </Button>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

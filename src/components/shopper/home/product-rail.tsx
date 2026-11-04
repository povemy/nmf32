"use client";
// ============================================================================
// HomeProductRail — reusable horizontal product shelf (flash deals, trending,
// inline campaign shelves). Native touch scrolling with scroll-snap; desktop
// gets prev/next chevrons. Product cards reuse the platform ProductCard so
// every merchandising surface shows identical data/eligibility.
// ============================================================================
import { useRef, useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { openProduct, ProductCard, type ProductCardT, type ShopperCtx } from "../ui-bits";
import { cn } from "@/lib/utils";

export function HomeProductRail({
  products,
  ctx,
  ariaLabel,
  quickActions = false,
  showStore = false,
}: {
  products: ProductCardT[];
  ctx: ShopperCtx;
  ariaLabel: string;
  /** Desktop homepage work order: wishlist + add-to-cart quick actions on the
   *  cards (md+ only — mobile cards unchanged). */
  quickActions?: boolean;
  /** Show the seller name on the card (e.g. the Trending section). */
  showStore?: boolean;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 8);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    sync();
    const el = railRef.current;
    if (!el) return;
    el.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => {
      el.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [sync, products.length]);

  const nudge = (dir: 1 | -1) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(320, el.clientWidth * 0.8), behavior: "smooth" });
  };

  return (
    <div className="relative">
      <div
        ref={railRef}
        role="region"
        aria-label={ariaLabel}
        className="flex snap-x snap-mandatory gap-2.5 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {products.map((p) => (
          <div key={p.id} className="w-[46%] xs:w-[40%] sm:w-[30%] md:w-[23%] lg:w-[19%] xl:w-[15.5%] shrink-0 snap-start">
            <ProductCard p={p} onOpen={(pp) => openProduct(ctx, pp)} quickActions={quickActions} showStore={showStore} />
          </div>
        ))}
      </div>

      {/* desktop nudgers — hidden while the rail is at either end */}
      <button
        type="button"
        onClick={() => nudge(-1)}
        aria-label={`Scroll ${ariaLabel} left`}
        className={cn(
          "absolute -left-3 top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border bg-background/95 shadow-sm hover:bg-background md:flex",
          atStart && "pointer-events-none opacity-0"
        )}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => nudge(1)}
        aria-label={`Scroll ${ariaLabel} right`}
        className={cn(
          "absolute -right-3 top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border bg-background/95 shadow-sm hover:bg-background md:flex",
          atEnd && "pointer-events-none opacity-0"
        )}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

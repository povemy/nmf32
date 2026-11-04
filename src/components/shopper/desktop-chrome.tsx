"use client";
// ============================================================================
// Desktop chrome (desktop homepage work order) — the two desktop-only bands
// around the main market header:
//   • UtilityBar     — slim informational strip ABOVE the header (scrolls
//                      away; the header itself stays sticky).
//   • DesktopNavBar  — prominent horizontal navigation bar rendered inside
//                      the sticky header, below the main row (All Categories
//                      dropdown + key marketplace destinations + More).
//
// STRICT SCOPE: both bands are `hidden md:*` — the mobile header, the mobile
// hamburger Sheet and the mobile BottomNav are untouched (separate work
// order). Every item points at a REAL platform destination — no decorative
// buttons, no invented shipping/returns/authenticity claims in the utility
// bar (the sandbox has no such published policies to cite).
// ============================================================================
import {
  ChevronDown,
  HandCoins,
  LayoutGrid,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  PackageSearch,
  Sparkles,
  Store,
  Ticket,
  TrendingUp,
  Wand2,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { categoryIcon } from "./market";
import { HOME_SECTION_IDS, navToHomeSection } from "./home/cta";
import type { CategoryT, ShopperView } from "./ui-bits";

// ---------------------------------------------------------------------------
// UtilityBar — desktop-only slim information strip above the sticky header.
// ---------------------------------------------------------------------------

export function UtilityBar({ nav }: { nav: (v: ShopperView) => void }) {
  const me = useApp((s) => s.me);
  const setSurface = useApp((s) => s.setSurface);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const signedIn = Boolean(me.loaded && me.shopper);

  const itemCls =
    "inline-flex items-center gap-1.5 rounded px-2 py-1 transition-colors hover:text-white hover:bg-teal-800/60";

  return (
    <div className="hidden border-b border-teal-50/10 bg-teal-950 text-teal-200/85 md:block">
      <div className="mx-auto flex h-9 max-w-7xl items-center justify-between gap-4 px-4">
        {/* factual platform line — the same wording the footer already uses */}
        <p className="truncate text-[11px] font-medium tracking-wide text-teal-100/70">
          NOMOFEE — the marketplace where independent Malaysian shops sell
        </p>
        <nav aria-label="Utilities" className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium">
          <button type="button" onClick={() => nav({ name: "lookup" })} className={itemCls}>
            <PackageSearch className="h-3.5 w-3.5" aria-hidden="true" /> Track my order
          </button>
          <button
            type="button"
            onClick={() => (signedIn ? nav({ name: "messages" }) : openShopperAuth())}
            className={itemCls}
            aria-label="Help and chat with sellers"
          >
            <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" /> Help &amp; chat
          </button>
          <button type="button" onClick={() => setSurface("seller")} className={itemCls}>
            <Store className="h-3.5 w-3.5" aria-hidden="true" /> Seller Centre
          </button>
        </nav>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DesktopNavBar — prominent horizontal navigation bar (inside sticky header).
// ---------------------------------------------------------------------------

const LINK_CLS =
  "inline-flex h-9 min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium text-teal-100/85 transition-colors hover:bg-teal-800/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/60";

export function DesktopNavBar({
  view,
  nav,
  categories,
}: {
  view: ShopperView;
  nav: (v: ShopperView) => void;
  categories: CategoryT[] | null;
}) {
  const me = useApp((s) => s.me);
  const setSurface = useApp((s) => s.setSurface);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const signedIn = Boolean(me.loaded && me.shopper);
  const onHome = view.name === "market";

  const isDeals = view.name === "search" && Boolean(view.deals);
  const isPopular = view.name === "search" && view.sort === "popular";
  const isNew = view.name === "search" && view.sort === "newest";
  const isCategory = view.name === "category";
  const isVouchers = view.name === "me" && view.tab === "vouchers";

  return (
    <nav aria-label="Marketplace sections" className="hidden border-t border-teal-50/10 bg-teal-900 md:block">
      <div className="mx-auto flex h-11 max-w-7xl items-center gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* All Categories — the SAME category tree + dropdown pattern the
            header used to carry (moved here so the nav bar owns browsing). */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-9 min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-brand-gradient px-3.5 text-[13px] font-semibold text-white shadow-sm transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/60",
                isCategory && "ring-2 ring-teal-300/60"
              )}
              aria-label="Browse all categories"
            >
              <LayoutGrid className="h-4 w-4" aria-hidden="true" /> All Categories <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64 max-h-[70vh] overflow-y-auto">
            {categories == null ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              categories.map((c) => {
                const Icon = categoryIcon(c.name);
                return c.children.length > 0 ? (
                  <DropdownMenuSub key={c.id}>
                    <DropdownMenuSubTrigger className="min-h-[44px]">
                      <span className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-teal-700" />
                        {c.name}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-56">
                      <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "category", categorySlug: c.slug, label: c.name })}>
                        All {c.name}
                      </DropdownMenuItem>
                      {c.children.map((ch) => (
                        <DropdownMenuItem key={ch.id} className="min-h-[44px]" onClick={() => nav({ name: "category", categorySlug: ch.slug, label: ch.name })}>
                          {ch.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : (
                  <DropdownMenuItem key={c.id} className="min-h-[44px]" onClick={() => nav({ name: "category", categorySlug: c.slug, label: c.name })}>
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-teal-700" />
                      {c.name}
                    </span>
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="mx-1.5 h-4 w-px shrink-0 bg-teal-50/15" aria-hidden="true" />

        {/* key marketplace destinations — every item a REAL view */}
        <button
          type="button"
          onClick={() => nav({ name: "search", q: "", deals: true })}
          className={cn(LINK_CLS, isDeals && "bg-teal-800 text-white")}
          aria-current={isDeals ? "page" : undefined}
        >
          <Zap className="h-4 w-4 text-amber-300" aria-hidden="true" /> Flash Deals
        </button>
        <button
          type="button"
          onClick={() => nav({ name: "search", q: "", sort: "popular" })}
          className={cn(LINK_CLS, isPopular && "bg-teal-800 text-white")}
          aria-current={isPopular ? "page" : undefined}
        >
          <TrendingUp className="h-4 w-4 text-amber-300" aria-hidden="true" /> Popular Products
        </button>
        <button
          type="button"
          onClick={() => navToHomeSection(nav, HOME_SECTION_IDS.stores, onHome)}
          className={LINK_CLS}
        >
          <Store className="h-4 w-4 text-amber-300" aria-hidden="true" /> Featured Stores
        </button>
        <button
          type="button"
          onClick={() => nav({ name: "me", tab: "vouchers" })}
          className={cn(LINK_CLS, isVouchers && "bg-teal-800 text-white")}
          aria-current={isVouchers ? "page" : undefined}
        >
          <Ticket className="h-4 w-4 text-amber-300" aria-hidden="true" /> Vouchers
        </button>
        <button
          type="button"
          onClick={() => nav({ name: "search", q: "", sort: "newest" })}
          className={cn(LINK_CLS, isNew && "bg-teal-800 text-white")}
          aria-current={isNew ? "page" : undefined}
        >
          <Sparkles className="h-4 w-4 text-amber-300" aria-hidden="true" /> New Arrivals
        </button>

        {/* More — secondary real destinations */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(LINK_CLS, "px-2.5")}
              aria-label="More destinations"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" /> More
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "lookup" })}>
              <PackageSearch className="h-4 w-4 text-teal-700" /> Track my order
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-[44px]"
              onClick={() => (signedIn ? nav({ name: "messages" }) : openShopperAuth())}
            >
              <MessagesSquare className="h-4 w-4 text-teal-700" /> Messages &amp; chat
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "affiliate" })}>
              <HandCoins className="h-4 w-4 text-teal-700" /> Earn with NOMOFEE
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "generate" })}>
              <Wand2 className="h-4 w-4 text-teal-700" /> Generate a store from a link
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-[44px]" onClick={() => setSurface("seller")}>
              <Store className="h-4 w-4 text-teal-700" /> Sell on NOMOFEE
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}

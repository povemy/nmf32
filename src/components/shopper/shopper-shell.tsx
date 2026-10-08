"use client";
// ============================================================================
// ShopperShell — the SHOPPER surface root (Task 2-e).
// Internal view state machine (no URL routing), sticky market header, category
// menu, global cart drawer, footer, and mounting of every shopper view.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ShoppingBag,
  Search,
  ShoppingCart,
  ChevronDown,
  Menu,
  PackageSearch,
  Trash2,
  Store,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/lib/app-store";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  fetchJson,
  patchJson,
  deleteJson,
  useCart,
  EmptyState,
  QtyStepper,
  type CategoryT,
  type ShopperCtx,
  type ShopperView,
} from "./ui-bits";
import MarketHome, { ResultsView, categoryIcon } from "./market";
import PdpView from "./pdp";
import StorefrontView, { StorePageView } from "./storefront";
import { CheckoutView, PayView, OrderStatusView, LookupView } from "./checkout";

const VIEW_KEY = "sm_shopper_view";

function isStoreChrome(view: ShopperView): boolean {
  return view.name === "storefront" || view.name === "store-page";
}

export default function ShopperShell() {
  const setSurface = useApp((s) => s.setSurface);
  const activeStoreSlug = useApp((s) => s.activeStoreSlug);
  const setActiveStoreSlug = useApp((s) => s.setActiveStoreSlug);

  const [view, setView] = useState<ShopperView>({ name: "market" });
  const [ready, setReady] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [headerSearch, setHeaderSearch] = useState("");
  const restored = useRef(false);

  // ---- mount: activeStoreSlug override, else restore last view --------------
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (activeStoreSlug) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
      setView({ name: "storefront", slug: activeStoreSlug });
      setActiveStoreSlug(null);
    } else {
      try {
        const raw = window.localStorage.getItem(VIEW_KEY);
        if (raw) {
          const v = JSON.parse(raw) as ShopperView;
          if (v && typeof v.name === "string") setView(v);
        }
      } catch {
        /* ignore */
      }
    }
    setReady(true);
  }, [activeStoreSlug, setActiveStoreSlug]);

  // ---- nav helper: persist + scroll to top ----------------------------------
  const nav = useCallback((v: ShopperView) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, JSON.stringify(v));
    } catch {
      /* ignore */
    }
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  // refresh storefront/store-page when slug changes externally
  useEffect(() => {
    if (!ready) return;
    if (activeStoreSlug) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
      setView({ name: "storefront", slug: activeStoreSlug });
      setActiveStoreSlug(null);
    }
  }, [activeStoreSlug, ready, setActiveStoreSlug]);

  const ctx = useMemo<ShopperCtx>(() => ({ nav, openCart: () => setCartOpen(true) }), [nav]);

  const showChrome = !isStoreChrome(view);

  return (
    <div className="flex-1 flex flex-col min-h-screen">
      <Toaster position="top-center" richColors />

      {showChrome ? (
        <MarketHeader
          view={view}
          nav={nav}
          openCart={() => setCartOpen(true)}
          search={headerSearch}
          setSearch={setHeaderSearch}
        />
      ) : null}

      <AnimatePresence mode="wait">
        <motion.main
          key={`${view.name}:${"slug" in view ? view.slug : ""}:${"pSlug" in view ? view.pSlug : ""}:${"ref" in view ? view.ref : ""}:${view.name === "search" ? view.q : view.name === "category" ? view.categorySlug : view.name === "order-status" ? view.orderNumber : view.name === "store-page" ? view.pageSlug : ""}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="flex-1 flex flex-col"
        >
          {view.name === "market" ? <MarketHome ctx={ctx} /> : null}
          {view.name === "search" ? <ResultsView ctx={ctx} mode={{ kind: "search", q: view.q }} /> : null}
          {view.name === "category" ? (
            <ResultsView ctx={ctx} mode={{ kind: "category", categorySlug: view.categorySlug, label: view.label }} />
          ) : null}
          {view.name === "storefront" ? <StorefrontView ctx={ctx} slug={view.slug} /> : null}
          {view.name === "store-page" ? <StorePageView ctx={ctx} slug={view.slug} pageSlug={view.pageSlug} /> : null}
          {view.name === "pdp" ? <PdpView ctx={ctx} slug={view.slug} pSlug={view.pSlug} /> : null}
          {view.name === "checkout" ? <CheckoutView ctx={ctx} /> : null}
          {view.name === "pay" ? <PayView ctx={ctx} paymentRef={view.ref} /> : null}
          {view.name === "order-status" ? <OrderStatusView ctx={ctx} orderNumber={view.orderNumber} /> : null}
          {view.name === "lookup" ? <LookupView ctx={ctx} /> : null}
        </motion.main>
      </AnimatePresence>

      {showChrome ? (
        <ShopperFooter
          onSeller={() => setSurface("seller")}
          onLookup={() => nav({ name: "lookup" })}
          onMarket={() => nav({ name: "market" })}
        />
      ) : null}

      <CartDrawer open={cartOpen} onOpenChange={setCartOpen} ctx={ctx} />
    </div>
  );
}

// =============================================================================================
// Market header (global chrome for market/search/category/pdp/checkout/… views)
// =============================================================================================

function MarketHeader({
  view,
  nav,
  openCart,
  search,
  setSearch,
}: {
  view: ShopperView;
  nav: (v: ShopperView) => void;
  openCart: () => void;
  search: string;
  setSearch: (s: string) => void;
}) {
  const { count } = useCart();
  const [categories, setCategories] = useState<CategoryT[] | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchJson<{ categories: CategoryT[] }>("/api/market/home")
      .then((d) => alive && setCategories(d.categories ?? []))
      .catch(() => alive && setCategories([]));
    return () => {
      alive = false;
    };
  }, []);

  function submitSearch() {
    nav({ name: "search", q: search.trim() });
    setMobileOpen(false);
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex max-w-7xl items-center gap-2 sm:gap-4 px-4 py-3">
        {/* mobile menu */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              className="md:hidden flex h-10 w-10 min-h-[44px] items-center justify-center rounded-lg hover:bg-muted transition-colors"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="w-80 p-0">
            <SheetHeader className="border-b p-4">
              <SheetTitle className="flex items-center gap-2 text-left">
                <ShoppingBag className="h-5 w-5 text-teal-700" /> SHOPMESH
              </SheetTitle>
            </SheetHeader>
            <div className="p-4 space-y-4 overflow-y-auto max-h-[calc(100vh-80px)]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitSearch()}
                  placeholder="Search products…"
                  className="pl-8 min-h-[44px]"
                  aria-label="Search products"
                />
              </div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Categories</p>
              <ul className="space-y-1">
                {(categories ?? []).flatMap((c) => [{ name: c.name, slug: c.slug, child: false }, ...c.children.map((ch) => ({ name: `↳ ${ch.name}`, slug: ch.slug, child: true }))]).map((c) => (
                  <li key={c.slug}>
                    <button
                      type="button"
                      onClick={() => {
                        nav({ name: "category", categorySlug: c.slug, label: c.name.replace("↳ ", "") });
                        setMobileOpen(false);
                      }}
                      className={cn(
                        "w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium hover:bg-muted transition-colors min-h-[44px]",
                        c.child && "text-muted-foreground pl-6"
                      )}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
              <Separator />
              <button
                type="button"
                onClick={() => {
                  nav({ name: "lookup" });
                  setMobileOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted min-h-[44px]"
              >
                <PackageSearch className="h-4 w-4 text-teal-700" /> Track my order
              </button>
            </div>
          </SheetContent>
        </Sheet>

        {/* logo */}
        <button type="button" onClick={() => nav({ name: "market" })} className="flex min-h-[44px] items-center gap-2" aria-label="SHOPMESH home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-700 text-white shadow-sm">
            <ShoppingBag className="h-5 w-5" />
          </span>
          <span className="text-lg font-extrabold tracking-tight text-teal-900">
            SHOP<span className="text-emerald-600">MESH</span>
          </span>
        </button>

        {/* category dropdown (desktop) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="hidden md:inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Browse categories"
            >
              <Menu className="h-4 w-4" /> Categories <ChevronDown className="h-3.5 w-3.5" />
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

        {/* search (desktop) */}
        <div className="relative ml-auto hidden flex-1 max-w-md md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitSearch()}
            placeholder="Search the marketplace…"
            className="pl-9 min-h-[44px] rounded-full"
            aria-label="Search the marketplace"
          />
        </div>

        <div className="ml-auto md:ml-0 flex items-center gap-1.5">
          {/* track order */}
          <button
            type="button"
            onClick={() => nav({ name: "lookup" })}
            className={cn(
              "hidden sm:inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
              view.name === "lookup" && "text-teal-800 bg-teal-50"
            )}
          >
            <PackageSearch className="h-4 w-4" /> Track order
          </button>

          {/* cart */}
          <button
            type="button"
            onClick={openCart}
            aria-label={`Open cart, ${count} item${count === 1 ? "" : "s"}`}
            className="relative flex h-10 w-10 min-h-[44px] items-center justify-center rounded-lg border bg-card hover:bg-muted transition-colors"
          >
            <ShoppingCart className="h-5 w-5 text-teal-700" />
            {count > 0 ? (
              <motion.span
                key={count}
                initial={{ scale: 0.5 }}
                animate={{ scale: 1 }}
                className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-extrabold text-white shadow"
              >
                {count > 99 ? "99+" : count}
              </motion.span>
            ) : null}
          </button>
        </div>
      </div>
    </header>
  );
}

// =============================================================================================
// Footer (global chrome)
// =============================================================================================

function ShopperFooter({
  onSeller,
  onLookup,
  onMarket,
}: {
  onSeller: () => void;
  onLookup: () => void;
  onMarket: () => void;
}) {
  return (
    <footer className="mt-auto border-t bg-gradient-to-b from-teal-950 to-teal-900 text-teal-50">
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50/10">
                <ShoppingBag className="h-5 w-5 text-amber-300" />
              </span>
              SHOP<span className="text-emerald-300">MESH</span>
            </p>
            <p className="max-w-md text-xs text-teal-200/80">
              The marketplace where independent Malaysian shops launch beautiful storefronts in minutes.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onMarket}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-teal-50/20 px-4 text-xs font-semibold text-teal-100 hover:bg-teal-50/10 transition-colors"
            >
              <Store className="h-3.5 w-3.5" /> Browse stores
            </button>
            <button
              type="button"
              onClick={onLookup}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-teal-50/20 px-4 text-xs font-semibold text-teal-100 hover:bg-teal-50/10 transition-colors"
            >
              <PackageSearch className="h-3.5 w-3.5" /> Track order
            </button>
            <Button
              onClick={onSeller}
              className="min-h-[44px] rounded-full bg-amber-400 text-teal-950 hover:bg-amber-300 font-bold"
            >
              Powered by SHOPMESH — launch your free store <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="pt-8 text-center text-[11px] text-teal-200/60">© {new Date().getFullYear()} SHOPMESH v1 · Sandbox demo</p>
      </div>
    </footer>
  );
}

// =============================================================================================
// Cart drawer (global)
// =============================================================================================

function CartDrawer({ open, onOpenChange, ctx }: { open: boolean; onOpenChange: (o: boolean) => void; ctx: ShopperCtx }) {
  const { cart, count, subtotal, loading } = useCart();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setQty(itemId: string, qty: number) {
    setBusyId(itemId);
    try {
      if (qty <= 0) await deleteJson(`/api/cart/items/${itemId}`);
      else await patchJson(`/api/cart/items/${itemId}`, { qty });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update cart");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full sm:max-w-md flex-col p-0">
        <SheetHeader className="border-b p-4 space-y-0">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ShoppingCart className="h-5 w-5 text-teal-700" />
            Your cart
            {count > 0 ? <span className="text-sm font-normal text-muted-foreground">({count} item{count === 1 ? "" : "s"})</span> : null}
          </SheetTitle>
          {cart?.storeName ? (
            <p className="text-xs text-muted-foreground">
              Items from <span className="font-semibold text-teal-700">{cart.storeName}</span> — one store per cart
            </p>
          ) : null}
        </SheetHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !cart || cart.items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={ShoppingCart}
              title="Your cart is empty"
              hint="Discover products across the marketplace and its stores."
              action={
                <Button
                  onClick={() => {
                    onOpenChange(false);
                    ctx.nav({ name: "market" });
                  }}
                  className="bg-teal-700 hover:bg-teal-800"
                >
                  Browse marketplace
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[calc(100vh-230px)]">
              <AnimatePresence initial={false}>
                {cart.items.map((it) => (
                  <motion.div
                    key={it.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 40 }}
                    transition={{ duration: 0.18 }}
                    className={cn("flex gap-3 rounded-xl border bg-card p-3", busyId === it.id && "opacity-60")}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        ctx.nav({ name: "pdp", slug: it.storeSlug, pSlug: it.productSlug });
                      }}
                      className="shrink-0"
                      aria-label={`View ${it.title}`}
                    >
                      <img src={it.imageUrl} alt={it.title} loading="lazy" className="h-20 w-20 rounded-lg border object-cover" />
                    </button>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            onOpenChange(false);
                            ctx.nav({ name: "pdp", slug: it.storeSlug, pSlug: it.productSlug });
                          }}
                          className="text-left text-sm font-semibold leading-tight line-clamp-2 hover:text-teal-700"
                        >
                          {it.title}
                        </button>
                        <button
                          type="button"
                          onClick={() => setQty(it.id, 0)}
                          className="text-muted-foreground hover:text-rose-600 transition-colors p-1"
                          aria-label={`Remove ${it.title}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      {it.variantLabel && it.variantLabel !== "Default" ? (
                        <p className="text-xs text-muted-foreground">{it.variantLabel}</p>
                      ) : null}
                      <div className="flex items-center justify-between gap-2 pt-0.5">
                        <QtyStepper
                          small
                          value={it.qty}
                          min={0}
                          max={Math.max(1, it.stock)}
                          onChange={(v) => setQty(it.id, v)}
                        />
                        <div className="text-right">
                          <p className="text-sm font-bold text-teal-700">{formatMinor(it.lineTotalMinor)}</p>
                          <p className="text-[11px] text-muted-foreground">{formatMinor(it.unitPriceMinor)} each</p>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            <div className="border-t bg-background p-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="text-lg font-extrabold text-teal-700">{formatMinor(subtotal)}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {subtotal >= 10000
                  ? "You've unlocked FREE standard shipping!"
                  : `Add ${formatMinor(10000 - subtotal)} more for FREE standard shipping.`}
              </p>
              <Button
                size="lg"
                onClick={() => {
                  onOpenChange(false);
                  ctx.nav({ name: "checkout" });
                }}
                className="w-full min-h-[48px] bg-teal-700 text-white hover:bg-teal-800"
              >
                Checkout <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

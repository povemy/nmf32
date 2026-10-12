"use client";
// ============================================================================
// ShopperShell — the SHOPPER surface root (Task 2-e).
// Internal view state machine (no URL routing), sticky market header, category
// menu, global cart drawer, footer, and mounting of every shopper view.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { io, type Socket } from "socket.io-client";
import {
  ShoppingBag,
  Search,
  ShoppingCart,
  ChevronDown,
  Menu,
  PackageSearch,
  Trash2,
  Store,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Package,
  MessagesSquare,
  LogIn,
  LogOut,
  Send,
  User,
} from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { setSessionToken } from "@/lib/session-client";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  fetchJson,
  patchJson,
  deleteJson,
  postJson,
  notifyCartUpdated,
  useCart,
  EmptyState,
  QtyStepper,
  fmtDateTime,
  type CategoryT,
  type ShopperCtx,
  type ShopperView,
} from "./ui-bits";
import MarketHome, { ResultsView, categoryIcon } from "./market";
import PdpView from "./pdp";
import StorefrontView, { StorePageView } from "./storefront";
import { CheckoutView, PayView, OrderStatusView, LookupView, OrdersView } from "./checkout";
import GenerateStoreView, { ClaimView } from "./generate";

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
  // Deep-link override for claim landing (?claim_job=…&claim_token=…):
  // intentionally NOT part of ShopperView — a synthetic render override.
  const [claimLink, setClaimLink] = useState<{ jobId: string; token: string } | null>(null);
  const restored = useRef(false);

  // ---- mount: activeStoreSlug override, else restore last view --------------
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    // claim deep-link wins over everything
    try {
      const params = new URLSearchParams(window.location.search);
      const cj = params.get("claim_job");
      const ct = params.get("claim_token");
      if (cj && ct) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deep-link reset
        setClaimLink({ jobId: cj, token: ct });
        setReady(true);
        return;
      }
      // SEO deep links (sitemap): /?sf={storeSlug} and /?sf={storeSlug}&sp={productSlug}
      const sf = params.get("sf");
      if (sf) {
        const sp = params.get("sp");
        setView(sp ? { name: "pdp", slug: sf, pSlug: sp } : { name: "storefront", slug: sf });
        setReady(true);
        return;
      }
    } catch {
      /* ignore */
    }
    if (activeStoreSlug) {
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
      <ShopperAuthDialog />

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
          key={`${view.name}:${"slug" in view ? view.slug : ""}:${"pSlug" in view ? view.pSlug : ""}:${"ref" in view ? view.ref : ""}:${view.name === "search" ? view.q : view.name === "category" ? view.categorySlug : view.name === "order-status" ? view.orderNumber : view.name === "store-page" ? view.pageSlug : view.name === "messages" ? view.threadId ?? "" : ""}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="flex-1 flex flex-col"
        >
          {claimLink ? null : (
            <>
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
              {view.name === "orders" ? <OrdersView ctx={ctx} /> : null}
              {view.name === "generate" ? <GenerateStoreView ctx={ctx} /> : null}
              {view.name === "lookup" ? <LookupView ctx={ctx} /> : null}
              {view.name === "messages" ? <MessagesView ctx={ctx} initialThreadId={view.threadId} /> : null}
            </>
          )}
          {claimLink ? <ClaimView jobId={claimLink.jobId} token={claimLink.token} onExit={() => setClaimLink(null)} /> : null}
        </motion.main>
      </AnimatePresence>

      {showChrome ? (
        <ShopperFooter
          onSeller={() => setSurface("seller")}
          onLookup={() => nav({ name: "lookup" })}
          onMarket={() => nav({ name: "market" })}
          onGenerate={() => nav({ name: "generate" })}
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
      {/* brand gradient strip */}
      <div className="h-1 w-full bg-brand-gradient" aria-hidden="true" />
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
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-sm">
            <ShoppingBag className="h-5 w-5" />
          </span>
          <span className="text-lg font-extrabold tracking-tight text-teal-900">
            SHOP<span className="text-brand-gradient">MESH</span>
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
          {/* sell / generate store (desktop + mobile) */}
          <button
            type="button"
            onClick={() => nav({ name: "generate" })}
            aria-label="Sell — generate your store from a marketplace link"
            className={cn(
              "inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold transition-colors sm:px-3",
              view.name === "generate" ? "bg-brand-gradient text-white shadow-sm" : "text-teal-800 hover:bg-teal-50"
            )}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Sell / Generate store</span>
            <span className="sm:hidden">Sell</span>
          </button>

          {/* messages (chat with sellers) */}
          <button
            type="button"
            onClick={() => nav({ name: "messages" })}
            aria-label="My messages"
            className={cn(
              "inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2.5 sm:px-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
              view.name === "messages" && "text-teal-800 bg-teal-50"
            )}
          >
            <MessagesSquare className="h-4 w-4" />
            <span className="hidden md:inline">Messages</span>
          </button>

          {/* orders */}
          <button
            type="button"
            onClick={() => nav({ name: "orders" })}
            aria-label="My orders"
            className={cn(
              "hidden sm:inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
              view.name === "orders" && "text-teal-800 bg-teal-50"
            )}
          >
            <Package className="h-4 w-4" /> Orders
          </button>

          {/* track order */}
          <button
            type="button"
            onClick={() => nav({ name: "lookup" })}
            className={cn(
              "hidden md:inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
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

          {/* account (shopper auth) */}
          <AccountButton nav={nav} />
        </div>
      </div>
    </header>
  );
}

// =============================================================================================
// Shopper account (sign-in chip / dropdown) + auth dialog + messages view
// =============================================================================================

function AccountButton({ nav }: { nav: (v: ShopperView) => void }) {
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const logout = useApp((s) => s.logout);
  const refreshMe = useApp((s) => s.refreshMe);
  const shopper = me.loaded ? me.shopper : null;

  if (!shopper) {
    return (
      <button
        type="button"
        onClick={() => openShopperAuth()}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-teal-800 hover:bg-teal-50 transition-colors"
        aria-label="Sign in to SHOPMESH"
      >
        <LogIn className="h-4 w-4" />
        <span className="hidden sm:inline">Sign in</span>
      </button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-teal-800 hover:bg-teal-50 transition-colors"
          aria-label={`Signed in as ${shopper.fullName}`}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-extrabold text-white">
            {shopper.fullName.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden sm:inline max-w-28 truncate">{shopper.fullName.split(" ")[0]}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-3 py-2">
          <p className="truncate text-sm font-semibold">{shopper.fullName}</p>
          <p className="truncate text-xs text-muted-foreground">{shopper.email}</p>
        </div>
        <Separator />
        <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "messages" })}>
          <MessagesSquare className="h-4 w-4 text-teal-700" /> My messages
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-[44px] text-rose-600"
          onClick={async () => {
            await logout();
            await refreshMe();
            toast.success("Signed out");
          }}
        >
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShopperAuthDialog() {
  const open = useApp((s) => s.shopperAuthOpen);
  const close = useApp((s) => s.closeShopperAuth);
  const after = useApp((s) => s.afterShopperAuth);
  const refreshMe = useApp((s) => s.refreshMe);
  const [tab, setTab] = useState("login");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setTab("login");
  }, [open]);

  const finish = async () => {
    await refreshMe();
    close();
    after?.();
  };

  const submitLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const res = await postJson<{ token?: string }>("/api/auth/shopper/login", { email: f.get("email"), password: f.get("password") });
      setSessionToken(res?.token); // localStorage bridge for cookie-less contexts
      toast.success("Welcome back!");
      await finish();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const submitRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const res = await postJson<{ token?: string }>("/api/auth/shopper/register", {
        fullName: f.get("fullName"),
        email: f.get("email"),
        password: f.get("password"),
      });
      setSessionToken(res?.token); // localStorage bridge for cookie-less contexts
      toast.success("Account created!", { description: "You can now chat with sellers and track orders." });
      await finish();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? close() : null)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5 text-teal-700" /> SHOPMESH shopper account
          </DialogTitle>
          <DialogDescription>Sign in to chat with sellers, or create a free account in seconds.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Sign in</TabsTrigger>
            <TabsTrigger value="register">Create account</TabsTrigger>
          </TabsList>
          <TabsContent value="login">
            <form onSubmit={submitLogin} className="space-y-3 pt-2">
              <Input name="email" type="email" required placeholder="you@example.com" autoComplete="email" className="min-h-[44px]" aria-label="Email" />
              <Input name="password" type="password" required placeholder="Password" autoComplete="current-password" className="min-h-[44px]" aria-label="Password" />
              <Button type="submit" disabled={busy} className="w-full min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110 gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Sign in
              </Button>
            </form>
          </TabsContent>
          <TabsContent value="register">
            <form onSubmit={submitRegister} className="space-y-3 pt-2">
              <Input name="fullName" required placeholder="Full name" autoComplete="name" className="min-h-[44px]" aria-label="Full name" />
              <Input name="email" type="email" required placeholder="you@example.com" autoComplete="email" className="min-h-[44px]" aria-label="Email" />
              <Input name="password" type="password" required minLength={8} placeholder="Password (min 8 characters)" autoComplete="new-password" className="min-h-[44px]" aria-label="Password" />
              <Button type="submit" disabled={busy} className="w-full min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110 gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <User className="h-4 w-4" />} Create free account
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- messages (chat)

type ThreadRow = {
  id: string;
  storeId: string;
  storeName: string;
  storeSlug: string;
  orderNumber: string | null;
  subject: string | null;
  lastMessageAt: string;
  lastMessage: { body: string; senderType: string; createdAt: string } | null;
};

type ChatMsg = { id: string; senderType: "shopper" | "seller"; senderName: string; body: string; createdAt: string };

function MessagesView({ ctx, initialThreadId }: { ctx: ShopperCtx; initialThreadId?: string }) {
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const shopper = me.loaded ? me.shopper : null;

  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(initialThreadId ?? null);
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  const [activeThread, setActiveThread] = useState<{ storeName: string; orderNumber: string | null; subject: string | null } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try {
      const rows = await fetchJson<ThreadRow[]>("/api/chat/threads");
      setThreads(rows);
      return rows;
    } catch {
      setThreads([]);
      return [];
    }
  }, []);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const d = await fetchJson<{ thread: { storeName: string; orderNumber: string | null; subject: string | null }; messages: ChatMsg[] }>(
        `/api/chat/threads/${threadId}`
      );
      setMessages(d.messages);
      setActiveThread(d.thread);
    } catch {
      setMessages([]);
    }
  }, []);

  // initial load
  useEffect(() => {
    if (!shopper) return;
    let alive = true;
    loadThreads().then((rows) => {
      if (!alive) return;
      if (initialThreadId) {
        setActiveId(initialThreadId);
      } else if (rows.length > 0) {
        setActiveId((cur) => cur ?? rows[0].id);
      }
    });
    return () => {
      alive = false;
    };
  }, [shopper, initialThreadId, loadThreads]);

  // load conversation when thread changes
  useEffect(() => {
    if (!activeId) return;
    setMessages(null);
    loadMessages(activeId);
  }, [activeId, loadMessages]);

  // live updates via the socket.io chat hub
  useEffect(() => {
    if (!shopper) return;
    const socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: 10000,
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      // join all thread rooms so the sidebar stays fresh too
      const rooms = (threads ?? []).map((t) => `thread:${t.id}`);
      socket.emit("join", { rooms });
    });
    socket.on("chat:message", (msg: ChatMsg & { threadId?: string }) => {
      if (msg.threadId && msg.threadId === activeId) {
        setMessages((prev) => (prev && !prev.some((m) => m.id === msg.id) ? [...prev, msg] : prev));
      }
      loadThreads();
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [shopper, threads, activeId, loadThreads]);

  // auto-scroll to latest
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const msg = await postJson<ChatMsg>(`/api/chat/threads/${activeId}/messages`, { body: text });
      setMessages((prev) => (prev ? [...prev, msg] : [msg]));
      setDraft("");
      loadThreads();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the message");
    } finally {
      setSending(false);
    }
  };

  if (!shopper) {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <EmptyState
          icon={MessagesSquare}
          title="Sign in to see your messages"
          hint="Create a free SHOPMESH account to chat with sellers about orders, deliveries and returns."
          action={
            <Button onClick={() => openShopperAuth(() => ctx.nav({ name: "messages" }))} className="min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110 gap-2">
              <LogIn className="h-4 w-4" /> Sign in or create account
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8">
      <div className="pb-4">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
          <MessagesSquare className="h-6 w-6 text-teal-700" /> Messages
        </h1>
        <p className="text-sm text-muted-foreground">Chat with sellers about your orders — replies arrive in real time.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-[300px_1fr]">
        {/* thread list */}
        <aside className={cn("rounded-2xl border bg-card p-2 shadow-soft", activeId && "hidden md:block")}>
          {threads === null ? (
            <div className="flex justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : threads.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No conversations yet — use “Contact seller” on any order to start one.
            </p>
          ) : (
            <ul className="space-y-1 max-h-96 md:max-h-[520px] overflow-y-auto">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(t.id);
                      setActiveThread({ storeName: t.storeName, orderNumber: t.orderNumber, subject: t.subject });
                    }}
                    className={cn(
                      "w-full rounded-xl p-3 text-left transition-colors min-h-[60px]",
                      activeId === t.id ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-muted"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-[11px] font-extrabold text-white">
                        {t.storeName.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.storeName}</span>
                    </div>
                    <p className="truncate pt-1 pl-10 text-xs text-muted-foreground">
                      {t.lastMessage?.body ?? "Say hello…"}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* conversation */}
        <section className={cn("flex flex-col rounded-2xl border bg-card shadow-soft", !activeId && "hidden md:flex", "min-h-[420px] md:min-h-[520px]")}>
          {activeId && activeThread ? (
            <>
              <header className="flex items-center gap-2 border-b p-3">
                <button
                  type="button"
                  className="md:hidden flex h-9 w-9 items-center justify-center rounded-lg hover:bg-muted"
                  onClick={() => setActiveId(null)}
                  aria-label="Back to conversations"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{activeThread.storeName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {activeThread.orderNumber ? `Order ${activeThread.orderNumber}` : activeThread.subject ?? "Direct message"}
                  </p>
                </div>
              </header>

              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 max-h-80 md:max-h-[380px]">
                {messages === null ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="pt-10 text-center text-sm text-muted-foreground">No messages yet — say hello!</p>
                ) : (
                  messages.map((m) => (
                    <div key={m.id} className={cn("flex", m.senderType === "shopper" ? "justify-end" : "justify-start")}>
                      <div
                        className={cn(
                          "max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm",
                          m.senderType === "shopper" ? "bg-brand-gradient text-white rounded-br-md" : "bg-muted rounded-bl-md"
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.body}</p>
                        <p className={cn("pt-1 text-[10px]", m.senderType === "shopper" ? "text-white/70" : "text-muted-foreground")}>
                          {m.senderType === "seller" ? `${m.senderName} · ` : ""}
                          {fmtDateTime(m.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <footer className="border-t p-3">
                <div className="flex items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    rows={1}
                    placeholder="Type a message… (Enter to send)"
                    aria-label="Message"
                    className="min-h-[44px] resize-none"
                  />
                  <Button onClick={send} disabled={sending || !draft.trim()} className="min-h-[44px] gap-2 bg-brand-gradient-deep text-white hover:brightness-110" aria-label="Send message">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span className="hidden sm:inline">Send</span>
                  </Button>
                </div>
              </footer>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              Pick a conversation to start chatting.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// =============================================================================================
// Footer (global chrome)
// =============================================================================================

function ShopperFooter({
  onSeller,
  onLookup,
  onMarket,
  onGenerate,
}: {
  onSeller: () => void;
  onLookup: () => void;
  onMarket: () => void;
  onGenerate: () => void;
}) {
  return (
    <footer className="mt-auto border-t bg-gradient-to-br from-teal-950 via-teal-900 to-teal-700 text-teal-50">
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50/10">
                <ShoppingBag className="h-5 w-5 text-amber-300" />
              </span>
              SHOP<span className="text-teal-200">MESH</span>
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
              onClick={onGenerate}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-teal-50/20 px-4 text-xs font-semibold text-teal-100 hover:bg-teal-50/10 transition-colors"
            >
              <Sparkles className="h-3.5 w-3.5" /> Generate your store from a marketplace link
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
              className="min-h-[44px] shrink whitespace-normal rounded-full bg-amber-400 px-4 text-left text-teal-950 hover:bg-amber-300 font-bold"
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
      notifyCartUpdated(); // keep badge + every useCart() instance in sync
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

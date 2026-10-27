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
  ShieldCheck,
  Settings,
  LockKeyhole,
  Headphones,
  Truck,
  Banknote,
  BadgeCheck,
  Timer,
  Eye,
  Flame,
  Plus,
  Gift,
} from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  mutateCartItems,
  applyServerCart,
  cartSnapshot,
  useCart,
  EmptyState,
  QtyStepper,
  fmtDateTime,
  fetchEnvelope,
  type CartItemT,
  type CartT,
  type CategoryT,
  type ProductCardT,
  type ShopperCtx,
  type ShopperView,
} from "./ui-bits";
import MarketHome, { ResultsView, categoryIcon } from "./market";
import PdpView from "./pdp";
import StorefrontView, { StorePageView } from "./storefront";
import { CheckoutView, PayView, OrderStatusView, LookupView, OrdersView } from "./checkout";
import GenerateStoreView, { ClaimView } from "./generate";
import MeHubView from "./me-hub";
import {
  ChatHeader,
  ChatListItem,
  ChatListSkeleton,
  ChatMessagesSkeleton,
  ChatEmptyDetail,
  ContextClearButton,
  MessageTicks,
  filterChatThreads,
  useChatHub,
  type ChatThreadRow,
  type ChatMsg,
  type ChatFilter,
} from "@/components/chat/chat-ui";
import { useChatUserRoom } from "@/lib/chat-presence";
import NotificationBell from "./notification-bell";

const VIEW_KEY = "sm_shopper_view";

function isStoreChrome(view: ShopperView): boolean {
  return view.name === "storefront" || view.name === "store-page";
}

/** Total unread seller messages — powers the "My messages" header badge.
 *  Polls lightly + refreshes when the messages view is opened/left. */
function useChatUnread(shopperSignedIn: boolean, viewName: ShopperView["name"]) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!shopperSignedIn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the badge on sign-out (no fetch involved)
      setUnread(0);
      return;
    }
    let alive = true;
    const load = () =>
      fetchJson<{ total: number }>("/api/chat/unread")
        .then((d) => alive && setUnread(d.total ?? 0))
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [shopperSignedIn]);
  // instant re-sync when a thread is read inside the messages view (the view
  // dispatches "nomofee:chat-sync" instead of prop-drilling a callback)
  useEffect(() => {
    if (!shopperSignedIn) return;
    const sync = () =>
      fetchJson<{ total: number }>("/api/chat/unread")
        .then((d) => setUnread(d.total ?? 0))
        .catch(() => {});
    window.addEventListener("nomofee:chat-sync", sync);
    return () => window.removeEventListener("nomofee:chat-sync", sync);
  }, [shopperSignedIn]);
  // opening (or leaving) the messages view should immediately re-sync the badge
  useEffect(() => {
    if (!shopperSignedIn) return;
    const t = setTimeout(
      () =>
        fetchJson<{ total: number }>("/api/chat/unread")
          .then((d) => setUnread(d.total ?? 0))
          .catch(() => {}),
      viewName === "messages" ? 600 : 0
    );
    return () => clearTimeout(t);
  }, [shopperSignedIn, viewName]);
  return unread;
}

// ---- platform chrome config (global footer visibility) ---------------------
// Admin → Settings → "Show global footer" (Setting ui.footer_visible) governs
// the shopper footer. Public endpoint + 60 s module cache: toggling takes
// effect on the next app load without per-navigation refetch chatter.
let appConfigCache: { at: number; footerVisible: boolean } | null = null;

function useFooterVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (appConfigCache && Date.now() - appConfigCache.at < 60_000) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- cache hit syncs an external module cache; the fresh-fetch path below sets state in a callback
      setVisible(appConfigCache.footerVisible);
      return;
    }
    let cancelled = false;
    fetch("/api/sf/app-config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const v = (b as { data?: { footerVisible?: boolean } } | null)?.data?.footerVisible;
        if (typeof v === "boolean" && !cancelled) {
          appConfigCache = { at: Date.now(), footerVisible: v };
          setVisible(v);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return visible;
}

export default function ShopperShell() {
  const setSurface = useApp((s) => s.setSurface);
  const activeStoreSlug = useApp((s) => s.activeStoreSlug);
  const setActiveStoreSlug = useApp((s) => s.setActiveStoreSlug);

  const [view, setView] = useState<ShopperView>({ name: "market" });
  const [ready, setReady] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  // Which store's customized cart experience to render in the drawer — set by
  // PDP add-to-cart / storefront header; null = platform defaults.
  const [cartStoreSlug, setCartStoreSlug] = useState<string | null>(null);
  const [headerSearch, setHeaderSearch] = useState("");
  // Back-navigation history stack (user request: back button on every page).
  // viewRef mirrors `view` so nav() can push the PREVIOUS view without reading
  // state inside the setState updater (StrictMode-safe).
  const viewStack = useRef<ShopperView[]>([]);
  const viewRef = useRef<ShopperView>({ name: "market" });
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
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const nav = useCallback((v: ShopperView) => {
    if (viewRef.current.name !== v.name || JSON.stringify(viewRef.current) !== JSON.stringify(v)) {
      viewStack.current.push(viewRef.current);
      if (viewStack.current.length > 25) viewStack.current.shift();
    }
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, JSON.stringify(v));
    } catch {
      /* ignore */
    }
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const back = useCallback(() => {
    const prev = viewStack.current.pop() ?? { name: "market" as const };
    setView(prev);
    try {
      window.localStorage.setItem(VIEW_KEY, JSON.stringify(prev));
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

  const ctx = useMemo<ShopperCtx>(
    () => ({
      nav,
      back,
      openCart: (storeSlug?: string) => {
        setCartStoreSlug(storeSlug ?? null);
        setCartOpen(true);
      },
    }),
    [nav, back]
  );

  // ---- global inbox presence (ONE socket on every view) ---------------------
  // Away from the messages page nothing used to listen for pushes, so the
  // Message/Chat tab badges only moved on a 15s poll — incoming messages felt
  // silent. This keeps the user's inbox room joined on every view: a push
  // fires "nomofee:chat-sync" (all badge hooks re-sync instantly) and, when
  // the user is NOT on the messages page, raises a toast with a jump-in link.
  const meForPresence = useApp((s) => s.me);
  const shopperForPresence = meForPresence.loaded ? meForPresence.shopper : null;
  useChatUserRoom(shopperForPresence?.id ?? null, {
    onMessage: (msg) => {
      if (msg.senderType === "shopper") return; // own echo / auto-ack paths
      window.dispatchEvent(new Event("nomofee:chat-sync"));
      if (viewRef.current.name !== "messages") {
        const preview = msg.body.length > 90 ? `${msg.body.slice(0, 90)}…` : msg.body;
        toast(`${msg.senderName} · New message`, {
          description: preview,
          action: msg.threadId
            ? { label: "Open chat", onClick: () => nav({ name: "messages", threadId: msg.threadId }) }
            : undefined,
        });
      }
    },
    onActivity: () => window.dispatchEvent(new Event("nomofee:chat-sync")),
  });

  const showChrome = !isStoreChrome(view);
  // App-like bottom navigation — mobile only, hidden during checkout focus mode.
  const showBottomNav = showChrome && view.name !== "checkout" && view.name !== "pay";
  // Admin-controlled global footer switch (default ON; checkout never shows it).
  const footerVisible = useFooterVisible();

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
          key={`${view.name}:${"slug" in view ? view.slug : ""}:${"pSlug" in view ? view.pSlug : ""}:${"ref" in view ? view.ref : ""}:${view.name === "search" ? view.q : view.name === "category" ? view.categorySlug : view.name === "order-status" ? view.orderNumber : view.name === "store-page" ? view.pageSlug : view.name === "messages" ? view.threadId ?? "" : view.name === "me" ? view.tab ?? "" : ""}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className={cn("flex-1 flex flex-col", showBottomNav && "pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:pb-0")}
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
              {view.name === "me" ? <MeHubView ctx={ctx} initialTab={view.tab} /> : null}
            </>
          )}
          {claimLink ? <ClaimView jobId={claimLink.jobId} token={claimLink.token} onExit={() => setClaimLink(null)} /> : null}
        </motion.main>
      </AnimatePresence>

      {showBottomNav ? (
        <BottomNav
          view={view}
          nav={nav}
          openCart={() => setCartOpen(true)}
        />
      ) : null}

      {showChrome && footerVisible ? (
        <ShopperFooter
          onSeller={() => setSurface("seller")}
          onLookup={() => nav({ name: "lookup" })}
          onMarket={() => nav({ name: "market" })}
          onGenerate={() => nav({ name: "generate" })}
        />
      ) : null}

      <CartDrawer open={cartOpen} onOpenChange={setCartOpen} ctx={ctx} storeSlug={cartStoreSlug} />
    </div>
  );
}

// =============================================================================================
// Mobile bottom navigation (app-like) — Home / Orders / Cart / Chat / Me
// =============================================================================================

function BottomNav({ view, nav, openCart }: { view: ShopperView; nav: (v: ShopperView) => void; openCart: () => void }) {
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const signedIn = Boolean(me.loaded && me.shopper);
  const { count } = useCart();
  const unreadChats = useChatUnread(signedIn, view.name);

  const items = [
    { key: "home", label: "Home", icon: ShoppingBag, active: view.name === "market", badge: 0, onClick: () => nav({ name: "market" }) },
    {
      key: "orders",
      label: "Orders",
      icon: Package,
      active: view.name === "orders" || (view.name === "me" && view.tab === "purchases"),
      badge: 0,
      onClick: () => (signedIn ? nav({ name: "me", tab: "purchases" }) : openShopperAuth()),
    },
    { key: "cart", label: "Cart", icon: ShoppingCart, active: false, badge: count, onClick: openCart },
    { key: "chat", label: "Chat", icon: MessagesSquare, active: view.name === "messages", badge: unreadChats, onClick: () => (signedIn ? nav({ name: "messages" }) : openShopperAuth()) },
    { key: "me", label: "Me", icon: User, active: view.name === "me", badge: 0, onClick: () => nav({ name: "me" }) },
  ];

  return (
    <nav
      aria-label="Bottom navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto grid max-w-lg grid-cols-5">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <button
              key={it.key}
              type="button"
              onClick={it.onClick}
              aria-label={it.label}
              aria-current={it.active ? "page" : undefined}
              className={cn(
                "relative flex h-16 min-h-[56px] flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition-colors",
                it.active ? "text-teal-800" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="relative">
                <Icon className="h-5 w-5" aria-hidden="true" />
                {it.badge > 0 ? (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-extrabold text-white shadow" aria-hidden>
                    {it.badge > 9 ? "9+" : it.badge}
                  </span>
                ) : null}
              </span>
              {it.label}
              {it.active ? <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-brand-gradient" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </nav>
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
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const logout = useApp((s) => s.logout);
  const refreshMe = useApp((s) => s.refreshMe);
  const shopperSignedIn = Boolean(me.loaded && me.shopper);
  const unreadChats = useChatUnread(shopperSignedIn, view.name);
  // Task 30 — the Me page (MOBILE ONLY) swaps the header to an account bar:
  // no logo, no search — just quick actions (right→left: Me, Chat, Cart, Bell).
  // Desktop keeps the full header everywhere.
  const isMe = view.name === "me";

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
                <ShoppingBag className="h-5 w-5 text-teal-700" /> NOMOFEE
              </SheetTitle>
            </SheetHeader>
            <div className="p-4 space-y-4 overflow-y-auto max-h-[calc(100vh-80px)]">
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

        {/* logo — hidden on the Me page (mobile) which becomes an account bar */}
        <button
          type="button"
          onClick={() => nav({ name: "market" })}
          className={cn("flex min-h-[44px] shrink-0 items-center gap-2", isMe && "max-md:hidden")}
          aria-label="NOMOFEE home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-sm">
            <ShoppingBag className="h-5 w-5" />
          </span>
          <span className="hidden text-lg font-extrabold tracking-tight text-teal-900 sm:inline">
            NOMO<span className="text-brand-gradient">FEE</span>
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

        {/* search — always visible (desktop + mobile), stretches into the space freed by hiding guest-only icons;
            hidden on the Me page (mobile) which swaps to an account bar */}
        <div className={cn("relative ml-auto min-w-0 flex-1 md:ml-0 md:max-w-md", isMe && "max-md:hidden")}>
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

        <div className={cn("ml-0 flex shrink-0 items-center gap-1.5", isMe && "max-md:hidden")}>
          {/* buyer notification bell (Task 10-d) — self-gates for guests */}
          <NotificationBell onOpenOrder={(orderNumber) => nav({ name: "order-status", orderNumber })} className="hidden sm:inline-flex" />

          {/* messages — account feature, hidden for guests */}
          {shopperSignedIn ? (
            <button
              type="button"
              onClick={() => nav({ name: "messages" })}
              aria-label={`My messages${unreadChats > 0 ? `, ${unreadChats} unread` : ""}`}
              className={cn(
                "relative inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 sm:px-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                view.name === "messages" && "text-teal-800 bg-teal-50"
              )}
            >
              <MessagesSquare className="h-4 w-4" />
              <span className="hidden md:inline">Messages</span>
              {unreadChats > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-extrabold text-white shadow" aria-hidden>
                  {unreadChats > 9 ? "9+" : unreadChats}
                </span>
              ) : null}
            </button>
          ) : null}

          {/* orders — account feature, hidden for guests (guests keep “Track order” via the footer/menu) */}
          {shopperSignedIn ? (
            <button
              type="button"
              onClick={() => nav({ name: "me", tab: "purchases" })}
              aria-label="My orders"
              className={cn(
                "hidden sm:inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                (view.name === "orders" || (view.name === "me" && view.tab === "purchases")) && "text-teal-800 bg-teal-50"
              )}
            >
              <Package className="h-4 w-4" /> Orders
            </button>
          ) : null}

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

        {/* Task 30 — Me page account bar (MOBILE ONLY). Order right→left as
            specified: Me menu (Dashboard / Purchases / Settings / Sign out —
            deliberately NO “Messages”), then Chat, then Cart, then Bell. */}
        {isMe ? (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 md:hidden" aria-label="Account quick actions">
            <NotificationBell onOpenOrder={(orderNumber) => nav({ name: "order-status", orderNumber })} />
            <button
              type="button"
              onClick={openCart}
              aria-label={`Open cart, ${count} item${count === 1 ? "" : "s"}`}
              className="relative flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-muted"
            >
              <ShoppingCart className="h-4.5 w-4.5" />
              {count > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-extrabold text-white shadow" aria-hidden>
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => (shopperSignedIn ? nav({ name: "messages" }) : openShopperAuth())}
              aria-label={`My messages${unreadChats > 0 ? `, ${unreadChats} unread` : ""}`}
              className="relative flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-muted"
            >
              <MessagesSquare className="h-4.5 w-4.5" />
              {unreadChats > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-extrabold text-white shadow" aria-hidden>
                  {unreadChats > 9 ? "9+" : unreadChats}
                </span>
              ) : null}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-muted"
                  aria-label="Account menu"
                  aria-haspopup="menu"
                >
                  <User className="h-4.5 w-4.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "me" })}>
                  <User className="h-4 w-4 text-teal-700" /> Dashboard
                </DropdownMenuItem>
                <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "me", tab: "purchases" })}>
                  <Package className="h-4 w-4 text-teal-700" /> Purchases
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-[44px]"
                  onClick={() => window.dispatchEvent(new CustomEvent("nomofee:open-settings"))}
                >
                  <Settings className="h-4 w-4 text-teal-700" /> Settings
                </DropdownMenuItem>
                <Separator />
                <DropdownMenuItem
                  className="min-h-[44px] text-rose-600"
                  onClick={async () => {
                    if (!shopperSignedIn) {
                      openShopperAuth();
                      return;
                    }
                    await logout();
                    await refreshMe();
                    toast.success("Signed out");
                  }}
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
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
        aria-label="Sign in to NOMOFEE"
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
        <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "me" })}>
          <User className="h-4 w-4 text-teal-700" /> My dashboard
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-[44px]" onClick={() => nav({ name: "me", tab: "purchases" })}>
          <Package className="h-4 w-4 text-teal-700" /> My purchases
        </DropdownMenuItem>
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
            <User className="h-5 w-5 text-teal-700" /> NOMOFEE shopper account
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

/** The "what is this chat about" bubble — product or order. */
type ThreadContextCard =
  | { kind: "product"; productId: string; title: string; slug: string; storeSlug: string; image: string | null; priceMinor: number; compareAtPriceMinor: number | null }
  | { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; itemCount: number; firstItemTitle: string | null; firstItemImage: string | null };

/** The shopper messages hub — master-detail chat per the messaging redesign:
 *  ChatHeader (back button + "Chats" + live search + All/Active pills), rich
 *  thread list (previews, ✓/✓✓ ticks, unread badges, smart timestamps),
 *  slide-in conversation on mobile, split pane on desktop, and instant
 *  two-way sync through the socket.io chat hub (thread + user rooms). */
function MessagesView({ ctx, initialThreadId }: { ctx: ShopperCtx; initialThreadId?: string }) {
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const shopper = me.loaded ? me.shopper : null;

  const [threads, setThreads] = useState<ChatThreadRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [activeId, setActiveId] = useState<string | null>(initialThreadId ?? null);
  const [activeThread, setActiveThread] = useState<{ storeName: string; storeSlug: string | null; orderNumber: string | null; contextType: string | null; subject: string | null } | null>(null);
  const [context, setContext] = useState<ThreadContextCard | null>(null);
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      // Fetch the FULL list once. The All/Active pills and the search box
      // filter this local snapshot instantly (filterChatThreads) — switching
      // pills no longer round-trips to the server, which is what read as a
      // blink ("it validates before it shows"). Socket pushes + read
      // receipts keep the same snapshot live and authoritative.
      const { data } = await fetchEnvelope<ChatThreadRow[]>("/api/chat/threads?size=100");
      setThreads(data);
      return data;
    } catch {
      setThreads([]);
      return [];
    }
  }, []);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const d = await fetchJson<{
        thread: { storeName: string; storeSlug: string | null; orderNumber: string | null; contextType: string | null; subject: string | null };
        context: ThreadContextCard | null;
        messages: ChatMsg[];
      }>(`/api/chat/threads/${threadId}`);
      setMessages(d.messages);
      setActiveThread({ storeName: d.thread.storeName, storeSlug: d.thread.storeSlug ?? null, orderNumber: d.thread.orderNumber, contextType: d.thread.contextType, subject: d.thread.subject });
      setContext(d.context ?? null);
    } catch {
      setMessages([]);
      setContext(null);
    }
  }, []);

  /** Debounced background list refresh — new threads + authoritative state. */
  const reloadThreadsSoon = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      void loadThreads();
      window.dispatchEvent(new Event("nomofee:chat-sync"));
    }, 250);
  }, [loadThreads]);

  /** Optimistic list patch: fresh preview, unread bump, moved to the top. */
  const patchRow = useCallback((threadId: string, body: string, senderType: string, at: string, isOpen: boolean) => {
    setThreads((prev) => {
      if (!prev) return prev;
      const idx = prev.findIndex((t) => t.id === threadId);
      if (idx === -1) return prev; // unknown (brand-new) thread → reload covers it
      const row = prev[idx];
      const patched: ChatThreadRow = {
        ...row,
        lastMessageAt: at,
        unreadCount: senderType === "seller" && !isOpen ? row.unreadCount + 1 : row.unreadCount,
        lastMessage: { body, senderType, createdAt: at, readAt: null },
      };
      return [patched, ...prev.filter((t) => t.id !== threadId)];
    });
  }, []);

  // initial load — runs ONCE (list fetch no longer depends on filter/search;
  // pill switches are pure client-side filtering, so no refetch and no blink)
  useEffect(() => {
    if (!shopper) return;
    let alive = true;
    loadThreads().then(() => {
      if (!alive) return;
      // Only auto-open when resuming an intent (contact-seller deep link).
      // Plain entry shows the list first so unread badges stay visible —
      // auto-reading the newest thread would instantly consume the badge.
      if (initialThreadId) setActiveId(initialThreadId);
    });
    return () => {
      alive = false;
    };
  }, [shopper, initialThreadId, loadThreads]);

  // load conversation when thread changes
  useEffect(() => {
    if (!activeId) return;
    setMessages(null);
    // the detail GET marks the thread read server-side — refresh the list so
    // the unread pill on the row (and the header badge) drops immediately
    loadMessages(activeId).then(() => {
      void loadThreads();
      window.dispatchEvent(new Event("nomofee:chat-sync"));
    });
  }, [activeId, loadMessages, loadThreads]);

  /** Either party closed the quoted product/order → plain direct message.
   *  Optimistic locally, authoritative via the PATCH, and mirrored live to
   *  the other party through the `chat:context` hub event. */
  const clearContext = useCallback(
    async (threadId: string) => {
      setContext(null);
      // the "x" only exists on the open conversation, so clearing the header
      // subtitle unconditionally is safe here
      setActiveThread((prev) => (prev ? { ...prev, orderNumber: null, contextType: null, subject: null } : prev));
      setThreads((prev) => (prev ? prev.map((t) => (t.id === threadId ? { ...t, orderNumber: null, contextType: null, subject: null } : t)) : prev));
      try {
        await patchJson(`/api/chat/threads/${threadId}`, { action: "clearContext" });
      } catch {
        toast.error("Could not remove the quote — try again");
      }
    },
    [],
  );

  // live updates via the socket.io chat hub (thread rooms + user inbox room)
  useChatHub({
    threadRooms: useMemo(() => (threads ?? []).map((t) => `thread:${t.id}`), [threads]),
    userRoom: shopper ? `user:${shopper.id}` : null,
    handlers: {
      onMessage: (msg) => {
        if (msg.threadId && msg.threadId === activeId) {
          setMessages((prev) => (prev && !prev.some((m) => m.id === msg.id) ? [...prev, msg] : prev));
          if (msg.senderType === "seller") {
            // arrived while the shopper is looking at this conversation —
            // clear the badge + stamp ✓✓ for the seller straight away
            void postJson(`/api/chat/threads/${msg.threadId}/read`, {}).catch(() => {});
          }
          patchRow(msg.threadId, msg.body, msg.senderType, msg.createdAt, true);
        } else if (msg.threadId) {
          patchRow(msg.threadId, msg.body, msg.senderType, msg.createdAt, false);
        }
        reloadThreadsSoon();
      },
      onActivity: () => reloadThreadsSoon(), // brand-new thread or inbox refresh
      onContext: (c) => {
        if (c.threadId === activeId) {
          setContext(null);
          setActiveThread((prev) => (prev ? { ...prev, orderNumber: null, contextType: null, subject: null } : prev));
        }
        setThreads((prev) => (prev ? prev.map((t) => (t.id === c.threadId ? { ...t, orderNumber: null, contextType: null, subject: null } : t)) : prev));
      },
      onRead: (r) => {
        if (r.readerType !== "seller") return; // seller read → my ticks flip ✓✓
        if (r.threadId === activeId) {
          setMessages((prev) => (prev ? prev.map((m) => (m.senderType === "shopper" && !m.readAt ? { ...m, readAt: r.at } : m)) : prev));
        }
        setThreads((prev) =>
          prev
            ? prev.map((t) =>
                t.id === r.threadId && t.lastMessage && t.lastMessage.senderType === "shopper" ? { ...t, lastMessage: { ...t.lastMessage, readAt: r.at } } : t
              )
            : prev
        );
      },
    },
  });

  // auto-scroll to latest
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Instant client-side filtering of the live snapshot — pills + search are
  // pure local compute (zero network), so switching feels immediate.
  const visibleThreads = useMemo(() => (threads ? filterChatThreads(threads, filter, query) : null), [threads, filter, query]);
  const activeTotal = useMemo(() => (threads ?? []).reduce((n, t) => n + (t.unreadCount > 0 ? 1 : 0), 0), [threads]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const msg = await postJson<ChatMsg>(`/api/chat/threads/${activeId}/messages`, { body: text });
      setMessages((prev) => (prev?.some((m) => m.id === msg.id) ? prev : prev ? [...prev, msg] : [msg]));
      setDraft("");
      patchRow(activeId, msg.body, msg.senderType, msg.createdAt, true);
      reloadThreadsSoon();
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
          hint="Create a free NOMOFEE account to chat with sellers about products, orders, deliveries and returns."
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
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:py-6">
      {/* Task 34: min-w-0 on the grid items — a grid/flex item defaults to
          min-width:auto, so the thread rows' unbreakable min-content (nowrap
          preview line, ~267px) used to force the whole master column wider
          than narrow viewports (≤300px: Fold cover screens, split view),
          overflowing the page horizontally. With min-w-0 the column can
          shrink to any width and the truncate chain does its job. */}
      <div className="grid min-w-0 gap-4 md:grid-cols-[360px_1fr]">
        {/* master — header + search + filter pills + thread list (hidden on
            mobile while a conversation is open: the panel replaces the list) */}
        {/* Task 33: the list auto-fits the mobile viewport — its height is
            capped to exactly the space under the app chrome (header 4.25rem +
            page padding 2rem + bottom-nav reserve 4.25rem + ChatHeader ~9.25rem
            + slack), never pushing the page into scroll on short phones. */}
        <aside className={cn("min-w-0 space-y-3", activeId && "hidden md:block")}>
          <ChatHeader
            onBack={() => ctx.nav({ name: "me" })}
            backLabel="Back to my account"
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            searchPlaceholder="Search chats"
            activeCount={activeTotal}
          />
          <div className="rounded-2xl border bg-card shadow-soft">
            {visibleThreads === null ? (
              <ChatListSkeleton />
            ) : visibleThreads.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {query.trim() || filter === "active"
                  ? "No conversations match — try a different search or filter."
                  : "No conversations yet — use “Message seller” on any product or “Contact seller” on an order to start one."}
              </p>
            ) : (
              <ul
                className="space-y-1 overflow-y-auto p-2 max-h-[min(24rem,calc(100dvh-20.5rem-env(safe-area-inset-bottom)))] md:max-h-[540px] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/25"
                aria-label="Chat threads"
              >
                {visibleThreads.map((t) => (
                  <ChatListItem
                    key={t.id}
                    row={t}
                    active={activeId === t.id}
                    mySide="shopper"
                    onSelect={() => {
                      setActiveId(t.id);
                      setActiveThread({ storeName: t.displayName, storeSlug: t.storeSlug ?? null, orderNumber: t.orderNumber, contextType: t.contextType, subject: t.subject });
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* detail — conversation panel. Task 33 mobile auto-fit: instead of a
            blanket 72dvh (dead space below on tall phones, page scroll on
            short ones), the panel is sized to EXACTLY the viewport minus the
            app chrome — header 4.25rem + page padding 2rem + bottom-nav
            reserve 4.25rem (+ safe-area) — so the composer always sits just
            above the bottom nav with zero page scroll. Desktop keeps 600px. */}
        <section
          className={cn(
            "flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-soft md:flex",
            activeId
              ? "flex h-[calc(100dvh-10.625rem-env(safe-area-inset-bottom))] min-h-[320px] md:h-[600px] md:min-h-[440px]"
              : "hidden md:flex md:h-[600px]",
          )}
        >
          {activeId && activeThread ? (
            <motion.div
              key={activeId}
              initial={{ opacity: 0, x: 56 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 36 }}
              className="flex h-full min-h-0 flex-col"
            >
              <header className="flex items-center gap-2 border-b p-3">
                <button
                  type="button"
                  className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-muted md:hidden"
                  onClick={() => setActiveId(null)}
                  aria-label="Back to chats"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                {/* vendor logo/name → their store, one tap away from the chat */}
                <button
                  type="button"
                  onClick={() => activeThread.storeSlug && ctx.nav({ name: "storefront", slug: activeThread.storeSlug })}
                  disabled={!activeThread.storeSlug}
                  title={activeThread.storeSlug ? `Visit ${activeThread.storeName}'s store` : undefined}
                  aria-label={activeThread.storeSlug ? `View ${activeThread.storeName}'s store` : activeThread.storeName}
                  className="group flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-gradient text-xs font-extrabold text-white">
                    {activeThread.storeName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold group-hover:underline group-hover:underline-offset-2">{activeThread.storeName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {activeThread.contextType === "order" && activeThread.orderNumber
                        ? `Order ${activeThread.orderNumber}`
                        : activeThread.contextType === "product"
                          ? "Product enquiry"
                          : activeThread.subject ?? "Direct message"}
                    </span>
                  </span>
                  {activeThread.storeSlug ? <Store className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-teal-700" aria-hidden="true" /> : null}
                </button>
              </header>

              {/* quoted product / order — pinned directly under the vendor name
                  bar so both parties always see what this conversation is about
                  while the messages scroll underneath; "x" drops the quote so
                  the chat can continue casually */}
              {context ? (
                <div className="relative shrink-0 border-b bg-muted/30 px-3 py-2.5">
                  <ShopperContextBubble ctx={ctx} context={context} />
                  <ContextClearButton onClear={() => activeId && void clearContext(activeId)} />
                </div>
              ) : null}

              <div
                ref={scrollRef}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/25"
              >
                {messages === null ? (
                  <ChatMessagesSkeleton />
                ) : (
                  <>
                    {!context ? (
                      <p className="mx-auto w-fit rounded-full bg-muted/70 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                        💬 Direct message with this store
                      </p>
                    ) : null}
                    {messages.length === 0 ? (
                      <p className="pt-6 text-center text-sm text-muted-foreground">No messages yet — say hello!</p>
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
                            <p className={cn("flex items-center justify-end gap-1 pt-1 text-[10px]", m.senderType === "shopper" ? "text-white/70" : "text-muted-foreground")}>
                              {m.senderType === "seller" ? `${m.senderName} · ` : ""}
                              {fmtDateTime(m.createdAt)}
                              {m.senderType === "shopper" ? <MessageTicks readAt={m.readAt} light className="h-3 w-3" /> : null}
                            </p>
                          </div>
                        </div>
                      ))
                    )}
                  </>
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
                    className="min-h-[44px] min-w-0 flex-1 resize-none"
                  />
                  <Button onClick={send} disabled={sending || !draft.trim()} className="min-h-[44px] gap-2 bg-brand-gradient-deep text-white hover:brightness-110" aria-label="Send message">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span className="hidden sm:inline">Send</span>
                  </Button>
                </div>
              </footer>
            </motion.div>
          ) : (
            <ChatEmptyDetail />
          )}
        </section>
      </div>
    </div>
  );
}

/** The cute clickable bubble that opens every conversation: it quotes the
 *  product (PDP entry point) or the order (order page entry point) the
 *  shopper is asking about, and taps through to that exact page. */
function ShopperContextBubble({ ctx, context }: { ctx: ShopperCtx; context: ThreadContextCard | null }) {
  // Rendered only when a product/order context exists — it is pinned under
  // the vendor name bar. Direct messages show their inline pill instead.
  if (!context) return null;

  if (context.kind === "product") {
    const go = () => ctx.nav({ name: "pdp", slug: context.storeSlug, pSlug: context.slug });
    return (
      <button
        type="button"
        onClick={go}
        className="group mx-auto flex w-full max-w-xs items-center gap-3 rounded-2xl border bg-card p-2.5 text-left shadow-sm transition-colors hover:bg-accent/40"
        aria-label={`View product: ${context.title}`}
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white shadow-inner">
          {context.image ? (
            <img src={context.image} alt="" className="h-full w-full object-cover" />
          ) : (
            <ShoppingBag className="h-5 w-5 text-teal-600" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-teal-600">🏷️ Asking about this product</span>
          <span className="block truncate text-sm font-bold text-foreground">{context.title}</span>
          <span className="block text-xs font-semibold text-teal-700">
            {formatMinor(context.priceMinor)}
            {context.compareAtPriceMinor && context.compareAtPriceMinor > context.priceMinor ? (
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground line-through">{formatMinor(context.compareAtPriceMinor)}</span>
            ) : null}
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-teal-600 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </button>
    );
  }

  const go = () => ctx.nav({ name: "order-status", orderNumber: context.orderNumber });
  return (
    <button
      type="button"
      onClick={go}
      className="group mx-auto flex w-full max-w-xs items-center gap-3 rounded-2xl border bg-card p-2.5 text-left shadow-sm transition-colors hover:bg-accent/40"
      aria-label={`View order ${context.orderNumber}`}
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white shadow-inner">
        {context.firstItemImage ? (
          <img src={context.firstItemImage} alt="" className="h-full w-full object-cover" />
        ) : (
          <Package className="h-5 w-5 text-amber-600" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-bold uppercase tracking-wider text-amber-600">🧾 Asking about this order</span>
        <span className="block truncate text-sm font-bold text-foreground">{context.orderNumber}</span>
        <span className="block truncate text-xs font-semibold text-amber-700">
          {context.firstItemTitle ?? `${context.itemCount} item${context.itemCount === 1 ? "" : "s"}`} · {formatMinor(context.totalMinor)}
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-amber-600 transition-transform group-hover:translate-x-0.5" aria-hidden />
    </button>
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
              {/* single flex item — bare "NOMO" text + "FEE" span used to be two
                  flex children, so the container's `gap-2` rendered "NOMO FEE" */}
              <span>
                NOMO<span className="text-teal-200">FEE</span>
              </span>
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
              Powered by NOMOFEE — launch your free store <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="pt-8 text-center text-[11px] text-teal-200/60">© {new Date().getFullYear()} NOMOFEE v1 · Sandbox demo</p>
      </div>
    </footer>
  );
}

// =============================================================================================
// =============================================================================================
// Cart drawer (global) — Shopify-style: slides in from the right on every
// add-to-cart and renders the SELLER'S CUSTOMIZED cart experience for the
// store the shopper is buying from (layout mode, free-shipping progress,
// upsell strip, urgency elements, trust badges, custom CTA label). Configured
// entirely through the Seller Backend's "Cart Experience" page — plain
// forms there, structured settings here, no JSON anywhere in the vendor UI.
// =============================================================================================

type CartDrawerConfig = {
  layout: string;
  showFreeShippingBar: boolean;
  freeShipThresholdMinor: number;
  upsellEnabled: boolean;
  upsellTitle: string;
  upsellLimit: number;
  urgencyStockEnabled: boolean;
  urgencyStockThreshold: number;
  urgencyViewersEnabled: boolean;
  urgencyViewersMin: number;
  urgencyViewersMax: number;
  urgencyCountdownEnabled: boolean;
  urgencyCountdownMinutes: number;
  showOrderNote: boolean;
  showDiscountHint: boolean;
  checkoutLabel: string;
  showContinueShopping: boolean;
  stickyCta: boolean;
  trustBadges: string[];
};

const CART_DRAWER_DEFAULTS: CartDrawerConfig = {
  layout: "standard",
  showFreeShippingBar: true,
  freeShipThresholdMinor: 10000,
  upsellEnabled: false,
  upsellTitle: "Frequently bought together",
  upsellLimit: 3,
  urgencyStockEnabled: false,
  urgencyStockThreshold: 5,
  urgencyViewersEnabled: false,
  urgencyViewersMin: 8,
  urgencyViewersMax: 28,
  urgencyCountdownEnabled: false,
  urgencyCountdownMinutes: 15,
  showOrderNote: false,
  showDiscountHint: true,
  checkoutLabel: "Checkout",
  showContinueShopping: true,
  stickyCta: true,
  trustBadges: [],
};

type UpsellProduct = ProductCardT & { variantId: string | null; stock: number };

type SfCartSettingsPayload = {
  store: { id: string; name: string; slug: string; theme?: { primaryColor?: string } | null };
  settings: CartDrawerConfig | null;
  upsell: UpsellProduct[];
  // Task 30: top sellers resolved for EVERY live store — the cross-vendor AOV
  // strip uses these for stores WITHOUT a cart-experience config so every
  // vendor in the cart is represented, not just the configured one.
  bestSellers?: UpsellProduct[];
};

// 60s module cache — keeps drawer opens snappy; the Seller Backend preview is
// always live, so sellers never wait on this cache to see their changes.
const cartSettingsCache = new Map<string, { at: number; payload: SfCartSettingsPayload | null; failed?: boolean }>();
const CART_SETTINGS_TTL_MS = 60_000;

const TRUST_BADGE_META: Record<string, { icon: typeof ShieldCheck; label: string }> = {
  secure: { icon: ShieldCheck, label: "Secure checkout" },
  // Task 30: "Easy returns" renamed to "Data protection" (same `returns` id so
  // sellers' saved badge selections keep working — only the label/icon changed).
  returns: { icon: LockKeyhole, label: "Data protection" },
  support: { icon: Headphones, label: "Local support" },
  shipping: { icon: Truck, label: "Fast shipping" },
  cod: { icon: Banknote, label: "COD available" },
  warranty: { icon: BadgeCheck, label: "Warranty included" },
};

function CartDrawer({
  open,
  onOpenChange,
  ctx,
  storeSlug,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ctx: ShopperCtx;
  storeSlug: string | null;
}) {
  const { cart, count, selectedCount, selectedSubtotal, loading } = useCart();
  const [addingUpsell, setAddingUpsell] = useState<string | null>(null);
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const signedIn = Boolean(me.loaded && me.shopper);

  // ---- seller cart experience -------------------------------------------------
  // Task 30: settings are loaded for EVERY store present in the cart (60s
  // cache per store). The "primary" store — the one whose PDP opened the
  // drawer, else the single store in the cart — supplies the branding (title,
  // theme accent, urgency, trust badges, CTA), while the AOV strip merges
  // recommendations from ALL vendors so no seller's picks are hidden.
  const [cfgMap, setCfgMap] = useState<Map<string, SfCartSettingsPayload | null>>(new Map());
  const [cfgLoading, setCfgLoading] = useState(false);

  const cartStoreSlugs = useMemo(
    () => [...new Set((cart?.items ?? []).map((it) => it.storeSlug).filter(Boolean))] as string[],
    [cart]
  );
  const cartSlugsKey = cartStoreSlugs.join(",");

  useEffect(() => {
    if (!open) return;
    const slugs = [...new Set([storeSlug, ...cartStoreSlugs].filter(Boolean))] as string[];
    if (slugs.length === 0) return;
    let alive = true;
    const uncached = slugs.some((s) => {
      const c = cartSettingsCache.get(s);
      return !(c && Date.now() - c.at < CART_SETTINGS_TTL_MS);
    });
    if (uncached) setCfgLoading(true);
    Promise.all(
      slugs.map(async (slug) => {
        const cached = cartSettingsCache.get(slug);
        if (cached && Date.now() - cached.at < CART_SETTINGS_TTL_MS) {
          return [slug, cached.failed ? null : cached.payload] as const;
        }
        try {
          const payload = await fetchJson<SfCartSettingsPayload>(`/api/sf/${encodeURIComponent(slug)}/cart-settings`);
          cartSettingsCache.set(slug, { at: Date.now(), payload });
          return [slug, payload] as const;
        } catch {
          cartSettingsCache.set(slug, { at: Date.now(), payload: null, failed: true });
          return [slug, null] as const;
        }
      })
    )
      .then((entries) => {
        if (alive) setCfgMap(new Map(entries));
      })
      .finally(() => {
        if (alive) setCfgLoading(false);
      });
    return () => {
      alive = false;
    };
    // cartSlugsKey stands in for cartStoreSlugs: the slug SET is what matters,
    // not item counts — this keeps the effect off every cart mutation path.
  }, [open, storeSlug, cartSlugsKey]);

  // Primary store config: explicit slug wins, else a single-store cart borrows
  // that store's experience; multi-store carts opened from the global header
  // stay on neutral platform defaults.
  const primaryPayload = storeSlug
    ? cfgMap.get(storeSlug) ?? null
    : cartStoreSlugs.length === 1
      ? cfgMap.get(cartStoreSlugs[0]) ?? null
      : null;

  const cfg: CartDrawerConfig = primaryPayload?.settings ? { ...CART_DRAWER_DEFAULTS, ...primaryPayload.settings } : { ...CART_DRAWER_DEFAULTS };
  const cfgPayloadTitle = primaryPayload?.store.name ?? null;
  const themePrimary = primaryPayload?.store.theme?.primaryColor || null;
  const accentStyle = themePrimary ? { backgroundColor: themePrimary, borderColor: themePrimary } : undefined;
  const accentText = themePrimary ? { color: themePrimary } : undefined;

  // structural gating: compact = essentials, standard = + urgency/trust, pro = + upsell
  const showUrgency = cfg.layout !== "compact";
  const showTrust = cfg.layout !== "compact" && cfg.trustBadges.length > 0;
  const showShipBar = cfg.showFreeShippingBar && cfg.layout !== "compact" && cfg.freeShipThresholdMinor > 0;
  const showCountdown = showUrgency && cfg.urgencyCountdownEnabled;
  const showViewers = showUrgency && cfg.urgencyViewersEnabled;

  // ---- urgency: reservation countdown (ticks once per second while open) ------
  const [openedAtMs, setOpenedAtMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setOpenedAtMs(Date.now());
    setNowMs(Date.now());
  }, [open]);
  useEffect(() => {
    if (!open || !showCountdown) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, showCountdown]);
  const remainSec = Math.max(0, cfg.urgencyCountdownMinutes * 60 - Math.floor((nowMs - openedAtMs) / 1000));
  const countdownLabel = `${String(Math.floor(remainSec / 60)).padStart(2, "0")}:${String(remainSec % 60).padStart(2, "0")}`;

  // ---- urgency: live-viewers indicator ----------------------------------------
  const [viewers, setViewers] = useState(12);
  useEffect(() => {
    if (!open || !showViewers) return;
    const lo = Math.max(2, Math.min(cfg.urgencyViewersMin, cfg.urgencyViewersMax));
    const hi = Math.max(cfg.urgencyViewersMin, cfg.urgencyViewersMax);
    setViewers(lo + Math.floor(Math.random() * (hi - lo + 1)));
    const t = setInterval(() => {
      setViewers((v) => Math.min(hi, Math.max(lo, v + (Math.random() < 0.5 ? -1 : 1))));
    }, 7000);
    return () => clearInterval(t);
  }, [open, showViewers, cfg.urgencyViewersMin, cfg.urgencyViewersMax]);

  // (Task 30: the cart order-note box was removed — buyers who need to tell a
  // seller something can reach them in chat, and checkout keeps its own note.)

  // Multi-seller cart: one section per seller (Option A — one payment at checkout).
  // Each group carries its own selection figures for the seller-level checkbox.
  const storeGroups = useMemo(() => {
    const items = cart?.items ?? [];
    const map = new Map<
      string,
      { storeId: string; storeSlug: string; storeName: string; items: CartItemT[]; subtotalMinor: number; selectedSubtotalMinor: number; allSelected: boolean; someSelected: boolean }
    >();
    for (const it of items) {
      const g = map.get(it.storeId);
      if (g) {
        g.items.push(it);
        g.subtotalMinor += it.lineTotalMinor;
        if (it.selected) g.selectedSubtotalMinor += it.lineTotalMinor;
      } else {
        map.set(it.storeId, {
          storeId: it.storeId,
          storeSlug: it.storeSlug,
          storeName: it.storeName,
          items: [it],
          subtotalMinor: it.lineTotalMinor,
          selectedSubtotalMinor: it.selected ? it.lineTotalMinor : 0,
          allSelected: it.selected,
          someSelected: it.selected,
        });
      }
    }
    for (const g of map.values()) {
      g.allSelected = g.items.every((it) => it.selected);
      g.someSelected = g.items.some((it) => it.selected);
    }
    return [...map.values()];
  }, [cart]);

  // -----------------------------------------------------------------------
  // Task 29 — INSTANT quantity + remove (same philosophy as the Task 28
  // selection toggles and the Messages filter): the shared cart store is
  // mutated SYNCHRONOUSLY — the row, price, subtotal, free-ship bar, header
  // count and header badge all repaint in the same frame, ZERO network in the
  // render path — while the PATCH/DELETE rides in the background.
  //
  // Rapid +/- taps are coalesced into ONE PATCH per item (350ms trailing
  // debounce), so a burst of five taps costs one request, not five. Server
  // truth (stock clamps) is adopted only if the buyer hasn't tapped since,
  // and any failure rolls back to the pre-burst quantity (guarded so it can
  // never clobber a newer edit).
  // -----------------------------------------------------------------------
  const qtyTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const qtyRevertPoint = useRef(new Map<string, number>());

  function bumpQty(itemId: string, nextQty: number) {
    const it = cartSnapshot().items.find((x) => x.id === itemId);
    if (!it) return;
    // Client-side guard rails: 1..stock (moq compliance is the stepper's min;
    // checkout/create re-validates authoritatively either way).
    const clamped = Math.max(1, Math.min(nextQty, Math.max(1, it.stock)));
    if (clamped === it.qty) return;
    if (!qtyTimers.current.has(itemId)) qtyRevertPoint.current.set(itemId, it.qty);
    mutateCartItems((items) =>
      items.map((x) => (x.id === itemId ? { ...x, qty: clamped, lineTotalMinor: x.unitPriceMinor * clamped } : x))
    );
    const t = qtyTimers.current.get(itemId);
    if (t) clearTimeout(t);
    qtyTimers.current.set(
      itemId,
      setTimeout(() => {
        qtyTimers.current.delete(itemId);
        const intended = cartSnapshot().items.find((x) => x.id === itemId)?.qty ?? clamped;
        patchJson<{ cart: CartT }>(`/api/cart/items/${itemId}`, { qty: intended })
          .then((res) => {
            qtyRevertPoint.current.set(itemId, intended);
            if (qtyTimers.current.has(itemId)) return; // newer taps pending — they will settle
            const serverItem = res.cart.items.find((x) => x.id === itemId);
            const localItem = cartSnapshot().items.find((x) => x.id === itemId);
            // The server clamps on stock changes (another device bought the
            // last units mid-burst). Adopt its number if we're still pristine.
            if (serverItem && localItem && serverItem.qty !== localItem.qty) {
              mutateCartItems((items) =>
                items.map((x) =>
                  x.id === itemId
                    ? { ...x, qty: serverItem.qty, stock: serverItem.stock, moq: serverItem.moq, lineTotalMinor: serverItem.lineTotalMinor }
                    : x
                )
              );
              toast.warning("Quantity adjusted", { description: `${localItem.title}: only ${serverItem.stock} left in stock` });
            }
          })
          .catch(() => {
            if (qtyTimers.current.has(itemId)) return; // a newer PATCH owns the outcome
            const revertTo = qtyRevertPoint.current.get(itemId);
            mutateCartItems((items) =>
              items.map((x) => {
                if (x.id !== itemId) return x;
                if (revertTo == null || x.qty !== intended) return x; // guarded revert
                return { ...x, qty: revertTo, lineTotalMinor: x.unitPriceMinor * revertTo };
              })
            );
            toast.error("Could not update quantity");
          });
      }, 350)
    );
  }

  function removeItem(itemId: string) {
    const items = cartSnapshot().items;
    const idx = items.findIndex((x) => x.id === itemId);
    if (idx === -1) return;
    const snapshot = items[idx];
    const pendingTimer = qtyTimers.current.get(itemId);
    if (pendingTimer) {
      clearTimeout(pendingTimer); // don't let a queued PATCH 404 behind the DELETE
      qtyTimers.current.delete(itemId);
    }
    qtyRevertPoint.current.delete(itemId);
    mutateCartItems((items) => items.filter((x) => x.id !== itemId));
    deleteJson(`/api/cart/items/${itemId}`).catch(() => {
      // Failure is rare (offline / session expired) — put the line back where
      // it was (guarded: never duplicate if state moved on) and say so.
      mutateCartItems((items) => {
        if (items.some((x) => x.id === snapshot.id)) return items;
        const at = Math.min(idx, items.length);
        return [...items.slice(0, at), snapshot, ...items.slice(at)];
      });
      toast.error("Could not remove item");
    });
  }

  // Launch-rush stock probe — ONCE per drawer open, ONE tiny indexed request
  // (GET /api/cart/stock?ids=…) refreshes only the volatile numbers (stock,
  // moq, purchasability). The UI then clamps LOCALLY: quantities over the real
  // stock are adjusted (with a notice), so the buyer never fights a stale
  // number while ten thousand other people are buying. Checkout/create still
  // runs the authoritative atomic decrement — this probe is the cheap first
  // layer, not the last.
  const stockProbeSeq = useRef(0);
  useEffect(() => {
    if (!open || !signedIn) return;
    const ids = [...new Set(cartSnapshot().items.map((i) => i.variantId))];
    if (ids.length === 0) return;
    const seq = ++stockProbeSeq.current;
    fetchJson<{ stocks: Record<string, { stock: number; moq: number; purchasable: boolean }> }>(
      `/api/cart/stock?ids=${encodeURIComponent(ids.join(","))}`
    )
      .then(({ stocks }) => {
        if (seq !== stockProbeSeq.current) return; // a newer open/refresh supersedes
        const adjusted: string[] = [];
        mutateCartItems((items) =>
          items.map((it) => {
            const s = stocks[it.variantId];
            if (!s) return it;
            const stock = s.purchasable ? s.stock : 0;
            let next: CartItemT = { ...it, stock, moq: s.moq };
            if (next.qty > stock && stock > 0) {
              adjusted.push(`“${it.title}” — only ${stock} left, quantity adjusted`);
              next = { ...next, qty: stock, lineTotalMinor: next.unitPriceMinor * stock };
            }
            return next;
          })
        );
        if (adjusted.length > 0) {
          toast.warning("Stock changed while you were away", {
            description: adjusted[0] + (adjusted.length > 1 ? ` (+${adjusted.length - 1} more)` : ""),
          });
        }
      })
      .catch(() => {
        /* probe is best-effort — checkout re-validates authoritatively */
      });
  }, [open, signedIn]);

  // Checkout selection — one item, or a whole seller's group at once.
  // Unchecked lines STAY in the cart (kept for later); only checked lines go
  // to checkout, and the payment webhook removes exactly the purchased items.
  //
  // Task 28: OPTIMISTIC — the shared cart store (module-level, see useCart)
  // is mutated synchronously so the checkbox, subtotal, free-shipping bar and
  // header count repaint in the same frame; the PATCH rides in the background
  // and only a failure rolls the change back (guarded so it can't clobber a
  // newer toggle). Zero waiting, zero refetch — the messaging-filter approach.
  function setItemSelected(itemId: string, selected: boolean) {
    mutateCartItems((items) => items.map((it) => (it.id === itemId ? { ...it, selected } : it)));
    patchJson(`/api/cart/items/${itemId}`, { selected }).catch(() => {
      mutateCartItems((items) =>
        items.map((it) => (it.id === itemId && it.selected === selected ? { ...it, selected: !selected } : it))
      );
      toast.error("Could not update selection");
    });
  }

  function setStoreSelected(g: (typeof storeGroups)[number], selected: boolean) {
    const ids = g.items.map((it) => it.id);
    const idSet = new Set(ids);
    mutateCartItems((items) => items.map((it) => (idSet.has(it.id) ? { ...it, selected } : it)));
    patchJson("/api/cart/selection", { itemIds: ids, selected }).catch(() => {
      mutateCartItems((items) =>
        items.map((it) => (idSet.has(it.id) && it.selected === selected ? { ...it, selected: !selected } : it))
      );
      toast.error("Could not update selection");
    });
  }

  async function addUpsell(p: UpsellProduct) {
    if (!p.variantId) return;
    setAddingUpsell(p.id);
    try {
      const res = await postJson<{ cart: CartT; notice: string | null }>("/api/cart/items", { variantId: p.variantId, qty: 1 });
      applyServerCart(res.cart); // same-frame badge/drawer update, zero refetch
      if (res.notice) toast.warning("Cart updated", { description: res.notice });
      else toast.success("Added to cart", { description: p.title });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add item");
    } finally {
      setAddingUpsell(null);
    }
  }

  // Task 30 — AOV strip across ALL vendors in the cart. Contribution rules:
  //   • store with upsell ENABLED → its own curated/auto list (their limit);
  //   • store with NO cart-experience config → its best-sellers fallback, so
  //     unconfigured sellers are still represented in multi-vendor carts;
  //   • store that explicitly DISABLED upsell → excluded (their choice).
  // Lists are ROUND-ROBIN merged so every vendor gets fair placement in the
  // strip instead of one store monopolising it, capped at 9 cards.
  const upsellStrip = useMemo(() => {
    const inCartProduct = new Set((cart?.items ?? []).map((it) => it.productId));
    const inCartVariant = new Set((cart?.items ?? []).map((it) => it.variantId));
    const lists: { slug: string; title: string; curated: boolean; items: UpsellProduct[] }[] = [];
    for (const payload of cfgMap.values()) {
      if (!payload) continue;
      const merged: CartDrawerConfig | null = payload.settings
        ? { ...CART_DRAWER_DEFAULTS, ...payload.settings }
        : null;
      if (merged?.upsellEnabled) {
        const items = (payload.upsell ?? [])
          .filter((u) => u.variantId && !inCartProduct.has(u.id) && !inCartVariant.has(u.variantId))
          .slice(0, Math.max(1, merged.upsellLimit));
        if (items.length > 0) lists.push({ slug: payload.store.slug, title: merged.upsellTitle || "You may also like", curated: true, items });
      } else if (!merged) {
        // never configured — platform-curated fallback keeps this vendor visible
        const items = (payload.bestSellers ?? [])
          .filter((u) => u.variantId && !inCartProduct.has(u.id) && !inCartVariant.has(u.variantId))
          .slice(0, 3);
        if (items.length > 0) lists.push({ slug: payload.store.slug, title: "You may also like", curated: false, items });
      }
    }
    if (lists.length === 0) return { items: [] as UpsellProduct[], title: "You may also like" };
    const mergedOut: UpsellProduct[] = [];
    const seen = new Set<string>();
    const cursor = lists.map(() => 0);
    let guard = 0;
    while (mergedOut.length < 9 && guard++ < 60) {
      let addedThisRound = false;
      for (let i = 0; i < lists.length && mergedOut.length < 9; i++) {
        while (cursor[i] < lists[i].items.length) {
          const cand = lists[i].items[cursor[i]++];
          const key = `${cand.id}:${cand.variantId ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          mergedOut.push(cand);
          addedThisRound = true;
          break;
        }
      }
      if (!addedThisRound) break;
    }
    // Title: keep the primary seller's configured strip title when their own
    // list contributed (the section keeps its identity — only the CONTENT
    // became multi-vendor); otherwise one list keeps its title, several
    // unbranded lists fall back to the neutral marketplace title.
    const primaryCurated = primaryPayload && lists.find((l) => l.slug === primaryPayload.store.slug && l.curated);
    const title = primaryCurated
      ? primaryCurated.title
      : lists.length === 1
        ? lists[0].title
        : "You may also like";
    return { items: mergedOut, title };
  }, [cfgMap, cart, primaryPayload]);

  // Strip visibility: the drawer's primary seller keeps control (their layout
  // must not be compact and, when they have an explicit config, they must
  // have upsell on). A multi-vendor cart opened WITHOUT any primary config
  // still gets the platform's cross-vendor strip — that's a marketplace
  // feature, not one seller's marketing.
  const crossVendorNeutralStrip = !primaryPayload?.settings && cartStoreSlugs.length > 1;
  const showUpsellStrip =
    cfg.layout !== "compact" && (cfg.upsellEnabled || crossVendorNeutralStrip) && upsellStrip.items.length > 0;

  // Selection-aware free-shipping progress — the bar tracks what is actually
  // going to checkout, not the whole cart.
  const shipProgress = Math.min(1, cfg.freeShipThresholdMinor > 0 ? selectedSubtotal / cfg.freeShipThresholdMinor : 1);
  const shipRemainingMinor = Math.max(0, cfg.freeShipThresholdMinor - selectedSubtotal);
  const keptLines = (cart?.items.length ?? 0) - (cart?.items.filter((it) => it.selected).length ?? 0);

  const lowStockOf = (it: CartItemT): number | null =>
    showUrgency && cfg.urgencyStockEnabled && it.stock > 0 && it.stock <= cfg.urgencyStockThreshold ? it.stock : null;

  const itemsBlock = (
    <div className="space-y-2.5">
      {/* Task 28: ONE card per vendor — every item from a seller lives inside
          the seller's card as a divided row (no per-item borders), so a
          2-seller cart is exactly 2 cards. */}
      {storeGroups.map((g) => (
        <div key={g.storeId} className="overflow-hidden rounded-xl border bg-card">
          {/* Seller header — select-all / deselect-all for this seller's items.
              Always rendered (selection is core cart mechanics in every layout);
              the compact layout hides only the shipping hint. */}
          <div className="flex items-center justify-between gap-2 bg-muted/60 px-2.5 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <Checkbox
                checked={g.allSelected ? true : g.someSelected ? "indeterminate" : false}
                // Convention for tri-state seller checkbox: mixed or empty →
                // select ALL of this seller; all selected → deselect all.
                // (Radix's own next-value treats indeterminate as checked,
                // which would deselect on the first click of a mixed group.)
                onCheckedChange={() => setStoreSelected(g, !g.allSelected)}
                aria-label={`Select all ${g.storeName} items`}
                className="h-4 w-4 shrink-0 data-[state=indeterminate]:border-teal-700 data-[state=indeterminate]:bg-teal-700 data-[state=indeterminate]:text-white"
              />
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  ctx.nav({ name: "storefront", slug: g.storeSlug });
                }}
                className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-teal-800 hover:underline"
                aria-label={`View seller ${g.storeName}`}
              >
                <Store className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{g.storeName}</span>
              </button>
            </div>
            {cfg.layout !== "compact" ? (
              <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">
                {g.selectedSubtotalMinor >= 10000 ? (
                  <span className="text-emerald-700">FREE shipping unlocked</span>
                ) : g.selectedSubtotalMinor > 0 ? (
                  `${formatMinor(g.selectedSubtotalMinor)} + shipping`
                ) : (
                  "Nothing selected"
                )}
              </span>
            ) : null}
          </div>
          <div className="divide-y">
            <AnimatePresence initial={false}>
              {g.items.map((it) => {
                const low = lowStockOf(it);
                const outOfStock = it.stock <= 0;
                const overStock = !outOfStock && it.qty > it.stock; // seller reduced stock / others bought
                const belowMoq = it.qty < it.moq; // seller raised the minimum after add
                return (
                  <motion.div
                    key={it.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 40 }}
                    transition={{ duration: 0.18 }}
                    className={cn("flex items-start gap-2.5 p-2 transition-opacity", !it.selected && "opacity-55")}
                  >
                    {/* checkout selection — unchecked = keep this item in the cart */}
                    <Checkbox
                      checked={it.selected}
                      onCheckedChange={(v) => setItemSelected(it.id, v === true)}
                      aria-label={`Include ${it.title} in checkout`}
                      className="mt-6 h-4 w-4 shrink-0"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        ctx.nav({ name: "pdp", slug: it.storeSlug, pSlug: it.productSlug });
                      }}
                      className="shrink-0"
                      aria-label={`View ${it.title}`}
                    >
                      <img
                        src={it.imageUrl}
                        alt={it.title}
                        loading="lazy"
                        className={cn(
                          "rounded-lg border object-cover",
                          cfg.layout === "compact" ? "h-12 w-12" : "h-16 w-16",
                          !it.selected && "grayscale-[35%]"
                        )}
                      />
                    </button>
                    {/* main column — title, then price directly under the name
                        (Task 29: price lives where the stepper used to be) */}
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          ctx.nav({ name: "pdp", slug: it.storeSlug, pSlug: it.productSlug });
                        }}
                        className="block text-left text-[12px] font-medium leading-tight line-clamp-2 hover:text-teal-700"
                      >
                        {it.title}
                      </button>
                      <p className="text-[13px] font-bold leading-tight text-teal-700">{formatMinor(it.lineTotalMinor)}</p>
                      {it.variantLabel && it.variantLabel !== "Default" ? <p className="text-[11px] leading-tight text-muted-foreground">{it.variantLabel}</p> : null}
                      {outOfStock ? (
                        <p className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700" role="status">
                          <Flame className="h-3 w-3" /> Out of stock
                        </p>
                      ) : overStock ? (
                        <p className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" role="status">
                          <Flame className="h-3 w-3" /> Only {it.stock} left — reduce quantity
                        </p>
                      ) : low !== null ? (
                        <p
                          className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700"
                          role="status"
                        >
                          <Flame className="h-3 w-3" /> Only {low} left in stock
                        </p>
                      ) : belowMoq ? (
                        <p className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" role="status">
                          Seller minimum {it.moq} — increase quantity
                        </p>
                      ) : null}
                    </div>
                    {/* right column — trash on top, minimalist stepper under it */}
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => removeItem(it.id)}
                        className="p-0.5 text-muted-foreground transition-colors hover:text-rose-600"
                        aria-label={`Remove ${it.title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <QtyStepper
                        xs
                        value={it.qty}
                        min={it.moq}
                        max={Math.max(it.qty, it.stock)}
                        onChange={(v) => bumpQty(it.id, v)}
                      />
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      ))}
    </div>
  );

  const ctaBlock = (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Subtotal ({selectedCount} of {count} items)</span>
        <span className="text-lg font-extrabold" style={accentText ?? { color: "#0f766e" }}>
          {formatMinor(selectedSubtotal)}
        </span>
      </div>
      <Button
        size="lg"
        disabled={selectedCount === 0}
        onClick={() => {
          onOpenChange(false);
          ctx.nav({ name: "checkout" });
        }}
        className={cn("w-full min-h-[48px] text-white hover:brightness-110", !themePrimary && "bg-teal-700 hover:bg-teal-800")}
        style={accentStyle}
      >
        {cfg.checkoutLabel || "Checkout"} <ArrowRight className="h-4 w-4" />
      </Button>
      {cfg.showContinueShopping ? (
        <button
          type="button"
          onClick={() => {
            onOpenChange(false);
            ctx.nav({ name: "market" }); // back to the marketplace, not just drawer-close
          }}
          className="w-full text-center text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          Continue shopping
        </button>
      ) : null}
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Task 33: gap-0 — the shadcn SheetContent base carries `flex flex-col
          gap-4`, which injected a dead 16px band between the header and the
          item list and again above the Subtotal/CTA block. */}
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md p-0">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ShoppingCart className="h-5 w-5" style={accentText ?? { color: "#0f766e" }} />
            {cfgPayloadTitle ? `${cfgPayloadTitle} — your cart` : "Your cart"}
            {count > 0 ? (
              <span className="text-sm font-normal text-muted-foreground">
                ({keptLines > 0 ? `${selectedCount} of ${count}` : count} item{count === 1 ? "" : "s"})
              </span>
            ) : null}
          </SheetTitle>
        </SheetHeader>

        {loading || (cfgLoading && !primaryPayload) ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !signedIn ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={ShoppingCart}
              title="Sign in to use your cart"
              hint="Carts live on your NOMOFEE account — your items stay with you on every device and are waiting when you come back."
              action={
                <Button onClick={() => openShopperAuth()} className="bg-brand-gradient-deep text-white hover:brightness-110 gap-2">
                  <LogIn className="h-4 w-4" /> Sign in or create account
                </Button>
              }
            />
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
            <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3 space-y-3">
              {/* urgency: cart reservation countdown — Task 30: fixed-height,
                  single-line row so the label never reflows the items below */}
              {showCountdown ? (
                <div
                  className="flex h-9 items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 text-xs font-semibold text-amber-800"
                  role="status"
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <Timer className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate tabular-nums">
                      {remainSec > 0 ? `Items reserved for ${countdownLabel}` : "Reservation expired — checkout to secure your items"}
                    </span>
                  </span>
                </div>
              ) : null}

              {/* urgency: live viewers — Task 30: locked to a fixed 20px row with
                  a truncated single line + tabular digits, so the count ticking
                  up/down every few seconds can NEVER wrap to a second line and
                  shift the item cards up/down */}
              {showViewers ? (
                <p className="flex h-5 items-center gap-1.5 overflow-hidden text-[11px] font-medium text-rose-600" role="status">
                  <Eye className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate tabular-nums">{viewers} people are viewing this store's products right now</span>
                </p>
              ) : null}

              {/* AOV: free-shipping progress — fixed-height text line (truncate)
                  so toggling selection can never push the item cards around */}
              {showShipBar ? (
                <div className="rounded-xl border p-3" role="status">
                  {/* Task 30: fixed h-5 row so crossing the threshold never
                      reflows the items. Task 33: unlocked state now carries a
                      lorry icon slightly larger than the text. */}
                  <p className="flex h-5 items-center gap-1.5 text-xs font-semibold tabular-nums">
                    {shipRemainingMinor <= 0 ? (
                      <>
                        <Truck className="h-[18px] w-[18px] shrink-0 text-emerald-700" aria-hidden="true" />
                        <span className="min-w-0 truncate text-emerald-700">You've unlocked FREE shipping</span>
                      </>
                    ) : (
                      <span className="min-w-0 truncate">
                        Spend <span className="font-extrabold">{formatMinor(shipRemainingMinor)}</span> more for FREE shipping
                      </span>
                    )}
                  </p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.round(shipProgress * 100)}%`,
                        backgroundColor: shipRemainingMinor <= 0 ? "#059669" : themePrimary ?? "#0f766e",
                      }}
                    />
                  </div>
                </div>
              ) : null}

              {itemsBlock}

              {/* AOV: upsell / cross-sell strip — Task 30: covers EVERY vendor
                  in the cart (round-robin merged; best-seller fallback for
                  unconfigured sellers), so a 2-seller cart surfaces
                  recommendations from both sellers */}
              {showUpsellStrip ? (
                <div className="space-y-2 border-t pt-3">
                  <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    <Gift className="h-3.5 w-3.5" /> {upsellStrip.title || "You may also like"}
                  </p>
                  <div className="flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
                    {upsellStrip.items.map((u) => (
                      <div key={u.id} className="w-28 shrink-0 rounded-xl border bg-card p-2">
                        <button
                          type="button"
                          onClick={() => {
                            onOpenChange(false);
                            ctx.nav({ name: "pdp", slug: u.storeSlug, pSlug: u.slug });
                          }}
                          className="block"
                          aria-label={`View ${u.title}`}
                        >
                          <img src={u.imageUrl} alt={u.title} loading="lazy" className="aspect-square w-full rounded-lg border object-cover" />
                        </button>
                        <p className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-tight">{u.title}</p>
                        <div className="mt-1 flex items-center justify-between gap-1">
                          <span className="text-xs font-bold text-teal-700">{formatMinor(u.priceMinor)}</span>
                          <Button
                            type="button"
                            size="icon"
                            className="h-7 w-7"
                            style={accentStyle}
                            disabled={!u.variantId || u.stock <= 0 || addingUpsell === u.id}
                            onClick={() => addUpsell(u)}
                            aria-label={`Add ${u.title} to cart`}
                          >
                            {addingUpsell === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* (Task 30: order-note box removed — buyers chat the seller
                  directly, and checkout keeps its own note field.) */}

              {/* conversion: trust badges */}
              {showTrust ? (
                <div className="grid grid-cols-3 gap-2 border-t pt-3">
                  {cfg.trustBadges.map((id) => {
                    const meta = TRUST_BADGE_META[id];
                    if (!meta) return null;
                    const Icon = meta.icon;
                    return (
                      <div key={id} className="flex flex-col items-center gap-1 rounded-lg border bg-muted/30 p-2 text-center">
                        <Icon className="h-4 w-4 text-teal-700" aria-hidden />
                        <span className="text-[10px] font-semibold leading-tight text-muted-foreground">{meta.label}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* non-sticky CTA renders inline at the end of the scroll area */}
              {!cfg.stickyCta ? <div className="border-t pt-3">{ctaBlock}</div> : null}
            </div>

            {cfg.stickyCta ? <div className="border-t bg-background p-4 space-y-3">{ctaBlock}</div> : null}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

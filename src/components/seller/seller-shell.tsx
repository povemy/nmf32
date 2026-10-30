"use client";
// Task 2-d — Seller surface shell: auth gate → status router → dashboard layout.
// Status machine: no session → auth screen; onboarding/rejected → wizard;
// pending_review → review screen (polls); active → full seller dashboard.
import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useApp } from "@/lib/app-store";
import { useChatUserRoom } from "@/lib/chat-presence";
import { setSessionToken } from "@/lib/session-client";
import { cn } from "@/lib/utils";
import {
  apiGet,
  apiSend,
  ageOf,
  fmtCommissionPercent,
  runMutation,
  StoreMe,
  SellerNav,
  StatusChip,
  fmtDateTime,
  PlatformTerms,
} from "./ui-bits";
import OnboardingWizard from "./onboarding";
import SellerDashboard from "./dashboard";
import SellerInsights from "./insights";
import SellerProducts from "./products";
import SellerOrders from "./orders";
import SellerMessages from "./messages";
import SellerWallet from "./wallet";
import PageBuilder from "./builder";
import SellerCoupons from "./marketing";
import SellerVouchers from "./vouchers";
import SellerAffiliate from "./affiliate";
import SellerIntegrations from "./integrations";
import SellerSettings from "./settings";
import SellerImports from "./imports";
import SellerSeo from "./seo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  BadgeCheck,
  BadgePercent,
  Bell,
  Blocks,
  ChartColumn,
  Clock3,
  DatabaseZap,
  ExternalLink,
  LayoutDashboard,
  LayoutTemplate,
  Loader2,
  LogOut,
  Menu,
  MessagesSquare,
  Package,
  Search,
  Settings,
  Share2,
  ShieldAlert,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  TicketPercent,
  Wallet,
} from "lucide-react";

// nav-reorg — consolidated nav: Pending releases is a Wallet & Payouts tab,
// Product Cards + Cart Experience are Page Builder tabs, and Domains is a
// Store Settings tab. The tab discriminator rides on SellerNav (see ui-bits).
const NAV: { key: SellerNav["view"]; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "insights", label: "Insights", icon: ChartColumn },
  { key: "imports", label: "Imports & Publish", icon: DatabaseZap },
  { key: "products", label: "Products", icon: Package },
  { key: "orders", label: "Orders", icon: ShoppingCart },
  { key: "messages", label: "Messages", icon: MessagesSquare },
  { key: "seo", label: "SEO", icon: Search },
  { key: "wallet", label: "Wallet & Payouts", icon: Wallet },
  { key: "builder", label: "Page Builder", icon: LayoutTemplate },
  { key: "coupons", label: "Coupons", icon: TicketPercent },
  { key: "vouchers", label: "Vouchers", icon: BadgePercent },
  { key: "affiliate", label: "Affiliate", icon: Share2 },
  { key: "integrations", label: "Integrations", icon: Blocks },
  { key: "settings", label: "Store Settings", icon: Settings },
];

export default function SellerShell() {
  const me = useApp((s) => s.me);
  const refreshMe = useApp((s) => s.refreshMe);
  const [nav, setNav] = useState<SellerNav>({ view: "dashboard" });
  const [storeMe, setStoreMe] = useState<StoreMe | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Bubbly Cyan backend theme — scoped to <body> so Radix portals (popovers,
  // sheets, toasts) inherit it too. Marketplace surfaces keep the root theme.
  useEffect(() => {
    document.body.classList.add("backend-ui");
    return () => document.body.classList.remove("backend-ui");
  }, []);

  const seller = me.loaded && "seller" in me ? me.seller : null;
  const sellerId = seller?.id ?? null;

  // ---- global inbox presence (ONE socket on every seller view) ---------------
  // Keeps the Messages nav badge instant (a push fires "nomofee:chat-sync",
  // which useSellerChatUnread already listens to) and toasts the shopper's
  // message with a jump-in action while the seller is on any other page.
  useChatUserRoom(sellerId, {
    onMessage: (msg) => {
      if (msg.senderType === "seller") return; // own echo / assistant paths
      window.dispatchEvent(new Event("nomofee:chat-sync"));
      if (nav.view !== "messages") {
        const preview = msg.body.length > 90 ? `${msg.body.slice(0, 90)}…` : msg.body;
        toast(`${msg.senderName} · New message`, {
          description: preview,
          action: { label: "Open messages", onClick: () => setNav({ view: "messages" }) },
        });
      }
    },
    onActivity: () => window.dispatchEvent(new Event("nomofee:chat-sync")),
  });

  const refreshStoreMe = useCallback(async () => {
    try {
      const d = await apiGet<StoreMe>("/api/store/me");
      setStoreMe(d);
    } catch {
      /* status-gated endpoints may 403 during onboarding — non-fatal */
    }
  }, []);

  useEffect(() => {
    if (sellerId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
      setNav({ view: "dashboard" });
      refreshStoreMe();
    } else {
      setStoreMe(null);
    }
  }, [sellerId, refreshStoreMe]);

  const logout = useCallback(async () => {
    await useApp.getState().logout();
    toast.success("Signed out");
  }, []);

  // ------------------------------------------------------------- render gates

  if (!me.loaded) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!seller) {
    return <AuthScreen onAuthed={refreshMe} />;
  }

  const status = seller.status;

  if (status === "suspended" || status === "terminated") {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full space-y-4 rounded-3xl border border-slate-200/80 bg-card p-8 text-center shadow-soft-card">
          <ShieldAlert className="mx-auto h-10 w-10 text-rose-500" />
          <h2 className="text-lg font-bold capitalize tracking-tight text-slate-900">Store {status}</h2>
          <p className="text-sm text-slate-500">
            This store is not currently trading. Contact NOMOFEE support if you believe this is a mistake.
          </p>
          <Button variant="outline" onClick={logout} className="gap-2">
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </div>
    );
  }

  if (status === "onboarding" || status === "rejected") {
    return <OnboardingWizard onStatusChanged={refreshMe} />;
  }

  if (status === "pending_review") {
    return <PendingReview onLogout={logout} />;
  }

  // ---------------------------------------------------------------- active

  const storeName = storeMe?.store.name ?? seller.storeName ?? "My store";
  const storeSlug = storeMe?.store.slug ?? seller.storeSlug ?? "";

  const openStorefront = () => {
    const app = useApp.getState();
    app.setActiveStoreSlug(storeSlug || null);
    app.setSurface("shopper");
  };

  const navigate = (n: SellerNav) => {
    setNav(n);
    setMobileNavOpen(false);
  };

  return (
    <div className="flex-1 flex min-h-0">
      {/* desktop sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-slate-200/80 bg-white print:hidden">
        <div className="flex items-center gap-2.5 border-b border-slate-200/80 px-4 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-glow-cyan-sm">
            <ShoppingBag className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-tight text-slate-900">{storeName}</p>
            <p className="truncate text-xs text-slate-400">/{storeSlug}</p>
          </div>
        </div>
        <SideNav active={nav.view} onNavigate={navigate} className="flex-1 overflow-y-auto p-2" />
        <div className="space-y-2 border-t border-slate-200/80 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">Store status</span>
            <StatusChip status={storeMe?.store.status ?? "live"} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">Plan</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold capitalize text-slate-600">
              {storeMe?.seller.planCode ?? "free"}
            </span>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* top bar */}
        <header className="flex items-center gap-3 border-b border-slate-200/80 bg-white/80 px-4 py-3 backdrop-blur print:hidden">
          {/* mobile nav trigger */}
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="md:hidden" aria-label="Open navigation">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 border-slate-200/80 bg-white p-0">
              <SheetHeader className="flex-row items-center gap-2.5 border-b border-slate-200/80 px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-glow-cyan-sm">
                  <ShoppingBag className="h-4.5 w-4.5" />
                </span>
                <SheetTitle className="text-left text-sm font-bold text-slate-900">{storeName}</SheetTitle>
              </SheetHeader>
              <SideNav active={nav.view} onNavigate={navigate} className="p-2" />
            </SheetContent>
          </Sheet>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-bold capitalize tracking-tight text-slate-900">
              {NAV.find((n) => n.key === nav.view)?.label ?? "Dashboard"}
            </h1>
            <p className="hidden sm:block text-xs text-slate-400">
              Seller portal · {seller.displayName} ({seller.email})
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={openStorefront} className="gap-1.5">
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">View storefront</span>
            <span className="sm:hidden">Store</span>
          </Button>
          <SellerNotificationBell />
          <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out" className="text-muted-foreground">
            <LogOut className="h-4 w-4" />
          </Button>
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto">
          <motion.div
            key={nav.view + (nav.pageId ?? "") + (nav.orderId ?? "") + (nav.productId ?? "") + (nav.activityId ?? "")}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="mx-auto w-full max-w-6xl p-4 sm:p-6"
          >
            {nav.view === "dashboard" && <SellerDashboard onNavigate={navigate} />}
            {nav.view === "insights" && <SellerInsights onNavigate={navigate} />}
            {nav.view === "imports" && <SellerImports onNavigate={navigate} />}
            {nav.view === "products" && <SellerProducts focusProductId={nav.productId} onNavigate={navigate} />}
            {nav.view === "orders" && <SellerOrders focusOrderId={nav.orderId} onNavigate={navigate} />}
            {nav.view === "messages" && <SellerMessages sellerId={sellerId} onNavigate={navigate} />}
            {nav.view === "wallet" && <SellerWallet focusActivityId={nav.activityId} walletTab={nav.walletTab} onNavigate={navigate} />}
            {nav.view === "builder" && (
              <PageBuilder
                pageId={nav.pageId}
                builderTab={nav.builderTab}
                onNavigate={navigate}
                storeSlug={storeSlug}
                storeName={storeName}
              />
            )}
            {nav.view === "coupons" && <SellerCoupons />}
            {nav.view === "vouchers" && <SellerVouchers />}
            {nav.view === "affiliate" && <SellerAffiliate affiliateTab={nav.affiliateTab} onNavigate={navigate} />}
            {nav.view === "seo" && <SellerSeo onNavigate={navigate} />}
            {nav.view === "integrations" && <SellerIntegrations />}
            {nav.view === "settings" && (
              <SellerSettings
                onNavigate={navigate}
                storeMe={storeMe}
                refreshStoreMe={refreshStoreMe}
                settingsTab={nav.settingsTab}
                storeSlug={storeSlug}
              />
            )}
          </motion.div>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- notifications

// FIN-3-c — seller in-app notification bell. Feeds from the NotificationLog
// rows (channel "inapp") the finance flows already write for the seller email:
// order.paid (FIN-2-b) + payout requested/approved/paid/failed/rejected
// (FIN-2-a/FIN-3-b). The shopper bell is a different subsystem (Notification
// model via /api/me/notifications) and is intentionally untouched.

type SellerNotificationRow = { id: string; subject: string; createdAt: string; event: string };

type SellerNotificationsPayload = { notifications: SellerNotificationRow[]; recentCount: number };

/** House scrollbar style (same treatment as the shopper bell panel). */
const SELLER_BELL_SCROLL =
  "max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent";

/** 24h recency = client-side "new" heuristic: NotificationLog has no read /
 *  seen column (adding fake read-tracking was out of scope), so "within the
 *  last 24h" is the honest approximation of "unread". */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function SellerNotificationBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SellerNotificationsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiGet<SellerNotificationsPayload>("/api/store/notifications");
      setData(d);
      setErrored(false);
    } catch (e) {
      // Silent by design — a failed bell must never break the seller shell:
      // keep the last data (no badge flicker), warn for debugging only.
      setErrored(true);
      console.warn("[seller-bell] notifications fetch failed", e instanceof Error ? e.message : e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Badge freshness without aggressive polling: fetch once on mount (dot only
  // needs recentCount) and refetch whenever the popover opens.
  useEffect(() => {
    void load();
  }, [load]);

  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (v) void load();
  };

  const recent = data?.recentCount ?? 0;
  const rows = data?.notifications ?? null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm hover:border-teal-400 hover:bg-white hover:text-teal-700"
          aria-label="Seller notifications"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {recent > 0 ? (
            <span
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white"
              aria-hidden="true"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-2xl p-0 sm:w-96" role="dialog" aria-label="Seller notifications panel">
        <div className="flex items-center gap-2 border-b border-slate-200/80 px-4 py-3">
          <h2 className="text-sm font-bold text-slate-900">Notifications</h2>
          {recent > 0 ? (
            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 tabular-nums">
              {recent} new
            </span>
          ) : null}
        </div>

        {loading && !rows ? (
          <div className="space-y-3 p-4" aria-label="Loading notifications">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center" aria-label="No notifications">
            <span className="rounded-full bg-muted p-4">
              <Bell className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </span>
            <p className="text-sm font-semibold">{errored && !data ? "Notifications unavailable" : "No notifications yet"}</p>
            <p className="max-w-[16rem] text-xs text-muted-foreground">
              {errored && !data
                ? "Couldn't load right now — it will retry next time you open the bell."
                : "Payout and order updates will appear here."}
            </p>
          </div>
        ) : (
          <ul className={cn("divide-y divide-slate-100", SELLER_BELL_SCROLL)} aria-label="Notification list">
            {rows.map((n) => {
              const isNew = Date.now() - new Date(n.createdAt).getTime() < RECENT_WINDOW_MS;
              return (
                <li key={n.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium" title={n.subject}>
                      {n.subject}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      <span title={new Date(n.createdAt).toLocaleString("en-MY")}>{ageOf(n.createdAt)}</span>
                      <span aria-hidden="true"> · </span>
                      <span className="lowercase">{n.event}</span>
                    </p>
                  </div>
                  {isNew ? (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" role="img" aria-label="Recent" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- side nav

/** Total unread shopper messages — powers the "Messages" nav badge. */
function useSellerChatUnread(active: SellerNav["view"]) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      apiGet<{ total: number }>("/api/store/chat/unread")
        .then((d) => alive && setUnread(d.total ?? 0))
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [active]);
  // instant re-sync when a thread is read inside the messages view (the view
  // dispatches "nomofee:chat-sync" instead of prop-drilling a callback)
  useEffect(() => {
    const sync = () =>
      apiGet<{ total: number }>("/api/store/chat/unread")
        .then((d) => setUnread(d.total ?? 0))
        .catch(() => {});
    window.addEventListener("nomofee:chat-sync", sync);
    return () => window.removeEventListener("nomofee:chat-sync", sync);
  }, []);
  return unread;
}

function SideNav({
  active,
  onNavigate,
  className,
}: {
  active: SellerNav["view"];
  onNavigate: (n: SellerNav) => void;
  className?: string;
}) {
  const unreadChats = useSellerChatUnread(active);
  return (
    <nav className={cn("flex flex-col gap-0.5", className)} aria-label="Seller navigation">
      {NAV.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => onNavigate({ view: key })}
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "flex min-h-[44px] items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
            active === key
              ? "bg-brand-gradient font-semibold text-white shadow-glow-cyan-sm"
              : "font-medium text-slate-500 hover:bg-teal-50/70 hover:text-teal-800"
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 text-left">{label}</span>
          {key === "messages" && unreadChats > 0 ? (
            <span
              className={cn(
                "flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-extrabold",
                active === key ? "bg-white/25 text-white" : "bg-amber-500 text-white shadow"
              )}
              aria-label={`${unreadChats} unread messages`}
            >
              {unreadChats > 99 ? "99+" : unreadChats}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------- pending review

function PendingReview({ onLogout }: { onLogout: () => void }) {
  const refreshMe = useApp((s) => s.refreshMe);
  const me = useApp((s) => s.me);
  const seller = me.loaded && "seller" in me ? me.seller : null;
  const setSurface = useApp((s) => s.setSurface);
  const setActiveStoreSlug = useApp((s) => s.setActiveStoreSlug);
  const [storeMe, setStoreMe] = useState<StoreMe | null>(null);

  useEffect(() => {
    let alive = true;
    apiGet<StoreMe>("/api/store/me")
      .then((d) => alive && setStoreMe(d))
      .catch(() => {});
    const t = setInterval(async () => {
      try {
        const d = await apiGet<StoreMe>("/api/store/me");
        if (!alive) return;
        setStoreMe(d);
        if (d.seller.status !== "pending_review") await refreshMe();
      } catch {
        /* ignore */
      }
    }, 20000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshMe]);

  const checks = [
    { label: "Identity & KYC documents", done: storeMe?.onboarding.checklist.kyc ?? false },
    { label: "Bank account details", done: storeMe?.onboarding.checklist.bank ?? false },
    { label: "At least one product listed", done: storeMe?.onboarding.checklist.products ?? false },
  ];

  return (
    <div className="flex-1 flex items-start justify-center p-4 sm:p-8">
      <div className="w-full max-w-lg space-y-4">
        <div className="space-y-3 rounded-3xl border border-slate-200/80 bg-card p-6 text-center shadow-soft-card sm:p-8">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
            <Clock3 className="h-7 w-7" />
          </span>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">Your store is under review</h2>
          <p className="text-sm text-slate-500">
            Thanks {seller?.displayName ?? "there"} — our team is verifying your details. This usually takes
            1–2 business days. We&apos;ll email you the moment your store is approved, no action needed.
          </p>
          {storeMe?.seller.submittedAt ? (
            <p className="text-xs text-slate-400">Submitted {fmtDateTime(storeMe.seller.submittedAt)}</p>
          ) : null}
          <div className="flex justify-center gap-2 pt-1">
            <StatusChip status="pending_review" />
            <StatusChip status={storeMe?.seller.kycStatus ?? "pending"} />
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200/80 bg-card p-5 shadow-soft-card">
          <p className="text-sm font-bold text-slate-900">What we verify</p>
          <ul className="mt-3 space-y-2.5">
            {checks.map((c) => (
              <li key={c.label} className="flex items-center gap-2.5 text-sm">
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full border",
                    c.done ? "border-emerald-200 bg-emerald-50 text-emerald-600" : "border-dashed border-slate-300 text-slate-400"
                  )}
                >
                  {c.done ? <BadgeCheck className="h-3.5 w-3.5" /> : <Clock3 className="h-3 w-3" />}
                </span>
                <span className={c.done ? "text-slate-700" : "text-slate-400"}>{c.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-400">
            While you wait you can keep editing products, pages and settings — everything goes live on approval.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button
            variant="outline"
            onClick={() => {
              setActiveStoreSlug(seller?.storeSlug ?? null);
              setSurface("shopper");
            }}
            className="gap-2"
          >
            <ExternalLink className="h-4 w-4" /> Preview my storefront
          </Button>
          <Button variant="ghost" onClick={onLogout} className="gap-2 text-muted-foreground">
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground">This page refreshes automatically every 20 seconds.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- auth screen

function AuthScreen({ onAuthed }: { onAuthed: () => Promise<void> }) {
  const setSurface = useApp((s) => s.setSurface);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [reg, setReg] = useState({ fullName: "", displayName: "", email: "", password: "", phone: "", storeName: "" });

  // ADDENDUM #8 — the pre-auth screen renders LIVE platform terms (commission
  // %, hold days, moderation window) from the public /api/platform/terms
  // endpoint, so admin changes reflect on the landing + registration copy
  // automatically. Failure keeps the graceful generic wording.
  const [publicTerms, setPublicTerms] = useState<PlatformTerms | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<PlatformTerms>("/api/platform/terms")
      .then((d) => {
        if (alive) setPublicTerms(d);
      })
      .catch(() => {
        /* keep graceful generic copy — the pre-auth screen must never break */
      });
    return () => {
      alive = false;
    };
  }, []);

  const goMarket = () => setSurface("shopper");

  const login = async () => {
    if (!loginEmail || !loginPassword) {
      toast.error("Enter your email and password");
      return;
    }
    setBusy(true);
    const ok = await runMutation(async () => {
      const body = await apiSend<{ token?: string }>("POST", "/api/auth/login", {
        email: loginEmail,
        password: loginPassword,
        portal: "seller",
      });
      setSessionToken(body?.token); // localStorage bridge for cookie-less contexts
    }, "Welcome back!");
    setBusy(false);
    if (ok) await onAuthed();
  };

  const register = async () => {
    if (!reg.fullName.trim() || !reg.email.includes("@") || reg.password.length < 8) {
      toast.error("Name, valid email and a password of at least 8 characters are required");
      return;
    }
    setBusy(true);
    const ok = await runMutation(async () => {
      const body = await apiSend<{ token?: string }>("POST", "/api/auth/register", reg);
      setSessionToken(body?.token); // localStorage bridge for cookie-less contexts
    }, "Store created — let's set it up!");
    setBusy(false);
    if (ok) await onAuthed();
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* top chrome — the portal is reachable from the buyer hub (“Start Selling” /
          “Open store”), so there is always a visible way back to the marketplace */}
      <header className="border-b border-slate-200/80 bg-white/80 px-4 py-2.5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
          <button
            type="button"
            onClick={goMarket}
            className="flex min-h-[44px] items-center gap-2.5"
            aria-label="NOMOFEE — back to the marketplace"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-glow-cyan-sm">
              <ShoppingBag className="h-4 w-4" />
            </span>
            <span className="text-lg font-extrabold tracking-tight text-slate-900">
              NOMO<span className="text-brand-gradient">FEE</span>{" "}
              <span className="text-sm font-semibold text-slate-400">Seller Portal</span>
            </span>
          </button>
          <Button variant="outline" size="sm" onClick={goMarket} className="ml-auto min-h-[40px] gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back to marketplace</span>
            <span className="sm:hidden">Back</span>
          </Button>
        </div>
      </header>

      <div className="flex-1 grid lg:grid-cols-2 min-h-0">
      {/* brand panel */}
      <div className="relative hidden overflow-hidden bg-brand-gradient text-white lg:flex flex-col justify-between p-10">
        <span aria-hidden="true" className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-24 -left-16 h-56 w-56 rounded-full bg-white/10 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15">
            <ShoppingBag className="h-5 w-5" />
          </span>
          <span className="text-lg font-bold tracking-tight">NOMO<span className="text-white/70">FEE</span></span>
        </div>
        <div className="relative max-w-md space-y-5">
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight">
            Sell on your own storefront — and the marketplace.
          </h1>
          <p className="text-sm leading-relaxed text-white/80">
            Spin up a hosted store in minutes: page builder, orders, wallet with transparent commission,
            payouts, custom domains and webhooks. One portal for everything.
          </p>
          <ul className="space-y-2.5 text-sm">
            {[
              "Drag-and-drop page builder with 15 section types",
              "Ledger-true wallet: pending → available → payouts",
              publicTerms
                ? `Flat ${fmtCommissionPercent(publicTerms.commissionPercent)} platform commission, no hidden fees`
                : "Transparent platform commission, no hidden fees",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <BadgeCheck className="h-4 w-4 shrink-0 text-white/90" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/60">Demo environment · data resets with the seed</p>
      </div>

      {/* forms */}
      <div className="flex items-center justify-center p-4 sm:p-8 overflow-y-auto">
        <div className="w-full max-w-md space-y-5 rounded-3xl border border-slate-200/80 bg-card p-5 shadow-soft-card sm:p-7">
          <div className="lg:hidden flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-glow-cyan-sm">
              <ShoppingBag className="h-4 w-4" />
            </span>
            <span className="font-bold text-slate-900">NOMO<span className="text-teal-600">FEE</span></span>
          </div>

          <Tabs defaultValue="login">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Log in</TabsTrigger>
              <TabsTrigger value="register">Create free store</TabsTrigger>
            </TabsList>

            <TabsContent value="login" className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="seller-login-email">Email</Label>
                <Input
                  id="seller-login-email"
                  type="email"
                  className="min-h-[44px]"
                  placeholder="you@store.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && login()}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seller-login-password">Password</Label>
                <Input
                  id="seller-login-password"
                  type="password"
                  className="min-h-[44px]"
                  placeholder="••••••••"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && login()}
                />
              </div>
              <Button className="w-full min-h-[44px] bg-brand-gradient-deep text-white shadow-glow-cyan-sm hover:brightness-105" onClick={login} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Log in to seller portal"}
              </Button>
              <div className="space-y-1.5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3 text-xs">
                <p className="flex items-center gap-1.5 font-medium">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" /> Sandbox demo accounts
                </p>
                <p className="text-muted-foreground">lumina@nomofee.io — active store, full dashboard</p>
                <p className="text-muted-foreground">trail@nomofee.io — onboarding wizard demo</p>
                <p className="text-muted-foreground">warung@nomofee.io — pending review screen</p>
                {/* F-19/F-12 remediation: the shared demo password and one-click
                    credential fill were removed from the client bundle. Seeded
                    credentials are documented SERVER-side only (prisma/seed.ts
                    + .env.example overrides). */}
              </div>
            </TabsContent>

            <TabsContent value="register" className="mt-4 space-y-3.5">
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-full">Full name *</Label>
                  <Input id="reg-full" className="min-h-[44px]" value={reg.fullName} onChange={(e) => setReg({ ...reg, fullName: e.target.value })} placeholder="Sofia Lim" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-disp">Display name</Label>
                  <Input id="reg-disp" className="min-h-[44px]" value={reg.displayName} onChange={(e) => setReg({ ...reg, displayName: e.target.value })} placeholder="Sofia" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-email">Email *</Label>
                <Input id="reg-email" type="email" className="min-h-[44px]" value={reg.email} onChange={(e) => setReg({ ...reg, email: e.target.value })} placeholder="you@store.com" />
              </div>
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-pass">Password * (min 8)</Label>
                  <Input id="reg-pass" type="password" className="min-h-[44px]" value={reg.password} onChange={(e) => setReg({ ...reg, password: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-phone">Phone</Label>
                  <Input id="reg-phone" className="min-h-[44px]" value={reg.phone} onChange={(e) => setReg({ ...reg, phone: e.target.value })} placeholder="60123456789" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-store">Store name *</Label>
                <Input id="reg-store" className="min-h-[44px]" value={reg.storeName} onChange={(e) => setReg({ ...reg, storeName: e.target.value })} placeholder="Lumina Living" />
              </div>
              <Button className="w-full min-h-[44px] bg-brand-gradient-deep text-white shadow-glow-cyan-sm hover:brightness-105" onClick={register} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create my free store"}
              </Button>
              <p className="text-center text-xs text-slate-400">
                Free forever plan ·{" "}
                {publicTerms
                  ? publicTerms.moderationFirstN > 0
                    ? `first ${publicTerms.moderationFirstN} products go through a quick review`
                    : "your products go live instantly"
                  : "new products go through a quick review"}
              </p>
            </TabsContent>
          </Tabs>

          <Alert>
            <AlertDescription className="text-xs">
              By continuing you agree to the NOMOFEE seller terms:{" "}
              {publicTerms ? `${fmtCommissionPercent(publicTerms.commissionPercent)} platform commission` : "platform commission"} on paid
              orders, payouts to a Malaysian bank account after{" "}
              {publicTerms && publicTerms.holdDays > 0 ? `a ${publicTerms.holdDays}-day hold` : "the clearing hold"}.
            </AlertDescription>
          </Alert>
        </div>
      </div>
      </div>
    </div>
  );
}

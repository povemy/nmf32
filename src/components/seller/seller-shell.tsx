"use client";
// Task 2-d — Seller surface shell: auth gate → status router → dashboard layout.
// Status machine: no session → auth screen; onboarding/rejected → wizard;
// pending_review → review screen (polls); active → full seller dashboard.
import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useApp } from "@/lib/app-store";
import { setSessionToken } from "@/lib/session-client";
import { cn } from "@/lib/utils";
import {
  apiGet,
  apiSend,
  runMutation,
  StoreMe,
  SellerNav,
  StatusChip,
  fmtDateTime,
} from "./ui-bits";
import OnboardingWizard from "./onboarding";
import SellerDashboard from "./dashboard";
import SellerProducts from "./products";
import SellerOrders from "./orders";
import SellerMessages from "./messages";
import SellerWallet from "./wallet";
import PageBuilder from "./builder";
import SellerDomains from "./domains";
import SellerCoupons from "./marketing";
import SellerIntegrations from "./integrations";
import SellerSettings from "./settings";
import SellerImports from "./imports";
import SellerSeo from "./seo";
import { Toaster } from "@/components/ui/sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BadgeCheck,
  Blocks,
  Clock3,
  DatabaseZap,
  ExternalLink,
  Globe,
  LayoutDashboard,
  LayoutTemplate,
  Loader2,
  LogOut,
  Menu,
  MessagesSquare,
  Package,
  Search,
  Settings,
  ShieldAlert,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  TicketPercent,
  Wallet,
} from "lucide-react";

const NAV: { key: SellerNav["view"]; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "imports", label: "Imports & Publish", icon: DatabaseZap },
  { key: "products", label: "Products", icon: Package },
  { key: "orders", label: "Orders", icon: ShoppingCart },
  { key: "messages", label: "Messages", icon: MessagesSquare },
  { key: "seo", label: "SEO", icon: Search },
  { key: "wallet", label: "Wallet & Payouts", icon: Wallet },
  { key: "builder", label: "Page Builder", icon: LayoutTemplate },
  { key: "domains", label: "Domains", icon: Globe },
  { key: "coupons", label: "Coupons", icon: TicketPercent },
  { key: "integrations", label: "Integrations", icon: Blocks },
  { key: "settings", label: "Store Settings", icon: Settings },
];

export default function SellerShell() {
  const me = useApp((s) => s.me);
  const refreshMe = useApp((s) => s.refreshMe);
  const [nav, setNav] = useState<SellerNav>({ view: "dashboard" });
  const [storeMe, setStoreMe] = useState<StoreMe | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const seller = me.loaded && "seller" in me ? me.seller : null;
  const sellerId = seller?.id ?? null;

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
    return (
      <>
        <AuthScreen onAuthed={refreshMe} />
        <Toaster position="bottom-right" richColors closeButton />
      </>
    );
  }

  const status = seller.status;

  if (status === "suspended" || status === "terminated") {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full space-y-4 text-center rounded-2xl border bg-card p-8">
          <ShieldAlert className="mx-auto h-10 w-10 text-rose-500" />
          <h2 className="text-lg font-semibold capitalize">Store {status}</h2>
          <p className="text-sm text-muted-foreground">
            This store is not currently trading. Contact SHOPMESH support if you believe this is a mistake.
          </p>
          <Button variant="outline" onClick={logout} className="gap-2">
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </div>
    );
  }

  if (status === "onboarding" || status === "rejected") {
    return (
      <>
        <OnboardingWizard onStatusChanged={refreshMe} />
        <Toaster position="bottom-right" richColors closeButton />
      </>
    );
  }

  if (status === "pending_review") {
    return (
      <>
        <PendingReview onLogout={logout} />
        <Toaster position="bottom-right" richColors closeButton />
      </>
    );
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
      <Toaster position="bottom-right" richColors closeButton />
      {/* desktop sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r bg-card/50 print:hidden">
        <div className="flex items-center gap-2.5 px-4 py-4 border-b">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShoppingBag className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{storeName}</p>
            <p className="truncate text-xs text-muted-foreground">/{storeSlug}</p>
          </div>
        </div>
        <SideNav active={nav.view} onNavigate={navigate} className="flex-1 overflow-y-auto p-2" />
        <div className="border-t p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Store status</span>
            <StatusChip status={storeMe?.store.status ?? "live"} />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Plan</span>
            <span className="font-medium capitalize text-foreground">{storeMe?.seller.planCode ?? "free"}</span>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* top bar */}
        <header className="flex items-center gap-3 border-b bg-background/95 px-4 py-3 print:hidden">
          {/* brand gradient strip */}
          <div className="fixed inset-x-0 top-0 z-50 h-1 bg-brand-gradient print:hidden" aria-hidden="true" />
          {/* mobile nav trigger */}
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="md:hidden" aria-label="Open navigation">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetHeader className="border-b px-4 py-3">
                <SheetTitle className="text-left text-sm">{storeName}</SheetTitle>
              </SheetHeader>
              <SideNav active={nav.view} onNavigate={navigate} className="p-2" />
            </SheetContent>
          </Sheet>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold capitalize">
              {NAV.find((n) => n.key === nav.view)?.label ?? "Dashboard"}
            </h1>
            <p className="hidden sm:block text-xs text-muted-foreground">
              Seller portal · {seller.displayName} ({seller.email})
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={openStorefront} className="gap-1.5">
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">View storefront</span>
            <span className="sm:hidden">Store</span>
          </Button>
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
            {nav.view === "imports" && <SellerImports onNavigate={navigate} />}
            {nav.view === "products" && <SellerProducts focusProductId={nav.productId} onNavigate={navigate} />}
            {nav.view === "orders" && <SellerOrders focusOrderId={nav.orderId} onNavigate={navigate} />}
            {nav.view === "messages" && <SellerMessages onNavigate={navigate} />}
            {nav.view === "wallet" && <SellerWallet focusActivityId={nav.activityId} onNavigate={navigate} />}
            {nav.view === "builder" && (
              <PageBuilder
                pageId={nav.pageId}
                onNavigate={navigate}
                storeSlug={storeSlug}
                storeName={storeName}
              />
            )}
            {nav.view === "domains" && <SellerDomains storeSlug={storeSlug} />}
            {nav.view === "coupons" && <SellerCoupons />}
            {nav.view === "seo" && <SellerSeo onNavigate={navigate} />}
            {nav.view === "integrations" && <SellerIntegrations />}
            {nav.view === "settings" && <SellerSettings onNavigate={navigate} storeMe={storeMe} refreshStoreMe={refreshStoreMe} />}
          </motion.div>
        </main>
      </div>
    </div>
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
            "flex min-h-[44px] items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            active === key
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 text-left">{label}</span>
          {key === "messages" && unreadChats > 0 ? (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-extrabold text-white shadow" aria-label={`${unreadChats} unread messages`}>
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
        <div className="rounded-2xl border bg-card p-6 sm:p-8 text-center space-y-3">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <Clock3 className="h-7 w-7" />
          </span>
          <h2 className="text-xl font-semibold">Your store is under review</h2>
          <p className="text-sm text-muted-foreground">
            Thanks {seller?.displayName ?? "there"} — our team is verifying your details. This usually takes
            1–2 business days. We&apos;ll email you the moment your store is approved, no action needed.
          </p>
          {storeMe?.seller.submittedAt ? (
            <p className="text-xs text-muted-foreground">Submitted {fmtDateTime(storeMe.seller.submittedAt)}</p>
          ) : null}
          <div className="flex justify-center gap-2 pt-1">
            <StatusChip status="pending_review" />
            <StatusChip status={storeMe?.seller.kycStatus ?? "pending"} />
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-5">
          <p className="text-sm font-semibold">What we verify</p>
          <ul className="mt-3 space-y-2.5">
            {checks.map((c) => (
              <li key={c.label} className="flex items-center gap-2.5 text-sm">
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full border",
                    c.done ? "border-emerald-300 bg-emerald-100 text-emerald-700" : "border-dashed text-muted-foreground"
                  )}
                >
                  {c.done ? <BadgeCheck className="h-3.5 w-3.5" /> : <Clock3 className="h-3 w-3" />}
                </span>
                <span className={c.done ? "" : "text-muted-foreground"}>{c.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
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
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [reg, setReg] = useState({ fullName: "", displayName: "", email: "", password: "", phone: "", storeName: "" });

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
    <div className="flex-1 grid lg:grid-cols-2 min-h-0">
      {/* brand panel */}
      <div className="relative hidden lg:flex flex-col justify-between p-10 bg-primary text-primary-foreground">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-foreground/15">
            <ShoppingBag className="h-5 w-5" />
          </span>
          <span className="text-lg font-bold tracking-tight">SHOPMESH</span>
        </div>
        <div className="max-w-md space-y-5">
          <h1 className="text-3xl font-bold leading-tight">
            Sell on your own storefront — and the marketplace.
          </h1>
          <p className="text-primary-foreground/80 text-sm leading-relaxed">
            Spin up a hosted store in minutes: page builder, orders, wallet with transparent commission,
            payouts, custom domains and webhooks. One portal for everything.
          </p>
          <ul className="space-y-2.5 text-sm">
            {[
              "Drag-and-drop page builder with 15 section types",
              "Ledger-true wallet: pending → available → payouts",
              "Flat 8% platform commission, no hidden fees",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <BadgeCheck className="h-4 w-4 shrink-0" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-primary-foreground/60">Demo environment · data resets with the seed</p>
      </div>

      {/* forms */}
      <div className="flex items-center justify-center p-4 sm:p-8 overflow-y-auto">
        <div className="w-full max-w-md space-y-5">
          <div className="lg:hidden flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShoppingBag className="h-4 w-4" />
            </span>
            <span className="font-bold">SHOPMESH</span>
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
                  placeholder="••••••••"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && login()}
                />
              </div>
              <Button className="w-full min-h-[44px]" onClick={login} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Log in to seller portal"}
              </Button>
              <div className="rounded-lg border border-dashed bg-muted/40 p-3 text-xs space-y-1.5">
                <p className="flex items-center gap-1.5 font-medium">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" /> Demo accounts (password Seller123!)
                </p>
                <p className="text-muted-foreground">lumina@shopmesh.io — active store, full dashboard</p>
                <p className="text-muted-foreground">trail@shopmesh.io — onboarding wizard demo</p>
                <p className="text-muted-foreground">warung@shopmesh.io — pending review screen</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1 h-8"
                  onClick={() => {
                    setLoginEmail("lumina@shopmesh.io");
                    setLoginPassword("Seller123!");
                  }}
                >
                  Fill demo credentials
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="register" className="mt-4 space-y-3.5">
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-full">Full name *</Label>
                  <Input id="reg-full" value={reg.fullName} onChange={(e) => setReg({ ...reg, fullName: e.target.value })} placeholder="Sofia Lim" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-disp">Display name</Label>
                  <Input id="reg-disp" value={reg.displayName} onChange={(e) => setReg({ ...reg, displayName: e.target.value })} placeholder="Sofia" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-email">Email *</Label>
                <Input id="reg-email" type="email" value={reg.email} onChange={(e) => setReg({ ...reg, email: e.target.value })} placeholder="you@store.com" />
              </div>
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-pass">Password * (min 8)</Label>
                  <Input id="reg-pass" type="password" value={reg.password} onChange={(e) => setReg({ ...reg, password: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-phone">Phone</Label>
                  <Input id="reg-phone" value={reg.phone} onChange={(e) => setReg({ ...reg, phone: e.target.value })} placeholder="60123456789" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-store">Store name *</Label>
                <Input id="reg-store" value={reg.storeName} onChange={(e) => setReg({ ...reg, storeName: e.target.value })} placeholder="Lumina Living" />
              </div>
              <Button className="w-full min-h-[44px]" onClick={register} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create my free store"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Free forever plan · first 5 products go through a quick review
              </p>
            </TabsContent>
          </Tabs>

          <Alert>
            <AlertDescription className="text-xs">
              By continuing you agree to the SHOPMESH seller terms: 8% platform commission on paid orders,
              payouts to a Malaysian bank account after a 7-day hold.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    </div>
  );
}

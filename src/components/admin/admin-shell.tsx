"use client";
// Admin command centre shell — auth gate, sidebar navigation (PART 4 tree),
// sticky top bar and the view switch. Views are client state (no URLs).
import { useCallback, useMemo, useState, type ComponentType } from "react";
import { toast } from "sonner";
import {
  Activity,
  Banknote,
  BarChart3,
  Bell,
  BookOpen,
  CalendarClock,
  FlaskConical,
  HeartPulse,
  Landmark,
  LayoutDashboard,
  LifeBuoy,
  Loader2,
  LogOut,
  Megaphone,
  Menu,
  PackageSearch,
  Percent,
  RotateCcw,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Star,
  Store,
  Tags,
  Ticket,
  ToggleLeft,
  UserCheck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { setSessionToken } from "@/lib/session-client";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-store";
import { apiSend } from "./use-api";
import type { AdminNav, AdminParams } from "./nav";
import { EmptyState } from "./ui-bits";

// views
import { DashboardView } from "./dashboard";
import { SellersView, KycQueueView } from "./sellers";
import { SellerDetailView } from "./seller-detail";
import { StoresView } from "./stores";
import { ModerationView } from "./moderation";
import { CategoriesView } from "./categories";
import { OrdersView, RefundsView, DisputesView } from "./orders";
import { OrderDetailView } from "./order-detail";
import { CommissionSettingsView, SimulatorView } from "./commission";
import { OverridesView, FeeHolidaysView } from "./finance";
import { WalletsView, LedgerView } from "./wallets-ledger";
import { PayoutsView, PayoutDetailView } from "./payouts";
import { BanksView } from "./banks";
import { BannersView, FeaturedView, CouponsView } from "./marketing";
import { SupportView } from "./support";
import { ReportsView } from "./reports";
import { SettingsView, FlagsView, AuditView, ActivityView, NotificationsView, HealthView } from "./system";

/* ------------------------------------------------------------ nav tree */

type NavItem = { view: string; label: string; icon: LucideIcon };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  { label: "", items: [{ view: "dashboard", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "Sellers",
    items: [
      { view: "sellers", label: "All Sellers", icon: Users },
      { view: "kyc-queue", label: "KYC Queue", icon: UserCheck },
    ],
  },
  { label: "Stores", items: [{ view: "stores", label: "Stores & Domains", icon: Store }] },
  {
    label: "Catalog",
    items: [
      { view: "moderation", label: "Product Moderation", icon: PackageSearch },
      { view: "categories", label: "Categories", icon: Tags },
    ],
  },
  {
    label: "Orders",
    items: [
      { view: "orders", label: "All Orders", icon: ShoppingCart },
      { view: "refunds", label: "Refunds", icon: RotateCcw },
      { view: "disputes", label: "Disputes", icon: Scale },
    ],
  },
  {
    label: "Finance",
    items: [
      { view: "commission", label: "Commission", icon: Percent },
      { view: "overrides", label: "Overrides", icon: SlidersHorizontal },
      { view: "holidays", label: "Fee Holidays", icon: CalendarClock },
      { view: "simulator", label: "Simulator", icon: FlaskConical },
      { view: "wallets", label: "Wallets", icon: Wallet },
      { view: "ledger", label: "Ledger Explorer", icon: BookOpen },
      { view: "payouts", label: "Payout Batches", icon: Banknote },
      { view: "banks", label: "Bank Verification", icon: Landmark },
    ],
  },
  {
    label: "Marketing",
    items: [
      { view: "banners", label: "Banners", icon: Megaphone },
      { view: "featured", label: "Featured", icon: Star },
      { view: "coupons", label: "Coupons", icon: Ticket },
    ],
  },
  { label: "Support", items: [{ view: "tickets", label: "Tickets", icon: LifeBuoy }] },
  { label: "Reports", items: [{ view: "reports", label: "Reports & Exports", icon: BarChart3 }] },
  {
    label: "System",
    items: [
      { view: "settings", label: "Settings", icon: Settings },
      { view: "flags", label: "Feature Flags", icon: ToggleLeft },
      { view: "audit", label: "Audit Log", icon: ScrollText },
      { view: "activity", label: "Activity Log", icon: Activity },
      { view: "notifications", label: "Notifications", icon: Bell },
      { view: "health", label: "System Health", icon: HeartPulse },
    ],
  },
];

const VIEW_TITLES: Record<string, string> = {
  ...Object.fromEntries(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.view, i.label]))),
  "seller-detail": "Seller Detail",
  "order-detail": "Order Detail",
  "payout-detail": "Payout Batch",
};

const VIEW_MAP: Record<string, ComponentType<{ nav: AdminNav }>> = {
  dashboard: DashboardView,
  sellers: SellersView,
  "kyc-queue": KycQueueView,
  stores: StoresView,
  moderation: ModerationView,
  categories: CategoriesView,
  orders: OrdersView,
  refunds: RefundsView,
  disputes: DisputesView,
  commission: CommissionSettingsView,
  overrides: OverridesView,
  holidays: FeeHolidaysView,
  simulator: SimulatorView,
  wallets: WalletsView,
  ledger: LedgerView,
  payouts: PayoutsView,
  banks: BanksView,
  banners: BannersView,
  featured: FeaturedView,
  coupons: CouponsView,
  tickets: SupportView,
  reports: ReportsView,
  settings: SettingsView,
  flags: FlagsView,
  audit: AuditView,
  activity: ActivityView,
  notifications: NotificationsView,
  health: HealthView,
};

/* -------------------------------------------------------------- shell */

export default function AdminShell() {
  const me = useApp((s) => s.me);
  const refreshMe = useApp((s) => s.refreshMe);

  const [view, setView] = useState("dashboard");
  const [params, setParams] = useState<AdminParams>({});

  const navigate = useCallback((v: string, p?: AdminParams) => {
    setView(v);
    setParams(p ?? {});
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const nav: AdminNav = useMemo(() => ({ view, params, navigate }), [view, params, navigate]);

  if (!me.loaded) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Loading command centre…</p>
        </div>
      </div>
    );
  }

  if (!me.admin) {
    return <LoginCard onLogin={() => void refreshMe()} />;
  }

  const title = VIEW_TITLES[view] ?? "Command Centre";

  return (
    <div className="flex min-h-screen w-full">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 border-r bg-card/40 lg:block">
        <SidebarContent nav={nav} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* top bar */}
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="h-1 w-full bg-brand-gradient" aria-hidden="true" />
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <MobileNav nav={nav} />
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight sm:text-base">{title}</h1>
            <AdminMenu admin={me.admin} />
          </div>
        </header>

        {/* view switch */}
        <main className="flex-1 space-y-4 p-4 pb-28 sm:p-6 sm:pb-28">
          {view === "seller-detail" ? (
            params.sellerId ? (
              <SellerDetailView nav={nav} sellerId={params.sellerId} />
            ) : (
              <MissingRef
                message="No seller selected — open one from the sellers list."
                actionLabel="Go to sellers"
                onAction={() => navigate("sellers")}
              />
            )
          ) : view === "order-detail" ? (
            params.orderId ? (
              <OrderDetailView nav={nav} orderId={params.orderId} />
            ) : (
              <MissingRef
                message="No order selected — open one from the orders list."
                actionLabel="Go to orders"
                onAction={() => navigate("orders")}
              />
            )
          ) : view === "payout-detail" ? (
            params.batchId ? (
              <PayoutDetailView nav={nav} batchId={params.batchId} />
            ) : (
              <MissingRef
                message="No payout batch selected — open one from the batches list."
                actionLabel="Go to payout batches"
                onAction={() => navigate("payouts")}
              />
            )
          ) : (
            (() => {
              const Active = VIEW_MAP[view] ?? DashboardView;
              return <Active nav={nav} />;
            })()
          )}
        </main>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- sidebar */

function SidebarContent({ nav, onNavigate }: { nav: AdminNav; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b px-4 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <ShieldCheck className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold tracking-tight">SHOPMESH</p>
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Command Centre</p>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 border-amber-200 bg-amber-50 text-[10px] font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
        >
          DEMO
        </Badge>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 [scrollbar-width:thin] [scrollbar-color:rgba(20,184,166,0.4)_transparent] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/30 [&::-webkit-scrollbar]:w-1.5" aria-label="Admin navigation">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label || `g${gi}`} className="mb-2">
            {group.label ? (
              <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{group.label}</p>
            ) : null}
            {group.items.map((item) => {
              const active = nav.view === item.view;
              const Icon = item.icon;
              return (
                <button
                  key={item.view}
                  onClick={() => {
                    nav.navigate(item.view);
                    onNavigate?.();
                  }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-[40px] w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground/80")} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t px-4 py-3">
        <p className="text-[10px] leading-tight text-muted-foreground">
          PART 4 wireframes · SHOPMESH v1
          <br />
          All actions are audited.
        </p>
      </div>
    </div>
  );
}

function MobileNav({ nav }: { nav: AdminNav }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        className="-ml-2 h-10 w-10 lg:hidden"
        aria-label="Open navigation menu"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-5 w-5" />
      </Button>
      <SheetContent side="left" className="w-64 p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Admin navigation</SheetTitle>
          <SheetDescription>Navigate between command centre views</SheetDescription>
        </SheetHeader>
        <SidebarContent nav={nav} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------- top bar */

function AdminMenu({ admin }: { admin: { id: string; email: string; name: string; role: string } }) {
  const refreshMe = useApp((s) => s.refreshMe);
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    try {
      await apiSend("/api/auth/logout", "POST");
      toast.success("Signed out", { description: "Session ended — see you soon." });
      await refreshMe();
    } catch (e) {
      toast.error("Logout failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const initials = (admin.name || admin.email || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex min-h-[44px] items-center gap-2 rounded-full pl-1 pr-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
          aria-label="Account menu"
        >
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-teal-600/10 text-xs font-semibold text-teal-700 dark:text-teal-300">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="hidden max-w-[140px] truncate text-sm font-medium sm:block">{admin.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <p className="truncate text-sm font-semibold">{admin.name}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{admin.email}</p>
          <Badge variant="outline" className="mt-1.5 capitalize">
            {admin.role.replace(/_/g, " ")}
          </Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={() => void logout()} className="text-red-600 focus:text-red-600">
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* --------------------------------------------------------------- login */

const DEMO_ACCOUNTS: { role: string; email: string; password: string }[] = [
  { role: "Superadmin", email: "admin@shopmesh.io", password: "Admin123!" },
  { role: "Ops", email: "ops@shopmesh.io", password: "Ops12345!" },
  { role: "Finance", email: "finance@shopmesh.io", password: "Finance123!" },
  { role: "Moderator", email: "moderator@shopmesh.io", password: "Mod12345!" },
];

function LoginCard({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fill = (a: (typeof DEMO_ACCOUNTS)[number]) => {
    setEmail(a.email);
    setPassword(a.password);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = await apiSend<{ userType?: string; token?: string; admin?: { name?: string } | null }>("/api/auth/login", "POST", {
        email: email.trim(),
        password,
        portal: "admin",
      });
      setSessionToken(body?.token); // localStorage bridge for cookie-less contexts
      if (body?.userType !== "admin") {
        setError("This account cannot access the admin command centre.");
        setBusy(false);
        return;
      }
      toast.success(`Welcome back, ${body.admin?.name ?? "admin"}`);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed — check your credentials.");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div>
            <p className="text-xl font-bold tracking-tight">SHOPMESH</p>
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Command Centre</p>
          </div>
        </div>

        <Card className="py-0">
          <CardContent className="p-6">
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="admin-email">Email</Label>
                <Input
                  id="admin-email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@shopmesh.io"
                  className="min-h-[44px]"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="admin-password">Password</Label>
                <Input
                  id="admin-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="min-h-[44px]"
                  required
                />
              </div>
              {error ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="min-h-[44px] w-full" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in to command centre"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="rounded-xl border bg-muted/40 p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Demo accounts — one-click fill</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                onClick={() => fill(a)}
                className="rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-teal-300 hover:bg-teal-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:hover:border-teal-800 dark:hover:bg-teal-950/30"
              >
                <p className="text-xs font-semibold">{a.role}</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">{a.email}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- misc bits */

function MissingRef({ message, actionLabel, onAction }: { message: string; actionLabel: string; onAction: () => void }) {
  return (
    <Card className="py-0">
      <CardContent className="p-4">
        <EmptyState title="Nothing selected" hint={message} />
        <div className="flex justify-center pb-4">
          <Button variant="outline" onClick={onAction} className="min-h-[44px]">
            {actionLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

"use client";
// Admin command centre shell — auth gate, sidebar navigation (PART 4 tree),
// sticky top bar and the view switch. Views are client state (no URLs).
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { toast } from "sonner";
import {
  Activity,
  Banknote,
  BarChart3,
  Bell,
  BookOpen,
  CalendarClock,
  ChevronDown,
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
  PartyPopper,
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { UnifiedAuthPanel, type UnifiedUserType } from "@/components/auth/unified-auth-panel";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-store";
import type { AdminNav, AdminParams } from "./nav";
import { EmptyState } from "./ui-bits";
import { roleHasAnyCap, type AdminCap } from "@/lib/admin-caps";

// views
import { DashboardView } from "./dashboard";
import { SellersView, KycQueueView } from "./sellers";
import { SellerDetailView } from "./seller-detail";
import { StoresView } from "./stores";
import { ModerationView } from "./moderation";
import { CategoriesView } from "./categories";
import { OrdersView, RefundsView, DisputesView } from "./orders";
import { OrderDetailView } from "./order-detail";
import { CommissionView, SimulatorView } from "./commission";
import { OverridesView, FeeHolidaysView } from "./finance";
import {
  AffiliateAccountsView,
  AffiliateCommissionsView,
  AffiliateOverviewView,
  AffiliatePayoutsView,
  AffiliateReconciliationView,
} from "./affiliate";
import { WalletsView, LedgerView } from "./wallets-ledger";
import { PayoutsView, PayoutDetailView } from "./payouts";
import { BanksView } from "./banks";
import { BannersView, CampaignsView, FeaturedView, CouponsView } from "./marketing";
import { SupportView } from "./support";
import { ReportsView } from "./reports";
import { SettingsView, AuditView, ActivityView, NotificationsView, HealthView } from "./system";

/* ------------------------------------------------------------ nav tree */

type NavItem = { view: string; label: string; icon: LucideIcon; caps?: AdminCap[] };
type NavGroup = { label: string; items: NavItem[] };

// Phase 3 UI/API consistency: navigation visibility mirrors the SERVER route
// guards via the SAME capability matrix (src/lib/admin-caps.ts — the module
// lib/auth.ts requireCap enforces). `caps` = ANY-of; omitted = every admin
// role (requireAdmin surface). The server remains the enforcement boundary —
// this only stops the UI from offering surfaces a role cannot use.
const NAV_GROUPS: NavGroup[] = [
  { label: "", items: [{ view: "dashboard", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "Sellers",
    items: [
      { view: "sellers", label: "All Sellers", icon: Users },
      { view: "kyc-queue", label: "KYC Queue", icon: UserCheck, caps: ["sellers.approve"] },
    ],
  },
  { label: "Stores", items: [{ view: "stores", label: "Stores & Domains", icon: Store }] },
  {
    label: "Catalog",
    items: [
      { view: "moderation", label: "Product Moderation", icon: PackageSearch, caps: ["products.moderate"] },
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
      { view: "commission", label: "Commission", icon: Percent, caps: ["commission.manage"] },
      { view: "overrides", label: "Overrides", icon: SlidersHorizontal, caps: ["commission.manage"] },
      { view: "holidays", label: "Fee Holidays", icon: CalendarClock, caps: ["commission.manage"] },
      { view: "simulator", label: "Simulator", icon: FlaskConical },
      { view: "wallets", label: "Wallets", icon: Wallet },
      { view: "ledger", label: "Ledger Explorer", icon: BookOpen },
      { view: "payouts", label: "Payout Batches", icon: Banknote },
      { view: "banks", label: "Bank Verification", icon: Landmark, caps: ["sellers.approve", "payouts.manage"] },
    ],
  },
  {
    // Task 2-B affiliate console. Nav caps mirror the SERVER route guards via
    // the same matrix (nav.ts contract — UI == API): overview + commissions
    // are requireAnyCap(affiliate.manage, affiliate.finance); accounts is
    // affiliate.manage ONLY and payouts + reconciliation are affiliate.finance
    // ONLY on the server (lib/auth.ts), so their nav entries gate identically.
    label: "Affiliate",
    items: [
      { view: "affiliate-overview", label: "Programme", icon: Megaphone, caps: ["affiliate.manage", "affiliate.finance"] },
      { view: "affiliate-accounts", label: "Accounts", icon: Users, caps: ["affiliate.manage"] },
      { view: "affiliate-commissions", label: "Commissions", icon: ScrollText, caps: ["affiliate.manage", "affiliate.finance"] },
      { view: "affiliate-payouts", label: "Payouts", icon: Banknote, caps: ["affiliate.finance"] },
      { view: "affiliate-reconciliation", label: "Reconciliation", icon: Scale, caps: ["affiliate.finance"] },
    ],
  },
  {
    label: "Marketing",
    items: [
      { view: "banners", label: "Banners", icon: Megaphone },
      { view: "campaigns", label: "Campaigns", icon: PartyPopper, caps: ["campaigns.manage"] },
      { view: "featured", label: "Featured", icon: Star },
      { view: "coupons", label: "Coupons", icon: Ticket, caps: ["campaigns.manage"] },
    ],
  },
  { label: "Support", items: [{ view: "tickets", label: "Tickets", icon: LifeBuoy }] },
  { label: "Reports", items: [{ view: "reports", label: "Reports & Exports", icon: BarChart3 }] },
  {
    label: "System",
    items: [
      { view: "settings", label: "Settings", icon: Settings, caps: ["settings.manage"] },
      // F-07: "Feature Flags" nav entry removed with its dead page (no runtime
      // consumer ever read the FeatureFlag table; see system.tsx note).
      { view: "audit", label: "Audit Log", icon: ScrollText, caps: ["logs.view"] },
      { view: "activity", label: "Activity Log", icon: Activity, caps: ["logs.view"] },
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
  commission: CommissionView,
  overrides: OverridesView,
  holidays: FeeHolidaysView,
  simulator: SimulatorView,
  "affiliate-overview": AffiliateOverviewView,
  "affiliate-accounts": AffiliateAccountsView,
  "affiliate-commissions": AffiliateCommissionsView,
  "affiliate-payouts": AffiliatePayoutsView,
  "affiliate-reconciliation": AffiliateReconciliationView,
  wallets: WalletsView,
  ledger: LedgerView,
  payouts: PayoutsView,
  banks: BanksView,
  banners: BannersView,
  campaigns: CampaignsView,
  featured: FeaturedView,
  coupons: CouponsView,
  tickets: SupportView,
  reports: ReportsView,
  settings: SettingsView,
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

  // Bubbly Cyan backend theme — scoped to <body> so Radix portals (dropdowns,
  // dialogs, toasts) inherit it too. Marketplace surfaces keep the root theme.
  useEffect(() => {
    document.body.classList.add("backend-ui");
    return () => document.body.classList.remove("backend-ui");
  }, []);

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
  const role = me.admin.role;

  return (
    <div className="flex min-h-screen w-full">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 border-r border-slate-200/80 bg-card lg:block">
        <SidebarContent nav={nav} role={role} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* top bar */}
        <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/80 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <MobileNav nav={nav} role={role} />
            <h1 className="min-w-0 flex-1 truncate text-sm font-bold tracking-tight text-slate-900 sm:text-base">{title}</h1>
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

function SidebarContent({ nav, role, onNavigate }: { nav: AdminNav; role: string; onNavigate?: () => void }) {
  // Phase 3: filter nav items by the signed-in admin's capabilities using the
  // same matrix the server enforces (lib/admin-caps.ts). Empty groups hidden.
  const visibleGroups = NAV_GROUPS.map((g) => ({
    label: g.label,
    items: g.items.filter((i) => !i.caps || roleHasAnyCap(role, ...i.caps)),
  })).filter((g) => g.items.length > 0);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-slate-200/80 px-4 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-glow-cyan-sm">
          <ShieldCheck className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold tracking-tight text-slate-900">NOMO<span className="text-brand-gradient">FEE</span></p>
          <p className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Command Centre</p>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 border-amber-200 bg-amber-50 text-[10px] font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
        >
          DEMO
        </Badge>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 [scrollbar-width:thin] [scrollbar-color:rgba(20,184,166,0.4)_transparent] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/30 [&::-webkit-scrollbar]:w-1.5" aria-label="Admin navigation">
        {visibleGroups.map((group, gi) => (
          <div key={group.label || `g${gi}`} className="mb-2">
            {group.label ? (
              <p className="px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">{group.label}</p>
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
                    "flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-brand-gradient font-semibold text-white shadow-glow-cyan-sm"
                      : "text-slate-500 hover:bg-teal-50/70 hover:text-teal-800"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-200/80 px-4 py-3">
        <p className="text-[10px] leading-tight text-muted-foreground">
          PART 4 wireframes · NOMOFEE v1
          <br />
          All actions are audited.
        </p>
      </div>
    </div>
  );
}

function MobileNav({ nav, role }: { nav: AdminNav; role: string }) {
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
      <SheetContent side="left" className="w-64 bg-card p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Admin navigation</SheetTitle>
          <SheetDescription>Navigate between command centre views</SheetDescription>
        </SheetHeader>
        <SidebarContent nav={nav} role={role} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------- top bar */

function AdminMenu({ admin }: { admin: { id: string; email: string; name: string; role: string } }) {
  // Unified sign-out (reliability fix): previously this menu POSTed the
  // logout directly and never cleared the localStorage Bearer token — leaving
  // zombie state — and left the admin on the login card instead of the
  // homepage. The shared app-store logout sends the captured token to the
  // server, clears local identity, re-checks the session and redirects every
  // portal to the marketplace homepage.
  const logout = useApp((s) => s.logout);
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      await logout();
      toast.success("Signed out", { description: "Session ended — see you soon." });
    } catch {
      toast.error("Sign out failed", { description: "Please try again." });
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
          className="flex min-h-[44px] items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pr-2.5 pl-1 shadow-sm transition-colors hover:border-teal-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          aria-label="Account menu"
        >
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-teal-100/70 text-xs font-semibold text-teal-800 dark:bg-teal-900/40 dark:text-teal-300">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="hidden max-w-[140px] truncate text-sm font-medium text-slate-700 sm:block">{admin.name}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
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
        <DropdownMenuItem disabled={busy} onClick={() => void signOut()} className="text-red-600 focus:text-red-600">
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* --------------------------------------------------------------- login */

// Unified login entry point (P11). F-19/F-12 still hold: no credentials live
// in the client bundle — the sandbox-only dev-accounts reference served by
// GET /api/auth/dev-accounts is dual-gated SERVER-side (development env +
// explicit opt-in flag) and 404s in production, and the panel below renders
// nothing unless that endpoint answers with live, re-verified accounts.

function LoginCard({ onLogin }: { onLogin: () => void }) {
  // Non-admin sign-ins are no longer rejected here: this is only the ENTRY
  // point. The console itself remains fully protected server-side
  // (requireAdmin on every admin API) — a buyer/seller session is simply
  // routed to its own portal instead of ever reaching admin data.
  const handleAuthed = async (userType: UnifiedUserType, res: { admin?: { name?: string } | null }) => {
    if (userType === "admin") {
      toast.success(`Welcome back, ${res.admin?.name ?? "admin"}`);
      onLogin(); // refreshMe — the shell gate renders the console
      return;
    }
    toast.info("This account is not an administrator", {
      description: `You are signed in — opening the ${userType === "seller" ? "Seller Centre" : "marketplace"} instead.`,
    });
    await useApp.getState().refreshMe();
    useApp.getState().setSurface(userType);
  };

  return (
    <div className="flex flex-1 items-center justify-center p-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow-cyan-sm">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div>
            <p className="text-xl font-extrabold tracking-tight text-slate-900">NOMO<span className="text-brand-gradient">FEE</span></p>
            <p className="text-xs font-medium uppercase tracking-widest text-slate-400">Command Centre</p>
          </div>
        </div>

        <Card className="rounded-3xl py-0 shadow-soft-card">
          <CardContent className="p-6">
            <UnifiedAuthPanel onAuthed={handleAuthed} submitLabel="Sign in to command centre" />
          </CardContent>
        </Card>

        <div className="rounded-xl border bg-muted/40 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Access notice</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Administrator credentials are issued by the platform team and are never published in the application bundle. In the
            sandbox, the seeded accounts documented in <span className="font-mono">prisma/seed.ts</span> (server-side) can be
            entered manually.
          </p>
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

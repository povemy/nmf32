"use client";
// ============================================================================
// MeHubView — the buyer dashboard / profile hub ("Me" tab), Shopee-style.
//   Mobile  : compact gradient profile header + stacked cards (app-like).
//   Desktop : sticky sidebar (lg+) + bento grid dashboard + product feed.
// Data comes from /api/me/* (all account-scoped server-side via requireShopper).
// Money is integer minor units — always format via formatMinor.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  BadgePercent,
  Bell,
  BellRing,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  CreditCard,
  Crown,
  Gift,
  Headset,
  Heart,
  History,
  Landmark,
  LifeBuoy,
  Loader2,
  MapPin,
  MessagesSquare,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  Radio,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Star,
  Store,
  Ticket,
  Trash2,
  Truck,
  User,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-store";
import {
  fetchJson,
  fetchEnvelope,
  postJson,
  patchJson,
  deleteJson,
  EmptyState,
  StatusBadge,
  dateShort,
  type ProductCardT,
  type ShopperCtx,
} from "./ui-bits";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

type Tier = "SILVER" | "GOLD" | "PLATINUM";

type ProfileT = {
  id: string;
  email: string;
  fullName: string;
  username: string | null;
  avatarUrl: string | null;
  phone: string | null;
  membershipLevel: Tier;
  followingCount: number;
  followerCount: number;
  memberSince: string;
  addressCount: number;
  lifetimeSpendMinor: number;
  tierProgress: { nextTier: Tier; remainingMinor: number; percent: number } | null;
};

type WalletT = {
  wallet: {
    balanceMinor: number;
    coinBalance: number;
    spayLaterLimitMinor: number;
    spayLaterUsedMinor: number;
    spayLaterAvailableMinor: number;
    checkInStreak: number;
  };
  vouchers: { available: number; used: number };
  checkIn: { canClaim: boolean; nextClaimAt: string | null };
};

type BucketCounts = Record<string, number>;

type OrderRowT = {
  id: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  createdAt: string;
  trackingNumber: string | null;
  store: { id: string; name: string; slug: string };
  items: { id: string; title: string; variantLabel: string | null; qty: number; unitPriceMinor: number }[];
};

type RecProductT = ProductCardT & {
  inStock: boolean;
  isFeatured: boolean;
  isSellingFast: boolean;
  spayLaterEligible: boolean;
};

type VoucherRowT = {
  id: string;
  status: string;
  claimedAt: string;
  usedAt: string | null;
  voucher: {
    code: string;
    title: string;
    kind: string;
    discountMinor: number;
    percentOff: number | null;
    maxDiscountMinor: number | null;
    minSpendMinor: number;
    expiryAt: string;
  };
};

type AddressT = {
  id: string;
  label: string;
  name: string;
  phone: string | null;
  line1: string;
  city: string;
  state: string;
  postcode: string;
  isDefault: boolean;
  updatedAt: string;
};

type MeSub = "purchases" | "wallet" | "vouchers" | "likes" | "viewed" | "addresses";

const PURCHASE_BUCKETS: { key: string; label: string; icon: typeof Package }[] = [
  { key: "to_pay", label: "To Pay", icon: Wallet },
  { key: "to_ship", label: "To Ship", icon: PackageCheck },
  { key: "to_receive", label: "To Receive", icon: Truck },
  { key: "to_rate", label: "To Rate", icon: Star },
];

const NOTIF_DISMISS_KEY = "sm_me_notif_dismissed";

const TIER_STYLE: Record<Tier, string> = {
  SILVER: "from-slate-300 to-slate-500",
  GOLD: "from-amber-300 to-amber-600",
  PLATINUM: "from-violet-400 to-violet-700",
};

// ---------------------------------------------------------------------------
// data hook — profile + wallet + purchase counts + like/viewed counters
// ---------------------------------------------------------------------------

function useMeData(enabled: boolean) {
  const [profile, setProfile] = useState<ProfileT | null>(null);
  const [wallet, setWallet] = useState<WalletT | null>(null);
  const [counts, setCounts] = useState<BucketCounts | null>(null);
  const [likeCount, setLikeCount] = useState(0);
  const [viewedCount, setViewedCount] = useState(0);
  const [loading, setLoading] = useState(enabled);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const [p, w, o, lk, vw] = await Promise.allSettled([
      fetchJson<ProfileT>("/api/me/profile"),
      fetchJson<WalletT>("/api/me/wallet"),
      fetchJson<{ bucketCounts: BucketCounts; orders: OrderRowT[] }>("/api/me/orders?size=1"),
      fetchEnvelope<{ activities: unknown[] }>("/api/me/activity?type=LIKE&size=1"),
      fetchEnvelope<{ activities: unknown[] }>("/api/me/activity?type=VIEWED&size=1"),
    ]);
    if (p.status === "fulfilled") setProfile(p.value);
    if (w.status === "fulfilled") setWallet(w.value);
    if (o.status === "fulfilled") setCounts(o.value.bucketCounts);
    if (lk.status === "fulfilled") setLikeCount(lk.value.meta?.total ?? 0);
    if (vw.status === "fulfilled") setViewedCount(vw.value.meta?.total ?? 0);
    setLoading(false);
  }, [enabled]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial dashboard data load (async fetch inside refresh)
    void refresh();
  }, [refresh]);

  // Address CRUD (in this hub's sub-view or during checkout) must reflect on
  // the dashboard teaser instantly — "N saved addresses" never goes stale.
  useEffect(() => {
    if (!enabled) return;
    const sync = () => void refresh();
    window.addEventListener("shopmesh:addresses-changed", sync);
    return () => window.removeEventListener("shopmesh:addresses-changed", sync);
  }, [enabled, refresh]);

  return { profile, wallet, counts, likeCount, viewedCount, loading, refresh };
}

// ---------------------------------------------------------------------------
// root view
// ---------------------------------------------------------------------------

export default function MeHubView({ ctx, initialTab }: { ctx: ShopperCtx; initialTab?: string }) {
  const meState = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const shopper = meState.loaded ? meState.shopper : null;
  const [sub, setSub] = useState<MeSub | null>((initialTab as MeSub) ?? null);
  const [purchaseTab, setPurchaseTab] = useState<string>(initialTab && initialTab.startsWith("bucket:") ? initialTab.slice(7) : "all");
  const data = useMeData(Boolean(shopper));

  if (!shopper) {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <EmptyState
          icon={User}
          title="Your dashboard awaits"
          hint="Sign in to see your purchases, wallet, coins, vouchers and personalised picks — all in one place."
          action={
            <Button onClick={() => openShopperAuth()} className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110">
              Sign in / Create account
            </Button>
          }
        />
      </div>
    );
  }

  if (sub) {
    const back = () => setSub(null);
    switch (sub) {
      case "purchases":
        return <PurchasesView ctx={ctx} onBack={back} initialTab={purchaseTab} />;
      case "wallet":
        return <WalletView onBack={back} wallet={data.wallet} onRefresh={data.refresh} />;
      case "vouchers":
        return <VouchersView onBack={back} onOpenMarket={() => ctx.nav({ name: "market" })} />;
      case "likes":
        return <ActivityGridView key="likes" type="LIKE" title="My Likes" onBack={back} ctx={ctx} />;
      case "viewed":
        return <ActivityGridView key="viewed" type="VIEWED" title="Recently Viewed" onBack={back} ctx={ctx} />;
      case "addresses":
        return <AddressesView onBack={back} />;
    }
  }

  return (
    <Dashboard
      ctx={ctx}
      data={data}
      onSub={(s) => setSub(s)}
      onPurchaseTab={(tab) => {
        setPurchaseTab(tab);
        setSub("purchases");
      }}
    />
  );
}

// =============================================================================================
// Dashboard (mobile stack / desktop bento)
// =============================================================================================

function Dashboard({
  ctx,
  data,
  onSub,
  onPurchaseTab,
}: {
  ctx: ShopperCtx;
  data: ReturnType<typeof useMeData>;
  onSub: (s: MeSub) => void;
  onPurchaseTab: (tab: string) => void;
}) {
  const meState = useApp((s) => s.me);
  const shopper = meState.loaded ? meState.shopper : null;
  const setSurface = useApp((s) => s.setSurface);
  const [notifOpen, setNotifOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [sort, setSort] = useState("popular");

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the dismiss flag from storage after mount
      if (window.localStorage.getItem(NOTIF_DISMISS_KEY) === "1") setNotifOpen(false);
    } catch {
      /* storage blocked — banner stays */
    }
  }, []);

  const dismissNotif = () => {
    setNotifOpen(false);
    try {
      window.localStorage.setItem(NOTIF_DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <div className="lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-6 lg:items-start">
        {/* ------------------------------ sidebar (desktop) ------------------------------ */}
        <aside className="hidden lg:block sticky top-20 space-y-3" aria-label="Dashboard menu">
          <div className="rounded-2xl border bg-card p-4 shadow-soft">
            <div className="flex items-center gap-3">
              <Avatar profile={data.profile} size="md" />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{shopper?.fullName ?? "…"}</p>
                <p className="truncate text-xs text-muted-foreground">{data.profile?.username ? `@${data.profile.username}` : shopper?.email}</p>
              </div>
            </div>
          </div>
          <nav className="rounded-2xl border bg-card p-2 shadow-soft">
            <SideItem icon={Store} label="Dashboard" active onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
            <SideItem icon={Package} label="My Purchases" onClick={() => onSub("purchases")} />
            <SideItem icon={Wallet} label="My Wallet" onClick={() => onSub("wallet")} />
            <SideItem icon={Ticket} label="My Vouchers" onClick={() => onSub("vouchers")} />
            <SideItem icon={MapPin} label="Delivery Addresses" onClick={() => onSub("addresses")} />
            <SideItem icon={Heart} label="My Likes" badge={data.likeCount} onClick={() => onSub("likes")} />
            <SideItem icon={History} label="Recently Viewed" badge={data.viewedCount} onClick={() => onSub("viewed")} />
            <SideItem icon={Settings} label="Settings" onClick={() => setSettingsOpen(true)} />
          </nav>
          <nav className="rounded-2xl border bg-card p-2 shadow-soft">
            <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Support</p>
            <SideItem icon={LifeBuoy} label="Help Center" onClick={() => onSub("purchases")} />
            <SideItem icon={Headset} label="Customer Service" onClick={() => ctx.nav({ name: "messages" })} />
            <SideItem icon={ShieldCheck} label="Jom Beli Selamat!" onClick={() => setSafetyOpen(true)} />
          </nav>
        </aside>

        {/* ------------------------------ main column ------------------------------ */}
        <div className="min-w-0 space-y-4 sm:space-y-5">
          {/* profile header */}
          <ProfileHeader
            profile={data.profile}
            loading={data.loading}
            onSettings={() => setSettingsOpen(true)}
            onCart={ctx.openCart}
            onChat={() => ctx.nav({ name: "messages" })}
            onMarket={() => ctx.nav({ name: "market" })}
          />

          {/* notification prompt */}
          {notifOpen ? (
            <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5" role="status">
              <Bell className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-xs font-medium text-amber-900 sm:text-sm">
                Allow notifications and get the latest updates on orders, deals and more.
              </p>
              <Button
                size="sm"
                className="h-8 min-h-[32px] bg-amber-500 hover:bg-amber-600 text-white"
                onClick={() => {
                  dismissNotif();
                  toast.success("Notifications enabled", { description: "We'll ping you about orders and deals right here." });
                }}
              >
                Allow
              </Button>
              <button
                type="button"
                onClick={dismissNotif}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-amber-700 hover:bg-amber-100 transition-colors"
                aria-label="Dismiss notification prompt"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          {/* purchases hub */}
          <section className="rounded-2xl border bg-card p-4 shadow-soft" aria-labelledby="me-purchases">
            <div className="flex items-center justify-between gap-2 pb-3">
              <h2 id="me-purchases" className="text-sm font-extrabold uppercase tracking-wide">
                My Purchases
              </h2>
              <button
                type="button"
                onClick={() => onSub("purchases")}
                className="inline-flex min-h-[44px] items-center gap-0.5 text-xs font-semibold text-teal-700 hover:text-teal-800 transition-colors"
                aria-label="View full purchase history"
              >
                View Purchase History <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-4">
              {PURCHASE_BUCKETS.map(({ key, label, icon: Icon }) => {
                const n = data.counts?.[key] ?? 0;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onPurchaseTab(key)}
                    className="relative flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 transition-colors hover:bg-muted"
                    aria-label={`${label}${n > 0 ? `, ${n} orders` : ""}`}
                  >
                    <span className="relative">
                      <Icon className="h-5 w-5 text-teal-700" aria-hidden="true" />
                      {n > 0 ? (
                        <span className="absolute -right-2.5 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-extrabold text-white shadow" aria-hidden>
                          {n > 9 ? "9+" : n}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-[11px] font-semibold sm:text-xs">{label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* quick services */}
          <section className="grid grid-cols-2 gap-3" aria-label="Quick services">
            <button
              type="button"
              onClick={() => toast.info("Prepaid, Bills & Tickets", { description: "Coming soon in this demo." })}
              className="flex items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-gradient-soft text-teal-800">
                <Landmark className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold sm:text-sm">Prepaid, Bills & Tickets</span>
                <span className="mt-0.5 inline-block rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-extrabold text-rose-700">20% Off</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => toast.info("SHOPMESH Food", { description: "Coming soon in this demo." })}
              className="flex items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-gradient-soft text-teal-800">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold sm:text-sm">SHOPMESH Food</span>
                <span className="mt-0.5 inline-block rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-extrabold text-teal-800">Free Delivery</span>
              </span>
            </button>
          </section>

          {/* campaign carousel */}
          <section className="rounded-2xl border bg-card p-4 shadow-soft" aria-labelledby="me-campaign">
            <h2 id="me-campaign" className="pb-3 text-sm font-extrabold uppercase tracking-wide">
              Oct 15 Mid-Month Madness
            </h2>
            <div className="grid grid-cols-4 gap-2">
              <CampaignCircle icon={Sparkles} label="Main" onClick={() => ctx.nav({ name: "market" })} />
              <CampaignCircle icon={Ticket} label="Oct 15 Vouchers" onClick={() => onSub("vouchers")} />
              <CampaignCircle icon={BadgePercent} label="Oct 15 Top Deals" onClick={() => ctx.nav({ name: "market" })} />
              <CampaignCircle icon={Coins} label="MESH Lagi Murah" onClick={() => onSub("vouchers")} />
            </div>
          </section>

          {/* wallet & financials */}
          <section className="space-y-3" aria-labelledby="me-wallet">
            <h2 id="me-wallet" className="sr-only">Wallet & financial dashboard</h2>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <WalletCard
                icon={Wallet}
                label="SHOPMESH Pay"
                value={data.wallet ? formatMinor(data.wallet.wallet.balanceMinor) : "—"}
                hint="Wallet balance"
                onClick={() => onSub("wallet")}
              />
              <CoinCard wallet={data.wallet} onRefresh={data.refresh} />
              <WalletCard
                icon={CreditCard}
                label="SPayLater"
                value={data.wallet ? formatMinor(data.wallet.wallet.spayLaterAvailableMinor) : "—"}
                hint={data.wallet ? `of ${formatMinor(data.wallet.wallet.spayLaterLimitMinor)} limit` : "Available credit"}
                meter={data.wallet && data.wallet.wallet.spayLaterLimitMinor > 0 ? data.wallet.wallet.spayLaterUsedMinor / data.wallet.wallet.spayLaterLimitMinor : 0}
                onClick={() => onSub("wallet")}
              />
              <WalletCard
                icon={Ticket}
                label="Vouchers"
                value={data.wallet ? `${data.wallet.vouchers.available}` : "—"}
                hint={data.wallet ? `${data.wallet.vouchers.available} voucher${data.wallet.vouchers.available === 1 ? "" : "s"} ready to use` : "Claimed vouchers"}
                onClick={() => onSub("vouchers")}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <ServiceCard icon={ShoppingCart} title="SHOPMESH Pay App" tag="Scan & Pay" onClick={() => toast.info("SHOPMESH Pay App", { description: "Coming soon in this demo." })} />
              <ServiceCard icon={Landmark} title="Cash Financing" tag="0.75% monthly" onClick={() => toast.info("Cash Financing", { description: "Coming soon in this demo." })} />
              <ServiceCard icon={ShieldCheck} title="Insurance" tag="From RM1.20" onClick={() => toast.info("Insurance", { description: "Coming soon in this demo." })} />
              <ServiceCard icon={Coins} title="Money+" tag="4.1% p.a." onClick={() => toast.info("Money+", { description: "Coming soon in this demo." })} />
            </div>
          </section>

          {/* activities & support */}
          <section className="grid gap-3 md:grid-cols-2" aria-label="Activities and support">
            <div className="rounded-2xl border bg-card p-4 shadow-soft">
              <h2 className="pb-3 text-sm font-extrabold uppercase tracking-wide">More Activities</h2>
              <div className="grid grid-cols-3 gap-y-3">
                <ActivityTile icon={Heart} label="My Likes" badge={data.likeCount} onClick={() => onSub("likes")} />
                <ActivityTile icon={History} label="Recently Viewed" onClick={() => onSub("viewed")} />
                <ActivityTile icon={Store} label="Start Selling" onClick={() => setSurface("seller")} />
                <ActivityTile icon={BellRing} label="Deal Alerts" isNew onClick={() => toast.info("Deal Alerts", { description: "Coming soon in this demo." })} />
                <ActivityTile icon={Radio} label="Live Shopping" isNew onClick={() => toast.info("Live Shopping", { description: "Coming soon in this demo." })} />
                <ActivityTile icon={Gift} label="Invite & Earn" onClick={() => toast.info("Invite & Earn", { description: "Coming soon in this demo." })} />
              </div>
            </div>
            <div className="rounded-2xl border bg-card p-4 shadow-soft">
              <h2 className="pb-1 text-sm font-extrabold uppercase tracking-wide">Support</h2>
              <ul>
                <SupportRow icon={LifeBuoy} title="Help Center" hint="Shipping, returns & payment FAQs" onClick={() => ctx.nav({ name: "lookup" })} />
                <SupportRow icon={Headset} title="Customer Service" hint="Chat with a store or our team" onClick={() => ctx.nav({ name: "messages" })} />
                <SupportRow icon={ShieldCheck} title="Jom Beli Selamat!" hint="Safe-shopping guidelines" onClick={() => setSafetyOpen(true)} />
              </ul>
            </div>
          </section>

          {/* addresses teaser */}
          <button
            type="button"
            onClick={() => onSub("addresses")}
            className="flex w-full items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-md"
            aria-label={`Manage delivery addresses, ${data.profile?.addressCount ?? 0} saved`}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-gradient-soft text-teal-800">
              <MapPin className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold">My Addresses</span>
              <span className="block truncate text-xs text-muted-foreground">
                {data.profile?.addressCount ? `${data.profile.addressCount} saved address${data.profile.addressCount === 1 ? "" : "es"}` : "Add your first delivery address"}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>

          {/* recommendations */}
          <ProductFeed ctx={ctx} sort={sort} onSort={setSort} />
        </div>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} profile={data.profile} onSaved={data.refresh} />
      <SafetyDialog open={safetyOpen} onOpenChange={setSafetyOpen} />
    </div>
  );
}

// =============================================================================================
// Profile header
// =============================================================================================

const GRADIENT_AVATARS = ["grad:teal", "grad:amber", "grad:rose", "grad:violet", "grad:emerald", "grad:slate"];

function Avatar({ profile, size = "md" }: { profile: ProfileT | null; size?: "sm" | "md" | "lg" }) {
  const px = size === "lg" ? "h-16 w-16 text-xl" : size === "md" ? "h-10 w-10 text-sm" : "h-8 w-8 text-xs";
  const gradKey = profile?.avatarUrl?.startsWith("grad:") ? profile.avatarUrl : null;
  const gradClass =
    gradKey === "grad:amber"
      ? "from-amber-400 to-orange-500"
      : gradKey === "grad:rose"
        ? "from-rose-400 to-pink-600"
        : gradKey === "grad:violet"
          ? "from-violet-400 to-purple-600"
          : gradKey === "grad:emerald"
            ? "from-emerald-400 to-teal-600"
            : gradKey === "grad:slate"
              ? "from-slate-400 to-slate-600"
              : "from-teal-500 to-teal-800";
  if (profile?.avatarUrl && !gradKey && /^https?:\/\/|^\//.test(profile.avatarUrl)) {
    return <img src={profile.avatarUrl} alt={`${profile.fullName} avatar`} className={cn(px, "shrink-0 rounded-full object-cover ring-2 ring-white/70")} />;
  }
  const initial = (profile?.fullName ?? "?").trim().slice(0, 1).toUpperCase();
  return (
    <span className={cn(px, "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-extrabold text-white ring-2 ring-white/70", gradClass)} aria-hidden="true">
      {initial}
    </span>
  );
}

function ProfileHeader({
  profile,
  loading,
  onSettings,
  onCart,
  onChat,
  onMarket,
}: {
  profile: ProfileT | null;
  loading: boolean;
  onSettings: () => void;
  onCart: () => void;
  onChat: () => void;
  onMarket: () => void;
}) {
  const { count } = useCartCount();
  const [tierOpen, setTierOpen] = useState(false);
  const tier = profile?.membershipLevel ?? "SILVER";

  return (
    <section className="overflow-hidden rounded-2xl bg-brand-gradient-deep text-white shadow-soft" aria-label="Profile">
      <div className="flex items-center gap-3 p-4 sm:gap-4 sm:p-5">
        <Avatar profile={profile} size="lg" />
        <div className="min-w-0 flex-1">
          {loading && !profile ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-40 bg-white/20" />
              <Skeleton className="h-3 w-24 bg-white/20" />
            </div>
          ) : (
            <>
              <p className="truncate text-base font-extrabold sm:text-lg">{profile?.fullName ?? "…"}</p>
              <p className="truncate text-xs text-white/80">
                {profile?.username ? `@${profile.username}` : (profile?.email ?? "")}
              </p>
              <p className="pt-1 text-[11px] font-medium text-white/90 tabular-nums">
                {profile ? `${profile.followingCount} Following · ${profile.followerCount} Followers` : ""}
              </p>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <IconAction label="Settings" onClick={onSettings}><Settings className="h-4.5 w-4.5" /></IconAction>
          <IconAction label={`Cart, ${count} item${count === 1 ? "" : "s"}`} onClick={onCart}>
            <ShoppingCart className="h-4.5 w-4.5" />
            {count > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-extrabold text-white shadow" aria-hidden>
                {count > 99 ? "99+" : count}
              </span>
            ) : null}
          </IconAction>
          <IconAction label="My messages" onClick={onChat}><MessagesSquare className="h-4.5 w-4.5" /></IconAction>
        </div>
      </div>

      <div className="px-4 pb-4 sm:px-5">
        <button
          type="button"
          onClick={() => setTierOpen(true)}
          className="inline-flex min-h-[28px] items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide backdrop-blur transition-colors hover:bg-white/30"
          aria-haspopup="dialog"
          aria-label={`${tier} membership — view benefits`}
        >
          <Crown className="h-3.5 w-3.5" aria-hidden="true" />
          {tier} Member
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={onMarket}
          className="group mt-3 flex w-full items-center justify-between gap-2 rounded-xl bg-white/15 px-3.5 py-2.5 text-left backdrop-blur transition-colors hover:bg-white/25"
          aria-label="Everything free shipping, no minimum spend — shop now"
        >
          <span className="flex items-center gap-2 text-xs font-bold sm:text-sm">
            <Sparkles className="h-4 w-4 text-amber-300" aria-hidden="true" />
            Everything Free Shipping <span className="hidden font-medium text-white/85 sm:inline">· No Min. Spend</span>
          </span>
          <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </button>
      </div>

      <MembershipDialog open={tierOpen} onOpenChange={setTierOpen} profile={profile} />
    </section>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="relative flex h-10 w-10 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/20 hover:text-white"
    >
      {children}
    </button>
  );
}

function MembershipDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (v: boolean) => void; profile: ProfileT | null }) {
  const tier = profile?.membershipLevel ?? "SILVER";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown className="h-4 w-4 text-amber-500" aria-hidden="true" /> {tier} Membership
          </DialogTitle>
          <DialogDescription>Your lifetime spend unlocks higher tiers automatically.</DialogDescription>
        </DialogHeader>
        {profile ? (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/40 p-4 text-center">
              <span className={cn("inline-flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br text-white shadow", TIER_STYLE[tier])}>
                <Crown className="h-6 w-6" aria-hidden="true" />
              </span>
              <p className="pt-2 text-sm font-extrabold uppercase tracking-wide">{tier}</p>
              <p className="text-xs text-muted-foreground">Lifetime spend {formatMinor(profile.lifetimeSpendMinor)}</p>
            </div>
            {profile.tierProgress ? (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span>Next: {profile.tierProgress.nextTier}</span>
                  <span className="tabular-nums">{profile.tierProgress.percent}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={profile.tierProgress.percent} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-brand-gradient" style={{ width: `${Math.max(4, profile.tierProgress.percent)}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">Spend {formatMinor(profile.tierProgress.remainingMinor)} more to reach {profile.tierProgress.nextTier}.</p>
              </div>
            ) : (
              <p className="text-center text-xs font-semibold text-emerald-700">You've reached the highest tier — PLATINUM.</p>
            )}
            <p className="text-xs text-muted-foreground">Member since {dateShort(profile.memberSince)}</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================================
// small building blocks
// =============================================================================================

function SideItem({ icon: Icon, label, badge, active, onClick }: { icon: typeof Package; label: string; badge?: number; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[40px] w-full items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors",
        active ? "bg-teal-50 text-teal-900" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">{label}</span>
      {badge ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-extrabold text-white">{badge > 9 ? "9+" : badge}</span>
      ) : null}
    </button>
  );
}

function CampaignCircle({ icon: Icon, label, onClick }: { icon: typeof Package; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex flex-col items-center gap-1.5" aria-label={label}>
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-gradient-soft text-teal-800 ring-1 ring-teal-700/10 transition-all group-hover:scale-105 group-hover:bg-brand-gradient group-hover:text-white">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="text-center text-[10px] font-semibold leading-tight sm:text-[11px]">{label}</span>
    </button>
  );
}

function WalletCard({ icon: Icon, label, value, hint, meter, onClick }: { icon: typeof Package; label: string; value: string; hint: string; meter?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border bg-card p-4 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-md"
      aria-label={`${label}: ${value}`}
    >
      <div className="flex items-center gap-2 pb-1.5">
        <Icon className="h-4 w-4 text-teal-700" aria-hidden="true" />
        <span className="text-xs font-bold">{label}</span>
      </div>
      <p className="truncate text-lg font-extrabold tabular-nums text-teal-800">{value}</p>
      <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      {typeof meter === "number" ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.min(100, Math.max(2, meter * 100))}%` }} aria-hidden="true" />
        </div>
      ) : null}
    </button>
  );
}

function CoinCard({ wallet, onRefresh }: { wallet: WalletT | null; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const canClaim = wallet?.checkIn.canClaim ?? false;

  const claim = async () => {
    setBusy(true);
    try {
      const res = await postJson<{ awarded: number; coinBalance: number; checkInStreak: number }>("/api/me/coins/claim", {});
      toast.success(`+${res.awarded} coins claimed!`, { description: `Streak ${res.checkInStreak} day${res.checkInStreak === 1 ? "" : "s"} · balance ${res.coinBalance} coins` });
      await onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not check in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-soft">
      <div className="flex items-center gap-2 pb-1.5">
        <Coins className="h-4 w-4 text-amber-500" aria-hidden="true" />
        <span className="text-xs font-bold">My Coins</span>
      </div>
      <p className="truncate text-lg font-extrabold tabular-nums text-teal-800">{wallet ? wallet.wallet.coinBalance.toLocaleString() : "—"}</p>
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          disabled={!canClaim || busy}
          onClick={() => void claim()}
          className={cn(
            "relative h-7 min-h-[28px] px-2.5 text-[11px] font-bold",
            canClaim ? "bg-amber-500 text-white hover:bg-amber-600" : "bg-muted text-muted-foreground hover:bg-muted"
          )}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : canClaim ? "Check in" : "Checked in"}
          {canClaim && !busy ? <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-card" aria-hidden="true" /> : null}
        </Button>
        {wallet && wallet.wallet.checkInStreak > 0 ? <span className="text-[10px] font-semibold text-muted-foreground">🔥 {wallet.wallet.checkInStreak}-day</span> : null}
      </div>
    </div>
  );
}

function ServiceCard({ icon: Icon, title, tag, onClick }: { icon: typeof Package; title: string; tag: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
      aria-label={`${title} — ${tag}`}
    >
      <Icon className="h-4 w-4 shrink-0 text-teal-700" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-xs font-bold">{title}</span>
        <span className="block truncate text-[10px] font-semibold text-amber-600">{tag}</span>
      </span>
    </button>
  );
}

function ActivityTile({ icon: Icon, label, badge, isNew, onClick }: { icon: typeof Package; label: string; badge?: number; isNew?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group relative flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-xl px-1 transition-colors hover:bg-muted" aria-label={label}>
      {isNew ? <span className="absolute right-1 top-0.5 rounded-full bg-rose-600 px-1 py-px text-[8px] font-extrabold text-white">NEW</span> : null}
      <Icon className="h-5 w-5 text-teal-700 transition-transform group-hover:scale-110" aria-hidden="true" />
      <span className="text-center text-[10px] font-semibold leading-tight sm:text-[11px]">
        {label}
        {badge ? <span className="ml-1 rounded-full bg-amber-100 px-1 text-[9px] font-extrabold text-amber-700 tabular-nums">{badge}</span> : null}
      </span>
    </button>
  );
}

function SupportRow({ icon: Icon, title, hint, onClick }: { icon: typeof Package; title: string; hint: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex min-h-[52px] w-full items-center gap-3 rounded-lg px-1 text-left transition-colors hover:bg-muted">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-gradient-soft text-teal-800">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{hint}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </li>
  );
}

function SafetyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-teal-700" aria-hidden="true" /> Jom Beli Selamat!
          </DialogTitle>
          <DialogDescription>SHOPMESH safe-shopping guidelines.</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>Keep payments on-platform — checkout and pay inside SHOPMESH only.</li>
          <li>Never share OTPs, passwords or full card numbers in chat.</li>
          <li>Check seller ratings, reviews and "official" markers before big purchases.</li>
          <li>Use Track Order to verify delivery — confirm only after the parcel arrives.</li>
          <li>Report suspicious listings or sellers via Customer Service chat.</li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================================
// Settings dialog (profile edit)
// =============================================================================================

function SettingsDialog({ open, onOpenChange, profile, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; profile: ProfileT | null; onSaved: () => Promise<void> }) {
  const refreshMe = useApp((s) => s.refreshMe);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open && profile) {
      setFullName(profile.fullName);
      setPhone(profile.phone ?? "");
      setUsername(profile.username ?? "");
      setAvatar(profile.avatarUrl);
      setDirty(false);
    }
  }, [open, profile]);

  const save = async () => {
    setBusy(true);
    try {
      await patchJson("/api/me/profile", {
        fullName: fullName.trim(),
        phone: phone.trim() || null,
        username: username.trim() || null,
        avatarUrl: avatar,
      });
      await refreshMe();
      await onSaved();
      toast.success("Profile updated");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save profile");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle>Profile settings</DialogTitle>
          <DialogDescription>{profile?.email}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="set-name">Full name</Label>
            <Input id="set-name" value={fullName} onChange={(e) => { setFullName(e.target.value); setDirty(true); }} className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-user">Username</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">@</span>
              <Input id="set-user" value={username} onChange={(e) => { setUsername(e.target.value.toLowerCase()); setDirty(true); }} placeholder="yourhandle" className="min-h-[44px] pl-8" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-phone">Phone</Label>
            <Input id="set-phone" type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setDirty(true); }} placeholder="+60 12-345 6789" className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label>Avatar</Label>
            <div className="flex flex-wrap gap-2">
              {GRADIENT_AVATARS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => { setAvatar(g); setDirty(true); }}
                  aria-label={`Choose avatar style ${g.replace("grad:", "")}`}
                  aria-pressed={avatar === g}
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br text-xs font-extrabold text-white ring-offset-2 transition-all",
                    TIER_STYLE.SILVER,
                    g === "grad:teal" && "from-teal-500 to-teal-800",
                    g === "grad:amber" && "from-amber-400 to-orange-500",
                    g === "grad:rose" && "from-rose-400 to-pink-600",
                    g === "grad:violet" && "from-violet-400 to-purple-600",
                    g === "grad:emerald" && "from-emerald-400 to-teal-600",
                    g === "grad:slate" && "from-slate-400 to-slate-600",
                    avatar === g ? "ring-2 ring-teal-700" : "opacity-70 hover:opacity-100"
                  )}
                >
                  {avatar === g ? <Check className="h-4 w-4" /> : (profile?.fullName ?? "?").slice(0, 1).toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={() => void save()} disabled={busy || !dirty} className="min-h-[44px] w-full bg-brand-gradient-deep text-white hover:brightness-110">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================================
// Purchases hub
// =============================================================================================

const PURCHASE_TABS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  ...PURCHASE_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
];

function SubHeader({ title, onBack, action }: { title: string; onBack: () => void; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-4">
      <button
        type="button"
        onClick={onBack}
        className="flex h-10 w-10 items-center justify-center rounded-lg border bg-card transition-colors hover:bg-muted"
        aria-label="Back to dashboard"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <h1 className="flex-1 truncate text-lg font-extrabold tracking-tight sm:text-xl">{title}</h1>
      {action}
    </div>
  );
}

function PurchasesView({ ctx, onBack, initialTab }: { ctx: ShopperCtx; onBack: () => void; initialTab?: string }) {
  const [tab, setTab] = useState(initialTab ?? "all");
  const [orders, setOrders] = useState<OrderRowT[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);

  const load = useCallback(async (t: string, p: number, replace: boolean) => {
    if (replace) setLoading(true);
    else setMore(true);
    try {
      const q = t === "all" ? "" : `&bucket=${t}`;
      const res = await fetchEnvelope<{ bucketCounts: BucketCounts; orders: OrderRowT[] }>(`/api/me/orders?page=${p}&size=8${q}`);
      setTotal(res.meta?.total ?? 0);
      setOrders((prev) => (replace || p === 1 ? res.data.orders : [...(prev ?? []), ...res.data.orders]));
    } catch {
      if (replace) setOrders([]);
    } finally {
      setLoading(false);
      setMore(false);
    }
  }, []);

  useEffect(() => {
    setPage(1);
    void load(tab, 1, true);
  }, [tab, load]);

  const shown = orders ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <SubHeader title="My Purchases" onBack={onBack} />
      <div className="flex gap-2 overflow-x-auto pb-4" role="tablist" aria-label="Purchase status filter">
        {PURCHASE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "min-h-[36px] shrink-0 rounded-full border px-3.5 text-xs font-bold transition-colors",
              tab === t.key ? "border-teal-700 bg-teal-700 text-white shadow-sm" : "bg-card text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Package}
          title={tab === "all" ? "No orders yet" : "Nothing here yet"}
          hint={tab === "all" ? "Orders you place will show up here — ready to track from payment to delivery." : `You have no orders in "${PURCHASE_TABS.find((t) => t.key === tab)?.label}".`}
          action={
            <Button onClick={() => ctx.nav({ name: "market" })} className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110">
              Start shopping
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {shown.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => ctx.nav({ name: "order-status", orderNumber: o.orderNumber })}
                className="w-full rounded-2xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
                aria-label={`View order ${o.orderNumber} from ${o.store.name}`}
              >
                <div className="flex items-center gap-3 pb-2">
                  <Store className="h-4 w-4 shrink-0 text-teal-700" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm font-bold">{o.store.name}</span>
                  <StatusBadge status={o.status} />
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
                    <Package className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {o.items[0]?.title ?? "Order"}
                      {o.items.length > 1 ? <span className="text-muted-foreground"> +{o.items.length - 1} more</span> : null}
                    </p>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {o.orderNumber} · {dateShort(o.createdAt)}
                      {o.trackingNumber ? ` · ${o.trackingNumber}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-extrabold text-teal-700">{formatMinor(o.totalMinor)}</p>
                    <p className="text-[10px] text-muted-foreground">{o.items.reduce((s, i) => s + i.qty, 0)} item(s)</p>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {shown.length < total ? (
        <div className="flex justify-center pt-5">
          <Button variant="outline" disabled={more} onClick={() => { const p = page + 1; setPage(p); void load(tab, p, false); }} className="min-h-[44px]">
            {more ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================================
// Wallet view
// =============================================================================================

function WalletView({ onBack, wallet, onRefresh }: { onBack: () => void; wallet: WalletT | null; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const canClaim = wallet?.checkIn.canClaim ?? false;

  const claim = async () => {
    setBusy(true);
    try {
      const res = await postJson<{ awarded: number; coinBalance: number; checkInStreak: number }>("/api/me/coins/claim", {});
      toast.success(`+${res.awarded} coins claimed!`, { description: `Streak ${res.checkInStreak} · balance ${res.coinBalance} coins` });
      await onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not check in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <SubHeader title="My Wallet" onBack={onBack} />
      {wallet ? (
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl bg-brand-gradient-deep p-5 text-white shadow-soft">
            <p className="text-xs font-semibold uppercase tracking-widest text-white/80">SHOPMESH Pay balance</p>
            <p className="pt-1 text-3xl font-extrabold tabular-nums">{formatMinor(wallet.wallet.balanceMinor)}</p>
            <p className="pt-1 text-xs text-white/80">Spend it at checkout — top-ups land instantly.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border bg-card p-4 shadow-soft">
              <div className="flex items-center gap-2 pb-1">
                <Coins className="h-4 w-4 text-amber-500" aria-hidden="true" />
                <p className="text-xs font-bold uppercase tracking-wide">My Coins</p>
              </div>
              <p className="text-2xl font-extrabold tabular-nums text-teal-800">{wallet.wallet.coinBalance.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">1 coin ≈ RM0.01 at checkout · streak {wallet.wallet.checkInStreak} day{wallet.wallet.checkInStreak === 1 ? "" : "s"}</p>
              <Button size="sm" disabled={!canClaim || busy} onClick={() => void claim()} className={cn("mt-3 min-h-[36px]", canClaim ? "bg-amber-500 text-white hover:bg-amber-600" : "bg-muted text-muted-foreground hover:bg-muted")}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : canClaim ? "Daily check-in" : "Come back tomorrow"}
              </Button>
              {!canClaim && wallet.checkIn.nextClaimAt ? (
                <p className="pt-1.5 text-[10px] text-muted-foreground">Next check-in from {new Date(wallet.checkIn.nextClaimAt).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" })}</p>
              ) : null}
            </div>
            <div className="rounded-2xl border bg-card p-4 shadow-soft">
              <div className="flex items-center gap-2 pb-1">
                <CreditCardIcon className="h-4 w-4 text-teal-700" aria-hidden="true" />
                <p className="text-xs font-bold uppercase tracking-wide">SPayLater</p>
              </div>
              <p className="text-2xl font-extrabold tabular-nums text-teal-800">{formatMinor(wallet.wallet.spayLaterAvailableMinor)}</p>
              <p className="text-xs text-muted-foreground">available of {formatMinor(wallet.wallet.spayLaterLimitMinor)} limit</p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round((wallet.wallet.spayLaterUsedMinor / Math.max(1, wallet.wallet.spayLaterLimitMinor)) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.min(100, Math.max(1, (wallet.wallet.spayLaterUsedMinor / Math.max(1, wallet.wallet.spayLaterLimitMinor)) * 100))}%` }} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      )}
    </div>
  );
}

function CreditCardIcon(props: React.SVGProps<SVGSVGElement>) {
  return <CreditCard {...props} />;
}

// =============================================================================================
// Vouchers view
// =============================================================================================
function VouchersView({ onBack, onOpenMarket }: { onBack: () => void; onOpenMarket: () => void }) {
  const [rows, setRows] = useState<VoucherRowT[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{ vouchers: VoucherRowT[] }>("/api/me/vouchers");
      setRows(d.vouchers);
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const res = await postJson<{ voucher: { title: string } }>("/api/me/vouchers", { code: code.trim() });
      toast.success("Voucher claimed", { description: res.voucher.title });
      setCode("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not claim that voucher");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <SubHeader title="My Vouchers" onBack={onBack} />
      <div className="flex gap-2 pb-5">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && void claim()}
          placeholder="Enter a voucher code (try MESH10)"
          className="min-h-[44px] font-mono"
          aria-label="Voucher code"
        />
        <Button onClick={() => void claim()} disabled={busy || !code.trim()} className="min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Claim
        </Button>
      </div>

      {rows === null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title="No vouchers yet"
          hint="Claim a code above or grab them from campaign events."
          action={<Button onClick={onOpenMarket} variant="outline" className="min-h-[44px]">Browse the market</Button>}
        />
      ) : (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1 sm:grid sm:grid-cols-2 sm:space-y-0 sm:gap-3" aria-label="Voucher list">
          {rows.map((r) => {
            const expired = r.status === "EXPIRED";
            const used = r.status === "USED";
            const tone = r.voucher.kind === "freeshipping" ? "bg-teal-600" : r.voucher.kind === "coinsback" ? "bg-amber-500" : "bg-rose-600";
            return (
              <div key={r.id} className={cn("flex overflow-hidden rounded-2xl border bg-card shadow-sm", (expired || used) && "opacity-60")} aria-label={`${r.voucher.title} — ${r.status}`}>
                <span className={cn("w-1.5 shrink-0", tone)} aria-hidden="true" />
                <div className="min-w-0 flex-1 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-bold leading-snug">{r.voucher.title}</p>
                    <Badge variant="outline" className={cn("shrink-0 text-[10px]", expired ? "border-rose-200 text-rose-700" : used ? "border-muted text-muted-foreground" : "border-emerald-200 text-emerald-700")}>
                      {r.status}
                    </Badge>
                  </div>
                  <p className="pt-1 font-mono text-xs font-extrabold text-teal-700">{r.voucher.code}</p>
                  <p className="pt-1 text-[11px] text-muted-foreground">
                    {r.voucher.minSpendMinor > 0 ? `Min. spend ${formatMinor(r.voucher.minSpendMinor)} · ` : ""}Expires {dateShort(r.voucher.expiryAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================================================
// Likes / Recently Viewed grids
// =============================================================================================

function ActivityGridView({ type, title, onBack, ctx }: { type: "LIKE" | "VIEWED"; title: string; onBack: () => void; ctx: ShopperCtx }) {
  const [items, setItems] = useState<{ activityId: string; product: ProductCardT }[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchEnvelope<{ activities: { activityId: string; product: ProductCardT }[] }>(`/api/me/activity?type=${type}&size=24`)
      .then((d) => alive && setItems(d.data.activities))
      .catch(() => alive && setItems([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [type]);

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <SubHeader title={title} onBack={onBack} />
      {loading ? (
        <ProductGridSkeletonLocal n={8} />
      ) : !items || items.length === 0 ? (
        <EmptyState
          icon={type === "LIKE" ? Heart : History}
          title={type === "LIKE" ? "Nothing liked yet" : "No browsing history yet"}
          hint={type === "LIKE" ? "Tap the heart on any product to save it here." : "Products you open will be remembered here so you can find them again."}
          action={<Button onClick={() => ctx.nav({ name: "market" })} className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110">Explore the market</Button>}
        />
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 xl:grid-cols-6">
          {items.map((it) => (
            <MeProductCard
              key={it.activityId}
              p={{ ...it.product, inStock: true, isFeatured: false, isSellingFast: false, spayLaterEligible: it.product.priceMinor >= 10000 }}
              onOpen={(prod) => ctx.nav({ name: "pdp", slug: prod.storeSlug, pSlug: prod.slug })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductGridSkeletonLocal({ n }: { n: number }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 xl:grid-cols-6">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-square rounded-xl" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
      ))}
    </div>
  );
}

// =============================================================================================
// Me product card (extended market card with campaign overlays)
// =============================================================================================

function MeProductCard({ p, onOpen }: { p: RecProductT; onOpen: (p: RecProductT) => void }) {
  const discount = p.compareAtPriceMinor && p.compareAtPriceMinor > p.priceMinor
    ? Math.round(100 - (p.priceMinor / p.compareAtPriceMinor) * 100)
    : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(p)}
      className="group text-left rounded-xl border bg-card shadow-soft overflow-hidden hover:shadow-md hover:border-teal-600/40 hover:-translate-y-0.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/50"
      aria-label={`${p.title}, ${formatMinor(p.priceMinor)}${p.isSellingFast ? ", selling fast" : ""}${p.spayLaterEligible ? ", SPayLater available" : ""}`}
    >
      <div className="relative aspect-square overflow-hidden bg-muted">
        <img
          src={p.imageUrl}
          alt={p.title}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
        />
        {discount ? (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-extrabold text-white shadow">-{discount}%</span>
        ) : null}
        {p.inStock ? (
          <span className="absolute bottom-1.5 left-1.5 rounded-full bg-emerald-600/95 px-1.5 py-0.5 text-[9px] font-extrabold text-white shadow">Ready Stock</span>
        ) : null}
        {p.isFeatured ? (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-amber-500/95 px-1.5 py-0.5 text-[9px] font-extrabold text-white shadow">Featured</span>
        ) : null}
      </div>
      <div className="space-y-1 p-2.5">
        <h3 className="line-clamp-2 min-h-[2rem] text-xs font-medium leading-snug">{p.title}</h3>
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-sm font-bold text-teal-700">{formatMinor(p.priceMinor)}</span>
          {p.compareAtPriceMinor && p.compareAtPriceMinor > p.priceMinor ? (
            <span className="text-[11px] text-muted-foreground line-through">{formatMinor(p.compareAtPriceMinor)}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          {p.isSellingFast ? (
            <span className="rounded border border-rose-300 bg-rose-50 px-1 py-px text-[9px] font-extrabold text-rose-700">Selling Fast</span>
          ) : null}
          {p.spayLaterEligible ? (
            <span className="rounded border border-teal-300 bg-teal-50 px-1 py-px text-[9px] font-extrabold text-teal-800">SPayLater 0% 3x</span>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-1 pt-0.5">
          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums">
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden="true" />
            {p.ratingAvg > 0 ? p.ratingAvg.toFixed(1) : "New"}
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{p.salesCount} sold</span>
        </div>
      </div>
    </button>
  );
}

// =============================================================================================
// "You May Also Like" feed
// =============================================================================================

function ProductFeed({ ctx, sort, onSort }: { ctx: ShopperCtx; sort: string; onSort: (s: string) => void }) {
  const [items, setItems] = useState<RecProductT[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setItems([]);
    fetchEnvelope<{ products: RecProductT[] }>(`/api/me/recommendations?sort=${encodeURIComponent(sort)}&page=1&size=12`)
      .then((d) => {
        if (!alive) return;
        setItems(d.data.products);
        setTotal(d.meta?.total ?? 0);
        setPage(1);
      })
      .catch(() => alive && setItems([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sort]);

  const loadMore = async () => {
    setMore(true);
    try {
      const next = page + 1;
      const d = await fetchEnvelope<{ products: RecProductT[] }>(`/api/me/recommendations?sort=${encodeURIComponent(sort)}&page=${next}&size=12`);
      setItems((prev) => [...prev, ...d.data.products]);
      setPage(next);
    } catch {
      /* keep list */
    } finally {
      setMore(false);
    }
  };

  return (
    <section className="rounded-2xl border bg-card p-4 shadow-soft" aria-labelledby="me-recs">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <h2 id="me-recs" className="text-sm font-extrabold uppercase tracking-wide">You May Also Like</h2>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="sr-only">Sort recommendations</span>
          <select
            value={sort}
            onChange={(e) => onSort(e.target.value)}
            className="min-h-[36px] rounded-lg border bg-background px-2 text-xs font-semibold text-foreground"
            aria-label="Sort recommendations"
          >
            <option value="popular">Popular</option>
            <option value="sales">Best selling</option>
            <option value="new">Newest</option>
          </select>
        </label>
      </div>

      {loading ? (
        <ProductGridSkeletonLocal n={12} />
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No products to recommend right now — check back soon.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 2xl:grid-cols-6">
            {items.map((p) => (
              <MeProductCard key={p.id} p={p} onOpen={(prod) => ctx.nav({ name: "pdp", slug: prod.storeSlug, pSlug: prod.slug })} />
            ))}
          </div>
          {items.length < total ? (
            <div className="flex justify-center pt-4">
              <Button variant="outline" disabled={more} onClick={() => void loadMore()} className="min-h-[44px]">
                {more ? <Loader2 className="h-4 w-4 animate-spin" /> : `Load more (${total - items.length} left)`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// =============================================================================================
// Addresses view (account-scoped via /api/checkout/addresses)
// =============================================================================================

const EMPTY_ADDR = { label: "Home", name: "", phone: "", line1: "", city: "", state: "", postcode: "" };

function AddressesView({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<AddressT[] | null>(null);
  const [form, setForm] = useState<typeof EMPTY_ADDR | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{ addresses: AddressT[] }>("/api/checkout/addresses");
      setRows(d.addresses);
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      if (editId) {
        const d = await patchJson<{ addresses: AddressT[] }>(`/api/checkout/addresses/${editId}`, form);
        setRows(d.addresses);
        toast.success("Address updated");
      } else {
        const d = await postJson<{ addresses: AddressT[] }>("/api/checkout/addresses", form);
        setRows(d.addresses);
        toast.success("Address saved");
      }
      setForm(null);
      setEditId(null);
      window.dispatchEvent(new Event("shopmesh:addresses-changed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the address");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const d = await deleteJson<{ addresses: AddressT[] }>(`/api/checkout/addresses/${id}`);
      setRows(d.addresses);
      setConfirmDelete(null);
      window.dispatchEvent(new Event("shopmesh:addresses-changed"));
      toast.success("Address removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the address");
    }
  };

  const setDefault = async (id: string) => {
    try {
      const d = await patchJson<{ addresses: AddressT[] }>(`/api/checkout/addresses/${id}`, { isDefault: true });
      setRows(d.addresses);
      window.dispatchEvent(new Event("shopmesh:addresses-changed"));
      toast.success("Default address updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the default");
    }
  };

  const field = (key: keyof typeof EMPTY_ADDR, label: string, opts?: { type?: string; placeholder?: string; wide?: boolean }) => (
    <div className={opts?.wide ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
      <Label htmlFor={`addr-${key}`}>{label}</Label>
      <Input
        id={`addr-${key}`}
        type={opts?.type ?? "text"}
        value={form?.[key] ?? ""}
        onChange={(e) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f))}
        placeholder={opts?.placeholder}
        className="min-h-[44px]"
      />
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <SubHeader
        title="Delivery Addresses"
        onBack={onBack}
        action={
          <Button
            size="sm"
            onClick={() => { setEditId(null); setForm(EMPTY_ADDR); }}
            className="min-h-[36px] bg-brand-gradient-deep text-white hover:brightness-110"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </Button>
        }
      />

      {rows === null ? (
        <div className="space-y-3">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      ) : rows.length === 0 && !form ? (
        <EmptyState
          icon={MapPin}
          title="No saved addresses"
          hint="Save your delivery address once — checkout will fill it in for you automatically."
          action={<Button onClick={() => { setEditId(null); setForm(EMPTY_ADDR); }} className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110">Add address</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((a) => (
            <li key={a.id} className="rounded-2xl border bg-card p-4 shadow-sm" aria-label={`${a.label} address for ${a.name}`}>
              <div className="flex items-center gap-2 pb-1">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">{a.label}</span>
                {a.isDefault ? <Badge className="bg-teal-700 hover:bg-teal-700 text-[10px]">Default</Badge> : null}
              </div>
              <p className="text-sm font-bold">{a.name} {a.phone ? <span className="font-normal text-muted-foreground">· {a.phone}</span> : null}</p>
              <p className="text-sm text-muted-foreground">{a.line1}, {a.city}, {a.state} {a.postcode}</p>
              <div className="flex flex-wrap gap-2 pt-3">
                {!a.isDefault ? (
                  <Button size="sm" variant="outline" className="h-8 min-h-[32px]" onClick={() => void setDefault(a.id)}>Set default</Button>
                ) : null}
                <Button size="sm" variant="outline" className="h-8 min-h-[32px]" onClick={() => { setEditId(a.id); setForm({ label: a.label, name: a.name, phone: a.phone ?? "", line1: a.line1, city: a.city, state: a.state, postcode: a.postcode }); }}>
                  <Pencil className="h-3 w-3" /> Edit
                </Button>
                {confirmDelete === a.id ? (
                  <Button size="sm" className="h-8 min-h-[32px] bg-rose-600 hover:bg-rose-700" onClick={() => void remove(a.id)} onBlur={() => setConfirmDelete(null)}>
                    Confirm delete
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-8 min-h-[32px] text-rose-600 hover:bg-rose-50" onClick={() => setConfirmDelete(a.id)}>
                    <Trash2 className="h-3 w-3" /> Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={form !== null} onOpenChange={(v) => { if (!v) { setForm(null); setEditId(null); } }}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit address" : "New address"}</DialogTitle>
            <DialogDescription>Saved to your account — used to prefill checkout.</DialogDescription>
          </DialogHeader>
          {form ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {field("name", "Recipient name", { placeholder: "Nur Aisyah" })}
              {field("phone", "Phone", { type: "tel", placeholder: "+60 12-345 6789" })}
              {field("line1", "Street address", { wide: true, placeholder: "12 Jalan Melati, Taman Melawati" })}
              {field("city", "City", { placeholder: "Kuala Lumpur" })}
              {field("state", "State", { placeholder: "Selangor" })}
              {field("postcode", "Postcode", { placeholder: "53100" })}
              {field("label", "Label", { placeholder: "Home / Office" })}
              <div className="sm:col-span-2">
                <Button onClick={() => void save()} disabled={busy} className="min-h-[44px] w-full bg-brand-gradient-deep text-white hover:brightness-110">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : editId ? "Save changes" : "Save address"}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// cart count (lightweight local hook so the header badge stays live)
function useCartCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchJson<{ cart: { items: { qty: number }[] } }>("/api/cart")
        .then((d) => alive && setCount(d.cart?.items.reduce((s, i) => s + i.qty, 0) ?? 0))
        .catch(() => {});
    load();
    window.addEventListener("sm-cart-updated", load);
    return () => {
      alive = false;
      window.removeEventListener("sm-cart-updated", load);
    };
  }, []);
  return { count };
}

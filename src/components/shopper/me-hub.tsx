"use client";
// ============================================================================
// MeHubView — the buyer dashboard / profile hub ("Me" tab), Shopee-style.
//   Mobile  : compact gradient profile header + stacked cards (app-like).
//   Desktop : sticky sidebar (lg+) + bento grid dashboard + product feed.
// Data comes from /api/me/* (all account-scoped server-side via requireShopper).
// Money is integer minor units — always format via formatMinor.
// ============================================================================
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  BadgeCheck,
  BadgePercent,
  Bell,
  BellRing,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  Coins,
  CreditCard,
  Crown,
  HandCoins,
  Headset,
  Heart,
  History,
  Landmark,
  LifeBuoy,
  Loader2,
  MapPin,
  MessageSquareQuote,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  Radio,
  RotateCcw,
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
import AffiliateHubView from "./affiliate-hub";
import { ReviewFormDialog, type EditableReviewT } from "./review-form-dialog";
import { cn } from "@/lib/utils";
import { NOMO_FINANCE_ENABLED } from "@/lib/feature-flags";
import { useApp } from "@/lib/app-store";
import {
  hydrateMeHub,
  refreshMeHub,
  subscribeMeHub,
  getMeHubSnapshot,
  getMeHubServerSnapshot,
  type MeProfile as ProfileT,
  type MeWallet as WalletT,
  type MeBucketCounts as BucketCounts,
} from "@/lib/me-hub-cache";
import {
  ApiFail,
  fetchJson,
  fetchEnvelope,
  postJson,
  patchJson,
  deleteJson,
  notifyCartUpdated,
  EmptyState,
  StatusBadge,
  Stars,
  dateShort,
  openProduct,
  statusLabel,
  type ProductCardT,
  type ShopperCtx,
} from "./ui-bits";

// ---------------------------------------------------------------------------
// DORMANT SCAFFOLD — NOMO FINANCE (finance-scaffold rebrand, Task 12/14-d).
// NOMO_FINANCE_ENABLED lives in @/lib/feature-flags (renamed from
// MESH_FINANCE_ENABLED in the 14-d global rename) and stays `false`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

type Tier = "SILVER" | "GOLD" | "PLATINUM";

// ProfileT / WalletT / BucketCounts now live in @/lib/me-hub-cache (Task 34):
// the Me-hub data is a shared module store there — prefetched on sign-in and
// persisted per shopper — so the banner paints instantly instead of
// skeleton-while-fetching. Type aliases stay local for the file's JSX.

type OrderRowT = {
  id: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  createdAt: string;
  paymentProvider?: string | null;
  trackingNumber: string | null;
  shipmentStatus?: string | null;
  shippingCourierName?: string | null;
  store: { id: string; name: string; slug: string };
  items: {
    id: string;
    title: string;
    variantLabel: string | null;
    qty: number;
    unitPriceMinor: number;
    productId?: string;
    imageUrl?: string;
  }[];
};

/** Shipment state-machine labels (Shipment.status) for courier chips. */
const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  PENDING_BOOKING: "Booking pending",
  BOOKED: "Booked",
  PICKED_UP: "Picked up",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  EXCEPTION: "Delivery exception",
  RETURNED: "Returned",
};

function shipmentStatusLabel(s: string | null | undefined): string {
  if (!s) return "";
  return SHIPMENT_STATUS_LABEL[s] ?? s.replace(/_/g, " ").toLowerCase();
}

type RecProductT = ProductCardT & {
  inStock: boolean;
  isFeatured: boolean;
  isSellingFast: boolean;
  payLaterEligible: boolean;
};

// Task 10-b voucher engine shapes (GET /api/me/vouchers → {vouchers, mine, center}).
type VoucherStoreBriefT = { name: string; slug: string; logoUrl: string | null } | null;

type VoucherCoreT = {
  id: string;
  code: string;
  title: string;
  kind: string; // discount | freeshipping | coinsback
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: string;
  scope?: string; // PLATFORM | STORE
  storeId?: string | null;
  regionLimit?: string | null;
  store?: VoucherStoreBriefT;
};

type MineVoucherT = {
  id: string;
  status: string; // AVAILABLE | USED | EXPIRED
  claimedByMe?: boolean;
  claimedAt: string;
  usedAt: string | null;
  usedOrderId?: string | null;
  voucher: VoucherCoreT;
};

type CenterVoucherT = VoucherCoreT & {
  claimedByMe: boolean;
  quotaRemaining: number | null;
  claimable: boolean;
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

type MeSub = "purchases" | "wallet" | "vouchers" | "likes" | "viewed" | "addresses" | "affiliate" | "reviews";

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
// (Task 34: backed by the module-level Me-hub cache in @/lib/me-hub-cache —
//  prefetched at sign-in, persisted per shopper, stale-while-revalidate — so
// the banner paints instantly instead of waiting on five remote fetches.)
// ---------------------------------------------------------------------------

function useMeData(enabled: boolean) {
  const me = useApp((s) => s.me);
  const shopperId = me.loaded ? (me.shopper?.id ?? null) : null;
  const snap = useSyncExternalStore(subscribeMeHub, getMeHubSnapshot, getMeHubServerSnapshot);

  useEffect(() => {
    if (!enabled || !shopperId) return;
    // 1) paint whatever the persisted snapshot has (same frame, zero network)
    hydrateMeHub(shopperId);
    // 2) revalidate in the background (skipped when a prefetch <45s old is
    //    already fresh) — data-bearing updates never flip a loading flag
    void refreshMeHub(shopperId).catch(() => {});
    // 3) address CRUD (here or during checkout) must reflect instantly
    const sync = () => void refreshMeHub(shopperId, { force: true }).catch(() => {});
    window.addEventListener("nomofee:addresses-changed", sync);
    return () => window.removeEventListener("nomofee:addresses-changed", sync);
  }, [enabled, shopperId]);

  const refresh = useCallback(async () => {
    if (!shopperId) return;
    await refreshMeHub(shopperId, { force: true }).catch(() => {});
  }, [shopperId]);

  return {
    profile: snap.profile,
    wallet: snap.wallet,
    counts: snap.counts,
    likeCount: snap.likeCount,
    viewedCount: snap.viewedCount,
    // skeleton only when NOTHING has ever painted (no prefetch, no cache)
    loading: snap.fetchedAt === null,
    refresh,
  };
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

  // Bubbly Cyan backend theme — the Me Hub is the BUYER backend; scope the
  // theme to <body> while it is mounted so portaled dialogs inherit it.
  // The marketplace views keep the root theme.
  useEffect(() => {
    document.body.classList.add("backend-ui");
    return () => document.body.classList.remove("backend-ui");
  }, []);

  // Task 30 — the Me-page (mobile) header's "Settings" item dispatches
  // nomofee:open-settings. The settings dialog lives at THIS level (lifted out
  // of the Dashboard) so it opens no matter which sub-page is currently
  // active — no return-to-dashboard detour needed anymore.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener("nomofee:open-settings", open);
    return () => window.removeEventListener("nomofee:open-settings", open);
  }, []);

  // Swap the right column (or full mobile page) and start at the top — the
  // sidebar (desktop) stays put while the content below swaps.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [sub]);

  if (!shopper) {
    // Bubbly Cyan recipe 10 — white rounded-3xl envelope, gradient squircle
    // logo, extrabold heading, gradient CTA pill (openShopperAuth preserved).
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <div className="relative overflow-hidden rounded-3xl border border-slate-200/80 bg-card p-8 text-center shadow-soft-card sm:p-12">
          <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-teal-100/70 blur-2xl pointer-events-none" aria-hidden="true" />
          <div className="absolute -bottom-12 -left-10 h-32 w-32 rounded-full bg-teal-50 blur-2xl pointer-events-none" aria-hidden="true" />
          <div className="relative flex flex-col items-center gap-4">
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-brand-gradient text-white shadow-glow-cyan-sm" aria-hidden="true">
              <User className="h-7 w-7" />
            </span>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900 sm:text-2xl">Your dashboard awaits</h1>
            <p className="max-w-md text-sm leading-relaxed text-slate-500">
              Sign in to see your purchases, vouchers and personalised picks — all in one place.
            </p>
            <Button
              onClick={() => openShopperAuth()}
              className="min-h-[44px] bg-brand-gradient px-6 text-white shadow-glow-cyan-sm hover:brightness-110"
            >
              Sign in / Create account
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---- content: the dashboard, or the selected sub-page -----------------------
  // User request (desktop UX): clicking a menu item must NOT remove the left
  // dashboard menu — the page renders in the right column while the sidebar
  // stays put. Mobile keeps the previous full-page behaviour (the sidebar is
  // lg-only; sub-views carry their own back buttons).
  let content: React.ReactNode;
  if (sub) {
    const back = () => setSub(null);
    switch (sub) {
      case "purchases":
        content = <PurchasesView ctx={ctx} onBack={back} initialTab={purchaseTab} onGoReviews={() => setSub("reviews")} />;
        break;
      case "wallet":
        // DORMANT SCAFFOLD — NOMO FINANCE: WalletView is kept intact for the
        // roadmap; until NOMO_FINANCE_ENABLED flips, this entry renders a
        // coming-soon view instead of any stored-value UI.
        content = NOMO_FINANCE_ENABLED ? (
          <WalletView onBack={back} wallet={data.wallet} onRefresh={data.refresh} />
        ) : (
          <FinanceComingSoonView onBack={back} />
        );
        break;
      case "vouchers":
        content = <VouchersView onBack={back} onOpenMarket={() => ctx.nav({ name: "market" })} />;
        break;
      case "likes":
        content = <ActivityGridView key="likes" type="LIKE" title="My Likes" onBack={back} ctx={ctx} />;
        break;
      case "viewed":
        content = <ActivityGridView key="viewed" type="VIEWED" title="Recently Viewed" onBack={back} ctx={ctx} />;
        break;
      case "addresses":
        content = <AddressesView onBack={back} />;
        break;
      case "affiliate":
        // Task 2-A — the affiliate hub is a full surface; the Me hub embeds it
        // as a sub-view with its own back affordance.
        content = <AffiliateHubView ctx={ctx} onBack={back} />;
        break;
      case "reviews":
        // Rewards work order — verified-review management: to-review queue,
        // submitted reviews with moderation status, membership reward ledger.
        content = <ReviewsView ctx={ctx} onBack={back} />;
        break;
      default:
        content = null;
    }
  } else {
    content = (
      <Dashboard
        ctx={ctx}
        data={data}
        onSub={(s) => setSub(s)}
        onPurchaseTab={(tab) => {
          setPurchaseTab(tab);
          setSub("purchases");
        }}
        onOpenSafety={() => setSafetyOpen(true)}
      />
    );
  }

  // ---- persistent shell: sidebar (lg+) + content column ----------------------
  // Dashboard branch replicates the previous Dashboard layout exactly (outer
  // padding + the same lg grid). Sub-page branch leaves mobile padding to the
  // sub-view's own wrapper and only pads at lg — mobile stays pixel-identical
  // to the old full-page sub-views, desktop gains the persistent menu.
  return (
    <div className="w-full flex-1">
      <div
        className={cn(
          "mx-auto w-full max-w-7xl lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:items-start lg:gap-6",
          sub ? "lg:px-4 lg:py-6" : "px-3 py-4 sm:px-4 sm:py-6"
        )}
      >
        <DashboardSidebar
          profile={data.profile}
          activeSub={sub}
          onNav={(s) => setSub(s)}
          onSettings={() => setSettingsOpen(true)}
          onSafety={() => setSafetyOpen(true)}
          onHelp={() => ctx.nav({ name: "lookup" })}
          onMessages={() => ctx.nav({ name: "messages" })}
        />
        <div className="min-w-0">{content}</div>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} profile={data.profile} onSaved={data.refresh} />
      <SafetyDialog open={safetyOpen} onOpenChange={setSafetyOpen} />
    </div>
  );
}

// =============================================================================================
// DashboardSidebar — persistent left menu (desktop lg+). Rendered by the Me-hub
// shell for BOTH the dashboard and every sub-page so the menu never disappears
// while content swaps in the right column (user request). Below lg it is hidden
// (mobile navigates via the dashboard cards / bottom nav / sub-view back
// buttons). The active item tracks the current sub-page.
// =============================================================================================

function DashboardSidebar({
  profile,
  activeSub,
  onNav,
  onSettings,
  onSafety,
  onHelp,
  onMessages,
}: {
  profile: ProfileT | null;
  /** Currently active sub-page; null = the dashboard itself. */
  activeSub: MeSub | null;
  onNav: (s: MeSub | null) => void;
  onSettings: () => void;
  onSafety: () => void;
  onHelp: () => void;
  onMessages: () => void;
}) {
  const meState = useApp((s) => s.me);
  const shopper = meState.loaded ? meState.shopper : null;

  return (
    <aside className="hidden lg:block sticky top-20 space-y-3" aria-label="Dashboard menu">
      <div className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
        <div className="flex items-center gap-3">
          <Avatar profile={profile} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-900">{shopper?.fullName ?? "…"}</p>
            <p className="truncate text-xs text-slate-400">{profile?.username ? `@${profile.username}` : shopper?.email}</p>
          </div>
        </div>
      </div>
      <nav className="rounded-xl border border-slate-200/80 bg-card p-2 shadow-soft-card">
        <SideItem
          icon={Store}
          label="Dashboard"
          active={activeSub === null}
          onClick={() => (activeSub === null ? window.scrollTo({ top: 0, behavior: "smooth" }) : onNav(null))}
        />
        <SideItem icon={Package} label="My Purchases" active={activeSub === "purchases"} onClick={() => onNav("purchases")} />
        <SideItem icon={Star} label="My Reviews" active={activeSub === "reviews"} onClick={() => onNav("reviews")} />
        {NOMO_FINANCE_ENABLED ? <SideItem icon={Wallet} label="My Wallet" active={activeSub === "wallet"} onClick={() => onNav("wallet")} /> : null}
        <SideItem icon={Ticket} label="My Vouchers" active={activeSub === "vouchers"} onClick={() => onNav("vouchers")} />
        <SideItem icon={MapPin} label="Delivery Addresses" active={activeSub === "addresses"} onClick={() => onNav("addresses")} />
        <SideItem icon={Heart} label="My Likes" active={activeSub === "likes"} onClick={() => onNav("likes")} />
        <SideItem icon={History} label="Recently Viewed" active={activeSub === "viewed"} onClick={() => onNav("viewed")} />
        <SideItem icon={HandCoins} label="Affiliate Hub" active={activeSub === "affiliate"} onClick={() => onNav("affiliate")} />
        <SideItem icon={Settings} label="Settings" onClick={onSettings} />
      </nav>
      <nav className="rounded-xl border border-slate-200/80 bg-card p-2 shadow-soft-card">
        <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Support</p>
        <SideItem icon={LifeBuoy} label="Help Center" onClick={onHelp} />
        <SideItem icon={Headset} label="Customer Service" onClick={onMessages} />
        <SideItem icon={ShieldCheck} label="Jom Beli Selamat!" onClick={onSafety} />
      </nav>
    </aside>
  );
}

// =============================================================================================
// Dashboard (mobile stack / desktop bento)
// =============================================================================================

// FINAL CLOSURE §2 — email-ownership verification card. Shown while the
// signed-in shopper's email is unverified: a code round-trip through their
// own mailbox is the ONLY way guest orders placed with that address are
// claimed into the account (the server gate lives in
// claimGuestStateForShopper). No order counts are displayed — an unverified
// account holder must not learn how many unclaimed guest orders exist for
// the address.
function EmailVerificationCard({ profile, onVerified }: { profile: ProfileT | null; onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!profile || profile.emailVerified) return null;

  const sendCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await postJson<{ sent: boolean; message?: string }>("/api/auth/shopper/email-verification/request", {});
      setSent(true);
      setCode("");
      toast.success("Verification code sent", { description: "Check your inbox — the code expires in 10 minutes." });
    } catch (e) {
      if (e instanceof ApiFail && e.status === 503) {
        toast.error("Email delivery isn't configured yet", {
          description: "Verification will be available once a provider is set up. Your account works normally in the meantime.",
        });
      } else {
        toast.error(e instanceof Error ? e.message : "Could not send the code");
      }
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    const digits = code.replace(/[^0-9]/g, "");
    if (digits.length !== 6) {
      toast.error("Enter the 6-digit code from your email.");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const res = await postJson<{ verified: boolean; alreadyVerified?: boolean; ordersClaimed: number }>(
        "/api/auth/shopper/email-verification/verify",
        { code: digits }
      );
      if (res.verified) {
        toast.success(res.alreadyVerified ? "Email already verified" : "Email verified", {
          description: res.alreadyVerified
            ? "Your email ownership is confirmed."
            : res.ordersClaimed > 0
              ? `${res.ordersClaimed} guest order${res.ordersClaimed === 1 ? "" : "s"} placed with this email ${res.ordersClaimed === 1 ? "was" : "were"} added to your account.`
              : "Any orders placed as a guest with this email will appear in your account.",
        });
        setCode("");
        onVerified();
      }
    } catch (e) {
      toast.error(
        e instanceof ApiFail && e.code === "INVALID"
          ? "That code isn't right — check the latest email and try again."
          : e instanceof Error
            ? e.message
            : "Verification failed"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-teal-200 bg-teal-50/60 p-4" aria-labelledby="me-email-verify">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-700">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="me-email-verify" className="text-sm font-extrabold text-slate-900">
            Verify your email
          </h2>
          <p className="pt-0.5 text-xs leading-relaxed text-slate-600">
            Confirm <span className="font-semibold">{profile.email}</span> to add any orders placed as a guest with that address to this account.
          </p>
          {sent ? (
            <form
              className="flex flex-wrap items-end gap-2 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submitCode();
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="me-ev-code" className="text-[11px] font-semibold text-slate-500">6-digit code</Label>
                <Input
                  id="me-ev-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                  placeholder="••••••"
                  className="h-11 min-h-[44px] w-36 text-center font-mono text-base tracking-[0.3em]"
                />
              </div>
              <Button type="submit" disabled={busy} className="min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Verify
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void sendCode()}
                className="min-h-[44px]"
                title="Request a fresh code (rate-limited)"
              >
                <RotateCcw className="h-4 w-4" /> New code
              </Button>
            </form>
          ) : (
            <Button
              type="button"
              onClick={() => void sendCode()}
              disabled={busy}
              className="mt-3 min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Send verification code
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function Dashboard({
  ctx,
  data,
  onSub,
  onPurchaseTab,
  onOpenSafety,
}: {
  ctx: ShopperCtx;
  data: ReturnType<typeof useMeData>;
  onSub: (s: MeSub) => void;
  onPurchaseTab: (tab: string) => void;
  /** Opens the shell-level safety dialog (lifted out of the Dashboard). */
  onOpenSafety: () => void;
}) {
  const setSurface = useApp((s) => s.setSurface);
  const [notifOpen, setNotifOpen] = useState(true);
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

  // The sidebar + outer page padding live in the Me-hub shell now — this
  // component is the right-hand content column only.
  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
          {/* profile header — Task 30: the Settings / bell / cart / messages
              icon actions were removed from the banner (they live in the top
              header now); the banner is a pure identity card with restructured
              follow stats and a progressive membership row. */}
          <ProfileHeader profile={data.profile} loading={data.loading} onMarket={() => ctx.nav({ name: "market" })} />

          {/* FINAL CLOSURE §2 — email verification (gates guest-order claiming) */}
          <EmailVerificationCard profile={data.profile} onVerified={data.refresh} />

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
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-amber-700 hover:bg-amber-100 transition-colors"
                aria-label="Dismiss notification prompt"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          {/* purchases hub */}
          <section className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card" aria-labelledby="me-purchases">
            <div className="flex items-center justify-between gap-2 pb-3">
              <h2 id="me-purchases" className="text-sm font-extrabold text-slate-900">
                My Purchases
              </h2>
              <button
                type="button"
                onClick={() => onSub("purchases")}
                className="inline-flex min-h-[44px] items-center gap-0.5 rounded-full px-2.5 text-[11px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 hover:text-teal-800"
                aria-label="View full purchase history"
              >
                View Purchase History <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {PURCHASE_BUCKETS.map(({ key, label, icon: Icon }) => {
                const n = data.counts?.[key] ?? 0;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onPurchaseTab(key)}
                    className="relative flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl border border-slate-200/60 bg-slate-50 px-1 py-2 transition-all hover:border-teal-200 hover:bg-teal-50/60"
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
                    <span className="text-[10px] font-bold text-slate-600 sm:text-[11px]">{label}</span>
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
              className="flex items-center gap-3 rounded-xl border border-slate-200/80 bg-card p-4 text-left shadow-soft-card transition-all hover:-translate-y-0.5 hover:shadow-glow-cyan-sm"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                <Landmark className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold text-slate-800 sm:text-sm">Prepaid, Bills & Tickets</span>
                <span className="mt-0.5 inline-block rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-600">20% Off</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => toast.info("NOMOFEE Food", { description: "Coming soon in this demo." })}
              className="flex items-center gap-3 rounded-xl border border-slate-200/80 bg-card p-4 text-left shadow-soft-card transition-all hover:-translate-y-0.5 hover:shadow-glow-cyan-sm"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold text-slate-800 sm:text-sm">NOMOFEE Food</span>
                <span className="mt-0.5 inline-block rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-bold text-teal-700">Free Delivery</span>
              </span>
            </button>
          </section>

          {/* campaign carousel */}
          <section className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card" aria-labelledby="me-campaign">
            <h2 id="me-campaign" className="pb-3 text-sm font-extrabold text-slate-900">
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
              {NOMO_FINANCE_ENABLED ? (
                <>
                  <WalletCard
                    icon={Wallet}
                    label="NomoPay"
                    value={data.wallet ? formatMinor(data.wallet.wallet.balanceMinor) : "—"}
                    hint="Wallet balance"
                    onClick={() => onSub("wallet")}
                  />
                  <CoinCard wallet={data.wallet} onRefresh={data.refresh} />
                  <WalletCard
                    icon={CreditCard}
                    label="NomoPay Later"
                    value={data.wallet ? formatMinor(data.wallet.wallet.payLaterAvailableMinor) : "—"}
                    hint={data.wallet ? `of ${formatMinor(data.wallet.wallet.payLaterLimitMinor)} limit` : "Available credit"}
                    meter={data.wallet && data.wallet.wallet.payLaterLimitMinor > 0 ? data.wallet.wallet.payLaterUsedMinor / data.wallet.wallet.payLaterLimitMinor : 0}
                    onClick={() => onSub("wallet")}
                  />
                </>
              ) : (
                // DORMANT SCAFFOLD — NOMO FINANCE (see src/lib/feature-flags.ts):
                // wallet / coins / pay-later cards are hidden; placeholder keeps the bento shape.
                <FinanceComingSoonCard />
              )}
              <WalletCard
                icon={Ticket}
                label="Vouchers"
                value={data.wallet ? `${data.wallet.vouchers.available}` : "—"}
                hint={data.wallet ? `${data.wallet.vouchers.available} voucher${data.wallet.vouchers.available === 1 ? "" : "s"} ready to use` : "Claimed vouchers"}
                onClick={() => onSub("vouchers")}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {NOMO_FINANCE_ENABLED ? (
                <>
                  <ServiceCard icon={ShoppingCart} title="NomoPay App" tag="Scan & Pay" onClick={() => toast.info("NomoPay App", { description: "Coming soon in this demo." })} />
                  <ServiceCard icon={Coins} title="Money+" tag="4.1% p.a." onClick={() => toast.info("Money+", { description: "Coming soon in this demo." })} />
                </>
              ) : null}
              {/* Task 33 — parked services: removed from the active offering,
                  cards remain as greyed placeholders for future functions */}
              <ServiceCard icon={Landmark} title="Cash Financing" tag="0.75% monthly" disabled />
              <ServiceCard icon={ShieldCheck} title="Insurance" tag="From RM1.20" disabled />
            </div>
          </section>

          {/* activities & support */}
          <section className="grid gap-3 md:grid-cols-2" aria-label="Activities and support">
            <div className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
              <h2 className="pb-3 text-sm font-extrabold text-slate-900">More Activities</h2>
              <div className="grid grid-cols-3 gap-2">
                <ActivityTile icon={Heart} label="My Likes" badge={data.likeCount} onClick={() => onSub("likes")} />
                <ActivityTile icon={Star} label="My Reviews" onClick={() => onSub("reviews")} />
                <ActivityTile icon={History} label="Recently Viewed" onClick={() => onSub("viewed")} />
                <ActivityTile icon={Store} label="Start Selling" onClick={() => setSurface("seller")} />
                {/* Sell / Generate — shortcut into the market's generate-store flow. */}
                <ActivityTile icon={Sparkles} label="Sell / Generate" onClick={() => ctx.nav({ name: "generate" })} />
                <ActivityTile icon={BellRing} label="Deal Alerts" isNew onClick={() => toast.info("Deal Alerts", { description: "Coming soon in this demo." })} />
                <ActivityTile icon={Radio} label="Live Shopping" isNew onClick={() => toast.info("Live Shopping", { description: "Coming soon in this demo." })} />
                <ActivityTile icon={HandCoins} label="Affiliate Hub" onClick={() => onSub("affiliate")} />
              </div>
            </div>
            <div className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
              <h2 className="pb-1 text-sm font-extrabold text-slate-900">Support</h2>
              <ul>
                <SupportRow icon={LifeBuoy} title="Help Center" hint="Shipping, returns & payment FAQs" onClick={() => ctx.nav({ name: "lookup" })} />
                <SupportRow icon={Headset} title="Customer Service" hint="Chat with a store or our team" onClick={() => ctx.nav({ name: "messages" })} />
                <SupportRow icon={ShieldCheck} title="Jom Beli Selamat!" hint="Safe-shopping guidelines" onClick={onOpenSafety} />
              </ul>
            </div>
          </section>

          {/* addresses teaser */}
          <button
            type="button"
            onClick={() => onSub("addresses")}
            className="flex w-full items-center gap-3 rounded-xl border border-slate-200/80 bg-card p-4 text-left shadow-soft-card transition-all hover:-translate-y-0.5 hover:shadow-glow-cyan-sm"
            aria-label={`Manage delivery addresses, ${data.profile?.addressCount ?? 0} saved`}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
              <MapPin className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-800">My Addresses</span>
              <span className="block truncate text-xs text-slate-400">
                {data.profile?.addressCount ? `${data.profile.addressCount} saved address${data.profile.addressCount === 1 ? "" : "es"}` : "Add your first delivery address"}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          </button>

          {/* recommendations */}
          <ProductFeed ctx={ctx} sort={sort} onSort={setSort} />
    </div>
  );
}

// =============================================================================================
// Profile header
// =============================================================================================

const GRADIENT_AVATARS = ["grad:teal", "grad:amber", "grad:rose", "grad:violet", "grad:emerald", "grad:slate"];

function Avatar({ profile, size = "md" }: { profile: ProfileT | null; size?: "sm" | "md" | "lg" }) {
  // Task 33: the banner avatar shrinks with the mobile banner (−40% height
  // goal) and returns to the full 64px on desktop.
  const px = size === "lg" ? "h-11 w-11 text-base md:h-16 md:w-16 md:text-xl" : size === "md" ? "h-10 w-10 text-sm" : "h-8 w-8 text-xs";
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
    return <img src={profile.avatarUrl} alt={`${profile.fullName} avatar`} className={cn(px, "shrink-0 rounded-full object-cover ring-2 ring-white")} />;
  }
  const initial = (profile?.fullName ?? "?").trim().slice(0, 1).toUpperCase();
  return (
    <span className={cn(px, "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-extrabold text-white ring-2 ring-white", gradClass)} aria-hidden="true">
      {initial}
    </span>
  );
}

function ProfileHeader({
  profile,
  loading,
  onMarket,
}: {
  profile: ProfileT | null;
  loading: boolean;
  onMarket: () => void;
}) {
  // Task 30 — the four icon actions (Settings / bell / cart / messages) that
  // used to sit here were removed: they now live in the top header (Me page
  // account bar on mobile; the global header on desktop). The banner is a
  // pure identity card: avatar + name, restructured follow stats, and a
  // progressive membership row whose right-chevron opens the details modal.
  const [tierOpen, setTierOpen] = useState(false);
  const tier = profile?.membershipLevel ?? "SILVER";
  const pct = profile?.tierProgress ? profile.tierProgress.percent : 100;

  return (
    // Task 33 — MOBILE ONLY banner compaction (−40% height): smaller avatar,
    // smaller name, no email line, follow stats folded into the name block as
    // plain text (no tiles), and the membership + free-shipping rows slimmed
    // down. Desktop (md+) keeps the Task-30 banner structure.
    // Bubbly Cyan recipe 3 — vibrant gradient hero + frosted rows + blob glow.
    <section className="relative overflow-hidden rounded-xl bg-brand-gradient text-white shadow-glow-cyan" aria-label="Profile">
      <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl pointer-events-none" aria-hidden="true" />
      <div className="absolute -bottom-12 -left-10 h-32 w-32 rounded-full bg-white/10 blur-2xl pointer-events-none" aria-hidden="true" />
      <div className="relative flex items-center gap-2.5 p-3 md:gap-4 md:p-5">
        <Avatar profile={profile} size="lg" />
        <div className="min-w-0 flex-1">
          {loading && !profile ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-40 bg-white/20" />
              <Skeleton className="h-3 w-24 bg-white/20" />
            </div>
          ) : (
            <>
              <p className="truncate text-sm font-extrabold md:text-lg">{profile?.fullName ?? "…"}</p>
              {/* desktop keeps the handle line — mobile banner drops the email */}
              <p className="hidden truncate text-xs text-white/80 md:block">
                {profile?.username ? `@${profile.username}` : (profile?.email ?? "")}
              </p>
              {/* mobile: follow stats as one quiet line under the name — no cards */}
              <p className="truncate text-[11px] text-white/85 md:hidden">
                {typeof profile?.followingCount === "number" ? profile.followingCount.toLocaleString() : "—"} Following ·{" "}
                {typeof profile?.followerCount === "number" ? profile.followerCount.toLocaleString() : "—"} Followers
              </p>
            </>
          )}
        </div>
      </div>

      {/* Following / Followers — desktop keeps the two stat tiles; mobile got
          the inline line above, so the tile row is hidden there */}
      <div className="relative hidden flex-wrap gap-2 px-5 pb-1 md:flex">
        <FollowStat label="Following" value={profile?.followingCount} />
        <FollowStat label="Followers" value={profile?.followerCount} />
      </div>

      <div className="relative space-y-2 px-3 pb-3 pt-1.5 md:space-y-2.5 md:px-5 md:pb-4 md:pt-2.5">
        {/* Membership — progressive: the current tier with its live progress
            bar visible at a glance; tapping the right-chevron opens the modal
            with the full breakdown (lifetime spend, next tier, member since). */}
        <button
          type="button"
          onClick={() => setTierOpen(true)}
          className="group flex w-full items-center gap-2.5 rounded-xl bg-white/15 px-2.5 py-1.5 text-left backdrop-blur transition-colors hover:bg-white/25 md:gap-3 md:px-3.5 md:py-2.5"
          aria-haspopup="dialog"
          aria-label={`${tier} membership — ${
            profile?.tierProgress ? `${pct}% of the way to ${profile.tierProgress.nextTier}` : "highest tier reached"
          }. View details.`}
        >
          <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300 md:h-4 md:w-4" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wide md:text-xs">{tier} Member</span>
              <span className="shrink-0 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                {profile?.tierProgress ? `${pct}% → ${profile.tierProgress.nextTier}` : "Top tier reached"}
              </span>
            </span>
            <span
              className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-white/25 md:mt-1.5 md:h-1.5"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Progress to next membership tier"
            >
              <span className="block h-full rounded-full pattern-stripes-cyan" style={{ width: `${Math.max(6, pct)}%` }} />
            </span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5 md:h-4 md:w-4" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={onMarket}
          className="group flex w-full items-center justify-between gap-2 rounded-xl bg-white/15 px-2.5 py-1.5 text-left backdrop-blur transition-colors hover:bg-white/25 md:px-3.5 md:py-2.5"
          aria-label="Everything free shipping, no minimum spend — shop now"
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-bold md:gap-2 md:text-sm">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-300 md:h-4 md:w-4" aria-hidden="true" />
            Everything Free Shipping <span className="hidden font-medium text-white/85 sm:inline">· No Min. Spend</span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5 md:h-4 md:w-4" aria-hidden="true" />
        </button>
      </div>

      <MembershipDialog open={tierOpen} onOpenChange={setTierOpen} profile={profile} />
    </section>
  );
}

function FollowStat({ label, value }: { label: string; value?: number }) {
  return (
    <span className="inline-flex min-w-[76px] flex-col rounded-full bg-white/15 px-3.5 py-1.5 backdrop-blur">
      <span className="text-sm font-extrabold leading-tight tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : "—"}
      </span>
      <span className="text-[10px] font-bold uppercase tracking-wider text-white/80">{label}</span>
    </span>
  );
}

function MembershipDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (v: boolean) => void; profile: ProfileT | null }) {
  const tier = profile?.membershipLevel ?? "SILVER";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-bold">
            <Crown className="h-4 w-4 text-amber-500" aria-hidden="true" /> {tier} Membership
          </DialogTitle>
          <DialogDescription>Your lifetime spend unlocks higher tiers automatically.</DialogDescription>
        </DialogHeader>
        {profile ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200/80 bg-slate-50 p-4 text-center">
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
                <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={profile.tierProgress.percent} aria-valuemin={0} aria-valuemax={100}>
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
  // Bubbly Cyan recipe 5 — active item is a gradient pill capsule with the
  // cyan glow; inactive items rest in slate until a soft teal hover.
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[40px] w-full items-center gap-2.5 rounded-xl px-3 text-sm transition-colors",
        active
          ? "bg-brand-gradient font-semibold text-white shadow-glow-cyan-sm"
          : "font-medium text-slate-500 hover:bg-teal-50/70 hover:text-teal-800"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">{label}</span>
      {badge ? (
        <span
          className={cn(
            "flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-extrabold",
            active ? "bg-white/25 text-white" : "bg-amber-500 text-white"
          )}
        >
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </button>
  );
}

function CampaignCircle({ icon: Icon, label, onClick }: { icon: typeof Package; label: string; onClick: () => void }) {
  // Bubbly Cyan recipe 8 — teal icon ring that flips to the gradient pill
  // with the cyan glow on hover.
  return (
    <button type="button" onClick={onClick} className="group flex flex-col items-center gap-1.5" aria-label={label}>
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 text-teal-700 ring-1 ring-teal-100 transition-all group-hover:scale-105 group-hover:bg-brand-gradient group-hover:text-white group-hover:shadow-glow-cyan-sm">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="text-center text-[10px] font-semibold leading-tight text-slate-600 sm:text-[11px]">{label}</span>
    </button>
  );
}

function WalletCard({ icon: Icon, label, value, hint, meter, onClick }: { icon: typeof Package; label: string; value: string; hint: string; meter?: number; onClick: () => void }) {
  // Bubbly Cyan recipe 4 — white metric card with a teal icon chip,
  // extrabold tabular headline and an optional gradient meter (recipe 9).
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col rounded-xl border border-slate-200/80 bg-card p-4 text-left shadow-soft-card transition-all hover:-translate-y-0.5 hover:shadow-glow-cyan-sm"
      aria-label={`${label}: ${value}`}
    >
      <div className="flex items-center gap-2.5 pb-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      </div>
      <p className="truncate text-2xl font-extrabold tracking-tight text-slate-900 tabular-nums">{value}</p>
      <p className="truncate text-xs text-slate-400">{hint}</p>
      {typeof meter === "number" ? (
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-brand-gradient" style={{ width: `${Math.min(100, Math.max(2, meter * 100))}%` }} aria-hidden="true" />
        </div>
      ) : null}
    </button>
  );
}

function CoinCard({ wallet, onRefresh }: { wallet: WalletT | null; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const canClaim = wallet?.checkIn?.canClaim ?? false;

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
    <div className="flex flex-col rounded-xl border border-slate-200/80 bg-card p-4 text-left shadow-soft-card">
      <div className="flex items-center gap-2.5 pb-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
          <Coins className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Nomo Coins</span>
      </div>
      <p className="truncate text-2xl font-extrabold tracking-tight text-slate-900 tabular-nums">{wallet ? wallet.wallet.coinBalance.toLocaleString() : "—"}</p>
      <div className="flex items-center gap-2 pt-2">
        <Button
          size="sm"
          disabled={!canClaim || busy}
          onClick={() => void claim()}
          className={cn(
            "relative h-7 min-h-[28px] px-2.5 text-[11px] font-bold",
            canClaim ? "bg-amber-500 text-white hover:bg-amber-600" : "bg-slate-100 text-slate-500 hover:bg-slate-100"
          )}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : canClaim ? "Check in" : "Checked in"}
          {canClaim && !busy ? <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-card" aria-hidden="true" /> : null}
        </Button>
        {wallet && wallet.wallet.checkInStreak > 0 ? <span className="text-[10px] font-semibold text-slate-400">🔥 {wallet.wallet.checkInStreak}-day</span> : null}
      </div>
    </div>
  );
}

// DORMANT SCAFFOLD — NOMO FINANCE placeholders (see src/lib/feature-flags.ts).
// Rendered while NOMO_FINANCE_ENABLED is false so the wallet bento keeps its
// shape; the real cards (WalletCard / CoinCard / WalletView) remain untouched
// and reconnect automatically when the flag flips to true.
function FinanceComingSoonCard() {
  return (
    <div
      className="flex min-h-[92px] flex-col justify-center rounded-xl border border-dashed border-teal-300/80 bg-teal-50/50 p-4"
      role="note"
      aria-label="NomoPay and Nomo Coins coming soon"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
          <Wallet className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="text-xs font-bold text-teal-900">NomoPay &amp; Coins</span>
        <span className="ml-auto rounded-full bg-teal-100 px-1.5 py-0.5 text-[9px] font-extrabold text-teal-800">SOON</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
        Wallet, coins &amp; pay-later are switched off for now — the scaffold is kept for the roadmap.
      </p>
    </div>
  );
}

function FinanceComingSoonView({ onBack }: { onBack: () => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-3 py-4 sm:px-4 sm:py-6">
      <SubHeader title="My Wallet" onBack={onBack} />
      <EmptyState
        icon={Wallet}
        title="NomoPay is coming soon"
        hint="NomoPay balance, Nomo Coins check-ins and pay-later are switched off for now. The wallet scaffold is kept and will be reconnected when the finance roadmap lands."
        action={
          <Button variant="outline" onClick={onBack} className="min-h-[44px]">
            Back to dashboard
          </Button>
        }
      />
    </div>
  );
}

function ServiceCard({
  icon: Icon,
  title,
  tag,
  onClick,
  disabled,
}: {
  icon: typeof Package;
  title: string;
  tag: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  // Task 33: `disabled` parks a service — the card stays as a greyed-out
  // placeholder (no click, no toast) so future products can slot straight in.
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-label={`${title} — ${tag}${disabled ? " (coming soon)" : ""}`}
      className={cn(
        "flex items-center gap-2.5 rounded-xl border border-slate-200/80 bg-card px-3 py-2.5 text-left shadow-soft-card transition-all",
        disabled ? "cursor-not-allowed opacity-50 grayscale" : "hover:-translate-y-0.5 hover:shadow-glow-cyan-sm",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-bold text-slate-800">{title}</span>
        <span className="block truncate text-[10px] font-bold text-amber-600">{tag}</span>
      </span>
    </button>
  );
}

function ActivityTile({ icon: Icon, label, badge, isNew, onClick }: { icon: typeof Package; label: string; badge?: number; isNew?: boolean; onClick: () => void }) {
  // Bubbly Cyan inner tile — soft slate well that blushes teal on hover, with
  // a rounded-lg icon chip (new-dot / count-badge logic preserved).
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl border border-slate-200/60 bg-slate-50 px-1 py-2 transition-all hover:border-teal-200 hover:bg-teal-50/60"
      aria-label={label}
    >
      {isNew ? <span className="absolute right-1.5 top-1 rounded-full bg-rose-600 px-1 py-px text-[8px] font-extrabold text-white">NEW</span> : null}
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100">
        <Icon className="h-4 w-4 transition-transform group-hover:scale-110" aria-hidden="true" />
      </span>
      <span className="text-center text-[10px] font-semibold leading-tight text-slate-600 sm:text-[11px]">
        {label}
        {badge ? <span className="ml-1 rounded-full bg-amber-100 px-1 text-[9px] font-extrabold text-amber-700 tabular-nums">{badge}</span> : null}
      </span>
    </button>
  );
}

function SupportRow({ icon: Icon, title, hint, onClick }: { icon: typeof Package; title: string; hint: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex min-h-[52px] w-full items-center gap-3 rounded-lg px-1.5 text-left transition-colors hover:bg-teal-50/60">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-800">{title}</span>
          <span className="block truncate text-xs text-slate-400">{hint}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </button>
    </li>
  );
}

function SafetyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-bold">
            <ShieldCheck className="h-4 w-4 text-teal-700" aria-hidden="true" /> Jom Beli Selamat!
          </DialogTitle>
          <DialogDescription>NOMOFEE safe-shopping guidelines.</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>Keep payments on-platform — checkout and pay inside NOMOFEE only.</li>
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
      <DialogContent className="max-w-md rounded-3xl">
        <DialogHeader>
          <DialogTitle className="font-bold">Profile settings</DialogTitle>
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
  // Bubbly Cyan — sticky frosted bar: white/80 backdrop-blur strip with a
  // white pill-circle back button that teases the teal ring on hover.
  // Offsets tuck it under the app's pinned market header (72px mobile / 68px desktop).
  return (
    <div className="sticky top-[72px] z-20 -mx-3 -mt-4 mb-4 flex items-center gap-2.5 border-b border-slate-200/70 bg-white/80 px-3 py-3 backdrop-blur-md sm:-mx-4 sm:-mt-6 sm:px-4 md:top-[68px]">
      <button
        type="button"
        onClick={onBack}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:border-teal-400 hover:text-teal-700"
        aria-label="Back to dashboard"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <h1 className="flex-1 truncate text-base font-bold tracking-tight text-slate-900 sm:text-lg">{title}</h1>
      {action}
    </div>
  );
}

function PurchasesView({ ctx, onBack, initialTab, onGoReviews }: { ctx: ShopperCtx; onBack: () => void; initialTab?: string; onGoReviews: () => void }) {
  const [tab, setTab] = useState(initialTab ?? "all");
  const [orders, setOrders] = useState<OrderRowT[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);

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

  // Task 11 live-refresh: parcel states advance server-side (mock courier ticks
  // + seller deliveries + the 14-day auto-complete sweep), so refetch whenever
  // the browser tab regains focus or becomes visible.
  useEffect(() => {
    const refetch = () => void load(tab, 1, true);
    const onVis = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [tab, load]);

  // "Order received" — buyer confirms receipt (shipped | delivered → completed).
  const receive = async (orderNumber: string) => {
    setBusyOrder(orderNumber);
    try {
      await postJson<{ status: string }>(`/api/me/orders/${orderNumber}/receive`, {});
      toast.success("Order received", { description: `${orderNumber} is marked completed — thank you for shopping!` });
      await load(tab, 1, true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not confirm receipt");
    } finally {
      setBusyOrder(null);
    }
  };

  // "Buy again" — one-tap reorder, then open the cart on success.
  const buyAgain = async (orderNumber: string) => {
    setBusyOrder(orderNumber);
    try {
      const res = await postJson<{ added: { title: string; qty: number }[]; skipped: { title: string; reason: string }[] }>(
        `/api/me/orders/${orderNumber}/reorder`,
        {}
      );
      const addedUnits = res.added.reduce((s, a) => s + a.qty, 0);
      const detail = [
        res.added.map((a) => `${a.title} ×${a.qty}`).join(", "),
        res.skipped.map((s) => `${s.title} — ${s.reason}`).join(", "),
      ]
        .filter(Boolean)
        .join(" · ");
      if (addedUnits > 0) {
        toast.success(`${res.added.length} item${res.added.length === 1 ? "" : "s"} added to cart`, {
          description: detail || undefined,
        });
        notifyCartUpdated();
        ctx.openCart();
      } else {
        toast.info("Nothing added to your cart", {
          description: detail || "These items are no longer available.",
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not re-order");
    } finally {
      setBusyOrder(null);
    }
  };

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
              "min-h-[36px] shrink-0 rounded-full border px-3.5 text-xs font-bold transition-all",
              tab === t.key
                ? "border-transparent bg-brand-gradient text-white shadow-glow-cyan-sm"
                : "border-slate-200/80 bg-card text-slate-500 hover:border-teal-300 hover:text-teal-800"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
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
            <PurchasesOrderCard
              key={o.id}
              o={o}
              busy={busyOrder === o.orderNumber}
              onOpen={() => ctx.nav({ name: "order-status", orderNumber: o.orderNumber })}
              onReceive={() => void receive(o.orderNumber)}
              onReorder={() => void buyAgain(o.orderNumber)}
              onReview={onGoReviews}
            />
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
// Purchases order card — Shopee-style: store header + status chip, shipment/
// courier chip, item rows with thumbnails, totals, receive / buy-again actions.
// =============================================================================================

function PurchasesOrderCard({
  o,
  busy,
  onOpen,
  onReceive,
  onReorder,
  onReview,
}: {
  o: OrderRowT;
  busy: boolean;
  onOpen: () => void;
  onReceive: () => void;
  onReorder: () => void;
  /** Navigates to My Reviews — the server certifies which items are reviewable. */
  onReview: () => void;
}) {
  const canReceive = o.status === "shipped" || o.status === "delivered";
  // Review affordance on receipt-confirmed purchases (the Reviews view itself
  // is server-gated per product — this is only the entry point).
  const canReview = o.status === "delivered" || o.status === "completed" || o.status === "partially_refunded";
  const shipLabel = shipmentStatusLabel(o.shipmentStatus);
  const shipTone =
    o.shipmentStatus === "DELIVERED"
      ? "bg-emerald-50 text-emerald-700"
      : o.shipmentStatus === "EXCEPTION" || o.shipmentStatus === "RETURNED"
        ? "bg-rose-50 text-rose-600"
        : "bg-teal-50 text-teal-700";

  return (
    <li className="overflow-hidden rounded-xl border border-slate-200/80 bg-card shadow-soft-card transition-shadow hover:shadow-glow-cyan-sm">
      {/* clickable summary (store header, chips, item rows, totals) */}
      <button
        type="button"
        onClick={onOpen}
        className="block w-full p-4 text-left transition-colors hover:bg-slate-50/80"
        aria-label={`View order ${o.orderNumber} from ${o.store.name}, ${statusLabel(o.status)}`}
      >
        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 shrink-0 text-teal-700" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-bold">{o.store.name}</span>
          <StatusBadge status={o.status} />
        </div>

        {o.trackingNumber ? (
          <div className="pt-2">
            <span className={cn("inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold", shipTone)}>
              <Truck className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {o.shippingCourierName ? `${o.shippingCourierName} · ` : ""}
                {shipLabel || o.trackingNumber}
                {shipLabel ? <span className="hidden font-mono text-[10px] opacity-80 sm:inline"> · {o.trackingNumber}</span> : null}
              </span>
            </span>
          </div>
        ) : null}

        <ul className="pt-1.5" aria-label={`Items in order ${o.orderNumber}`}>
          {o.items.map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-2">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100" aria-hidden="true">
                {i.imageUrl ? (
                  <img src={i.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <Package className="h-5 w-5 text-muted-foreground" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-1 block text-xs font-medium sm:text-[13px]">{i.title}</span>
                {i.variantLabel ? <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{i.variantLabel}</span> : null}
              </span>
              <span className="shrink-0 text-right" aria-label={`${formatMinor(i.unitPriceMinor)} each, quantity ${i.qty}`}>
                <span className="block text-sm font-bold tabular-nums">x{i.qty}</span>
                <span className="block text-[11px] text-muted-foreground tabular-nums">{formatMinor(i.unitPriceMinor)} each</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="flex items-end justify-between gap-2 pt-2">
          <span className="min-w-0 text-[11px] text-slate-500 tabular-nums">
            <span className="block truncate font-bold">{o.orderNumber}</span>
            <span className="block">{dateShort(o.createdAt)}</span>
          </span>
          <span className="text-right" aria-label={`Order total ${formatMinor(o.totalMinor)}`}>
            <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Order Total</span>
            <span className="block text-base font-extrabold tracking-tight text-slate-900 tabular-nums">{formatMinor(o.totalMinor)}</span>
          </span>
        </div>
      </button>

      {/* actions row — outside the clickable summary so buttons never nest */}
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onReorder}
          className="min-h-[36px] gap-1.5"
          aria-label={`Buy again from order ${o.orderNumber}`}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Buy again
        </Button>
        {canReceive ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={onReceive}
            className="min-h-[36px] gap-1.5 bg-brand-gradient-deep text-white hover:brightness-110"
            aria-label={`Confirm receipt of order ${o.orderNumber}`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />}
            Order received
          </Button>
        ) : null}
        {canReview ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onReview}
            className="min-h-[36px] gap-1.5"
            aria-label={`Review products from order ${o.orderNumber}`}
          >
            <Star className="h-3.5 w-3.5" aria-hidden="true" /> Review
          </Button>
        ) : null}
      </div>
    </li>
  );
}

// =============================================================================================
// My Reviews view (rewards work order §7) — to-review queue, submitted reviews
// with moderation status, and the membership reward ledger. All server-derived
// from GET /api/me/reviews; submission/editing ride the REAL verified-purchase
// endpoints (the review button can never appear for an ineligible purchase).
// =============================================================================================

type ReviewToReviewT = {
  orderNumber: string;
  orderStatus: string;
  purchasedAt: string;
  store: { id: string; name: string; slug: string };
  product: { id: string; title: string; slug: string; imageUrl: string };
};

type ReviewSubmittedT = {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  status: string;
  createdAt: string;
  product: { id: string; title: string; slug: string; imageUrl: string; store: { name: string; slug: string } };
  reward: { points: number; reversed: boolean; reversalReason: string | null } | null;
  editable: boolean;
  editCount: number;
};

type ReviewsMgmtT = {
  toReview: ReviewToReviewT[];
  submitted: ReviewSubmittedT[];
  rewards: {
    activePoints: number;
    activeCount: number;
    reversedCount: number;
    reversedPoints: number;
    minorEquivalent: number;
    recent: { id: string; kind: string; points: number; note: string | null; createdAt: string; reversedAt: string | null; reversalReason: string | null }[];
  };
  policy: { pointsPerReview: number; minorPerPoint: number; maxEdits: number };
};

function ReviewStatusBadge({ status }: { status: string }) {
  if (status === "published") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
        <CircleCheck className="h-3 w-3" aria-hidden="true" /> Published
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-600">
        <CircleX className="h-3 w-3" aria-hidden="true" /> Not approved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
      <Clock className="h-3 w-3" aria-hidden="true" /> Pending approval
    </span>
  );
}

function ReviewsView({ ctx, onBack }: { ctx: ShopperCtx; onBack: () => void }) {
  const [data, setData] = useState<ReviewsMgmtT | null>(null);
  const [failed, setFailed] = useState(false);
  // dialog targets
  const [formFor, setFormFor] = useState<ReviewToReviewT | null>(null);
  const [editFor, setEditFor] = useState<ReviewSubmittedT | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const d = await fetchJson<ReviewsMgmtT>("/api/me/reviews");
      setData(d);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rewards = data?.rewards;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <SubHeader
        title="My Reviews"
        onBack={onBack}
        action={
          data ? (
            <span className="rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-bold text-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
              {data.toReview.length} to review
            </span>
          ) : null
        }
      />

      {failed ? (
        <EmptyState
          icon={MessageSquareQuote}
          title="Could not load your reviews"
          hint="Check your connection and try again."
          action={
            <Button onClick={() => void load()} className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110">
              Retry
            </Button>
          }
        />
      ) : !data ? (
        <div className="space-y-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* ---- membership rewards summary (real ledger aggregate) ---------- */}
          <section className="relative overflow-hidden rounded-xl bg-brand-gradient p-5 text-white shadow-glow-cyan" aria-labelledby="me-review-rewards">
            <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl pointer-events-none" aria-hidden="true" />
            <div className="relative">
              <p className="text-[11px] font-bold uppercase tracking-wider text-white/80">Review rewards</p>
              <p className="pt-1 text-2xl font-extrabold tracking-tight tabular-nums lg:text-3xl">
                {rewards?.activePoints ?? 0} points
                <span className="pl-2 text-sm font-bold text-white/80">≈ {formatMinor(rewards?.minorEquivalent ?? 0)}</span>
              </p>
              <p className="pt-1 text-xs text-white/85">
                Earned from {rewards?.activeCount ?? 0} verified review{rewards?.activeCount === 1 ? "" : "s"}
                {rewards && rewards.reversedCount > 0 ? ` · ${rewards.reversedCount} reversed (fraud)` : ""} · 1 point ≈ RM0.01
              </p>
              <p className="pt-2 text-[11px] leading-relaxed text-white/70">
                Rewards are membership benefits — redemption activates with Nomo Finance. Every honest review earns the same
                reward, regardless of star level.
              </p>
            </div>
          </section>

          {/* ---- to review: server-certified eligible purchases -------------- */}
          <section aria-labelledby="me-reviews-toreview" className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
            <h2 id="me-reviews-toreview" className="pb-3 text-sm font-extrabold text-slate-900">
              To review{" "}
              <span className="font-bold text-slate-400">
                ({data.toReview.length} item{data.toReview.length === 1 ? "" : "s"})
              </span>
            </h2>
            {data.toReview.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
                Nothing to review right now — delivered and completed purchases appear here.
              </p>
            ) : (
              <ul className="space-y-3">
                {data.toReview.map((t) => (
                  <li key={t.product.id} className="flex items-center gap-3 rounded-xl border border-slate-100 p-3">
                    <button
                      type="button"
                      onClick={() => openProduct(ctx, { storeSlug: t.store.slug, slug: t.product.slug })}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      aria-label={`View ${t.product.title}`}
                    >
                      <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100" aria-hidden="true">
                        {t.product.imageUrl ? <img src={t.product.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-muted-foreground" />}
                      </span>
                      <span className="min-w-0">
                        <span className="line-clamp-1 block text-[13px] font-semibold">{t.product.title}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {t.store.name} · {t.orderNumber} · {statusLabel(t.orderStatus)}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-emerald-600">
                          <BadgeCheck className="h-3 w-3" aria-hidden="true" /> Verified purchase — earns 5 points
                        </span>
                      </span>
                    </button>
                    <Button
                      size="sm"
                      onClick={() => setFormFor(t)}
                      className="min-h-[36px] shrink-0 bg-brand-gradient text-white hover:brightness-110"
                      aria-label={`Write a review for ${t.product.title}`}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Review
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ---- submitted reviews with moderation status --------------------- */}
          <section aria-labelledby="me-reviews-submitted" className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
            <h2 id="me-reviews-submitted" className="pb-3 text-sm font-extrabold text-slate-900">
              My submitted reviews{" "}
              <span className="font-bold text-slate-400">
                ({data.submitted.length})
              </span>
            </h2>
            {data.submitted.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
                You haven&apos;t reviewed any products yet. Approved reviews help other buyers shop with confidence.
              </p>
            ) : (
              <ul className="space-y-3">
                {data.submitted.map((r) => (
                  <li key={r.id} className="rounded-xl border border-slate-100 p-3">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => openProduct(ctx, { storeSlug: r.product.store.slug, slug: r.product.slug })}
                        className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100"
                        aria-label={`View ${r.product.title}`}
                      >
                        {r.product.imageUrl ? <img src={r.product.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-muted-foreground" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="line-clamp-1 text-[13px] font-semibold">{r.product.title}</p>
                          <ReviewStatusBadge status={r.status} />
                        </div>
                        <p className="pt-0.5 text-[11px] text-muted-foreground">
                          {r.product.store.name} · {dateShort(r.createdAt)}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 pt-1.5">
                          <Stars rating={r.rating} numeric={false} />
                          {r.reward ? (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold",
                                r.reward.reversed ? "bg-rose-50 text-rose-600" : "bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300"
                              )}
                              title={r.reward.reversed ? r.reward.reversalReason ?? "Reward reversed" : "Membership reward credited"}
                            >
                              <Coins className="h-3 w-3" aria-hidden="true" />
                              {r.reward.reversed ? `+${r.reward.points} pts reversed` : `+${r.reward.points} pts earned`}
                            </span>
                          ) : null}
                          {r.editable ? (
                            <button
                              type="button"
                              onClick={() => setEditFor(r)}
                              className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600 transition-colors hover:border-teal-300 hover:text-teal-800"
                              aria-label={`Edit your pending review of ${r.product.title}`}
                            >
                              <Pencil className="h-3 w-3" aria-hidden="true" /> Edit ({data.policy.maxEdits - r.editCount} left)
                            </button>
                          ) : null}
                        </div>
                        {r.title ? <p className="pt-1.5 text-xs font-semibold">{r.title}</p> : null}
                        {r.body ? <p className="whitespace-pre-line pt-0.5 text-xs text-slate-600">{r.body}</p> : null}
                        {r.status === "rejected" ? (
                          <p className="pt-1.5 text-[11px] text-rose-500">
                            This review was not published. {r.reward?.reversed ? "Its reward was reversed." : "Your reward for the submission is retained."}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ---- reward ledger history (auditable) --------------------------- */}
          {rewards && rewards.recent.length > 0 ? (
            <section aria-labelledby="me-rewards-ledger" className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
              <h2 id="me-rewards-ledger" className="pb-3 text-sm font-extrabold text-slate-900">
                Reward history
              </h2>
              <ul className="max-h-96 space-y-2.5 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Membership reward ledger entries">
                {rewards.recent.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{e.note ?? "Membership reward"}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {dateShort(e.createdAt)}
                        {e.reversedAt ? " · reversed" : ""}
                        {e.reversalReason ? ` — ${e.reversalReason.slice(0, 80)}` : ""}
                      </p>
                    </div>
                    <span className={cn("shrink-0 text-sm font-extrabold tabular-nums", e.reversedAt ? "text-slate-400 line-through" : "text-teal-700")}>
                      {e.reversedAt ? "+" : "+"}
                      {e.points} pts
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {/* the REAL submission dialog — eligibility + reward enforced server-side */}
      {formFor ? (
        <ReviewFormDialog
          open
          onOpenChange={(v) => !v && setFormFor(null)}
          storeSlug={formFor.store.slug}
          productSlug={formFor.product.slug}
          productTitle={formFor.product.title}
          productImage={formFor.product.imageUrl}
          orderNumber={formFor.orderNumber}
          onSubmitted={() => void load()}
        />
      ) : null}

      {/* pending-edit dialog — PATCH /api/me/reviews/[id], rewards untouched */}
      {editFor ? (
        <ReviewFormDialog
          open
          onOpenChange={(v) => !v && setEditFor(null)}
          storeSlug={editFor.product.store.slug}
          productSlug={editFor.product.slug}
          productTitle={editFor.product.title}
          productImage={editFor.product.imageUrl}
          edit={{ id: editFor.id, rating: editFor.rating, title: editFor.title, body: editFor.body } satisfies EditableReviewT}
          onSubmitted={() => void load()}
        />
      ) : null}
    </div>
  );
}

// =============================================================================================
// Wallet view
// =============================================================================================

function WalletView({ onBack, wallet, onRefresh }: { onBack: () => void; wallet: WalletT | null; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const canClaim = wallet?.checkIn?.canClaim ?? false;

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
          <div className="relative overflow-hidden rounded-xl bg-brand-gradient p-5 text-white shadow-glow-cyan">
            <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl pointer-events-none" aria-hidden="true" />
            <div className="relative">
              <p className="text-[11px] font-bold uppercase tracking-wider text-white/80">NomoPay balance</p>
              <p className="pt-1 text-2xl font-extrabold tracking-tight tabular-nums lg:text-3xl">{formatMinor(wallet.wallet.balanceMinor)}</p>
              <p className="pt-1 text-xs text-white/80">Spend it at checkout — top-ups land instantly.</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
              <div className="flex items-center gap-2.5 pb-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                  <Coins className="h-4 w-4" aria-hidden="true" />
                </span>
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Nomo Coins</p>
              </div>
              <p className="text-2xl font-extrabold tracking-tight text-slate-900 tabular-nums">{wallet.wallet.coinBalance.toLocaleString()}</p>
              <p className="text-xs text-slate-400">1 coin ≈ RM0.01 at checkout · streak {wallet.wallet.checkInStreak} day{wallet.wallet.checkInStreak === 1 ? "" : "s"}</p>
              <Button size="sm" disabled={!canClaim || busy} onClick={() => void claim()} className={cn("mt-3 min-h-[36px]", canClaim ? "bg-amber-500 text-white hover:bg-amber-600" : "bg-slate-100 text-slate-500 hover:bg-slate-100")}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : canClaim ? "Daily check-in" : "Come back tomorrow"}
              </Button>
              {!canClaim && wallet?.checkIn?.nextClaimAt ? (
                <p className="pt-1.5 text-[10px] text-slate-400">Next check-in from {new Date(wallet.checkIn.nextClaimAt).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" })}</p>
              ) : null}
            </div>
            <div className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
              <div className="flex items-center gap-2.5 pb-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                  <CreditCardIcon className="h-4 w-4" aria-hidden="true" />
                </span>
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">NomoPay Later</p>
              </div>
              <p className="text-2xl font-extrabold tracking-tight text-slate-900 tabular-nums">{formatMinor(wallet.wallet.payLaterAvailableMinor)}</p>
              <p className="text-xs text-slate-400">available of {formatMinor(wallet.wallet.payLaterLimitMinor)} limit</p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round((wallet.wallet.payLaterUsedMinor / Math.max(1, wallet.wallet.payLaterLimitMinor)) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-brand-gradient" style={{ width: `${Math.min(100, Math.max(1, (wallet.wallet.payLaterUsedMinor / Math.max(1, wallet.wallet.payLaterLimitMinor)) * 100))}%` }} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      )}
    </div>
  );
}

function CreditCardIcon(props: React.SVGProps<SVGSVGElement>) {
  return <CreditCard {...props} />;
}

// =============================================================================================
// Vouchers view — Task 10-c: "My Vouchers" wallet + "Voucher Center" claim pool.
// =============================================================================================

const VOUCHER_TABS: { key: "mine" | "center"; label: string }[] = [
  { key: "mine", label: "Mine" },
  { key: "center", label: "Voucher Center" },
];

const VOUCHER_KIND_META: Record<string, { label: string; badgeClass: string; stripe: string }> = {
  discount: { label: "Discount", badgeClass: "bg-rose-50 text-rose-600", stripe: "bg-rose-500" },
  freeshipping: { label: "Free Shipping", badgeClass: "bg-teal-50 text-teal-700", stripe: "bg-teal-600" },
  coinsback: { label: "Coins Back", badgeClass: "bg-amber-50 text-amber-700", stripe: "bg-amber-500" },
};

function voucherKindMeta(kind: string) {
  return VOUCHER_KIND_META[kind] ?? { label: kind.replace(/_/g, " "), badgeClass: "bg-slate-100 text-slate-600", stripe: "bg-slate-400" };
}

/** Human value line: "RM 10 off" / "20% off · up to RM 15" / "Free shipping". */
function voucherValueLabel(v: VoucherCoreT): string {
  if (v.kind === "freeshipping") return "Free shipping";
  if (v.percentOff) {
    const cap = v.maxDiscountMinor ? ` · up to ${formatMinor(v.maxDiscountMinor)}` : "";
    return `${v.percentOff}% off${cap}`;
  }
  if (v.discountMinor > 0) return `${formatMinor(v.discountMinor)} off`;
  return "Voucher";
}

function KindBadge({ kind }: { kind: string }) {
  const meta = voucherKindMeta(kind);
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold", meta.badgeClass)}>
      {meta.label}
    </span>
  );
}

function VouchersView({ onBack, onOpenMarket }: { onBack: () => void; onOpenMarket: () => void }) {
  const [tab, setTab] = useState<"mine" | "center">("mine");
  const [mine, setMine] = useState<MineVoucherT[] | null>(null);
  const [center, setCenter] = useState<CenterVoucherT[] | null>(null);
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{ vouchers?: MineVoucherT[]; mine?: MineVoucherT[]; center?: CenterVoucherT[] }>("/api/me/vouchers");
      // `vouchers` is the legacy mine-array contract — keep honouring it in case
      // this view is ever rendered against an older API build.
      setMine(d.mine ?? d.vouchers ?? []);
      setCenter(d.center ?? []);
    } catch {
      setMine([]);
      setCenter([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Claim a pool voucher by code (legacy POST /api/me/vouchers contract).
  const claimByCode = async () => {
    if (!code.trim()) return;
    setCodeBusy(true);
    try {
      const res = await postJson<{ voucher: { title: string } }>("/api/me/vouchers", { code: code.trim() });
      toast.success("Voucher claimed", { description: `${res.voucher.title} — saved to your wallet.` });
      setCode("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not claim that voucher");
    } finally {
      setCodeBusy(false);
    }
  };

  // Claim a Voucher Center pool card by voucherId (engine route: /claim).
  const claimPool = async (v: CenterVoucherT) => {
    setClaimingId(v.id);
    try {
      const res = await postJson<{ voucher: { title: string } }>("/api/me/vouchers/claim", { voucherId: v.id });
      toast.success("Voucher claimed", { description: `${res.voucher.title} — saved to your wallet.` });
      // optimistic claimed-state swap, then resync from the server
      setCenter((prev) =>
        prev
          ? prev.map((c) =>
              c.id === v.id
                ? { ...c, claimedByMe: true, claimable: false, quotaRemaining: c.quotaRemaining == null ? null : Math.max(0, c.quotaRemaining - 1) }
                : c
            )
          : prev
      );
      await load();
    } catch (e) {
      if (e instanceof ApiFail) {
        if (e.code === "ALREADY_HELD") toast.error("Already claimed", { description: `${v.title} is already in your wallet.` });
        else if (e.code === "QUOTA_EXHAUSTED") toast.error("Quota used up", { description: `${v.title} has been fully claimed — try another one.` });
        else toast.error(e.message);
      } else {
        toast.error("Could not claim that voucher");
      }
      await load();
    } finally {
      setClaimingId(null);
    }
  };

  const mineCount = mine?.length ?? 0;
  const availableCount = mine?.filter((m) => m.status === "AVAILABLE").length ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <SubHeader title="My Vouchers" onBack={onBack} />

      {/* hero summary — Bubbly Cyan gradient envelope (recipe 3) */}
      <div className="relative mb-4 overflow-hidden rounded-xl bg-brand-gradient p-5 text-white shadow-glow-cyan" aria-label="Voucher wallet summary">
        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl pointer-events-none" aria-hidden="true" />
        <div className="relative flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-white/80">Voucher wallet</p>
            <p className="text-2xl font-extrabold tracking-tight tabular-nums lg:text-3xl">{mine === null ? "…" : availableCount}</p>
            <p className="pt-0.5 text-xs text-white/80">
              {mine === null ? "Loading your vouchers…" : `${availableCount} voucher${availableCount === 1 ? "" : "s"} ready to apply at checkout`}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
            {mine === null ? "…" : `${mineCount} total`}
          </span>
        </div>
      </div>

      {/* segmented tabs — Mine | Voucher Center */}
      <div className="flex rounded-full border border-slate-200/70 bg-slate-100/80 p-1" role="tablist" aria-label="Voucher views">
        {VOUCHER_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "min-h-[36px] flex-1 rounded-full px-4 text-xs font-bold transition-all sm:text-sm",
              tab === t.key ? "bg-brand-gradient text-white shadow-glow-cyan-sm" : "text-slate-500 hover:text-slate-800"
            )}
          >
            {t.label}
            {t.key === "mine" && mineCount > 0 ? <span className="ml-1 tabular-nums opacity-90">({mineCount})</span> : null}
          </button>
        ))}
      </div>

      {tab === "mine" ? (
        <div className="space-y-4 pt-5">
          {/* claim-by-code */}
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && void claimByCode()}
              placeholder="Enter a voucher code (try MESH10)"
              className="min-h-[44px] rounded-full font-mono"
              aria-label="Voucher code"
            />
            <Button onClick={() => void claimByCode()} disabled={codeBusy || !code.trim()} className="min-h-[44px] bg-brand-gradient text-white shadow-glow-cyan-sm hover:brightness-110">
              {codeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Claim
            </Button>
          </div>

          {mine === null ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-28 rounded-xl" />
              <Skeleton className="h-28 rounded-xl" />
            </div>
          ) : mine.length === 0 ? (
            <EmptyState
              icon={Ticket}
              title="No vouchers yet"
              hint="Claim a code above or grab them from the Voucher Center."
              action={
                <Button onClick={() => setTab("center")} variant="outline" className="min-h-[44px]">
                  Open Voucher Center
                </Button>
              }
            />
          ) : (
            <div
              className="max-h-[70vh] space-y-3 overflow-y-auto pr-1 pb-1 sm:grid sm:grid-cols-2 sm:space-y-0 sm:gap-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
              aria-label="My vouchers"
            >
              {mine.map((r) => {
                const expired = r.status === "EXPIRED";
                const used = r.status === "USED";
                const meta = voucherKindMeta(r.voucher.kind);
                return (
                  <div key={r.id} className={cn("flex overflow-hidden rounded-xl border border-slate-200/80 bg-card shadow-soft-card", (expired || used) && "opacity-60")} aria-label={`${r.voucher.title} — ${r.status.toLowerCase()}`}>
                    <span className={cn("w-1.5 shrink-0", meta.stripe)} aria-hidden="true" />
                    <div className="min-w-0 flex-1 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 text-sm font-bold leading-snug text-slate-900">{r.voucher.title}</p>
                        <Badge variant="outline" className={cn("shrink-0 border-transparent text-[10px] font-bold", expired ? "bg-rose-50 text-rose-600" : used ? "bg-slate-100 text-slate-500" : "bg-emerald-50 text-emerald-700")}>
                          {r.status}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <p className="text-sm font-extrabold text-teal-700">{voucherValueLabel(r.voucher)}</p>
                        <KindBadge kind={r.voucher.kind} />
                      </div>
                      <p className="pt-1.5">
                        <code className="inline-block rounded-lg bg-slate-50 px-2 py-1 font-mono text-xs font-extrabold tracking-wide text-slate-700">{r.voucher.code}</code>
                      </p>
                      <p className="pt-1.5 text-[11px] text-slate-400">
                        {r.voucher.scope === "STORE" && r.voucher.store ? `${r.voucher.store.name} · ` : ""}
                        {r.voucher.minSpendMinor > 0 ? `Min. spend ${formatMinor(r.voucher.minSpendMinor)} · ` : "No min. spend · "}
                        Expires {dateShort(r.voucher.expiryAt)}
                      </p>
                      {r.voucher.regionLimit === "peninsular" ? (
                        <p className="pt-1 text-[10px] font-semibold text-amber-700">West Malaysia delivery only</p>
                      ) : null}
                      {used && r.usedAt ? (
                        <p className="pt-1 text-[10px] text-slate-400">Used on {dateShort(r.usedAt)}</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {mine !== null && availableCount > 0 ? (
            <p className="text-center text-[11px] text-muted-foreground">
              {availableCount} voucher{availableCount === 1 ? "" : "s"} ready to apply at checkout.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="pt-5">
          {center === null ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-44 rounded-xl" />
              <Skeleton className="h-44 rounded-xl" />
            </div>
          ) : center.length === 0 ? (
            <EmptyState
              icon={Ticket}
              title="No vouchers to claim right now"
              hint="New vouchers from NOMOFEE and your favourite stores will appear here — check back soon."
              action={
                <Button onClick={onOpenMarket} variant="outline" className="min-h-[44px]">
                  Browse the market
                </Button>
              }
            />
          ) : (
            <div
              className="max-h-[70vh] space-y-3 overflow-y-auto pr-1 pb-1 sm:grid sm:grid-cols-2 sm:space-y-0 sm:gap-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
              aria-label="Voucher Center pool"
            >
              {center.map((v) => {
                const claiming = claimingId === v.id;
                const fullyClaimed = v.quotaRemaining === 0;
                const label = v.claimedByMe ? "Claimed" : fullyClaimed ? "Fully claimed" : "Claim";
                return (
                  <div key={v.id} className="flex flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-card shadow-soft-card" aria-label={`${v.title} from ${v.store?.name ?? "platform"}`}>
                    {/* store header */}
                    <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                      {v.store?.logoUrl ? (
                        <img src={v.store.logoUrl} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-teal-100" />
                      ) : (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700" aria-hidden="true">
                          <Store className="h-3.5 w-3.5" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-800">{v.store?.name ?? "NOMOFEE"}</span>
                      {v.scope !== "STORE" ? (
                        <span className="shrink-0 rounded-full bg-teal-50 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-teal-700">Platform</span>
                      ) : null}
                    </div>
                    {/* body */}
                    <div className="min-w-0 flex-1 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 text-sm font-bold leading-snug text-slate-900">{v.title}</p>
                        <KindBadge kind={v.kind} />
                      </div>
                      <p className="pt-1 text-lg font-extrabold tabular-nums text-teal-700">{voucherValueLabel(v)}</p>
                      <p className="pt-1 text-[11px] text-slate-400">
                        {v.minSpendMinor > 0 ? `Min. spend ${formatMinor(v.minSpendMinor)}` : "No min. spend"}
                        {" · "}
                        {v.quotaRemaining == null ? "Unlimited quota" : `${v.quotaRemaining} left`}
                      </p>
                      <p className="pt-0.5 text-[11px] text-slate-400">Expires {dateShort(v.expiryAt)}</p>
                      {v.regionLimit === "peninsular" ? (
                        <p className="pt-1 text-[10px] font-semibold text-amber-700">West Malaysia delivery only</p>
                      ) : null}
                    </div>
                    {/* claim action — 44px target */}
                    <div className="border-t border-slate-100 px-4 py-3">
                      <Button
                        onClick={() => void claimPool(v)}
                        disabled={claiming || v.claimedByMe || fullyClaimed}
                        className={cn(
                          "min-h-[44px] w-full gap-1.5",
                          v.claimedByMe || fullyClaimed
                            ? "bg-slate-100 text-slate-500 hover:bg-slate-100"
                            : "bg-brand-gradient text-white shadow-glow-cyan-sm hover:brightness-110"
                        )}
                        aria-label={`${label} — ${v.title}`}
                      >
                        {claiming ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : v.claimedByMe ? (
                          <Check className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        )}
                        {label}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
        <section className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card" aria-label={title}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 xl:grid-cols-6">
            {items.map((it) => (
              <MeProductCard
                key={it.activityId}
                p={{ ...it.product, inStock: true, isFeatured: false, isSellingFast: false, payLaterEligible: it.product.priceMinor >= 10000 }}
                onOpen={(prod) => ctx.nav({ name: "pdp", slug: prod.storeSlug, pSlug: prod.slug })}
              />
            ))}
          </div>
        </section>
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
  // Bubbly Cyan product tile — padded slate-100 image well (rounded-lg),
  // bold title, extrabold tabular price and soft pill micro-badges.
  return (
    <button
      type="button"
      onClick={() => onOpen(p)}
      className="group rounded-xl text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/60"
      aria-label={`${p.title}, ${formatMinor(p.priceMinor)}${p.isSellingFast ? ", selling fast" : ""}${NOMO_FINANCE_ENABLED && p.payLaterEligible ? ", NomoPay Later available" : ""}`}
    >
      <div className="relative mb-2 aspect-square overflow-hidden rounded-lg bg-slate-100 p-2">
        <img
          src={p.imageUrl}
          alt={p.title}
          loading="lazy"
          className="h-full w-full rounded-md object-cover transition-transform duration-300 group-hover:scale-[1.04]"
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
      <div className="space-y-1">
        <h3 className="line-clamp-2 min-h-[2rem] text-xs font-bold leading-snug text-slate-800">{p.title}</h3>
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-sm font-extrabold tracking-tight text-slate-900 tabular-nums">{formatMinor(p.priceMinor)}</span>
          {p.compareAtPriceMinor && p.compareAtPriceMinor > p.priceMinor ? (
            <span className="text-[10px] text-slate-400 line-through">{formatMinor(p.compareAtPriceMinor)}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          {p.isSellingFast ? (
            <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[9px] font-extrabold text-rose-600">Selling Fast</span>
          ) : null}
          {NOMO_FINANCE_ENABLED && p.payLaterEligible ? (
            <span className="rounded-full bg-teal-50 px-1.5 py-0.5 text-[9px] font-extrabold text-teal-700">NomoPay Later 0% 3x</span>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-1 pt-0.5">
          <span className="inline-flex items-center gap-0.5 text-[10px] text-slate-400 tabular-nums">
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden="true" />
            {p.ratingAvg > 0 ? p.ratingAvg.toFixed(1) : "New"}
          </span>
          <span className="text-[10px] text-slate-400 tabular-nums">{p.salesCount} sold</span>
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
  // Task 34: true once a page added zero new products — hides "Load more" so
  // boundary drift (live activity shifting the personalised window between
  // requests) can never spin on an exhausted feed.
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setItems([]);
    setExhausted(false);
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
      // Dedupe by id — the server paginates deterministically now, but the
      // personalised window legitimately shifts as the shopper browses
      // (VIEWED activities), so a belt-and-braces client guard keeps React's
      // key list unique no matter what arrives.
      const seen = new Set(items.map((x) => x.id));
      if (d.data.products.every((p) => seen.has(p.id))) setExhausted(true);
      setItems((prev) => {
        const s = new Set(prev.map((x) => x.id));
        return [...prev, ...d.data.products.filter((p) => !s.has(p.id))];
      });
      setPage(next);
    } catch {
      /* keep list */
    } finally {
      setMore(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card" aria-labelledby="me-recs">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <h2 id="me-recs" className="text-sm font-extrabold text-slate-900">You May Also Like</h2>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <span className="sr-only">Sort recommendations</span>
          <select
            value={sort}
            onChange={(e) => onSort(e.target.value)}
            className="min-h-[36px] cursor-pointer rounded-full border border-slate-200 bg-slate-100 px-3.5 text-[11px] font-semibold text-slate-600 transition-colors hover:border-teal-300 focus:border-teal-400 focus:outline-none"
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
          {items.length < total && !exhausted ? (
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
      window.dispatchEvent(new Event("nomofee:addresses-changed"));
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
      window.dispatchEvent(new Event("nomofee:addresses-changed"));
      toast.success("Address removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the address");
    }
  };

  const setDefault = async (id: string) => {
    try {
      const d = await patchJson<{ addresses: AddressT[] }>(`/api/checkout/addresses/${id}`, { isDefault: true });
      setRows(d.addresses);
      window.dispatchEvent(new Event("nomofee:addresses-changed"));
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
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
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
            <li key={a.id} className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card" aria-label={`${a.label} address for ${a.name}`}>
              <div className="flex items-center gap-2 pb-1">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">{a.label}</span>
                {a.isDefault ? <Badge className="bg-teal-700 hover:bg-teal-700 text-[10px]">Default</Badge> : null}
              </div>
              <p className="text-sm font-bold text-slate-900">{a.name} {a.phone ? <span className="font-normal text-slate-400">· {a.phone}</span> : null}</p>
              <p className="text-sm text-slate-500">{a.line1}, {a.city}, {a.state} {a.postcode}</p>
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
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle className="font-bold">{editId ? "Edit address" : "New address"}</DialogTitle>
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

// (Task 30: the local cart-count hook was removed with the banner's cart icon
// — the top-header cart badge already tracks the live count via useCart.)

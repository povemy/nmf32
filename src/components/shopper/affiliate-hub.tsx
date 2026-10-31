"use client";
// ============================================================================
// AffiliateHubView — the shopper-facing AFFILIATE HUB (Task 2-A).
// Backend is fully implemented (/api/affiliate/**); this file is UI + wiring.
//
// State machine:
//   loading → not signed in (gate) → activation flow → hub tabs
//   (programme paused / account suspended|terminated render honest notices)
//
// Tabs: Overview · Discover · Links · Collections · Showcase · Network ·
//       Earnings · Payouts  (Links/Collections/Showcase/Network/Earnings/
//       Payouts live in affiliate-tabs.tsx; public pages in affiliate-public.tsx)
//       Collections & Showcase are feature-gated (settings.collectionsEnabled /
//       showcaseEnabled) — hidden entirely while the flags are off (P2).
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  BadgeCheck,
  Ban,
  CircleDollarSign,
  HandCoins,
  Info,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  Megaphone,
  MousePointerClick,
  Search,
  ShieldAlert,
  Store,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toMinor } from "@/lib/money";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { EmptyState, type ShopperCtx } from "./ui-bits";
import {
  affGet,
  affPost,
  AuthoritativeBadge,
  EstBadge,
  money,
  Pager,
  ratePercent,
  referralJoinUrl,
  CopyButton,
  SectionCard,
  StatCard,
  TabError,
  TabSkeleton,
  useDebouncedValue,
  useDiscoverFeed,
  type AffiliateActivateCtxT,
  type AffiliateMeT,
  type AffiliateSettingsT,
  type DiscoverProductT,
  type HubOverviewT,
} from "./affiliate-shared";
import {
  CollectionsTab,
  EarningsTab,
  LinksTab,
  LinkCreateDialog,
  NetworkTab,
  PayoutsTab,
  ShowcaseTab,
} from "./affiliate-tabs";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type AffiliateTabKey =
  | "overview"
  | "discover"
  | "links"
  | "collections"
  | "showcase"
  | "network"
  | "earnings"
  | "payouts";

const TABS: { key: AffiliateTabKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "discover", label: "Discover", icon: Search },
  { key: "links", label: "Links", icon: Link2 },
  { key: "collections", label: "Collections", icon: LayoutGrid },
  { key: "showcase", label: "Showcase", icon: Megaphone },
  { key: "network", label: "Network", icon: Users },
  { key: "earnings", label: "Earnings", icon: CircleDollarSign },
  { key: "payouts", label: "Payouts", icon: Wallet },
];

function sanitizeTab(t: string | undefined): AffiliateTabKey {
  return (TABS.find((x) => x.key === t)?.key ?? "overview") as AffiliateTabKey;
}

// ---------------------------------------------------------------------------
// Root view
// ---------------------------------------------------------------------------

export default function AffiliateHubView({
  ctx,
  initialTab,
  onBack,
  onTabChange,
}: {
  ctx: ShopperCtx;
  initialTab?: string;
  /** When embedded (e.g. inside the Me hub) a dedicated back handler renders. */
  onBack?: () => void;
  /** Persist the active tab (shopper-shell writes the view cache key). */
  onTabChange?: (tab: string) => void;
}) {
  const meState = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const shopper = meState.loaded ? meState.shopper : null;

  const [data, setData] = useState<AffiliateMeT | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Public activation context for the NOT-signed-in gate (referral banner).
  const [gateCtx, setGateCtx] = useState<AffiliateActivateCtxT | null>(null);
  const [tab, setTab] = useState<AffiliateTabKey>(sanitizeTab(initialTab));
  // Cross-tab "create a link for this product" hand-off from Discover.
  const [linkDraft, setLinkDraft] = useState<DiscoverProductT | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!shopper) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadErr(null);
    try {
      const d = await affGet<AffiliateMeT>("/api/affiliate/me");
      setData(d);
    } catch (e) {
      setData(null);
      setLoadErr(e instanceof Error ? e.message : "Could not load your affiliate account");
    } finally {
      setLoading(false);
    }
  }, [shopper]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Guest: fetch the public pre-activation context (invited-by banner, pause
  // state) — this endpoint is public by design for the landing experience.
  useEffect(() => {
    if (!meState.loaded || shopper) return;
    let alive = true;
    affGet<AffiliateActivateCtxT>("/api/affiliate/activate")
      .then((d) => {
        if (alive) setGateCtx(d);
      })
      .catch(() => {
        /* banner is best-effort */
      });
    return () => {
      alive = false;
    };
  }, [meState.loaded, shopper]);

  const switchTab = useCallback(
    (t: AffiliateTabKey) => {
      setTab(t);
      onTabChange?.(t);
    },
    [onTabChange]
  );

  const openLinkDialog = useCallback((p: DiscoverProductT | null) => {
    setLinkDraft(p);
    setLinkOpen(true);
  }, []);

  // ---- phases --------------------------------------------------------------

  let body: React.ReactNode;
  if (!meState.loaded || (loading && !data)) {
    body = (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-10 w-72 rounded-full" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      </div>
    );
  } else if (!shopper) {
    body = (
      <SignInGate
        invitedBy={gateCtx?.invitedBy ?? null}
        enabled={gateCtx ? gateCtx.enabled : true}
        onSignIn={() => openShopperAuth()}
      />
    );
  } else if (loadErr || !data) {
    body = (
      <div className="space-y-4">
        <TabError message={loadErr ?? "Could not load your affiliate account."} onRetry={() => void refresh()} />
      </div>
    );
  } else if (!data.activated) {
    body = data.settings.enabled ? (
      <ActivationPanel settings={data.settings} invitedBy={data.invitedBy} onActivated={() => void refresh()} />
    ) : (
      <PausedCard />
    );
  } else if (data.profile.status !== "active") {
    body = <AccountStatusCard status={data.profile.status} />;
  } else {
    const { profile, settings } = data;
    // P2 gating: Collections & Showcase are deferred features. Both default to
    // HIDDEN while the flags are unknown (fail closed) — only an explicit
    // `true` from /api/affiliate/me surfaces the tabs. A stale persisted tab
    // (e.g. a cached “collections” deep link) falls back to Overview below.
    const collectionsEnabled = settings.collectionsEnabled === true;
    const showcaseEnabled = settings.showcaseEnabled === true;
    const visibleTabs = TABS.filter(
      (t) => (t.key !== "collections" || collectionsEnabled) && (t.key !== "showcase" || showcaseEnabled)
    );
    const activeTab: AffiliateTabKey =
      (tab === "collections" && !collectionsEnabled) || (tab === "showcase" && !showcaseEnabled) ? "overview" : tab;
    body = (
      <>
        {/* tab bar */}
        <div className="sticky top-[57px] z-20 -mx-3 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-4 sm:px-4">
          <div className="flex gap-1 overflow-x-auto py-2" role="tablist" aria-label="Affiliate hub sections">
            {visibleTabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={activeTab === key}
                onClick={() => switchTab(key)}
                className={cn(
                  "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-bold transition-colors sm:text-[13px]",
                  activeTab === key ? "bg-brand-gradient text-white shadow-glow-cyan-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-4">
          {activeTab === "overview" ? (
            <OverviewTab settings={settings} onNavigate={switchTab} />
          ) : activeTab === "discover" ? (
            <DiscoverTab onCreateLink={(p) => openLinkDialog(p)} />
          ) : activeTab === "links" ? (
            <LinksTab onCreate={() => openLinkDialog(null)} />
          ) : activeTab === "collections" ? (
            <CollectionsTab ctx={ctx} />
          ) : activeTab === "showcase" ? (
            <ShowcaseTab ctx={ctx} profile={profile} />
          ) : activeTab === "network" ? (
            <NetworkTab settings={settings} joinCode={profile.code} />
          ) : activeTab === "earnings" ? (
            <EarningsTab settings={settings} />
          ) : (
            <PayoutsTab />
          )}
        </div>

        {/* link creation dialog — shared by Links tab + Discover cards */}
        <LinkCreateDialog
          open={linkOpen}
          onOpenChange={setLinkOpen}
          preset={linkDraft}
          collectionsEnabled={collectionsEnabled}
          showcaseEnabled={showcaseEnabled}
          onCreated={() => {
            if (activeTab !== "links") switchTab("links");
          }}
        />
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      {/* page header */}
      <div className="flex items-center gap-3 pb-4">
        {onBack ? (
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 shrink-0" onClick={onBack} aria-label="Back to dashboard">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        ) : null}
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-glow-cyan-sm" aria-hidden>
          <HandCoins className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-extrabold tracking-tight text-slate-900 sm:text-xl">Affiliate Hub</h1>
          <p className="truncate text-xs text-muted-foreground">Earn from products you genuinely recommend</p>
        </div>
        {data?.activated && data.profile.status === "active" ? (
          <div className="ml-auto hidden shrink-0 items-center gap-2 sm:flex">
            <CopyButton text={referralJoinUrl(data.profile.code)} label="Join link" />
          </div>
        ) : null}
      </div>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase cards
// ---------------------------------------------------------------------------

function SignInGate({
  invitedBy,
  enabled,
  onSignIn,
}: {
  invitedBy: string | null;
  enabled: boolean;
  onSignIn: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-xl py-6">
      <div className="relative overflow-hidden rounded-3xl border border-slate-200/80 bg-card p-8 text-center shadow-soft-card">
        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-teal-100/70 blur-2xl pointer-events-none" aria-hidden />
        <div className="absolute -bottom-12 -left-10 h-32 w-32 rounded-full bg-teal-50 blur-2xl pointer-events-none" aria-hidden />
        <div className="relative flex flex-col items-center gap-4">
          <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-brand-gradient text-white shadow-glow-cyan-sm" aria-hidden>
            <HandCoins className="h-7 w-7" />
          </span>
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900">Earn with the NOMOFEE Affiliate Programme</h2>
          <p className="max-w-md text-sm leading-relaxed text-slate-500">
            Share links to products you love. When someone buys through your link, you earn a commission from the
            seller-funded pool — no inventory, no fees.
          </p>
          {invitedBy ? (
            <p className="rounded-full border border-teal-200 bg-teal-50 px-4 py-1.5 text-xs font-bold text-teal-800">
              You were invited by @{invitedBy}
            </p>
          ) : null}
          {!enabled ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-900">
              The affiliate programme is paused right now — you can sign in, but activation is unavailable until it
              resumes.
            </p>
          ) : null}
          <Button onClick={onSignIn} className="min-h-[44px] bg-brand-gradient px-6 text-white shadow-glow-cyan-sm hover:brightness-110">
            Sign in / Create account
          </Button>
        </div>
      </div>
    </div>
  );
}

function PausedCard() {
  return (
    <div className="mx-auto w-full max-w-xl py-6">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-amber-600" aria-hidden />
        <h2 className="pt-3 text-lg font-extrabold text-amber-900">Programme paused</h2>
        <p className="pt-1 text-sm text-amber-900/80">
          The affiliate programme is temporarily paused. Your account is safe — check back later.
        </p>
      </div>
    </div>
  );
}

function AccountStatusCard({ status }: { status: string }) {
  const suspended = status === "suspended";
  return (
    <div className="mx-auto w-full max-w-xl py-6">
      <div className={cn("rounded-2xl border p-6 text-center", suspended ? "border-rose-200 bg-rose-50" : "border-rose-200 bg-rose-50")}>
        <Ban className="mx-auto h-10 w-10 text-rose-600" aria-hidden />
        <h2 className="pt-3 text-lg font-extrabold text-rose-900">
          {status === "suspended" ? "Account suspended" : status === "terminated" ? "Account terminated" : "Account unavailable"}
        </h2>
        <p className="pt-1 text-sm text-rose-900/80">
          {suspended
            ? "Your affiliate account is suspended — balances are frozen and links stop attributing while reviewed."
            : "This affiliate account has been terminated. Historical records remain available to our team on request."}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activation flow
// ---------------------------------------------------------------------------

const TERMS_SUMMARY = [
  "Earn only from eligible, seller-funded sales driven by your links — never from clicks or sign-ups.",
  "No recruitment bonuses: the programme rewards genuine product recommendations, one level deep.",
  "The commission pool splits 90% to you and 10% to your sponsor (when you have one).",
  "Refunds reverse commissions — including amounts already paid out (offset against future earnings).",
  "Buying through your own links is never eligible for commission.",
  "Your sponsor relationship is permanent once activated — choose carefully.",
];

function ActivationPanel({
  settings,
  invitedBy,
  onActivated,
}: {
  settings: AffiliateSettingsT;
  invitedBy: string | null;
  onActivated: () => void;
}) {
  const meState = useApp((s) => s.me);
  const shopper = meState.loaded ? meState.shopper : null;
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [slug, setSlug] = useState("");
  const [sponsorCode, setSponsorCode] = useState("");
  const [confirmSponsor, setConfirmSponsor] = useState(false);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrated = useRef(false);

  // Prefill display name from the signed-in shopper (once).
  useEffect(() => {
    if (hydrated.current || !shopper) return;
    hydrated.current = true;
    setDisplayName(shopper.fullName);
  }, [shopper]);

  const submit = async () => {
    setError(null);
    if (!terms) {
      setError("Please accept the affiliate programme terms first.");
      return;
    }
    if (invitedBy && !confirmSponsor) {
      setError("Confirm the sponsor relationship shown above, or continue without it by leaving the confirmation unticked (the invitation cannot be re-applied later).");
      return;
    }
    if (!invitedBy && sponsorCode.trim() && !confirmSponsor) {
      setError("Tick the confirmation to use this sponsor code — the relationship is permanent.");
      return;
    }
    setBusy(true);
    try {
      await affPost("/api/affiliate/activate", {
        displayName: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
        slug: slug.trim() || undefined,
        sponsorCode: !invitedBy && sponsorCode.trim() ? sponsorCode.trim() : undefined,
        sponsorConfirmed: confirmSponsor,
        termsAccepted: true,
      });
      toast.success("Welcome to the NOMOFEE Affiliate Programme!");
      onActivated();
    } catch (e) {
      const af = e as { status?: number; code?: string; message?: string };
      if (af.code === "ALREADY_AFFILIATE") {
        toast.info("You're already an affiliate");
        onActivated();
        return;
      }
      if (af.code === "AFFILIATE_DISABLED") {
        setError(af.message ?? "The affiliate programme is currently paused.");
      } else {
        setError(af.message ?? "Activation failed — please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-6">
      <div className="rounded-2xl border bg-card p-5 shadow-soft-card sm:p-6">
        <h2 className="flex items-center gap-2 text-base font-extrabold text-slate-900">
          <BadgeCheck className="h-5 w-5 text-teal-700" aria-hidden /> Activate your affiliate account
        </h2>
        <p className="pt-1 text-xs text-muted-foreground">
          Free to join. You can update how your name appears later — but the sponsor decision below is permanent.
        </p>

        {invitedBy ? (
          <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50/70 p-4" role="note">
            <p className="text-sm font-bold text-teal-900">You were invited by @{invitedBy}</p>
            <p className="pt-1 text-xs leading-relaxed text-teal-900/80">
              Accepting makes this person your permanent sponsor: they earn 10% of the commission pool on your future
              eligible sales, and you keep 90%. This cannot be changed later.
            </p>
            <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-lg bg-white/70 px-3 text-xs font-semibold text-teal-900">
              <Checkbox checked={confirmSponsor} onCheckedChange={(v) => setConfirmSponsor(v === true)} aria-label="Confirm permanent sponsor relationship" />
              Confirm permanent sponsor relationship with @{invitedBy}
            </label>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="aff-sponsor-code" className="text-xs font-bold text-slate-700">
                Sponsor code (optional)
              </Label>
              <Input
                id="aff-sponsor-code"
                value={sponsorCode}
                onChange={(e) => setSponsorCode(e.target.value)}
                placeholder="e.g. a1b2c3d4e5 — only if a friend shared their code"
                className="min-h-[44px]"
                maxLength={32}
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground">Leave empty if nobody invited you.</p>
            </div>
            {sponsorCode.trim() ? (
              <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-lg border border-teal-200 bg-teal-50/70 px-3 text-xs font-semibold text-teal-900">
                <Checkbox checked={confirmSponsor} onCheckedChange={(v) => setConfirmSponsor(v === true)} aria-label="Confirm permanent sponsor relationship" />
                Make this my permanent sponsor (cannot be changed later)
              </label>
            ) : null}
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="aff-display-name" className="text-xs font-bold text-slate-700">
              Public display name
            </Label>
            <Input
              id="aff-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How you appear on your public page"
              className="min-h-[44px]"
              maxLength={60}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="aff-bio" className="text-xs font-bold text-slate-700">
              Short bio (optional)
            </Label>
            <Textarea
              id="aff-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="What do you recommend? e.g. Tech finds under RM100, honest reviews."
              className="min-h-[80px]"
              maxLength={500}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="aff-slug" className="text-xs font-bold text-slate-700">
              Custom page address (optional)
            </Label>
            <Input
              id="aff-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="your-name"
              className="min-h-[44px]"
              maxLength={24}
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">Letters, numbers and dashes — your page becomes /?aff=your-name</p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-extrabold uppercase tracking-wide text-slate-500">Affiliate terms — the short version</p>
          <ul className="mt-2 space-y-1.5">
            {TERMS_SUMMARY.map((t) => (
              <li key={t} className="flex gap-2 text-[11px] leading-snug text-slate-600">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-teal-600" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
          <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-2.5 text-xs font-semibold text-slate-800">
            <Checkbox checked={terms} onCheckedChange={(v) => setTerms(v === true)} aria-label="Accept affiliate programme terms" />
            I have read and accept the affiliate programme terms
          </label>
        </div>

        {error ? (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800" role="alert">
            {error}
          </p>
        ) : null}

        <Button
          type="button"
          disabled={busy || !terms}
          onClick={() => void submit()}
          className="mt-4 min-h-[44px] w-full bg-brand-gradient text-white shadow-glow-cyan-sm hover:brightness-110"
        >
          {busy ? "Activating…" : "Activate affiliate account"}
        </Button>
        <p className="pt-2 text-center text-[11px] text-muted-foreground">
          Review window: {settings.reviewDays} day{settings.reviewDays === 1 ? "" : "s"} before commissions become
          payable · Minimum payout {money(settings.minPayoutMinor)}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

const DAY_WINDOWS = [30, 60, 90] as const;

function OverviewTab({ settings, onNavigate }: { settings: AffiliateSettingsT; onNavigate: (t: AffiliateTabKey) => void }) {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<HubOverviewT | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<"clicks" | "orders" | "commissionMinor">("clicks");

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setErr(null);
    try {
      setData(await affGet<HubOverviewT>(`/api/affiliate/overview?days=${d}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load your overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  if (err) return <TabError message={err} onRetry={() => void load(days)} />;

  if (loading || !data) return <TabSkeleton />;

  const e = data.earnings;
  const allZero =
    data.estimated.clicks + data.estimated.productViews + data.estimated.addToCart === 0 &&
    data.commerce.attributedOrders === 0 &&
    e.personalDirectMinor === 0 &&
    e.sponsorMinor === 0;

  if (allZero) {
    return (
      <div className="space-y-4">
        <SectionCard title="Period" action={<DaysToggle days={days} onChange={setDays} />}>
          <EmptyState
            icon={MousePointerClick}
            title="No tracked activity yet"
            hint="Nothing has been recorded for this window. Share your links — clicks, orders and commissions will show up here as they happen. Nothing is back-filled or estimated in advance."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" className="min-h-[44px] bg-brand-gradient text-white" onClick={() => onNavigate("links")}>
                  Create your first link
                </Button>
                <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => onNavigate("discover")}>
                  Browse products
                </Button>
              </div>
            }
          />
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionCard title="Traffic & engagement" badge={<EstBadge />} action={<DaysToggle days={days} onChange={setDays} />}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Link clicks" value={data.estimated.clicks.toLocaleString()} hint="Promotional link opens" />
          <StatCard label="Unique visitors" value={data.estimated.uniqueVisitors.toLocaleString()} hint="Distinct people who clicked" />
          <StatCard label="Product views" value={data.estimated.productViews.toLocaleString()} hint="Via your affiliate links" />
          <StatCard label="Add-to-cart" value={data.estimated.addToCart.toLocaleString()} hint="Items added after a click" />
        </div>
        <p className="pt-2 text-[11px] leading-snug text-muted-foreground">
          Estimated figures come from attribution touches and tagged analytics events. They are advisory — commissions
          are always computed from real orders.
        </p>
      </SectionCard>

      <SectionCard title="Commerce" badge={<AuthoritativeBadge />}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Attributed orders" value={data.commerce.attributedOrders.toLocaleString()} hint="Orders touched by your links" tone="brand" />
          <StatCard label="Paid orders" value={data.commerce.paidOrders.toLocaleString()} hint="Payment confirmed" />
          <StatCard label="Eligible sales" value={money(data.commerce.eligibleSalesMinor)} hint="Commissionable base" />
          <StatCard label="Reversed" value={money(data.commerce.reversedMinor)} hint="Refunded commissions" tone={data.commerce.reversedMinor > 0 ? "danger" : "default"} />
        </div>
      </SectionCard>

      <SectionCard title="Earnings" badge={<AuthoritativeBadge />}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Personal promotion (90%)" value={money(e.personalDirectMinor)} hint="Your share of pools you drove" tone="brand" />
          <StatCard
            label="Sponsor earnings (10%)"
            value={money(e.sponsorMinor)}
            hint={settings.sponsorEnabled ? "From referrals you sponsored" : "Sponsor override disabled"}
          />
          <StatCard label="Requestable now" value={money(e.requestableMinor)} hint="Available for payout" tone="brand" />
          <StatCard label="Pending" value={money(e.pendingMinor)} hint="Awaiting approval" tone="warn" />
          <StatCard label="Approved" value={money(e.approvedMinor)} hint="Review window running" />
          <StatCard label="Available" value={money(e.availableMinor)} hint="Matured, unclaimed" />
          <StatCard label="Payout in flight" value={money(e.payoutInFlightMinor)} hint="Claimed by a payout request" />
          <StatCard label="Paid out" value={money(e.paidMinor)} hint="Lifetime settled" />
          <StatCard label="Held" value={money(e.heldMinor)} hint="Under review" tone={e.heldMinor > 0 ? "warn" : "default"} />
          <StatCard label="Reversed" value={money(e.reversedMinor)} hint="Refund reversals" tone={e.reversedMinor > 0 ? "danger" : "default"} />
          <StatCard label="Recovery" value={money(e.recoveryMinor)} hint="Late refunds after payout" tone={e.recoveryMinor > 0 ? "danger" : "default"} />
        </div>
        {!settings.sponsorEnabled && e.sponsorMinor === 0 ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-600">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Sponsor earnings are switched off platform-wide (sponsor override disabled), so this figure only reflects
            historical entries recorded while it was enabled — it is not a live earning stream right now.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="Your network" badge={<AuthoritativeBadge />}>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Direct referrals" value={data.network.directReferrals.toLocaleString()} />
          <StatCard label="Activated" value={data.network.activatedAffiliates.toLocaleString()} />
          <StatCard label="With sales" value={data.network.affiliatesWithSales.toLocaleString()} />
        </div>
        <p className="pt-2 text-[11px] text-muted-foreground">One level only — you see the people you directly invited, never a downline tree.</p>
      </SectionCard>

      <SectionCard
        title="Daily activity"
        badge={<EstBadge />}
        action={
          <div className="flex gap-1" role="group" aria-label="Chart metric">
            {(["clicks", "orders", "commissionMinor"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetric(m)}
                aria-pressed={metric === m}
                className={cn(
                  "min-h-[32px] rounded-full border px-2.5 text-[11px] font-bold transition-colors",
                  metric === m ? "border-teal-700 bg-teal-700 text-white" : "border-border bg-card text-muted-foreground hover:bg-muted"
                )}
              >
                {m === "clicks" ? "Clicks" : m === "orders" ? "Orders" : "Pool"}
              </button>
            ))}
          </div>
        }
      >
        <MiniSeriesChart series={data.series} metric={metric} />
      </SectionCard>
    </div>
  );
}

function DaysToggle({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Date range">
      {DAY_WINDOWS.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          aria-pressed={days === d}
          className={cn(
            "min-h-[32px] rounded-full border px-2.5 text-[11px] font-bold transition-colors",
            days === d ? "border-teal-700 bg-teal-700 text-white" : "border-border bg-card text-muted-foreground hover:bg-muted"
          )}
        >
          {d}d
        </button>
      ))}
    </div>
  );
}

/** Lightweight bar chart — plain divs, no chart lib, honest zero rendering. */
function MiniSeriesChart({
  series,
  metric,
}: {
  series: { date: string; clicks: number; orders: number; commissionMinor: number }[];
  metric: "clicks" | "orders" | "commissionMinor";
}) {
  const max = Math.max(1, ...series.map((d) => d[metric]));
  const labelEvery = series.length > 45 ? 15 : series.length > 20 ? 7 : 5;
  return (
    <div>
      <div className="flex h-28 items-end gap-[2px]" role="img" aria-label={`Daily ${metric} over the selected window`}>
        {series.map((d) => {
          const v = d[metric];
          const pct = Math.round((v / max) * 100);
          return (
            <div
              key={d.date}
              className="group relative flex-1"
              title={`${d.date}: ${metric === "commissionMinor" ? money(v) : v.toLocaleString()}`}
            >
              <div
                className={cn(
                  "w-full rounded-t-sm transition-all",
                  metric === "clicks" ? "bg-teal-600/80 group-hover:bg-teal-700" : metric === "orders" ? "bg-amber-500/80 group-hover:bg-amber-600" : "bg-emerald-600/80 group-hover:bg-emerald-700",
                  v === 0 && "bg-slate-200 group-hover:bg-slate-300"
                )}
                style={{ height: `${v === 0 ? 2 : Math.max(6, pct)}%`, minHeight: 2 }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between pt-1.5 text-[10px] text-muted-foreground tabular-nums">
        <span>{series[0]?.date ?? ""}</span>
        <span>{series[series.length - 1]?.date ?? ""}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discover tab
// ---------------------------------------------------------------------------

const SORT_OPTIONS = [
  { key: "featured", label: "Featured" },
  { key: "rate", label: "Highest rate" },
  { key: "sales", label: "Best selling" },
  { key: "price_asc", label: "Price: low to high" },
  { key: "price_desc", label: "Price: high to low" },
  { key: "newest", label: "Newest" },
] as const;

const MIN_RATE_OPTIONS = [
  { value: "any", label: "Any rate", bps: null },
  { value: "100", label: "1%+", bps: 100 },
  { value: "300", label: "3%+", bps: 300 },
  { value: "500", label: "5%+", bps: 500 },
  { value: "800", label: "8%+", bps: 800 },
  { value: "1000", label: "10%+", bps: 1000 },
] as const;

function DiscoverTab({ onCreateLink }: { onCreateLink: (p: DiscoverProductT) => void }) {
  const [qInput, setQInput] = useState("");
  const q = useDebouncedValue(qInput, 400);
  const [store, setStore] = useState("all");
  const [sort, setSort] = useState<string>("featured");
  const [minRate, setMinRate] = useState<string>("any");
  const [maxPrice, setMaxPrice] = useState("");
  const [page, setPage] = useState(1);
  const dMaxPrice = useDebouncedValue(maxPrice, 500);
  const maxPriceMinor = dMaxPrice.trim() && Number(dMaxPrice) > 0 ? toMinor(dMaxPrice) : null;

  const feed = useDiscoverFeed({
    q,
    store: store === "all" ? "" : store,
    sort,
    minRateBps: MIN_RATE_OPTIONS.find((o) => o.value === minRate)?.bps ?? null,
    maxPriceMinor,
    page,
    enabled: true,
  });

  // Pagination resets happen inside the filter handlers above (event-driven —
  // no effect needed).

  const rows = feed.data?.rows ?? [];
  const total = feed.data?.total ?? 0;

  if (feed.data?.paused) {
    return (
      <EmptyState
        icon={Store}
        title="Discovery is paused"
        hint="The affiliate programme is temporarily paused — product discovery will return when it resumes."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* filter bar */}
      <div className="rounded-xl border bg-card p-3 shadow-soft-card sm:p-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={qInput}
              onChange={(ev) => {
                setQInput(ev.target.value);
                setPage(1);
              }}
              placeholder="Search products or stores"
              className="min-h-[44px] pl-9"
              aria-label="Search participating products"
            />
          </div>
          <Select
            value={store}
            onValueChange={(v) => {
              setStore(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="min-h-[44px]" aria-label="Filter by store">
              <SelectValue placeholder="All stores" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stores</SelectItem>
              {feed.stores.map((s) => (
                <SelectItem key={s.slug} value={s.slug}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sort}
            onValueChange={(v) => {
              setSort(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="min-h-[44px]" aria-label="Sort products">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.key} value={o.key}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Select
              value={minRate}
              onValueChange={(v) => {
                setMinRate(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="min-h-[44px]" aria-label="Minimum commission rate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MIN_RATE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={maxPrice}
              onChange={(ev) => {
                setMaxPrice(ev.target.value);
                setPage(1);
              }}
              type="number"
              inputMode="decimal"
              min={0}
              placeholder="Max RM"
              className="min-h-[44px]"
              aria-label="Maximum price in RM"
            />
          </div>
        </div>
      </div>

      {feed.error ? <TabError message={feed.error} onRetry={() => feed.reload()} /> : null}

      {!feed.error && feed.loading && rows.length === 0 ? (
        <TabSkeleton rows={2} />
      ) : !feed.error && rows.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No participating products match"
          hint="Try clearing the filters — only products enrolled in the affiliate programme by opted-in stores appear here."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
            {rows.map((p) => (
              <DiscoverCard key={p.productId} p={p} onCreateLink={() => onCreateLink(p)} />
            ))}
          </div>
          <Pager
            page={page}
            size={24}
            total={total}
            rowCount={rows.length}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}
    </div>
  );
}

function DiscoverCard({ p, onCreateLink }: { p: DiscoverProductT; onCreateLink: () => void }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] border bg-card shadow-soft-card transition-all hover:-translate-y-0.5 hover:border-teal-600/40 hover:shadow-md">
      <div className="relative aspect-square overflow-hidden bg-muted">
        {/* plain <img> — same convention as the shopper ProductCard */}
        {p.image ? (
          <img src={p.image} alt={p.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Store className="h-8 w-8" aria-hidden />
          </div>
        )}
        {p.isFeatured ? (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-bold text-white">Featured</span>
        ) : null}
        <span className="absolute right-1.5 top-1.5 rounded-full bg-teal-700 px-2 py-0.5 text-[10px] font-bold text-white shadow">
          {ratePercent(p.rateBps)} rate
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-2.5">
        <h3 className="line-clamp-2 min-h-[2rem] text-xs font-medium leading-snug">{p.title}</h3>
        <p className="truncate text-[11px] text-muted-foreground">{p.storeName}</p>
        <div className="flex items-baseline justify-between gap-1">
          <span className="text-sm font-bold text-teal-700">{money(p.priceMinor)}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{p.salesCount} sold</span>
        </div>
        <p className="text-[11px] font-semibold text-emerald-700">≈ {money(p.estimatedCommissionMinor)} / sale</p>
        <Button
          type="button"
          size="sm"
          className="mt-auto min-h-[44px] w-full gap-1 bg-teal-700 text-xs text-white hover:bg-teal-800"
          onClick={onCreateLink}
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden /> Create link
        </Button>
      </div>
    </div>
  );
}


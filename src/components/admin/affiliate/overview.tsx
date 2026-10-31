"use client";
// AFF-01 — Affiliate Programme overview: stat cards, READ-ONLY settings
// summary (editing lives in System → Settings) and the sponsor-override
// launch-gate callout. Data: GET /api/admin/affiliate/overview
// (cap: affiliate.manage OR affiliate.finance).
import {
  ArrowUpRight,
  BadgeCheck,
  Megaphone,
  PauseCircle,
  ReceiptText,
  Scale,
  ScrollText,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { AdminNav } from "../nav";
import { useAdminCaps } from "../use-admin-caps";
import { useApi } from "../use-api";
import { CardsSkeleton, ErrorState, KpiCard, Money, PageHeader } from "../ui-bits";
import { bpsLabel, type AffiliateOverviewBody, type ReconciliationReport } from "./types";

export function AffiliateOverviewView({ nav }: { nav: AdminNav }) {
  const { can } = useAdminCaps();
  const { data, error, loading, refetch } = useApi<AffiliateOverviewBody>("/api/admin/affiliate/overview");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Affiliate Programme"
        description="Sponsorship economics, review queue and payout liability — read-only rollup of the whole programme."
      />

      {error ? (
        <Card className="py-0">
          <CardContent className="p-4">
            <ErrorState message={error} onRetry={() => void refetch()} />
          </CardContent>
        </Card>
      ) : loading ? (
        <CardsSkeleton n={6} />
      ) : data ? (
        <>
          <LaunchGate settings={data.settings} />
          <KpiGrid
            nav={nav}
            recon={data.reconciliation}
            affiliates={data.counts.affiliates}
            suspended={data.counts.suspended}
          />
          <SettingsSummary nav={nav} canManageSettings={can("settings.manage")} body={data} />
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- launch gate */

function LaunchGate({ settings }: { settings: AffiliateOverviewBody["settings"] }) {
  if (!settings.enabled) {
    return (
      <div
        className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40"
        role="alert"
      >
        <PauseCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <div>
          <p className="text-sm font-semibold text-red-800 dark:text-red-300">Programme paused — kill switch is OFF</p>
          <p className="mt-1 text-xs text-red-700 dark:text-red-400/90">
            <span className="font-mono text-[11px]">affiliate.enabled</span> is false: no new commission liabilities are
            computed at checkout or posted at payment, and attribution stops recording. Existing commission records are
            immutable. Re-enable in System → Settings.
          </p>
        </div>
      </div>
    );
  }
  if (!settings.sponsorEnabled) {
    return (
      <div
        className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40"
        role="status"
      >
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">
            Sponsor override (90/10) ships disabled pending legal clearance (DSA 1993/KPDN) — see
            docs/affiliate/rollout-checklist.md
          </p>
          <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-400/90">
            Direct affiliates currently receive 100% of every commission pool. The one-level sponsor split only starts
            applying to NEW commissions once cleared and enabled — existing records keep their original split.
          </p>
        </div>
      </div>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ KPIs */

function KpiGrid({
  nav,
  recon,
  affiliates,
  suspended,
}: {
  nav: AdminNav;
  recon: ReconciliationReport;
  affiliates: number;
  suspended: number;
}) {
  const { can } = useAdminCaps();
  const openPayouts = recon.payoutsByStatus
    .filter((p) => p.status === "requested" || p.status === "processing")
    .reduce((s, p) => ({ count: s.count + p.count, amountMinor: s.amountMinor + p.amountMinor }), {
      count: 0,
      amountMinor: 0,
    });

  const cards: {
    label: string;
    value: ReactNode;
    sub?: ReactNode;
    icon: LucideIcon;
    tone?: "emerald" | "amber" | "red" | "teal" | "plain";
    onClick?: () => void;
  }[] = [
    {
      label: "Affiliates",
      value: affiliates,
      sub: `${suspended} suspended`,
      icon: Users,
      tone: "teal" as const,
      onClick: can("affiliate.manage") ? () => nav.navigate("affiliate-accounts") : undefined,
    },
    {
      label: "Commissions posted",
      value: recon.commissionCount,
      sub: (
        <>
          pool <Money minor={recon.points.expectedPoolMinor} muted /> · allocated{" "}
          <Money minor={recon.points.allocatedMinor} muted />
        </>
      ),
      icon: ReceiptText,
      onClick: () => nav.navigate("affiliate-commissions"),
    },
    {
      label: "Held / pending review",
      value: <Money minor={recon.points.heldMinor} />,
      sub: `${recon.pendingEntryCount} entr${recon.pendingEntryCount === 1 ? "y" : "ies"} awaiting maturity`,
      icon: ShieldAlert,
      tone: recon.points.heldMinor > 0 ? "amber" : "plain",
    },
    {
      label: "Available (incl. approved)",
      value: <Money minor={recon.points.availableMinor} bold />,
      sub: "requestable by affiliates now",
      icon: Wallet,
      tone: "emerald" as const,
    },
    {
      label: "Paid out",
      value: <Money minor={recon.points.paidOutMinor} />,
      sub: "lifetime settled payouts",
      icon: BadgeCheck,
    },
    {
      label: "Reversals",
      value: <Money minor={recon.points.reversalsMinor} />,
      sub: "refunds clawed back from pools",
      icon: ArrowUpRight,
      tone: recon.points.reversalsMinor > 0 ? "amber" : "plain",
    },
    {
      label: "Open payouts",
      value: openPayouts.count,
      sub:
        openPayouts.count > 0 ? (
          <>
            <Money minor={openPayouts.amountMinor} muted /> in the queue
          </>
        ) : (
          "queue is clear"
        ),
      icon: Wallet,
      tone: openPayouts.count > 0 ? "amber" : "plain",
      onClick: can("affiliate.finance") ? () => nav.navigate("affiliate-payouts") : undefined,
    },
    {
      label: "Liability outstanding",
      value: <Money minor={recon.points.remainingLiabilityMinor} bold />,
      sub: recon.invariantOk ? (
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
          <ShieldCheck className="h-3 w-3" /> ledger invariant OK
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 font-semibold text-red-600 dark:text-red-400">
          <ShieldAlert className="h-3 w-3" /> variance — check reconciliation
        </span>
      ),
      icon: Scale,
      tone: recon.invariantOk ? "emerald" : "red",
      onClick: can("affiliate.finance") ? () => nav.navigate("affiliate-reconciliation") : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((c) => (
        <KpiCard key={c.label} label={c.label} value={c.value} sub={c.sub} icon={c.icon} onClick={c.onClick} tone={c.tone} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- settings */

const SETTING_ROWS: { key: keyof AffiliateOverviewBody["settings"]; label: string; hint: string }[] = [
  { key: "enabled", label: "Programme enabled (kill switch)", hint: "affiliate.enabled" },
  { key: "sponsorEnabled", label: "Sponsor override (90/10 split)", hint: "affiliate.sponsor_enabled" },
  { key: "maxRateBps", label: "Max commission rate", hint: "affiliate.max_rate_bps" },
  { key: "attrWindowDays", label: "Product attribution window", hint: "affiliate.attr_window_days" },
  { key: "sponsorWindowDays", label: "Referral (sponsor) window", hint: "affiliate.sponsor_window_days" },
  { key: "reviewDays", label: "Commission review window", hint: "affiliate.review_days" },
  { key: "minPayoutMinor", label: "Minimum payout", hint: "affiliate.min_payout_minor" },
];

function SettingsSummary({
  nav,
  canManageSettings,
  body,
}: {
  nav: AdminNav;
  canManageSettings: boolean;
  body: AffiliateOverviewBody;
}) {
  const s = body.settings;
  const value = (key: keyof AffiliateOverviewBody["settings"]) => {
    switch (key) {
      case "enabled":
      case "sponsorEnabled":
        return (
          <Badge
            variant="outline"
            className={cn(
              s[key]
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
                : "border-slate-200 bg-slate-100 text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
            )}
          >
            {s[key] ? "on" : "off"}
          </Badge>
        );
      case "maxRateBps":
        return (
          <span className="tabular-nums">
            {bpsLabel(s.maxRateBps)} <span className="text-muted-foreground">({s.maxRateBps} bps ceiling)</span>
          </span>
        );
      case "attrWindowDays":
        return <span className="tabular-nums">{s.attrWindowDays} days</span>;
      case "sponsorWindowDays":
        return <span className="tabular-nums">{s.sponsorWindowDays} days</span>;
      case "reviewDays":
        return <span className="tabular-nums">{s.reviewDays} days</span>;
      case "minPayoutMinor":
        return <Money minor={s.minPayoutMinor} />;
      default:
        return String(s[key]);
    }
  };

  return (
    <Card className="py-0">
      <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ScrollText className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden />
          Programme settings
          <Badge variant="outline" className="font-normal text-muted-foreground">
            read-only
          </Badge>
        </CardTitle>
        <CardDescription>
          Live values served by the overview API — the same seven keys the affiliate engine reads at checkout, payment
          posting and payout requests.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 sm:px-6">
        <div className="overflow-hidden rounded-lg border">
          {SETTING_ROWS.map((row, i) => (
            <div
              key={row.key}
              className={cn("flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm", i > 0 && "border-t")}
            >
              <div className="min-w-0">
                <p className="font-medium">{row.label}</p>
                <p className="font-mono text-[10px] text-muted-foreground">{row.hint}</p>
              </div>
              <div className="text-sm">{value(row.key)}</div>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            <Megaphone className="mr-1 inline h-3 w-3" aria-hidden />
            Split-attribution config lives in the settings registry, group “Affiliate”.
          </p>
          {canManageSettings ? (
            <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => nav.navigate("settings")}>
              <Settings className="h-3.5 w-3.5" /> Edit in System → Settings
            </Button>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Editing requires the superadmin <span className="font-mono">settings.manage</span> capability — the System
              → Settings entry is hidden for your role.
            </p>
          )}
        </div>
        <Separator className="mt-4" />
        <p className="pt-3 text-[11px] text-muted-foreground">
          {body.counts.links} referral links · {body.counts.attributionTouches} attribution touches recorded. Role-level
          (direct vs sponsor) split totals are inspectable per row in Commissions.
        </p>
      </CardContent>
    </Card>
  );
}

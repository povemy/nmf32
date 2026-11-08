"use client";
// Seller affiliate programme (spec §7): store opt-in + default commission rate
// (Programme tab), per-product enrollment / rate overrides (Products tab) and
// attributed performance + commission liabilities (Report tab). The tab
// discriminator rides on SellerNav.affiliateTab — same pattern as settingsTab
// and walletTab, so deep links keep working.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  apiSend,
  CardsSkeleton,
  EmptyState,
  RowsSkeleton,
  StatCard,
  StatusChip,
  fmtCommissionPercent,
  fmtDate,
  formatMinor,
  runMutation,
  useApi,
  useDebouncedCallback,
  type AffiliateTab,
  type SellerNav,
} from "./ui-bits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Banknote,
  ChartColumn,
  CirclePause,
  Coins,
  Eye,
  HandCoins,
  ImageIcon,
  Loader2,
  MousePointerClick,
  Network,
  Package,
  ReceiptText,
  RotateCcw,
  Save,
  Search,
  Share2,
  ShoppingBag,
  UserCheck,
  Wallet2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  AffiliateProductBody,
  AffiliateProductData,
  AffiliateProductRow as AffiliateProduct,
  AffiliateProgrammeData,
  AffiliateProductsData,
  AffiliateReportData,
  AffiliateSettingsBody,
  AffiliateSettingsData,
} from "@/lib/types/api-contract";

// ---------------------------------------------------------------- helpers

/** 850 → "8.5" (1 decimal) — seed value for the percent inputs. */
function bpsToPercentInput(bps: number): string {
  return (bps / 100).toFixed(1);
}

/** Percent text → basis points, or null when blank/unparseable/out of range. */
function percentTextToBps(text: string, maxRateBps: number): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const pct = Number(trimmed);
  if (!Number.isFinite(pct)) return null;
  const bps = Math.round(pct * 100);
  if (bps < 0 || bps > maxRateBps) return null;
  return bps;
}

// Commission statuses come raw from the API (pending|approved|available|paid|
// reversed|held). Same approach as the wallet's payout chip: a small local map
// so wording and tones stay consistent across the report table.
const COMMISSION_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  available: "Available",
  paid: "Paid",
  reversed: "Reversed",
  held: "Held",
};

const COMMISSION_CHIP_CLASS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  held: "bg-amber-100 text-amber-800 border-amber-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  available: "bg-emerald-100 text-emerald-800 border-emerald-200",
  paid: "bg-emerald-100 text-emerald-800 border-emerald-200",
  reversed: "bg-rose-100 text-rose-800 border-rose-200",
};

function CommissionStatusChip({ status, className }: { status: string; className?: string }) {
  const s = (status ?? "").toLowerCase();
  return (
    <Badge
      variant="outline"
      className={cn("border font-medium", COMMISSION_CHIP_CLASS[s] ?? "bg-muted text-muted-foreground border-border", className)}
    >
      {COMMISSION_STATUS_LABELS[s] ?? s.replace(/_/g, " ")}
    </Badge>
  );
}

// ---------------------------------------------------------------- root view

export default function SellerAffiliate({
  affiliateTab,
  onNavigate,
}: {
  affiliateTab?: AffiliateTab;
  onNavigate: (n: SellerNav) => void;
}) {
  return (
    <Tabs value={affiliateTab ?? "program"} onValueChange={(v) => onNavigate({ view: "affiliate", affiliateTab: v as AffiliateTab })}>
      <TabsList className="mb-4">
        <TabsTrigger value="program" className="min-h-[44px] gap-1.5">
          <Share2 className="h-3.5 w-3.5" aria-hidden /> Programme
        </TabsTrigger>
        <TabsTrigger value="products" className="min-h-[44px] gap-1.5">
          <Package className="h-3.5 w-3.5" aria-hidden /> Products
        </TabsTrigger>
        <TabsTrigger value="report" className="min-h-[44px] gap-1.5">
          <ChartColumn className="h-3.5 w-3.5" aria-hidden /> Report
        </TabsTrigger>
      </TabsList>
      <TabsContent value="program" className="mt-0">
        <ProgrammeTab />
      </TabsContent>
      <TabsContent value="products" className="mt-0">
        <ProductsTab />
      </TabsContent>
      <TabsContent value="report" className="mt-0">
        <ReportTab />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------- programme tab

function ProgrammeTab() {
  const { data, loading, error, refetch } = useApi<AffiliateProgrammeData>("/api/store/affiliate");
  const [optIn, setOptIn] = useState(false);
  const [rateText, setRateText] = useState("");
  const [busy, setBusy] = useState(false);

  // hydrate the controls from the server state (and re-seed after every save —
  // the refetch writes back the persisted opt-in + default rate)
  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setOptIn(data.optIn);
  }, [data?.optIn]);
  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setRateText(bpsToPercentInput(data.defaultRateBps));
  }, [data?.defaultRateBps]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-rose-600">Could not load the affiliate programme{error ? `: ${error}` : ""}</CardContent>
      </Card>
    );
  }

  const paused = !data.programmeEnabled;
  const maxPercent = fmtCommissionPercent(data.maxRateBps / 100);

  const saveOptIn = async (next: boolean) => {
    setOptIn(next);
    const ok = await runMutation(
      () => apiSend<AffiliateSettingsData>("PATCH", "/api/store/affiliate", { optIn: next } satisfies AffiliateSettingsBody),
      next ? "Your store joined the affiliate programme" : "Your store left the affiliate programme"
    );
    if (!ok) setOptIn(!next);
    else refetch();
  };

  const saveRate = async () => {
    const bps = percentTextToBps(rateText, data.maxRateBps);
    if (bps == null) {
      toast.error(`Rate must be between 0% and ${maxPercent}`);
      return;
    }
    setBusy(true);
    const ok = await runMutation(
      () => apiSend<AffiliateSettingsData>("PATCH", "/api/store/affiliate", { defaultRateBps: bps } satisfies AffiliateSettingsBody),
      `Default commission rate saved at ${fmtCommissionPercent(bps / 100)}`
    );
    setBusy(false);
    if (ok) refetch();
  };

  return (
    <div className="space-y-4">
      {paused ? (
        <Alert>
          <CirclePause />
          <AlertTitle>Affiliate programme paused</AlertTitle>
          <AlertDescription>
            The affiliate programme is currently paused platform-wide. Your opt-in, default rate and product enrollments are preserved — controls
            are disabled until it resumes.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* summary chips */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "border font-semibold",
            data.optIn ? "bg-emerald-50 text-emerald-700 border-emerald-200/70" : "bg-slate-100 text-slate-600 border-slate-200/70"
          )}
        >
          {data.optIn ? "Store opted in" : "Store not opted in"}
        </Badge>
        <Badge variant="outline" className="border bg-slate-100 font-semibold text-slate-600 border-slate-200/70">
          Enrolled products · {data.enrolledProducts} of {data.totalProducts}
        </Badge>
      </div>

      {/* participation */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <HandCoins className="h-4 w-4 text-primary" /> Store participation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
            <div>
              <p className="text-sm font-medium">Let buyers earn commission promoting your products</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                When enabled, buyers can earn commission promoting your enrolled products. Commission is deducted from your proceeds at checkout —
                never from platform revenue.
              </p>
            </div>
            <Switch checked={optIn} onCheckedChange={saveOptIn} disabled={paused} aria-label="Affiliate programme participation" />
          </div>
        </CardContent>
      </Card>

      {/* default rate */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Coins className="h-4 w-4 text-primary" /> Default commission rate
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="aff-default-rate">Default rate (%)</Label>
            <div className="flex gap-2">
              <div className="relative w-32">
                <Input
                  id="aff-default-rate"
                  inputMode="decimal"
                  value={rateText}
                  onChange={(e) => setRateText(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder={bpsToPercentInput(data.defaultRateBps)}
                  disabled={paused}
                  className="pr-7 tabular-nums"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
              </div>
              <Button onClick={saveRate} disabled={paused || busy || rateText.trim() === ""} className="min-h-[44px] gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save rate
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Current default {fmtCommissionPercent(data.defaultRateBps / 100)} · platform max {maxPercent}. Enrolled products without a per-product
              rate inherit this.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">Changes apply to future orders only. Existing order snapshots are never recalculated.</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- products tab

type EnrolledFilter = "all" | "enrolled" | "notEnrolled";

function ProductsTab() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EnrolledFilter>("all");
  const [page, setPage] = useState(1);
  const { run: debouncedSearch } = useDebouncedCallback((v: string) => {
    setQuery(v);
    setPage(1);
  }, 350);

  const params = new URLSearchParams();
  if (filter === "enrolled") params.set("enrolled", "true");
  if (filter === "notEnrolled") params.set("enrolled", "false");
  if (query.trim()) params.set("q", query.trim());
  params.set("page", String(page));
  params.set("size", "10");

  const { data, loading, error, refetch } = useApi<AffiliateProductsData>(`/api/store/affiliate/products?${params.toString()}`);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / 10));
  const filtering = query.trim() !== "" || filter !== "all";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose which products buyers can promote, and set per-product commission rates. Products without their own rate use your store default.
      </p>

      {!loading && data && !data.storeOptIn ? (
        <Alert>
          <HandCoins />
          <AlertDescription className="text-xs">
            Your store has not opted in yet — enable participation on the Programme tab before enrolling products. Per-product rates can still be
            prepared ahead.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search products…"
            className="pl-8"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              debouncedSearch(e.target.value);
            }}
          />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          value={filter}
          onValueChange={(v) => {
            if (!v) return;
            setFilter(v as EnrolledFilter);
            setPage(1);
          }}
          aria-label="Filter products by enrollment"
        >
          <ToggleGroupItem value="all" className="min-h-[44px] px-3">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="enrolled" className="min-h-[44px] px-3">
            Enrolled
          </ToggleGroupItem>
          <ToggleGroupItem value="notEnrolled" className="min-h-[44px] px-3">
            Not enrolled
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {loading ? (
        <RowsSkeleton rows={5} />
      ) : error || !data ? (
        <Card>
          <CardContent className="p-6 text-sm text-rose-600">Could not load products{error ? `: ${error}` : ""}</CardContent>
        </Card>
      ) : data.products.length === 0 ? (
        <EmptyState
          icon={<Package className="h-8 w-8" />}
          title={filtering ? "No matching products" : "No products yet"}
          hint={filtering ? "Try clearing the search or switching the enrollment filter." : "Create products first — then enroll them so buyers can earn commission promoting them."}
        />
      ) : (
        <div className="space-y-2">
          {data.products.map((p) => (
            <AffiliateProductRow
              key={p.id}
              product={p}
              maxRateBps={data.maxRateBps}
              storeDefaultRateBps={data.storeDefaultRateBps}
              storeOptIn={data.storeOptIn}
              onChanged={refetch}
            />
          ))}
        </div>
      )}

      {!loading && data && data.products.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {data.total} product{data.total === 1 ? "" : "s"} · page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AffiliateProductRow({
  product,
  maxRateBps,
  storeDefaultRateBps,
  storeOptIn,
  onChanged,
}: {
  product: AffiliateProduct;
  maxRateBps: number;
  storeDefaultRateBps: number;
  storeOptIn: boolean;
  onChanged: () => void;
}) {
  const [enabled, setEnabled] = useState(product.affiliateEnabled);
  const [rateText, setRateText] = useState(product.rateSource === "product" ? bpsToPercentInput(product.effectiveRateBps) : "");
  const [busy, setBusy] = useState(false);

  // re-seed the inline controls whenever the server row changes (post-save
  // refetch writes new affiliateEnabled / rateSource / effectiveRateBps)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setEnabled(product.affiliateEnabled);
  }, [product.affiliateEnabled]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setRateText(product.rateSource === "product" ? bpsToPercentInput(product.effectiveRateBps) : "");
  }, [product.rateSource, product.effectiveRateBps]);

  const toggleEnrollment = async (next: boolean) => {
    setEnabled(next);
    const ok = await runMutation(
      () => apiSend<AffiliateProductData>("PATCH", `/api/store/affiliate/products/${product.id}`, { enabled: next } satisfies AffiliateProductBody),
      next ? `${product.title} enrolled — buyers can now earn commission on it` : `${product.title} paused from the affiliate programme`
    );
    if (ok) onChanged();
    else setEnabled(!next);
  };

  const applyRate = async () => {
    const bps = percentTextToBps(rateText, maxRateBps);
    if (bps == null) {
      toast.error(`Rate must be between 0% and ${fmtCommissionPercent(maxRateBps / 100)}`);
      return;
    }
    setBusy(true);
    const ok = await runMutation(
      () => apiSend<AffiliateProductData>("PATCH", `/api/store/affiliate/products/${product.id}`, { rateBps: bps } satisfies AffiliateProductBody),
      `${product.title} commission rate set to ${fmtCommissionPercent(bps / 100)}`
    );
    setBusy(false);
    if (ok) onChanged();
  };

  // X = "reset to store default": drops the drafted text and, when the product
  // carries its own override, sends rateBps: null so it inherits the store rate.
  const resetRate = async () => {
    setRateText("");
    if (product.rateSource !== "product") return;
    setBusy(true);
    const ok = await runMutation(
      () => apiSend<AffiliateProductData>("PATCH", `/api/store/affiliate/products/${product.id}`, { rateBps: null } satisfies AffiliateProductBody),
      `${product.title} reset to the store default rate`
    );
    setBusy(false);
    if (ok) onChanged();
  };

  const canReset = rateText.trim() !== "" || product.rateSource === "product";

  return (
    <div className="rounded-xl border bg-card p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {product.image ? (
            <img src={product.image} alt={product.title} className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="max-w-64 truncate font-medium">{product.title}</p>
          <p className="text-xs text-muted-foreground">
            {formatMinor(product.priceMinor)} · {product.salesCount} sale{product.salesCount === 1 ? "" : "s"}
          </p>
        </div>
        <StatusChip status={product.status} />
        <Badge variant="outline" className="font-semibold">
          {fmtCommissionPercent(product.effectiveRateBps / 100)} · {product.rateSource === "product" ? "product rate" : "store default"}
        </Badge>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        <Switch
          checked={enabled}
          onCheckedChange={toggleEnrollment}
          disabled={busy || !storeOptIn}
          aria-label={`Affiliate enrollment for ${product.title}`}
        />
        <span className="text-xs font-medium text-muted-foreground">{enabled ? "Enrolled" : "Paused"}</span>
        {!storeOptIn ? <span className="text-xs text-amber-600">Enable the programme on the Programme tab to enroll products</span> : null}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-28">
            <Input
              inputMode="decimal"
              value={rateText}
              onChange={(e) => setRateText(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder={bpsToPercentInput(storeDefaultRateBps)}
              disabled={busy}
              aria-label={`Commission rate override for ${product.title}`}
              className="pr-7 tabular-nums"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
          {canReset ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={resetRate}
              disabled={busy}
              aria-label={`Reset ${product.title} to the store default rate`}
              title="Reset to store default rate"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={applyRate} disabled={busy || rateText.trim() === ""} className="gap-1.5">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- report tab

const DAY_WINDOWS = [7, 30, 90];

function ReportTab() {
  const [days, setDays] = useState(30);
  const { data, loading, error } = useApi<AffiliateReportData>(`/api/store/affiliate/report?days=${days}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Attributed traffic, orders and commission liabilities for the last {days} day{days === 1 ? "" : "s"}.
        </p>
        <ToggleGroup
          type="single"
          variant="outline"
          value={String(days)}
          onValueChange={(v) => v && setDays(Number(v))}
          aria-label="Report window"
        >
          {DAY_WINDOWS.map((d) => (
            <ToggleGroupItem key={d} value={String(d)} className="min-h-[44px] px-3">
              {d} days
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {loading ? (
        <div className="space-y-4">
          <CardsSkeleton count={6} />
          <RowsSkeleton rows={5} />
        </div>
      ) : error || !data ? (
        <Card>
          <CardContent className="p-6 text-sm text-rose-600">Could not load the affiliate report{error ? `: ${error}` : ""}</CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard label="Attributed clicks" value={String(data.clicks)} sub="Affiliate link clicks" icon={<MousePointerClick className="h-4 w-4" />} />
            <StatCard label="Product views" value={String(data.productViews)} sub="Product views via affiliate links" icon={<Eye className="h-4 w-4" />} />
            <StatCard label="Attributed orders" value={String(data.attributedOrders)} sub="Orders that earned commission" icon={<ShoppingBag className="h-4 w-4" />} />
            <StatCard label="Eligible sales" value={formatMinor(data.eligibleSalesMinor)} sub="Commissionable order value" icon={<Banknote className="h-4 w-4" />} />
            <StatCard label="Commission pool" value={formatMinor(data.totalPoolMinor)} sub="Commission owed at checkout" icon={<Coins className="h-4 w-4" />} />
            <StatCard label="Direct allocation" value={formatMinor(data.directAllocationMinor)} sub="90% to the referring affiliate" icon={<UserCheck className="h-4 w-4" />} />
            <StatCard label="Sponsor allocation" value={formatMinor(data.sponsorAllocationMinor)} sub="10% to the referring affiliate's sponsor" icon={<Network className="h-4 w-4" />} />
            <StatCard label="Reversals" value={formatMinor(data.reversalMinor)} sub="Clawed back on processed refunds" icon={<RotateCcw className="h-4 w-4" />} />
            <StatCard label="Current liability" value={formatMinor(data.currentLiabilityMinor)} sub="Owed to affiliates, net of reversals" icon={<Wallet2 className="h-4 w-4" />} />
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Recent commissions</h2>
              <Badge variant="outline" className="font-semibold">
                Enrolled products · {data.enrolledCount} of {data.totalProducts}
              </Badge>
            </div>
            {data.recentCommissions.length === 0 ? (
              <EmptyState
                icon={<ReceiptText className="h-8 w-8" />}
                title="No affiliate orders yet"
                hint="Affiliate-attributed orders will appear here once buyers purchase through affiliate links."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Base</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Pool</TableHead>
                      <TableHead className="text-right">Direct</TableHead>
                      <TableHead className="text-right">Sponsor</TableHead>
                      <TableHead className="text-right">Reversed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentCommissions.map((c, i) => (
                      <TableRow key={`${c.orderNumber}-${i}`}>
                        <TableCell className="font-mono text-sm font-semibold">{c.orderNumber}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fmtDate(c.createdAt)}</TableCell>
                        <TableCell>
                          <CommissionStatusChip status={c.status} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMinor(c.baseMinor)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtCommissionPercent(c.rateBps / 100)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMinor(c.poolMinor)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMinor(c.directMinor)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMinor(c.sponsorMinor)}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.reversedMinor > 0 ? formatMinor(c.reversedMinor) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

"use client";
// Seller Insights: one SPA view, six tabs (Overview / Cart activity /
// Products / Sales / Markets / Campaigns) over the frozen
// /api/store/insights/* contract. Every figure comes from the API — the
// server's honesty notes are rendered verbatim; nothing is fabricated
// client-side. Money fields are MYR minor units (formatMinor).
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, formatDistanceToNow, subDays } from "date-fns";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUpDown,
  BadgeDollarSign,
  Boxes,
  CalendarRange,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  Copy,
  Download,
  Eye,
  Globe,
  GraduationCap,
  Info,
  Lightbulb,
  Link2,
  Loader2,
  MapPin,
  Megaphone,
  MousePointerClick,
  Package,
  Plus,
  ReceiptText,
  RefreshCw,
  RotateCw,
  ShoppingBasket,
  ShoppingCart,
  Store,
  TrendingDown,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { FunnelCard, FUNNEL_WINDOW_PARAM, type FunnelApi, type FunnelData, type FunnelViewKey } from "./funnel-diagram";
import { TourGuide, type TourStep } from "./tour-guide";
import {
  apiGetPaged,
  apiSend,
  runMutation,
  CardsSkeleton,
  EmptyState,
  RowsSkeleton,
  StatCard,
  StatusChip,
  ageOf,
  formatMinor,
  useApi,
  type SellerNav,
} from "./ui-bits";

// ---------------------------------------------------------------- contract types
// Client-side mirror of the /api/store/insights/* response shapes (Task 5).

type InsightsWindowInfo = {
  key: string;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  days: number;
};

type Freshness = { eventsUpTo: string | null; trackingSince: string | null; note?: string | null };

type OverviewData = {
  window: InsightsWindowInfo;
  generatedAt: string;
  freshness: Freshness;
  traffic: {
    storeViews: number;
    storeViewsPrev: number;
    sessions: number;
    sessionsPrev: number;
    uniqueVisitors: number;
    uniqueVisitorsPrev: number;
    productViews: number;
    productViewsPrev: number;
    byDay: { day: string; storeViews: number; productViews: number }[];
    channels: { channel: string; views: number; sessions: number }[];
    topViewedProducts: { productId: string; title: string; slug: string; imageUrl: string | null; views: number }[];
    truncated: boolean;
  };
  funnel: {
    stages: { key: string; label: string; count: number; prev: number; stepRate: number | null; dropOff: number | null; dropOffPct: number | null }[];
    basis: string[];
    paymentAttempts: number;
    paymentAttemptsPrev: number;
  };
  summary: {
    orders: number;
    ordersPrev: number;
    unitsSold: number;
    unitsSoldPrev: number;
    grossSalesMinor: number;
    grossSalesMinorPrev: number;
    grossProductSalesMinor: number;
    netProductSalesMinor: number;
    refundsMinor: number;
    refundsMinorPrev: number;
    refundCount: number;
    aovMinor: number | null;
    aovMinorPrev: number | null;
    cartAddUnits: number;
    cartAddUnitsPrev: number;
    activeCartsNow: number;
    unitsInCartsNow: number;
    visitToPurchaseRate: number | null;
  };
  observations: { kind: string; text: string }[];
};

// ---------------------------------------------------------------- product traffic
// Contract mirror of /api/store/insights/product-traffic — the Top viewed
// products card's OWN Daily/Weekly/Monthly/Yearly filter + drill-down modal.

type ProductTrafficViewKey = "daily" | "weekly" | "monthly" | "yearly";

const PT_WINDOW_PARAM: Record<ProductTrafficViewKey, string> = {
  daily: "today",
  weekly: "7d",
  monthly: "30d",
  yearly: "1y",
};

const PT_VIEW_LABELS: Record<ProductTrafficViewKey, string> = {
  daily: "Today",
  weekly: "Last 7 days",
  monthly: "Last 30 days",
  yearly: "Last 12 months",
};

type ProductTrafficTotals = {
  views: number;
  uniqueViewers: number;
  cartAddTimes: number;
  cartAddUnits: number;
  cartRemoveTimes: number;
  cartRemoveUnits: number;
  purchaseOrders: number;
  purchaseUnits: number;
};

type ProductTrafficRow = ProductTrafficTotals & {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
};

type ProductTrafficListData = {
  window: InsightsWindowInfo;
  generatedAt: string;
  topViewedProducts: ProductTrafficRow[];
  truncated: boolean;
};

type ProductTrafficDetailData = {
  window: InsightsWindowInfo;
  generatedAt: string;
  product: { id: string; title: string; slug: string; imageUrl: string | null };
  totals: ProductTrafficTotals;
  channels: { channel: string; views: number; sessions: number }[];
  referrers: { host: string; views: number }[];
  byDay: { day: string; views: number }[];
  truncated: boolean;
  notes?: string[] | null;
};

/** Fixed display order + plain-language labels for the five channels a view
 *  can be classified into (server values: direct/search/social/internal/other). */
const PT_CHANNEL_ORDER = ["internal", "direct", "search", "social", "other"] as const;

const PT_CHANNEL_META: Record<string, { label: string; hint: string }> = {
  internal: { label: "Marketplace / internal", hint: "Navigation inside NOMOFEE — marketplace home, category and storefront pages, in-app search." },
  direct: { label: "Direct link", hint: "Typed URLs, bookmarks, in-app browsers and apps that strip referrers." },
  search: { label: "Search engines", hint: "Google, Bing, DuckDuckGo and other search sites." },
  social: { label: "Social media", hint: "Facebook, Instagram, TikTok, X, YouTube, WhatsApp and other social platforms." },
  other: { label: "Other sites", hint: "Links from sites that are neither search engines nor social networks." },
};

type CartData = {
  window: InsightsWindowInfo;
  generatedAt: string;
  freshness?: Freshness;
  period: {
    addEvents: number;
    addEventsPrev: number;
    addUnits: number;
    addUnitsPrev: number;
    removeEvents: number;
    removeEventsPrev: number;
    removeUnits: number;
    removeUnitsPrev: number;
    byDay: { day: string; addUnits: number; removeUnits: number }[];
    topAdded: { productId: string; title: string; imageUrl: string | null; addUnits: number; addEvents: number }[];
  };
  current: {
    sampledAt: string;
    activeCarts: number;
    totalUnits: number;
    totalLines: number;
    ineligibleUnits: number;
    byProduct: { productId: string; title: string; slug: string; imageUrl: string | null; units: number; carts: number }[];
    eligibilityNote: string;
  };
};

type ProductRow = {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  status: string;
  views: number;
  viewSessions: number;
  addUnits: number;
  addEvents: number;
  currentCartUnits: number;
  currentCarts: number;
  orderedUnits: number;
  purchasedUnits: number;
  grossSalesMinor: number;
  netSalesMinor: number;
  refundedMinor: number;
  viewToCartRate: number | null;
  checkoutToPurchaseRate: number | null;
};

type ProductsPayload = { rows: ProductRow[]; notes: string[] };

type SalesData = {
  window: InsightsWindowInfo;
  generatedAt: string;
  cards: {
    paidOrders: number;
    paidOrdersPrev: number;
    unitsSold: number;
    unitsSoldPrev: number;
    grossSalesMinor: number;
    grossSalesMinorPrev: number;
    grossProductSalesMinor: number;
    grossProductSalesMinorPrev?: number;
    discountsMinor: number;
    discountsMinorPrev?: number;
    shippingChargedMinor: number;
    shippingChargedMinorPrev?: number;
    sellerProceedsMinor: number;
    sellerProceedsMinorPrev?: number;
    refundsMinor: number;
    refundsMinorPrev: number;
    refundCount: number;
    refundCountPrev: number;
    cancelledOrders: number;
    cancelledOrdersPrev?: number;
    aovMinor: number | null;
    aovMinorPrev: number | null;
    netProductSalesMinor: number;
    refundedItemsMinor?: number;
    visitToPurchaseRate: number | null;
  };
  byDay: { bucket: string; grossSalesMinor: number; netProductSalesMinor: number; orders: number; units: number; refundsMinor: number }[];
  granularity: string;
  topProducts: { productId: string; title: string; units: number; netSalesMinor: number }[];
  fulfillment: { unfulfilledPaidOrders: number; avgPaidToShippedHours: number | null; shippedSample: number; note: string };
  notes: string[];
};

type MarketRow = {
  code: string;
  label: string;
  paidOrders: number;
  paidOrdersPrev: number;
  unitsSold: number;
  grossProductSalesMinor: number;
  discountsMinor: number;
  refundsMinor: number;
  netProductSalesMinor: number;
  shippingChargedMinor: number;
  aovMinor: number;
  shareNetPct: number;
  shareOrdersPct: number;
  growthPct: number | null;
  isNew: boolean;
  source: string;
};

type MarketsData = {
  window: InsightsWindowInfo;
  generatedAt: string;
  dimension: "country" | "state";
  rows: MarketRow[];
  totals: { paidOrders: number; netProductSalesMinor: number };
  notes: string[];
  movers: {
    risers: { code: string; label: string; growthPct: number }[];
    fallers: { code: string; label: string; growthPct: number }[];
  };
};

type MarketProductsData = {
  label: string;
  rows: {
    productId: string;
    title: string;
    slug: string;
    imageUrl: string | null;
    unitsSold: number;
    grossProductSalesMinor: number;
    discountsMinor: number;
    refundedMinor: number;
    netProductSalesMinor: number;
    paidOrders: number;
    avgSellingPriceMinor: number;
    views: number;
    addUnits: number;
  }[];
  notes: string[];
};

// Marketing Intelligence — /api/store/insights/campaigns report mirror.
type CampaignReportRow = {
  campaignId: string;
  name: string;
  slug: string;
  code: string;
  status: string;
  defaultSource: string | null;
  defaultMedium: string | null;
  createdAt: string;
  visits: number;
  visitSessions: number;
  productViews: number;
  addUnits: number;
  attributedOrders: number;
  paidOrders: number;
  paidOrdersPrev: number;
  grossSalesMinor: number;
  grossProductSalesMinor: number;
  aovMinor: number | null;
  conversionPct: number | null;
  firstEventAt: string | null;
};

type CampaignUtmRow = {
  source: string;
  medium: string | null;
  campaign: string | null;
  visits: number;
  visitSessions: number;
  productViews: number;
  addUnits: number;
  attributedOrders: number;
  paidOrders: number;
  grossSalesMinor: number;
};

type CampaignsData = {
  window: InsightsWindowInfo;
  generatedAt: string;
  rows: CampaignReportRow[];
  utmRows: CampaignUtmRow[];
  totals: {
    campaigns: number;
    attributedVisits: number;
    attributedPaidOrders: number;
    attributedGrossSalesMinor: number;
    unclaimedPaidOrders: number;
    unclaimedGrossSalesMinor: number;
  };
  notes: string[];
};

// /api/store/campaigns list mirror (link management).
type CampaignLinkRow = {
  id: string;
  name: string;
  slug: string;
  code: string;
  status: string;
  defaultSource: string | null;
  defaultMedium: string | null;
  createdAt: string;
  linkPath: string;
};

// ---------------------------------------------------------------- constants + helpers

type WindowKey = "today" | "7d" | "30d" | "custom";

const WINDOW_LABELS: Record<WindowKey, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  custom: "Custom range",
};

type TabKey = "overview" | "cart" | "products" | "sales" | "markets" | "campaigns";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "cart", label: "Cart activity" },
  { key: "products", label: "Products" },
  { key: "sales", label: "Sales" },
  { key: "markets", label: "Markets" },
  { key: "campaigns", label: "Campaigns" },
];

const PRODUCT_SORTS = ["views", "adds", "cartQty", "purchases", "revenue", "conversion"] as const;
type ProductSort = (typeof PRODUCT_SORTS)[number];
const SORT_LABELS: Record<ProductSort, string> = {
  views: "views",
  adds: "cart adds",
  cartQty: "units in carts",
  purchases: "purchased units",
  revenue: "gross sales",
  conversion: "view→cart rate",
};

const CHART_MARGIN = { top: 8, right: 12, left: 4, bottom: 0 };
const tooltipStyle = { borderRadius: 10, fontSize: 12 };

const TEAL = "#0d9488";
const AMBER = "#a16207";
const ROSE = "#e11d48";

/** localStorage flag — the Campaigns page-guide button keeps its "new" emphasis
 *  until the seller opens the tour for the first time. */
const CAMPAIGNS_TOUR_SEEN_KEY = "nomo.insights.campaignsTourSeen";

/** House scrollbar treatment for long in-card lists (matches the bell panel). */
const SCROLLY =
  "max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent";

function fmtInt(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-MY");
}

/** Percent fields arrive pre-rounded (e.g. 12.5); null → "—". */
function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : `${v}%`;
}

function fmtHours(v: number | null | undefined): string {
  return v == null ? "—" : `${v} h`;
}

/** X-axis tick: day buckets "2026-09-28" → "09-28"; month buckets pass through. */
function bucketTick(v: unknown): string {
  const s = String(v);
  return s.length > 7 ? s.slice(5) : s;
}

/** Prev-period delta: ▲/▼ % (emerald/rose), "New" badge when prev=0 & value>0,
 *  "—" when there is no prior data. goodDown flips the polarity (refunds). */
function Delta({ value, prev, goodDown = false }: { value: number | null; prev: number | null | undefined; goodDown?: boolean }) {
  if (prev == null || value == null) return <span className="text-xs text-muted-foreground">—</span>;
  if (prev === 0) {
    return value > 0 ? (
      <Badge variant="outline" className="border-emerald-200 bg-emerald-100 text-emerald-800">
        New
      </Badge>
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );
  }
  const pct = ((value - prev) / prev) * 100;
  if (pct === 0) return <span className="text-xs text-muted-foreground">0% vs prev</span>;
  const up = pct > 0;
  const good = goodDown ? !up : up;
  return (
    <span className={cn("text-xs font-medium tabular-nums", good ? "text-emerald-600" : "text-rose-600")}>
      {up ? "▲" : "▼"} {Math.abs(Math.round(pct * 10) / 10)}%
      <span className="ml-1 font-normal text-muted-foreground">vs prev</span>
    </span>
  );
}

function ChartSkeleton() {
  return <div className="h-[240px] w-full animate-pulse rounded-lg bg-muted sm:h-[280px]" />;
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-rose-500" />
      <p className="text-sm font-medium">Failed to load this section</p>
      <p className="max-w-sm text-xs text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-1 gap-1.5" onClick={onRetry}>
        <RotateCw className="h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}

/** Muted "How it's calculated" collapsible — renders server-provided notes verbatim.
 *  `defaultOpen` + a `key` remount lets the Campaigns page guide expand it
 *  mid-tour (the key flip forces the open state; the user can still toggle). */
function NotesCollapsible({
  title,
  notes,
  defaultOpen = false,
}: {
  title: string;
  notes: string[] | null | undefined;
  defaultOpen?: boolean;
}) {
  if (!notes || notes.length === 0) return null;
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group flex min-h-[44px] w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-0 sm:py-2">
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="list-disc space-y-1 pb-2 pl-5 text-xs leading-relaxed text-muted-foreground">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProductThumb({ imageUrl, title, size = 32 }: { imageUrl: string | null | undefined; title: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <Package className="h-4 w-4 text-muted-foreground" />
      )}
    </span>
  );
}

/** Market growth badge: ▲/▼ % or "New" (amber) when isNew, "—" otherwise. */
function GrowthBadge({ growthPct, isNew }: { growthPct: number | null; isNew: boolean }) {
  if (growthPct == null) {
    return isNew ? (
      <Badge variant="outline" className="border-amber-200 bg-amber-100 text-amber-800">
        New
      </Badge>
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );
  }
  const up = growthPct >= 0;
  return (
    <span className={cn("text-xs font-medium tabular-nums", up ? "text-emerald-600" : "text-rose-600")}>
      {up ? "▲" : "▼"} {Math.abs(growthPct)}%
    </span>
  );
}

/** Paged fetch hook (apiGetPaged keeps the top-level pagination meta). */
function usePagedApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<{ page: number; size: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch reset
    setLoading(true);
    apiGetPaged<T>(url)
      .then((r) => {
        if (alive) {
          setData(r.rows);
          setMeta(r.meta);
          setError(null);
        }
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [url, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, meta, loading, error, refetch };
}

/** Sortable table header — server-side sort: clicking sets the sort + refetch. */
function SortHead({
  label,
  sortKey,
  active,
  onSort,
  align = "right",
}: {
  label: string;
  sortKey: ProductSort;
  active: boolean;
  onSort: (s: ProductSort) => void;
  align?: "left" | "right";
}) {
  return (
    <TableHead scope="col" aria-sort={active ? "descending" : undefined} className={cn("h-11 p-0 md:h-10", align === "right" && "text-right")}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sort products by ${label}`}
        className={cn(
          "flex h-full w-full items-center gap-1 px-2 text-xs font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "justify-end",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        {active ? <ArrowDown className="h-3 w-3 shrink-0" /> : <ArrowUpDown className="h-3 w-3 shrink-0 opacity-60" />}
      </button>
    </TableHead>
  );
}

// ---------------------------------------------------------------- main view

export default function SellerInsights({ onNavigate }: { onNavigate: (n: SellerNav) => void }) {
  const [tab, setTab] = useState<TabKey>("overview");
  const [visited, setVisited] = useState<Record<TabKey, boolean>>({
    overview: true,
    cart: false,
    products: false,
    sales: false,
    markets: false,
    campaigns: false,
  });

  const [winKey, setWinKey] = useState<WindowKey>("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [freshTick, setFreshTick] = useState(0);

  // Funnel diagram view — independent of the page window so the 3D diagram can
  // be toggled (Daily/Weekly/Monthly/Yearly) without refetching every tab.
  // Changing the PAGE window to a matching preset syncs it (custom does not).
  const [funnelView, setFunnelView] = useState<FunnelViewKey>("monthly");
  useEffect(() => {
    // Derived state: the funnel card follows the page window when a matching
    // preset is chosen (custom has no funnel equivalent — the diagram keeps
    // its own last-selected view).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived preset sync, one setState max per window change
    if (winKey === "today") setFunnelView("daily");
    else if (winKey === "7d") setFunnelView("weekly");
    else if (winKey === "30d") setFunnelView("monthly");
  }, [winKey]);

  // Per-product funnel scope — null = whole store. Owned here so the product
  // selection survives view toggles and page-window changes (URL rebuilt below).
  const [funnelProduct, setFunnelProduct] = useState<string | null>(null);

  const [productSort, setProductSort] = useState<ProductSort>("views");
  const [productPage, setProductPage] = useState(1);
  const [salesGran, setSalesGran] = useState<"day" | "week" | "month">("day");
  // nav/markets default: State — on this Malaysia-first platform the state
  // dimension is the actionable one (every destination country is MY), so the
  // Markets tab opens with the finer-grained breakdown. Country stays one
  // toggle away. The API itself still defaults to country when the dimension
  // param is omitted (see docs/seller-insights/markets-api.md).
  const [marketDim, setMarketDim] = useState<"country" | "state">("state");

  // Custom range validity mirrors the backend contract: from < to, span ≤ 92 days.
  const datesFilled = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  const spanDays = datesFilled ? (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 : Number.NaN;
  const customOk = datesFilled && Number.isFinite(spanDays) && spanDays >= 0 && spanDays <= 91;
  const windowQuery = winKey === "custom" ? (customOk ? `window=custom&from=${from}&to=${to}` : null) : `window=${winKey}`;
  const canFetch = windowQuery != null;
  const freshQ = freshTick > 0 ? `&fresh=1&_r=${freshTick}` : "";

  const mkUrl = (path: string, isVisited: boolean, extra = "") =>
    isVisited && windowQuery ? `/api/store/insights/${path}?${windowQuery}${extra}${freshQ}` : null;

  // Per-tab lazy data: a tab's URL stays null until it is first activated,
  // so nothing is fetched for tabs the seller never opens. Window changes and
  // refreshes rewrite every loaded tab's URL (keys the useApi effect).
  const overview = useApi<OverviewData>(mkUrl("overview", visited.overview));
  const cart = useApi<CartData>(mkUrl("cart", visited.cart));
  const sales = useApi<SalesData>(mkUrl("sales", visited.sales, `&granularity=${salesGran}`));
  const markets = useApi<MarketsData>(mkUrl("markets", visited.markets, `&dimension=${marketDim}`));
  const campaigns = useApi<CampaignsData>(mkUrl("campaigns", visited.campaigns));
  const products = usePagedApi<ProductsPayload>(mkUrl("products", visited.products, `&sort=${productSort}&page=${productPage}&size=20`));
  const funnelUrl = visited.overview
    ? `/api/store/insights/funnel?window=${FUNNEL_WINDOW_PARAM[funnelView]}${
        funnelProduct ? `&productId=${encodeURIComponent(funnelProduct)}` : ""
      }${freshQ}`
    : null;
  const funnel: FunnelApi = useApi<FunnelData>(funnelUrl);

  // Self-healing: when the selected product stops resolving server-side
  // (deleted, or never belonged to this store → honest 404 "Unknown product…"),
  // fall back to the store-wide funnel instead of a dead error panel.
  // Transient network/server errors keep the panel + Retry.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- self-heal product scope, one setState max
    if (funnelProduct && funnel.error?.includes("Unknown product")) setFunnelProduct(null);
  }, [funnelProduct, funnel.error]);

  const refreshing =
    (visited.overview && overview.loading) ||
    (visited.cart && cart.loading) ||
    (visited.products && products.loading) ||
    (visited.sales && sales.loading) ||
    (visited.markets && markets.loading) ||
    (visited.campaigns && campaigns.loading);

  const generatedAt =
    tab === "overview"
      ? overview.data?.generatedAt
      : tab === "cart"
        ? cart.data?.generatedAt
        : tab === "sales"
          ? sales.data?.generatedAt
          : tab === "markets"
            ? markets.data?.generatedAt
            : tab === "campaigns"
              ? campaigns.data?.generatedAt
              : null;

  const windowLabel = winKey === "custom" ? `Custom · ${from} → ${to}` : WINDOW_LABELS[winKey];

  const exportHref = (type: string, extra = "") =>
    canFetch ? `/api/store/insights/export?type=${type}&${windowQuery}${extra}` : null;

  const onTabChange = (v: string) => {
    const k = v as TabKey;
    setTab(k);
    setVisited((s) => ({ ...s, [k]: true }));
  };

  const onWindowChange = (v: string) => {
    const k = v as WindowKey;
    setWinKey(k);
    if (k === "custom") {
      // sensible 30-day default so the tab keeps loading immediately
      if (!from) setFrom(format(subDays(new Date(), 29), "yyyy-MM-dd"));
      if (!to) setTo(format(new Date(), "yyyy-MM-dd"));
    }
  };

  const onProductSort = (s: ProductSort) => {
    if (s === productSort) return;
    setProductSort(s);
    setProductPage(1);
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* header: title, window filter, updated stamp, refresh */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ChartColumn className="h-5 w-5 text-primary" />
            Insights
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Traffic, cart activity and sales performance
            {generatedAt ? <> · updated {formatDistanceToNow(new Date(generatedAt), { addSuffix: true })}</> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {winKey === "custom" ? (
            <>
              <Input
                type="date"
                aria-label="Custom range start date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-[150px]"
              />
              <Input
                type="date"
                aria-label="Custom range end date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-[150px]"
              />
            </>
          ) : null}
          <Select value={winKey} onValueChange={onWindowChange}>
            <SelectTrigger className="min-h-[44px] w-[170px]" aria-label="Insights window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="custom">Custom range</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={() => setFreshTick((t) => t + 1)}
            disabled={!canFetch || refreshing}
            className="gap-1.5"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {!canFetch ? (
        <EmptyState
          title="Custom range not ready"
          hint="Pick a start and end date (up to 92 days apart) — insights load automatically once both are set."
          icon={<CalendarRange className="h-8 w-8" />}
        />
      ) : (
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList className="h-auto w-full flex-wrap sm:w-fit">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="min-h-[44px] flex-1 sm:flex-none sm:px-4">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <OverviewSection
              data={overview.data}
              loading={overview.loading}
              error={overview.error}
              onRetry={overview.refetch}
              onNavigate={onNavigate}
              funnelApi={funnel}
              funnelView={funnelView}
              onFunnelView={setFunnelView}
              funnelProduct={funnelProduct}
              onFunnelProduct={setFunnelProduct}
            />
          </TabsContent>

          <TabsContent value="cart" className="mt-4">
            <CartSection data={cart.data} loading={cart.loading} error={cart.error} onRetry={cart.refetch} />
          </TabsContent>

          <TabsContent value="products" className="mt-4">
            <ProductsSection
              data={products.data}
              meta={products.meta}
              loading={products.loading}
              error={products.error}
              onRetry={products.refetch}
              sort={productSort}
              onSort={onProductSort}
              page={productPage}
              onPage={setProductPage}
              exportHref={exportHref("products")}
            />
          </TabsContent>

          <TabsContent value="sales" className="mt-4">
            <SalesSection
              data={sales.data}
              loading={sales.loading}
              error={sales.error}
              onRetry={sales.refetch}
              granularity={salesGran}
              onGranularity={setSalesGran}
              onNavigate={onNavigate}
            />
          </TabsContent>

          <TabsContent value="markets" className="mt-4">
            <MarketsSection
              data={markets.data}
              loading={markets.loading}
              error={markets.error}
              onRetry={markets.refetch}
              dimension={marketDim}
              onDimension={setMarketDim}
              exportHref={exportHref("markets", `&dimension=${marketDim}`)}
              windowQuery={windowQuery}
              windowLabel={windowLabel}
            />
          </TabsContent>

          <TabsContent value="campaigns" className="mt-4">
            <CampaignsSection
              data={campaigns.data}
              loading={campaigns.loading}
              error={campaigns.error}
              onRetry={campaigns.refetch}
              onReportChanged={campaigns.refetch}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- overview tab

function OverviewSection({
  data,
  loading,
  error,
  onRetry,
  onNavigate,
  funnelApi,
  funnelView,
  onFunnelView,
  funnelProduct,
  onFunnelProduct,
}: {
  data: OverviewData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onNavigate: (n: SellerNav) => void;
  funnelApi: FunnelApi;
  funnelView: FunnelViewKey;
  onFunnelView: (v: FunnelViewKey) => void;
  /** Selected per-product funnel scope (null = store-wide). */
  funnelProduct: string | null;
  onFunnelProduct: (id: string | null) => void;
}) {
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <CardsSkeleton count={8} />
        <ChartSkeleton />
        <RowsSkeleton rows={3} />
      </div>
    );
  }

  const { traffic, summary, observations, freshness } = data;
  const hasTraffic = traffic.byDay.some((d) => d.storeViews > 0 || d.productViews > 0);
  const maxChannelViews = Math.max(1, ...traffic.channels.map((c) => c.views));

  return (
    <div className="space-y-4 sm:space-y-6">
      {freshness?.trackingSince == null ? (
        <div className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900" role="note">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              Traffic tracking started fresh — visitor metrics accrue from now on; sales metrics below use complete order history.
            </p>
            {freshness.note ? <p className="mt-1 text-xs opacity-80">{freshness.note}</p> : null}
          </div>
        </div>
      ) : null}

      {/* summary cards */}
      <section aria-label="Summary cards">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <StatCard
            label="Visits"
            value={fmtInt(traffic.sessions)}
            sub={<Delta value={traffic.sessions} prev={traffic.sessionsPrev} />}
            icon={<Store className="h-4 w-4" />}
          />
          <StatCard
            label="Unique visitors (est.)"
            value={fmtInt(traffic.uniqueVisitors)}
            sub={<Delta value={traffic.uniqueVisitors} prev={traffic.uniqueVisitorsPrev} />}
            icon={<Users className="h-4 w-4" />}
          />
          <StatCard
            label="Product views"
            value={fmtInt(traffic.productViews)}
            sub={<Delta value={traffic.productViews} prev={traffic.productViewsPrev} />}
            icon={<Eye className="h-4 w-4" />}
          />
          <StatCard
            label="Cart adds (units)"
            value={fmtInt(summary.cartAddUnits)}
            sub={<Delta value={summary.cartAddUnits} prev={summary.cartAddUnitsPrev} />}
            icon={<ShoppingCart className="h-4 w-4" />}
          />
          <StatCard
            label="Paid orders"
            value={fmtInt(summary.orders)}
            sub={<Delta value={summary.orders} prev={summary.ordersPrev} />}
            icon={<ReceiptText className="h-4 w-4" />}
          />
          <StatCard
            label="Gross sales"
            value={formatMinor(summary.grossSalesMinor)}
            sub={<Delta value={summary.grossSalesMinor} prev={summary.grossSalesMinorPrev} />}
            icon={<BadgeDollarSign className="h-4 w-4" />}
          />
          <StatCard
            label="AOV"
            value={summary.aovMinor == null ? "—" : formatMinor(summary.aovMinor)}
            sub={<Delta value={summary.aovMinor} prev={summary.aovMinorPrev} />}
            icon={<Coins className="h-4 w-4" />}
          />
          <StatCard
            label="In carts now (units)"
            value={fmtInt(summary.unitsInCartsNow)}
            sub={`Live · ${fmtInt(summary.activeCartsNow)} active carts`}
            icon={<ShoppingBasket className="h-4 w-4" />}
          />
        </div>
      </section>

      {/* conversion funnel — interactive 3D canvas diagram (hero, full width) */}
      <FunnelCard
        api={funnelApi}
        view={funnelView}
        onView={onFunnelView}
        product={funnelProduct}
        onProduct={onFunnelProduct}
      />

      {/* top viewed products — own Daily/Weekly/Monthly/Yearly filter + traffic
          source drill-down modal (moved below the funnel per seller feedback) */}
      <TopViewedProductsCard onNavigate={onNavigate} />

      <div className="grid gap-4 lg:grid-cols-5">
        {/* traffic trend */}
        <Card className="gap-3 lg:col-span-3">
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MousePointerClick className="h-4 w-4 text-primary" /> Traffic trend
            </CardTitle>
            <CardDescription className="text-xs">Store views vs product views by day</CardDescription>
          </CardHeader>
          <CardContent className="px-2">
            {hasTraffic ? (
              <div className="h-[240px] w-full sm:h-[280px]" role="img" aria-label="Daily store views and product views chart">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={traffic.byDay} margin={CHART_MARGIN}>
                    <defs>
                      <linearGradient id="ovStoreViews" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={TEAL} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={TEAL} stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="ovProductViews" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={AMBER} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={AMBER} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tickFormatter={bucketTick}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={24}
                      stroke="currentColor"
                      className="text-muted-foreground"
                    />
                    <YAxis
                      tickFormatter={(v) => fmtInt(Number(v))}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      allowDecimals={false}
                      stroke="currentColor"
                      className="text-muted-foreground"
                    />
                    <Tooltip
                      formatter={(v, name) => [fmtInt(Number(v)), String(name)]}
                      labelFormatter={(l) => `Date: ${l}`}
                      contentStyle={tooltipStyle}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="storeViews" name="Store views" stroke={TEAL} strokeWidth={2} fill="url(#ovStoreViews)" />
                    <Area type="monotone" dataKey="productViews" name="Product views" stroke={AMBER} strokeWidth={2} fill="url(#ovProductViews)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState
                title="No traffic in this window yet"
                hint="Store and product views chart here as visitor tracking accrues."
                icon={<Eye className="h-8 w-8" />}
              />
            )}
          </CardContent>
        </Card>

        {/* channels */}
        <Card className="gap-3 lg:col-span-2">
          <CardHeader className="flex-row items-start justify-between space-y-0 pb-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Globe className="h-4 w-4 text-primary" /> Channels
              </CardTitle>
              <CardDescription className="text-xs">Where store views came from</CardDescription>
            </div>
            {/* Inline explainer — the attribution design in plain language
                (campaign links → UTM/tokens, referrer hostname, direct). */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground"
                  aria-label="How channel detection works"
                >
                  <Info className="h-3.5 w-3.5" aria-hidden="true" /> How?
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 text-xs leading-relaxed">
                <p className="text-sm font-medium">How we know where a visit came from</p>
                <ul className="mt-2 space-y-2">
                  <li>
                    <span className="font-medium">1 · Campaign links — most reliable.</span> Links shared from the Campaigns tab carry UTM
                    tags (utm_source …) plus a store token. The storefront reads them once on landing and remembers the visit for 30 days —
                    every tracked view is then stamped with that source (e.g. utm_source=instagram → Social).
                  </li>
                  <li>
                    <span className="font-medium">2 · Referrer header.</span> Untagged visits are classified from the browser&apos;s standard
                    Referer hostname: known search engines → Search, known social networks → Social, any other site → Other.
                  </li>
                  <li>
                    <span className="font-medium">3 · Direct.</span> No referrer and no campaign tag — typed URLs, bookmarks, in-app
                    browsers and messengers that strip referrers all land here.
                  </li>
                </ul>
                <p className="mt-2 text-muted-foreground">
                  Last-touch, first-party measurement: a channel shows where the most recent tagged/referring visit came from — it is
                  associated with, never proven to cause, a sale. No cross-site tracking, no fingerprints, no personal data.
                </p>
              </PopoverContent>
            </Popover>
          </CardHeader>
          <CardContent>
            {traffic.channels.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No channel data yet — visitor tracking accrues from now on.</p>
            ) : (
              <div className="space-y-3">
                {traffic.channels.map((c) => (
                  <div key={c.channel}>
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium capitalize">{c.channel}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {fmtInt(c.views)} views · {fmtInt(c.sessions)} sessions
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden="true">
                      <div className="h-full rounded-full bg-teal-600" style={{ width: `${(c.views / maxChannelViews) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* observations — server-gated, rendered verbatim */}
      {observations.length > 0 ? (
        <section aria-label="Observations" className="grid gap-3 sm:grid-cols-2">
          {observations.map((o, i) => (
            <div key={i} className="flex gap-2.5 rounded-xl border bg-muted/40 p-3.5">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="min-w-0 text-xs leading-relaxed">{o.text}</p>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

// ------------------------------------------- top viewed products card + modal

/** Top viewed products — the seller's per-product traffic card with its OWN
 *  Daily/Weekly/Monthly/Yearly filter (independent of the page window, like
 *  the funnel diagram) and a click-through drill-down modal showing where
 *  each product's viewers came from plus cart/purchase movement. */
function TopViewedProductsCard({ onNavigate }: { onNavigate: (n: SellerNav) => void }) {
  const [view, setView] = useState<ProductTrafficViewKey>("monthly");
  const [selected, setSelected] = useState<ProductTrafficRow | null>(null);
  const list = useApi<ProductTrafficListData>(`/api/store/insights/product-traffic?window=${PT_WINDOW_PARAM[view]}`);
  const rows = list.data?.topViewedProducts ?? [];

  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Eye className="h-4 w-4 text-primary" /> Top viewed products
          </CardTitle>
          <CardDescription className="text-xs">
            Views in the selected filter{list.data?.truncated ? " · list truncated" : ""} · click a product for its traffic sources
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={view} onValueChange={(v) => setView(v as ProductTrafficViewKey)}>
            <SelectTrigger className="h-9 w-[122px] text-xs" aria-label="Top viewed products filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="hidden h-9 gap-1 text-xs sm:inline-flex" onClick={() => onNavigate({ view: "products" })}>
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {list.error ? (
          <ErrorPanel message={list.error} onRetry={list.refetch} />
        ) : list.loading ? (
          <RowsSkeleton rows={5} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No product views in this filter yet.</p>
        ) : (
          <ul className={cn("space-y-2 pr-1", SCROLLY)}>
            {rows.map((p) => (
              <li key={p.productId}>
                <button
                  type="button"
                  onClick={() => setSelected(p)}
                  className="flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-colors hover:border-teal-300 hover:bg-teal-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 dark:hover:border-teal-800 dark:hover:bg-teal-950/30"
                  aria-label={`Traffic detail for ${p.title}`}
                >
                  <ProductThumb imageUrl={p.imageUrl} title={p.title} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.title}</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" aria-hidden="true" /> {fmtInt(p.uniqueViewers)} viewers
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <ShoppingCart className="h-3 w-3 text-emerald-600" aria-hidden="true" /> {fmtInt(p.cartAddUnits)} added
                      </span>
                      {p.purchaseUnits > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <ReceiptText className="h-3 w-3 text-teal-600" aria-hidden="true" /> {fmtInt(p.purchaseUnits)} purchased
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold tabular-nums">{fmtInt(p.views)}</span>
                    <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">views</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ProductTrafficDialog product={selected} view={view} onClose={() => setSelected(null)} />
    </Card>
  );
}

/** One KPI tile for the drill-down modal. */
function PtKpi({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: "emerald" | "rose" | "teal" }) {
  return (
    <div className="rounded-xl border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {icon} {label}
      </p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums leading-none",
          tone === "emerald" && "text-emerald-600 dark:text-emerald-400",
          tone === "rose" && "text-rose-600 dark:text-rose-400",
          tone === "teal" && "text-teal-700 dark:text-teal-300"
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-[10px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/** Traffic-source drill-down modal for ONE product — channel breakdown with
 *  bars, a by-day view trend, top referrer hosts and cart/purchase movement,
 *  all scoped to the card's current filter. */
function ProductTrafficDialog({
  product,
  view,
  onClose,
}: {
  product: ProductTrafficRow | null;
  view: ProductTrafficViewKey;
  onClose: () => void;
}) {
  const url = product ? `/api/store/insights/product-traffic?window=${PT_WINDOW_PARAM[view]}&productId=${encodeURIComponent(product.productId)}` : null;
  const detail = useApi<ProductTrafficDetailData>(url);
  const d = detail.data;

  const channels = PT_CHANNEL_ORDER.map((ch) => {
    const found = d?.channels.find((c) => c.channel === ch);
    return { channel: ch, views: found?.views ?? 0, sessions: found?.sessions ?? 0 };
  });
  const maxChViews = Math.max(1, ...channels.map((c) => c.views));
  const hasViews = (d?.totals.views ?? 0) > 0;

  return (
    <Dialog open={product != null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl [scrollbar-width:thin]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 pr-8 text-left">
            <ProductThumb imageUrl={product?.imageUrl ?? null} title={product?.title ?? ""} size={44} />
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold leading-tight">{product?.title}</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">Traffic detail · {PT_VIEW_LABELS[view]}</span>
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Where this product&apos;s viewers came from and how they moved through the cart in the selected period.
          </DialogDescription>
        </DialogHeader>

        {detail.error ? (
          <ErrorPanel message={detail.error} onRetry={detail.refetch} />
        ) : detail.loading || !d ? (
          <div className="space-y-3">
            <RowsSkeleton rows={4} />
          </div>
        ) : (
          <div className="space-y-5">
            {/* movement KPIs */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
              <PtKpi icon={<Eye className="h-3.5 w-3.5" aria-hidden="true" />} label="Views" value={fmtInt(d.totals.views)} sub={`${fmtInt(d.totals.uniqueViewers)} unique viewers`} />
              <PtKpi icon={<ShoppingCart className="h-3.5 w-3.5" aria-hidden="true" />} label="Added to cart" value={fmtInt(d.totals.cartAddUnits)} sub={`${fmtInt(d.totals.cartAddTimes)} times`} tone="emerald" />
              <PtKpi icon={<ShoppingBasket className="h-3.5 w-3.5" aria-hidden="true" />} label="Removed from cart" value={fmtInt(d.totals.cartRemoveUnits)} sub={`${fmtInt(d.totals.cartRemoveTimes)} times`} tone="rose" />
              <PtKpi icon={<ReceiptText className="h-3.5 w-3.5" aria-hidden="true" />} label="Purchased" value={fmtInt(d.totals.purchaseUnits)} sub={`${fmtInt(d.totals.purchaseOrders)} paid orders`} tone="teal" />
              <PtKpi icon={<MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />} label="View → cart" value={fmtPct(d.totals.views > 0 ? Math.round((d.totals.cartAddUnits / d.totals.views) * 1000) / 10 : null)} sub="units per 100 views" />
            </div>

            {/* where viewers came from */}
            <section aria-label="Where viewers came from">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="flex items-center gap-1.5 text-sm font-medium">
                  <Globe className="h-4 w-4 text-primary" aria-hidden="true" /> Where viewers came from
                </h4>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground" aria-label="How channel detection works">
                      <Info className="h-3.5 w-3.5" aria-hidden="true" /> How?
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80 text-xs leading-relaxed">
                    <p className="text-sm font-medium">How we know where a view came from</p>
                    <ul className="mt-2 space-y-2">
                      <li>
                        <span className="font-medium">1 · Campaign links — most reliable.</span> Links shared from the Campaigns tab carry UTM tags plus a
                        store token; the source (e.g. utm_source=instagram → Social media) is stamped on every tracked view.
                      </li>
                      <li>
                        <span className="font-medium">2 · Referrer header.</span> Untagged views use the browser&apos;s standard Referer hostname: known
                        search engines → Search engines, known social networks → Social media, other sites → Other sites.
                      </li>
                      <li>
                        <span className="font-medium">3 · Direct link.</span> No referrer and no campaign tag — typed URLs, bookmarks and referrer-stripping
                        apps land here.
                      </li>
                    </ul>
                    <p className="mt-2 text-muted-foreground">Marketplace / internal = the viewer was already browsing NOMOFEE (marketplace pages, storefronts, in-app search). Last-touch, first-party measurement — associated with the view, never claimed to cause a sale.</p>
                  </PopoverContent>
                </Popover>
              </div>
              {!hasViews ? (
                <p className="py-3 text-center text-sm text-muted-foreground">No views in this filter yet.</p>
              ) : (
                <div className="space-y-2.5">
                  {channels.map((c) => {
                    const meta = PT_CHANNEL_META[c.channel];
                    return (
                      <div key={c.channel}>
                        <div className="mb-1 flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium">{meta?.label ?? c.channel}</span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {fmtInt(c.views)} views · {fmtInt(c.sessions)} viewers
                          </span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden="true">
                          <div className="h-full rounded-full bg-teal-600" style={{ width: `${(c.views / maxChViews) * 100}%` }} />
                        </div>
                        <p className="mt-0.5 text-[10px] text-muted-foreground/80">{meta?.hint}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* views by day */}
            {d.byDay.length > 1 ? (
              <section aria-label="Views by day">
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <TrendingUp className="h-4 w-4 text-primary" aria-hidden="true" /> Views by day
                  {d.truncated ? <span className="text-[10px] font-normal text-amber-600">· event data truncated</span> : null}
                </h4>
                <div className="h-[160px] w-full" role="img" aria-label="Daily product views chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={d.byDay} margin={CHART_MARGIN}>
                      <defs>
                        <linearGradient id="ptViewsFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={TEAL} stopOpacity={0.3} />
                          <stop offset="100%" stopColor={TEAL} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
                      <XAxis dataKey="day" tickFormatter={bucketTick} fontSize={11} tickLine={false} axisLine={false} minTickGap={24} stroke="currentColor" className="text-muted-foreground" />
                      <YAxis tickFormatter={(v) => fmtInt(Number(v))} fontSize={11} tickLine={false} axisLine={false} width={40} allowDecimals={false} stroke="currentColor" className="text-muted-foreground" />
                      <Tooltip formatter={(v) => [fmtInt(Number(v)), "Views"]} labelFormatter={(l) => `Date: ${l}`} contentStyle={tooltipStyle} />
                      <Area type="monotone" dataKey="views" name="Views" stroke={TEAL} strokeWidth={2} fill="url(#ptViewsFill)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>
            ) : null}

            {/* top referring sites — the exact hosts behind Other/Internal */}
            {d.referrers.length > 0 ? (
              <section aria-label="Top referring sites">
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Link2 className="h-4 w-4 text-primary" aria-hidden="true" /> Top referring sites
                </h4>
                <div className="space-y-1.5">
                  {d.referrers.map((r) => (
                    <div key={r.host} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
                      <span className="min-w-0 truncate font-mono text-xs">{r.host}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtInt(r.views)} views</span>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground/80">Hostnames of referring pages (privacy-aware — full URLs are never stored). Direct and campaign visits do not appear here.</p>
              </section>
            ) : null}

            <NotesCollapsible title="How these numbers are calculated" notes={d.notes} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- cart activity tab

/** Custom tooltip for the adds/removes stacked bar: date heading, both
 *  components, the stacked total (cart movement) and the net direction. */
function CartDayTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { day: string; addUnits: number; removeUnits: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const d = new Date(`${p.day}T00:00:00Z`);
  const heading = Number.isNaN(d.getTime())
    ? p.day
    : d.toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const net = p.addUnits - p.removeUnits;
  return (
    <div className="rounded-xl border bg-popover/95 p-3 text-xs shadow-lg backdrop-blur">
      <p className="mb-1.5 font-semibold">{heading}</p>
      <ul className="space-y-0.5 tabular-nums">
        <li className="flex items-center justify-between gap-6">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TEAL }} aria-hidden="true" />
            Adds (units)
          </span>
          <span className="font-medium">{fmtInt(p.addUnits)}</span>
        </li>
        <li className="flex items-center justify-between gap-6">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ROSE }} aria-hidden="true" />
            Removes (units)
          </span>
          <span className="font-medium">{fmtInt(p.removeUnits)}</span>
        </li>
        <li className="mt-1 flex items-center justify-between gap-6 border-t pt-1">
          <span className="text-muted-foreground">Total cart movement</span>
          <span className="font-semibold">{fmtInt(p.addUnits + p.removeUnits)}</span>
        </li>
        <li className="flex items-center justify-between gap-6">
          <span className="text-muted-foreground">Net (adds − removes)</span>
          <span className={cn("font-semibold", net >= 0 ? "text-emerald-600" : "text-rose-600")}>
            {net >= 0 ? "+" : "−"}
            {fmtInt(Math.abs(net))}
          </span>
        </li>
      </ul>
    </div>
  );
}

function CartSection({
  data,
  loading,
  error,
  onRetry,
}: {
  data: CartData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <CardsSkeleton count={4} />
        <ChartSkeleton />
        <RowsSkeleton rows={3} />
      </div>
    );
  }

  const { period, current } = data;
  const hasCartActivity = period.byDay.some((d) => d.addUnits > 0 || d.removeUnits > 0);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* period cards */}
      <section aria-label="Cart period cards">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Cart adds (units)"
            value={fmtInt(period.addUnits)}
            sub={<Delta value={period.addUnits} prev={period.addUnitsPrev} />}
            icon={<ShoppingCart className="h-4 w-4" />}
          />
          <StatCard
            label="Add events"
            value={fmtInt(period.addEvents)}
            sub={<Delta value={period.addEvents} prev={period.addEventsPrev} />}
            icon={<ShoppingCart className="h-4 w-4" />}
          />
          <StatCard
            label="Cart removes (units)"
            value={fmtInt(period.removeUnits)}
            sub={<Delta value={period.removeUnits} prev={period.removeUnitsPrev} goodDown />}
            icon={<ShoppingBasket className="h-4 w-4" />}
          />
          <StatCard
            label="Remove events"
            value={fmtInt(period.removeEvents)}
            sub={<Delta value={period.removeEvents} prev={period.removeEventsPrev} goodDown />}
            icon={<ShoppingBasket className="h-4 w-4" />}
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* adds/removes by day — stacked vertical columns: one bar per day so
            a single day's cart movement is readable at a glance (hover for the
            exact add/remove/net numbers) */}
        <Card className="gap-3">
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShoppingCart className="h-4 w-4 text-primary" /> Cart adds &amp; removes by day
            </CardTitle>
            <CardDescription className="text-xs">Units added vs removed from carts · one column per day</CardDescription>
          </CardHeader>
          <CardContent className="px-2">
            {hasCartActivity ? (
              <div className="h-[240px] w-full sm:h-[280px]" role="img" aria-label="Daily cart add units and remove units stacked bar chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={period.byDay} margin={CHART_MARGIN} barCategoryGap="22%" maxBarSize={42}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tickFormatter={bucketTick}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={24}
                      stroke="currentColor"
                      className="text-muted-foreground"
                    />
                    <YAxis
                      tickFormatter={(v) => fmtInt(Number(v))}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      allowDecimals={false}
                      stroke="currentColor"
                      className="text-muted-foreground"
                    />
                    <Tooltip content={<CartDayTip />} cursor={{ fill: "rgba(13,148,136,0.08)" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconSize={9} />
                    <Bar dataKey="addUnits" name="Adds (units)" stackId="cart" fill={TEAL} />
                    <Bar dataKey="removeUnits" name="Removes (units)" stackId="cart" fill={ROSE} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState
                title="No cart activity in this window"
                hint="Adds and removes chart here as shoppers use carts."
                icon={<ShoppingCart className="h-8 w-8" />}
              />
            )}
          </CardContent>
        </Card>

        {/* top added products */}
        <Card className="gap-3">
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Package className="h-4 w-4 text-primary" /> Top added products
            </CardTitle>
            <CardDescription className="text-xs">Units added to carts in this window</CardDescription>
          </CardHeader>
          <CardContent>
            {period.topAdded.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No cart adds in this window yet.</p>
            ) : (
              <ul className={cn("space-y-2 pr-1", SCROLLY)}>
                {period.topAdded.map((p) => (
                  <li key={p.productId} className="flex items-center gap-3 rounded-xl border p-2.5">
                    <ProductThumb imageUrl={p.imageUrl} title={p.title} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.title}</p>
                      <p className="text-xs text-muted-foreground">{fmtInt(p.addEvents)} add events</p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{fmtInt(p.addUnits)}</span>
                    <span className="sr-only">units added</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* currently in carts — live snapshot, NOT windowed */}
      <Card className="gap-3">
        <CardHeader className="pb-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShoppingBasket className="h-4 w-4 text-primary" /> Currently in carts
          </CardTitle>
          <CardDescription className="text-xs">Live snapshot · sampled {ageOf(current.sampledAt)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard label="Active carts" value={fmtInt(current.activeCarts)} sub="carts with purchasable items" />
            <StatCard label="Units in carts" value={fmtInt(current.totalUnits)} sub={`${fmtInt(current.totalLines)} cart lines`} />
            <StatCard
              label="Units on unavailable items"
              value={fmtInt(current.ineligibleUnits)}
              tone={current.ineligibleUnits > 0 ? "warn" : "default"}
              sub="parked on items that can't be bought"
            />
          </div>
          {current.ineligibleUnits > 0 ? (
            <p className="text-xs text-amber-700">
              {fmtInt(current.ineligibleUnits)} units sit in carts on unavailable items — those carts can&apos;t complete checkout
              until the items are active again.
            </p>
          ) : null}
          {current.byProduct.length === 0 ? (
            <EmptyState
              title="No purchasable units in carts right now"
              hint="Ranked products appear here the moment shoppers add something."
              icon={<ShoppingBasket className="h-8 w-8" />}
            />
          ) : (
            <ul className={cn("space-y-2 pr-1", SCROLLY)}>
              {current.byProduct.map((p) => (
                <li key={p.productId} className="flex items-center gap-3 rounded-xl border p-2.5">
                  <ProductThumb imageUrl={p.imageUrl} title={p.title} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.title}</p>
                    <p className="text-xs text-muted-foreground">{fmtInt(p.carts)} carts</p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {fmtInt(p.units)} <span className="text-xs font-normal text-muted-foreground">units</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <NotesCollapsible title="How this is calculated" notes={current.eligibilityNote ? [current.eligibilityNote] : []} />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- products tab

function ProductsSection({
  data,
  meta,
  loading,
  error,
  onRetry,
  sort,
  onSort,
  page,
  onPage,
  exportHref,
}: {
  data: ProductsPayload | null;
  meta: { page: number; size: number; total: number } | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  sort: ProductSort;
  onSort: (s: ProductSort) => void;
  page: number;
  onPage: (p: number) => void;
  exportHref: string | null;
}) {
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;

  const rows = data?.rows ?? [];
  const total = meta?.total ?? 0;
  const size = meta?.size ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, size)));

  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Package className="h-4 w-4 text-primary" /> Product performance
          </CardTitle>
          <CardDescription className="text-xs">
            {meta ? `${fmtInt(total)} products · sorted by ${SORT_LABELS[sort]}` : "Sortable product metrics for this window"}
          </CardDescription>
        </div>
        {exportHref ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              window.location.href = exportHref;
            }}
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {loading && !data ? (
          <div className="px-6">
            <RowsSkeleton rows={8} />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6">
            <EmptyState title="No products to report" hint="Products appear here with views, carts and sales metrics." />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="min-w-[220px]">
                    Product
                  </TableHead>
                  <SortHead label="Views" sortKey="views" active={sort === "views"} onSort={onSort} />
                  <SortHead label="Cart adds" sortKey="adds" active={sort === "adds"} onSort={onSort} />
                  <SortHead label="In carts now" sortKey="cartQty" active={sort === "cartQty"} onSort={onSort} />
                  <SortHead label="Purchased" sortKey="purchases" active={sort === "purchases"} onSort={onSort} />
                  <SortHead label="Gross sales" sortKey="revenue" active={sort === "revenue"} onSort={onSort} />
                  <TableHead scope="col" className="text-right">
                    Net sales
                  </TableHead>
                  <SortHead label="View→cart" sortKey="conversion" active={sort === "conversion"} onSort={onSort} />
                  <TableHead scope="col" className="text-right">
                    Checkout→purchase
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.productId}>
                    <TableCell className="min-w-[220px]">
                      <div className="flex items-center gap-2.5">
                        <ProductThumb imageUrl={r.imageUrl} title={r.title} />
                        <div className="min-w-0">
                          <p className="max-w-[220px] truncate text-sm font-medium">{r.title}</p>
                          <StatusChip status={r.status} className="mt-0.5" />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtInt(r.views)}</TableCell>
                    <TableCell className="text-right">
                      <p className="text-sm font-medium tabular-nums">{fmtInt(r.addUnits)}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">{fmtInt(r.addEvents)} events</p>
                    </TableCell>
                    <TableCell className="text-right">
                      <p className="text-sm font-medium tabular-nums">{fmtInt(r.currentCartUnits)}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">{fmtInt(r.currentCarts)} carts</p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtInt(r.purchasedUnits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(r.grossSalesMinor)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(r.netSalesMinor)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(r.viewToCartRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(r.checkoutToPurchaseRate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex flex-wrap items-center justify-between gap-2 px-6 pt-3">
              <p className="text-xs text-muted-foreground">
                {meta ? (
                  <>
                    Page {meta.page} of {totalPages} · {fmtInt(total)} products
                  </>
                ) : (
                  "Loading pages…"
                )}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => onPage(page - 1)}
                  className="min-h-[44px] sm:min-h-0"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => onPage(page + 1)}
                  className="min-h-[44px] sm:min-h-0"
                >
                  Next
                </Button>
              </div>
            </div>
            <div className="px-6">
              <NotesCollapsible title="How product metrics are calculated" notes={data?.notes} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- sales tab

function SalesSection({
  data,
  loading,
  error,
  onRetry,
  granularity,
  onGranularity,
  onNavigate,
}: {
  data: SalesData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  granularity: "day" | "week" | "month";
  onGranularity: (g: "day" | "week" | "month") => void;
  onNavigate: (n: SellerNav) => void;
}) {
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <CardsSkeleton count={6} />
        <ChartSkeleton />
        <RowsSkeleton rows={3} />
      </div>
    );
  }

  const { cards, byDay, topProducts, fulfillment, notes } = data;
  const hasSales = byDay.some((d) => d.netProductSalesMinor > 0 || d.refundsMinor > 0 || d.orders > 0);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* cards row */}
      <section aria-label="Sales cards">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <StatCard
            label="Paid orders"
            value={fmtInt(cards.paidOrders)}
            sub={<Delta value={cards.paidOrders} prev={cards.paidOrdersPrev} />}
            icon={<ReceiptText className="h-4 w-4" />}
          />
          <StatCard
            label="Units sold"
            value={fmtInt(cards.unitsSold)}
            sub={<Delta value={cards.unitsSold} prev={cards.unitsSoldPrev} />}
            icon={<Boxes className="h-4 w-4" />}
          />
          <StatCard
            label="Gross sales"
            value={formatMinor(cards.grossSalesMinor)}
            sub={<Delta value={cards.grossSalesMinor} prev={cards.grossSalesMinorPrev} />}
            icon={<BadgeDollarSign className="h-4 w-4" />}
          />
          <StatCard
            label="Net product sales"
            value={formatMinor(cards.netProductSalesMinor)}
            sub="after discounts & refunds"
            icon={<Coins className="h-4 w-4" />}
          />
          <StatCard
            label="Refunds"
            value={formatMinor(cards.refundsMinor)}
            sub={
              <>
                <Delta value={cards.refundsMinor} prev={cards.refundsMinorPrev} goodDown />
                <span className="ml-1 text-muted-foreground">· {fmtInt(cards.refundCount)} refunds</span>
              </>
            }
            icon={<RotateCw className="h-4 w-4" />}
          />
          <StatCard
            label="AOV"
            value={cards.aovMinor == null ? "—" : formatMinor(cards.aovMinor)}
            sub={<Delta value={cards.aovMinor} prev={cards.aovMinorPrev} />}
            icon={<ReceiptText className="h-4 w-4" />}
          />
        </div>
      </section>

      {/* money breakdown strip */}
      <section aria-label="Money breakdown">
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
          <StatCard
            label="Gross product sales"
            value={formatMinor(cards.grossProductSalesMinor)}
            sub={<Delta value={cards.grossProductSalesMinor} prev={cards.grossProductSalesMinorPrev ?? null} />}
          />
          <StatCard
            label="Discounts"
            value={formatMinor(cards.discountsMinor)}
            sub={<Delta value={cards.discountsMinor} prev={cards.discountsMinorPrev ?? null} goodDown />}
          />
          <StatCard
            label="Shipping charged"
            value={formatMinor(cards.shippingChargedMinor)}
            sub={<Delta value={cards.shippingChargedMinor} prev={cards.shippingChargedMinorPrev ?? null} />}
          />
          <StatCard
            label="Seller proceeds"
            value={formatMinor(cards.sellerProceedsMinor)}
            sub={<Delta value={cards.sellerProceedsMinor} prev={cards.sellerProceedsMinorPrev ?? null} />}
          />
          <StatCard
            label="Cancelled orders"
            value={fmtInt(cards.cancelledOrders)}
            sub={<Delta value={cards.cancelledOrders} prev={cards.cancelledOrdersPrev ?? null} goodDown />}
          />
        </div>
      </section>

      {/* trend chart */}
      <Card className="gap-3">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="h-4 w-4 text-primary" /> Sales trend
            </CardTitle>
            <CardDescription className="text-xs">Net product sales (area) and processed refunds (line)</CardDescription>
          </div>
          <Select value={granularity} onValueChange={(v) => onGranularity(v as "day" | "week" | "month")}>
            <SelectTrigger className="min-h-[44px] w-[120px]" aria-label="Sales chart granularity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Daily</SelectItem>
              <SelectItem value="week">Weekly</SelectItem>
              <SelectItem value="month">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="px-2">
          {hasSales ? (
            <div className="h-[240px] w-full sm:h-[280px]" role="img" aria-label="Net product sales and refunds over time chart">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={byDay} margin={CHART_MARGIN}>
                  <defs>
                    <linearGradient id="salesNet" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={TEAL} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={TEAL} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={bucketTick}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  <YAxis
                    tickFormatter={(v) => `RM${Math.round(Number(v) / 100)}`}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={58}
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  <Tooltip
                    formatter={(v, name) => [formatMinor(Number(v)), String(name)]}
                    labelFormatter={(l) => `Date: ${l}`}
                    contentStyle={tooltipStyle}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area
                    type="monotone"
                    dataKey="netProductSalesMinor"
                    name="Net product sales"
                    stroke={TEAL}
                    strokeWidth={2}
                    fill="url(#salesNet)"
                  />
                  <Line type="monotone" dataKey="refundsMinor" name="Refunds" stroke={ROSE} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState
              title="No sales in this window"
              hint="Paid orders chart here as they come in."
              icon={<ReceiptText className="h-8 w-8" />}
            />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* top products */}
        <Card className="gap-3">
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Boxes className="h-4 w-4 text-primary" /> Top products
            </CardTitle>
            <CardDescription className="text-xs">By net product sales in this window</CardDescription>
          </CardHeader>
          <CardContent>
            {topProducts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No product sales in this window.</p>
            ) : (
              <ol className={cn("space-y-2 pr-1", SCROLLY)}>
                {topProducts.map((p, i) => (
                  <li key={p.productId} className="flex items-center gap-3 rounded-xl border p-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{p.title}</p>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtInt(p.units)} units</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{formatMinor(p.netSalesMinor)}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* fulfillment */}
        <Card className="gap-3">
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Truck className="h-4 w-4 text-primary" /> Fulfillment
            </CardTitle>
            <CardDescription className="text-xs">Shipping speed on paid orders</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <StatCard
                label="Unfulfilled paid orders"
                value={fmtInt(fulfillment.unfulfilledPaidOrders)}
                tone={fulfillment.unfulfilledPaidOrders > 0 ? "warn" : "default"}
                sub="paid, waiting to ship"
              />
              <StatCard
                label="Avg paid → shipped"
                value={fmtHours(fulfillment.avgPaidToShippedHours)}
                sub={`${fmtInt(fulfillment.shippedSample)} shipped orders sampled`}
              />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{fulfillment.note}</p>
            {fulfillment.unfulfilledPaidOrders > 0 ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onNavigate({ view: "orders" })}>
                Go to orders <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="px-1">
        <NotesCollapsible title="How sales metrics are calculated" notes={notes} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- markets tab

function MarketsSection({
  data,
  loading,
  error,
  onRetry,
  dimension,
  onDimension,
  exportHref,
  windowQuery,
  windowLabel,
}: {
  data: MarketsData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  dimension: "country" | "state";
  onDimension: (d: "country" | "state") => void;
  exportHref: string | null;
  windowQuery: string | null;
  windowLabel: string;
}) {
  // Drill-down dialog state (fetches markets/products for the chosen code)
  const [drill, setDrill] = useState<{ code: string; label: string } | null>(null);
  const drillUrl =
    drill && windowQuery
      ? `/api/store/insights/markets/products?${windowQuery}&dimension=${dimension}&code=${encodeURIComponent(drill.code)}`
      : null;
  const drillApi = useApi<MarketProductsData>(drillUrl);

  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <CardsSkeleton count={3} />
        <RowsSkeleton rows={4} />
      </div>
    );
  }

  const { rows, totals, notes, movers } = data;
  const hasMovers = movers.risers.length > 0 || movers.fallers.length > 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      <Card className="gap-3">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-primary" /> Markets
            </CardTitle>
            <CardDescription className="text-xs">
              {dimension === "country" ? "Destination countries" : "Destination states"} · {fmtInt(totals.paidOrders)} paid orders ·{" "}
              {formatMinor(totals.netProductSalesMinor)} net
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={dimension} onValueChange={(v) => onDimension(v as "country" | "state")}>
              <SelectTrigger className="min-h-[44px] w-[130px]" aria-label="Market dimension">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="country">Country</SelectItem>
                <SelectItem value="state">State</SelectItem>
              </SelectContent>
            </Select>
            {exportHref ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  window.location.href = exportHref;
                }}
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 px-0">
          {rows.length === 0 ? (
            <div className="px-6">
              <EmptyState title="No market sales in this window" hint="Paid orders will populate the map of destination markets." />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="min-w-[150px]">
                    Market
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Paid orders
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Units
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Gross product sales
                  </TableHead>
                  <TableHead scope="col" className="hidden text-right lg:table-cell">
                    Discounts
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Refunds
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Net
                  </TableHead>
                  <TableHead scope="col" className="hidden text-right lg:table-cell">
                    Shipping
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    AOV
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Net share
                  </TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">View products</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow key={m.code}>
                    <TableCell className="min-w-[150px]">
                      <p className="text-sm font-medium">{m.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.code !== m.label ? `${m.code} · ` : ""}
                        {m.source || "checkout destination"}
                      </p>
                    </TableCell>
                    <TableCell className="text-right">
                      <p className="text-sm font-semibold tabular-nums">{fmtInt(m.paidOrders)}</p>
                      <p className="text-xs text-muted-foreground">
                        prev {fmtInt(m.paidOrdersPrev)} · <GrowthBadge growthPct={m.growthPct} isNew={m.isNew} />
                      </p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtInt(m.unitsSold)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(m.grossProductSalesMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">
                      {formatMinor(m.discountsMinor)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(m.refundsMinor)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(m.netProductSalesMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">
                      {formatMinor(m.shippingChargedMinor)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(m.aovMinor)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(m.shareNetPct)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        onClick={() => setDrill({ code: m.code, label: m.label })}
                        aria-label={`View product performance for ${m.label}`}
                      >
                        View <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="px-6">
            <NotesCollapsible title="How geographic sales are measured" notes={notes} />
          </div>
        </CardContent>
      </Card>

      {/* movers — only when the server has some */}
      {hasMovers ? (
        <Card className="gap-3">
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="h-4 w-4 text-primary" /> Movers
            </CardTitle>
            <CardDescription className="text-xs">Fastest risers and fallers by paid orders vs the previous period</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">Risers</p>
              <ul className="space-y-1.5">
                {movers.risers.map((m) => (
                  <li key={m.code} className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm">
                    <span className="min-w-0 truncate font-medium">{m.label}</span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-emerald-600">▲ {m.growthPct}%</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-rose-700">Fallers</p>
              <ul className="space-y-1.5">
                {movers.fallers.map((m) => (
                  <li key={m.code} className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm">
                    <span className="min-w-0 truncate font-medium">{m.label}</span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-rose-600">▼ {Math.abs(m.growthPct)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* drill-down dialog */}
      <Dialog
        open={!!drill}
        onOpenChange={(o) => {
          if (!o) setDrill(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-left">{drill?.label} — product performance</DialogTitle>
            <DialogDescription className="text-left">
              Sales attributed by recorded destination geography · {windowLabel}
            </DialogDescription>
          </DialogHeader>
          {drillApi.loading && !drillApi.data ? (
            <RowsSkeleton rows={4} />
          ) : drillApi.error ? (
            <ErrorPanel message={drillApi.error} onRetry={drillApi.refetch} />
          ) : (drillApi.data?.rows?.length ?? 0) === 0 ? (
            <EmptyState title="No products sold in this market" hint="Products appear here once paid orders ship to this destination." />
          ) : (
            <div className="space-y-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="min-w-[200px]">
                      Product
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Units sold
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Net sales
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Paid orders
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      ASP
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Views (store-wide)
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Adds (store-wide)
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drillApi.data?.rows.map((r) => (
                    <TableRow key={r.productId}>
                      <TableCell className="min-w-[200px]">
                        <div className="flex items-center gap-2.5">
                          <ProductThumb imageUrl={r.imageUrl} title={r.title} />
                          <p className="max-w-[220px] truncate text-sm font-medium">{r.title}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.unitsSold)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinor(r.netProductSalesMinor)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.paidOrders)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinor(r.avgSellingPriceMinor)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.views)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.addUnits)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
                {(drillApi.data?.notes ?? []).map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- campaigns tab
// Marketing Intelligence — first-party campaign attribution + tracking-link
// management. Every metric is server-computed; the honesty notes render
// verbatim. No spend data exists here, so no ROAS/CPC/CPA is ever shown, and
// ad-platform-reported conversions are explicitly out of scope.

function CampaignsSection({
  data,
  loading,
  error,
  onRetry,
  onReportChanged,
}: {
  data: CampaignsData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onReportChanged: () => void;
}) {
  // Link management list (independent of the insights window — a campaign's
  // link and code do not change with the selected date range).
  const links = useApi<CampaignLinkRow[]>("/api/store/campaigns");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", source: "", medium: "" });
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ---- Page guide (in-page documentation tour) --------------------------------
  // The Campaigns page is feature-dense; the guide overlays the page and walks
  // through every card, button and column with detailed explanations. Targets
  // are `data-tour` attributes on the elements below; conditional sections
  // (zero-attribution callout, UTM table, methodology notes) only join the
  // tour when they are actually rendered — the TourGuide also auto-skips a
  // step whose target vanished.
  const [tourOpen, setTourOpen] = useState(false);
  const [tourSeen, setTourSeen] = useState(true); // stays true (no emphasis) until the mount probe finds no "seen" flag
  const [notesOpen, setNotesOpen] = useState(false); // remounts the methodology collapsible open (tour step)
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage probe on mount
      setTourSeen(window.localStorage.getItem(CAMPAIGNS_TOUR_SEEN_KEY) === "1");
    } catch {
      /* private mode — keep the default */
    }
  }, []);

  const startTour = () => {
    setShowCreate(false);
    setNotesOpen(false);
    setTourOpen(true);
    setTourSeen(true); // the seller has now opened it — drop the first-time emphasis
    try {
      window.localStorage.setItem(CAMPAIGNS_TOUR_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  const endTour = (completed: boolean) => {
    setTourOpen(false);
    // restore the sections the tour expanded
    setShowCreate(false);
    setNotesOpen(false);
    if (completed) {
      try {
        window.localStorage.setItem(CAMPAIGNS_TOUR_SEEN_KEY, "1");
      } catch {
        /* ignore */
      }
    }
  };

  // Tour step list — built BEFORE the loading guard (hooks must run
  // unconditionally). Conditional sections (zero-attribution callout, UTM
  // table, methodology notes) join only when they are rendered; the copy is
  // static (no values embedded), so the memo stays stable across refreshes.
  const utmCount = data?.utmRows?.length ?? 0;
  const hasNotes = !!data?.notes?.length;
  const zeroAttribution = data
    ? data.totals.attributedVisits === 0 &&
      data.totals.attributedPaidOrders === 0 &&
      data.totals.unclaimedPaidOrders === 0 &&
      utmCount === 0
    : false;
  const tourSteps = useMemo<TourStep[]>(
    () => [
      {
        title: "Welcome to Campaigns",
        body: (
          <>
            <p>
              This page answers two questions: <strong className="text-foreground">where do my buyers come from</strong>, and{" "}
              <strong className="text-foreground">which of my marketing links actually lead to visits and orders</strong>?
            </p>
            <p className="mt-1.5">
              Everything is measured by your own storefront — the campaign links you create below, UTM-tagged traffic, and the orders
              those visits are associated with. No ad-platform data is involved.
            </p>
            <p className="mt-1.5">Click Next (or press →) to walk through every card, button and column. Esc or ✕ exits at any time.</p>
          </>
        ),
      },
      ...(zeroAttribution
        ? [
            {
              target: "cmp-zero-note",
              title: "Attribution starts from zero",
              body: (
                <p>
                  Tracking began when this feature was released — earlier traffic and orders have no attribution and are never
                  backfilled. Create a campaign link below, share it, and attributed visits accrue from the first tagged visitor onward.
                </p>
              ),
            },
          ]
        : []),
      {
        target: "cmp-totals",
        title: "Campaign totals",
        body: (
          <p>
            Four summary cards for the selected date range (Today / 7 days / 30 days / custom — chosen at the top of the page): how
            many tagged visits arrived, how many paid orders are associated with campaigns, the sales those orders brought in, and
            UTM-tagged orders no campaign link claims. The next four steps explain each card.
          </p>
        ),
      },
      {
        target: "cmp-card-visits",
        title: "Attributed visits",
        body: (
          <p>
            Store views that arrived through your campaign links or with valid UTM tags — every tagged store view, across all
            campaigns. One shopper browsing several pages in one visit still counts as one <em>session</em> — see the Sessions column
            in the performance table.
          </p>
        ),
      },
      {
        target: "cmp-card-orders",
        title: "Attributed paid orders",
        body: (
          <p>
            Orders associated with a campaign at checkout (last-touch): the campaign whose link the shopper used sticks with their
            session, and when they pay, the order counts against it. It is an association — the system never claims the campaign
            <em> caused</em> the sale.
          </p>
        ),
      },
      {
        target: "cmp-card-sales",
        title: "Attributed sales",
        body: (
          <p>Gross sales (RM) of those attributed paid orders — real order money from checkout records, not estimates or projections.</p>
        ),
      },
      {
        target: "cmp-card-utm",
        title: "Other tagged orders (UTM only)",
        body: (
          <p>
            Orders that arrived with UTM parameters but no platform campaign token — e.g. links you built yourself with utm_source.
            Tagged traffic, but no campaign link below can claim them.
          </p>
        ),
      },
      {
        target: "cmp-links-card",
        title: "Campaign links",
        body: (
          <p>
            Your library of named tracking links. Each one points at your storefront and carries both standard UTM parameters{" "}
            <strong className="text-foreground">and</strong> a NOMOFEE campaign token (nmcl) — so attribution survives even when a
            network strips UTM parameters (some in-app browsers do exactly that).
          </p>
        ),
      },
      {
        target: "cmp-new-link",
        title: "New campaign link",
        body: <p>Opens the creation form — every campaign starts here. The button toggles: click again to collapse it.</p>,
      },
      {
        target: "cmp-create-form",
        title: "Create a campaign link",
        onEnter: () => setShowCreate(true),
        body: (
          <>
            <p>
              <strong className="text-foreground">Campaign name</strong> (required) — a label only you see, e.g. “Raya Mega Sale
              WhatsApp blast”. <strong className="text-foreground">utm_source</strong> and{" "}
              <strong className="text-foreground">utm_medium</strong> (optional) pre-fill the link’s UTM tags, e.g. whatsapp / social.
            </p>
            <p className="mt-1.5">
              Create generates the shareable link. The nmcl token inside it resolves only against <em>your</em> storefront — it cannot
              be replayed on anyone else’s store.
            </p>
          </>
        ),
      },
      {
        target: "cmp-link-col-campaign",
        title: "Campaign column",
        body: (
          <p>
            The campaign’s name plus the tags its link carries: utm_campaign (auto-derived from the name) and the source/medium you
            set. This is the signature the storefront recognises on later visits.
          </p>
        ),
      },
      {
        target: "cmp-link-col-link",
        title: "Shareable link column",
        body: (
          <p>
            Your storefront URL with UTM parameters and the nmcl token appended. Use Copy link (right) to grab it, then paste it
            anywhere — Instagram bio, WhatsApp messages, ads, QR codes.
          </p>
        ),
      },
      {
        target: "cmp-link-col-status",
        title: "Status column",
        body: (
          <p>
            <strong className="text-foreground">Active</strong> — live and tracking. <strong className="text-foreground">Archived</strong>{" "}
            — retired from the active list, but the link keeps resolving and past attribution keeps reporting. Restore brings it back.
          </p>
        ),
      },
      {
        target: "cmp-link-col-actions",
        title: "Actions column",
        body: (
          <p>
            <strong className="text-foreground">Copy link</strong> puts the full URL on your clipboard.{" "}
            <strong className="text-foreground">Archive / Restore</strong> toggles the campaign’s status — archiving never deletes data
            and never breaks a link you already shared.
          </p>
        ),
      },
      {
        target: "cmp-perf-card",
        title: "Campaign performance",
        body: (
          <p>
            The report card: one row per campaign in the window. Traffic columns (visits → cart adds) come from tagged events; orders,
            sales, AOV and conversion come from authoritative attributed orders. Archived campaigns stay visible, dimmed. The next
            steps walk through every column.
          </p>
        ),
      },
      {
        target: "cmp-perf-col-visits",
        title: "Visits",
        body: <p>Tagged store views through this campaign — every attributed store view event in the window.</p>,
      },
      {
        target: "cmp-perf-col-sessions",
        title: "Sessions",
        body: (
          <p>
            Distinct shopper sessions behind those visits. One shopper can view the store several times in a session (or across
            midnight), so sessions can be lower than visits — and conversion is computed on sessions.
          </p>
        ),
      },
      {
        target: "cmp-perf-col-views",
        title: "Product views",
        body: <p>Product pages viewed during attributed visits — how deep this campaign’s traffic got into your catalogue.</p>,
      },
      {
        target: "cmp-perf-col-cartadds",
        title: "Cart adds",
        body: <p>Units added to carts during attributed visits — early buying intent from this campaign’s traffic.</p>,
      },
      {
        target: "cmp-perf-col-orders",
        title: "Orders",
        body: <p>Orders created by attributed shoppers in the window (checkout started) — includes orders that were never paid.</p>,
      },
      {
        target: "cmp-perf-col-paid",
        title: "Paid orders",
        body: (
          <p>
            Orders that actually got paid. The ▲/▼ chip compares against the previous equal-length window; “New” appears when there is
            no prior data to compare.
          </p>
        ),
      },
      {
        target: "cmp-perf-col-sales",
        title: "Gross sales",
        body: <p>Gross sales (RM) of those paid orders, before refunds and fees — authoritative order money.</p>,
      },
      {
        target: "cmp-perf-col-aov",
        title: "AOV",
        body: <p>Average order value: this campaign’s gross sales ÷ its paid orders.</p>,
      },
      {
        target: "cmp-perf-col-conversion",
        title: "Conversion*",
        body: (
          <p>
            Attributed paid orders ÷ attributed visit sessions — a mixed-basis indication (orders vs sessions), which is why it carries
            an asterisk. A tagged visit is associated with the campaign; it is never claimed to have caused the sale.
          </p>
        ),
      },
      ...(utmCount > 0
        ? [
            {
              target: "cmp-utm-card",
              title: "Tagged traffic without a campaign link",
              body: (
                <p>
                  Visits that arrived with valid UTM parameters but no nmcl token — links you shared manually, or before campaign links
                  existed. Same metrics as the performance table, grouped by source / medium / campaign, so you can see what your own
                  UTM tagging brings in.
                </p>
              ),
            },
          ]
        : []),
      ...(hasNotes
        ? [
            {
              target: "cmp-notes",
              title: "How campaign attribution is measured",
              onEnter: () => setNotesOpen(true),
              body: (
                <p>
                  The full methodology straight from the measurement layer: how visits and sessions are counted, how orders associate
                  with campaigns, and what is authoritative versus estimated. The tour opened it for you here — you can expand it any
                  time from this toggle.
                </p>
              ),
            },
          ]
        : []),
      {
        title: "You’re all set",
        body: (
          <p>
            The typical loop: <strong className="text-foreground">create a link → share it → watch visits and orders accrue → compare
            conversion across campaigns → archive what you stop using</strong>. Reopen this guide any time with the “Page guide”
            button. Happy selling!
          </p>
        ),
      },
    ],
    [zeroAttribution, utmCount, hasNotes]
  );

  const copyLink = async (row: CampaignLinkRow) => {
    const url = `${window.location.origin}${row.linkPath}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API can be unavailable (insecure context) — textarea fallback.
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      } catch {
        return; // never toast an error for a copy affordance
      }
    }
    setCopiedId(row.id);
    setTimeout(() => setCopiedId((cur) => (cur === row.id ? null : cur)), 1600);
  };

  const createCampaign = async () => {
    if (creating || form.name.trim() === "") return;
    setCreating(true);
    const done = await runMutation(
      () =>
        apiSend<CampaignLinkRow>("POST", "/api/store/campaigns", {
          name: form.name.trim(),
          source: form.source.trim() || undefined,
          medium: form.medium.trim() || undefined,
        }),
      "Campaign link created — share it anywhere; visits through it are attributed automatically"
    );
    setCreating(false);
    if (done) {
      setShowCreate(false);
      setForm({ name: "", source: "", medium: "" });
      links.refetch();
      onReportChanged();
    }
  };

  const toggleArchive = async (row: CampaignLinkRow) => {
    const next = row.status === "active" ? "archived" : "active";
    const done = await runMutation(
      () => apiSend<unknown>("PATCH", `/api/store/campaigns/${row.id}`, { status: next }),
      next === "archived"
        ? "Campaign archived — its link keeps resolving and past attribution keeps reporting"
        : "Campaign reactivated"
    );
    if (done) {
      links.refetch();
      onReportChanged();
    }
  };

  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <CardsSkeleton count={4} />
        <RowsSkeleton rows={4} />
      </div>
    );
  }

  const { totals, rows, utmRows, notes } = data;
  const linkRows = links.data ?? [];
  const hasAnyAttribution = !zeroAttribution;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* in-page documentation tour — see tour-guide.tsx */}
      <TourGuide steps={tourSteps} open={tourOpen} onClose={endTour} />

      {/* guide launcher — emphasised until the seller opens it once */}
      <div data-tour="cmp-guide-bar" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3.5 py-2.5">
        <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <GraduationCap className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0">
            New to campaigns? The page guide overlays this page and walks through every card, button and column with detailed
            explanations.
          </span>
        </p>
        <Button size="sm" variant={tourSeen ? "outline" : "default"} onClick={startTour} className="shrink-0 gap-1.5">
          <GraduationCap className="h-4 w-4" aria-hidden="true" /> Page guide
        </Button>
      </div>

      {/* tracking honesty callout */}
      {!hasAnyAttribution ? (
        <div data-tour="cmp-zero-note" className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900" role="note">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 text-sm">
            <p className="font-medium">Campaign attribution starts from zero — it begins accruing with the first tagged visit.</p>
            <p className="mt-1 text-xs opacity-80">
              Create a campaign link below and share it. Visits through tagged links and UTM parameters are attributed from that moment
              on; earlier traffic and orders have no attribution and are never backfilled.
            </p>
          </div>
        </div>
      ) : null}

      {/* totals */}
      <section aria-label="Campaign totals" data-tour="cmp-totals">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div data-tour="cmp-card-visits">
            <StatCard
              label="Attributed visits"
              value={fmtInt(totals.attributedVisits)}
              sub={<span className="text-xs text-muted-foreground">tagged store views, all campaigns</span>}
              icon={<Megaphone className="h-4 w-4" />}
            />
          </div>
          <div data-tour="cmp-card-orders">
            <StatCard
              label="Attributed paid orders"
              value={fmtInt(totals.attributedPaidOrders)}
              sub={<span className="text-xs text-muted-foreground">last-touch association</span>}
              icon={<ReceiptText className="h-4 w-4" />}
            />
          </div>
          <div data-tour="cmp-card-sales">
            <StatCard
              label="Attributed sales"
              value={formatMinor(totals.attributedGrossSalesMinor)}
              sub={<span className="text-xs text-muted-foreground">authoritative order money</span>}
              icon={<BadgeDollarSign className="h-4 w-4" />}
            />
          </div>
          <div data-tour="cmp-card-utm">
            <StatCard
              label="Other tagged orders (UTM only)"
              value={fmtInt(totals.unclaimedPaidOrders)}
              sub={
                totals.unclaimedGrossSalesMinor > 0 ? (
                  <span className="text-xs text-muted-foreground">{formatMinor(totals.unclaimedGrossSalesMinor)} gross</span>
                ) : (
                  <span className="text-xs text-muted-foreground">no campaign token</span>
                )
              }
              icon={<Link2 className="h-4 w-4" />}
            />
          </div>
        </div>
      </section>

      {/* campaign links management */}
      <Card data-tour="cmp-links-card" className="gap-3">
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Link2 className="h-4 w-4 text-primary" /> Campaign links
              </CardTitle>
              <CardDescription className="text-xs">
                Named tracking links for your storefront — share them on social, chat or ads
              </CardDescription>
            </div>
            <Button size="sm" data-tour="cmp-new-link" onClick={() => setShowCreate((s) => !s)} className="gap-1.5">
              {showCreate ? <ChevronDown className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {showCreate ? "Close" : "New campaign link"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {showCreate ? (
            <form
              data-tour="cmp-create-form"
              className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-[1fr_150px_150px_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                void createCampaign();
              }}
            >
              <div className="space-y-1">
                <label htmlFor="campaign-name" className="text-xs font-medium">
                  Campaign name <span className="text-rose-600">*</span>
                </label>
                <Input
                  id="campaign-name"
                  value={form.name}
                  maxLength={80}
                  placeholder="e.g. Raya Mega Sale WhatsApp blast"
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="campaign-source" className="text-xs font-medium">
                  utm_source <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="campaign-source"
                  value={form.source}
                  maxLength={100}
                  placeholder="whatsapp"
                  onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="campaign-medium" className="text-xs font-medium">
                  utm_medium <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="campaign-medium"
                  value={form.medium}
                  maxLength={50}
                  placeholder="social"
                  onChange={(e) => setForm((f) => ({ ...f, medium: e.target.value }))}
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={creating || form.name.trim() === ""} className="gap-1.5">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Create
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground sm:col-span-4">
                The generated link carries both standard UTM parameters and a platform campaign token — attribution survives even when a
                network strips UTMs. The token resolves only against YOUR storefront.
              </p>
            </form>
          ) : null}

          {links.error ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              <span className="min-w-0 truncate">{links.error}</span>
              <Button variant="outline" size="sm" onClick={links.refetch}>
                Retry
              </Button>
            </div>
          ) : links.loading && linkRows.length === 0 ? (
            <RowsSkeleton rows={2} />
          ) : linkRows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No campaign links yet — create one above to start attributing visits.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" data-tour="cmp-link-col-campaign">
                      Campaign
                    </TableHead>
                    <TableHead scope="col" data-tour="cmp-link-col-link">
                      Shareable link
                    </TableHead>
                    <TableHead scope="col" data-tour="cmp-link-col-status">
                      Status
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-link-col-actions">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {linkRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="min-w-[180px]">
                        <p className="text-sm font-medium">{r.name}</p>
                        <p className="text-xs text-muted-foreground">
                          utm_campaign={r.slug}
                          {r.defaultSource ? ` · source=${r.defaultSource}` : ""}
                          {r.defaultMedium ? ` · medium=${r.defaultMedium}` : ""}
                        </p>
                      </TableCell>
                      <TableCell className="min-w-[220px] max-w-[320px]">
                        <p className="truncate font-mono text-xs text-muted-foreground" title={`${window.location.origin}${r.linkPath}`}>
                          {window.location.origin}
                          {r.linkPath}
                        </p>
                      </TableCell>
                      <TableCell>
                        <StatusChip status={r.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => void copyLink(r)} className="gap-1.5">
                            {copiedId === r.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                            {copiedId === r.id ? "Copied" : "Copy link"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void toggleArchive(r)}
                            className="gap-1.5"
                            title={r.status === "active" ? "Archive (link keeps resolving; attribution keeps reporting)" : "Reactivate"}
                          >
                            {r.status === "active" ? <Archive className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
                            {r.status === "active" ? "Archive" : "Restore"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* per-campaign performance */}
      <Card data-tour="cmp-perf-card" className="gap-3">
        <CardHeader className="pb-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Megaphone className="h-4 w-4 text-primary" /> Campaign performance
          </CardTitle>
          <CardDescription className="text-xs">
            Visits and cart activity from tagged events · orders and sales from authoritative attributed orders
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No campaigns yet — create a campaign link above; performance appears with the first tagged visit.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Campaign</TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-visits">
                      Visits
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-sessions">
                      Sessions
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-views">
                      Product views
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-cartadds">
                      Cart adds
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-orders">
                      Orders
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-paid">
                      Paid orders
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-sales">
                      Gross sales
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-aov">
                      AOV
                    </TableHead>
                    <TableHead scope="col" className="text-right" data-tour="cmp-perf-col-conversion">
                      Conversion*
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.campaignId} className={r.status === "archived" ? "opacity-60" : undefined}>
                      <TableCell className="min-w-[180px]">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{r.name}</p>
                          {r.status === "archived" ? <Badge variant="outline">archived</Badge> : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {r.firstEventAt
                            ? `first tagged visit ${new Date(r.firstEventAt).toLocaleDateString("en-MY")}`
                            : "no tagged visits yet"}
                        </p>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.visits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.visitSessions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.productViews)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.addUnits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.attributedOrders)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="inline-flex items-center gap-1.5">
                          {fmtInt(r.paidOrders)}
                          <Delta value={r.paidOrders} prev={r.paidOrdersPrev} />
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinor(r.grossSalesMinor)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinor(r.aovMinor)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(r.conversionPct)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-[11px] text-muted-foreground">
                *Conversion = attributed paid orders ÷ attributed visit sessions — mixed bases, read as an indication. A tagged visit is
                associated with the campaign; it is never claimed to have caused the sale.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* raw UTM-tagged traffic without a campaign token */}
      {utmRows.length > 0 ? (
        <Card data-tour="cmp-utm-card" className="gap-3">
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Globe className="h-4 w-4 text-primary" /> Tagged traffic without a campaign link
            </CardTitle>
            <CardDescription className="text-xs">
              Visits that arrived with valid UTM parameters but no platform campaign token
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Source / medium / campaign</TableHead>
                    <TableHead scope="col" className="text-right">
                      Visits
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Sessions
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Product views
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Cart adds
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Orders
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Paid orders
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Gross sales
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {utmRows.map((r) => (
                    <TableRow key={`${r.source}|${r.medium ?? ""}|${r.campaign ?? ""}`}>
                      <TableCell className="min-w-[200px]">
                        <p className="text-sm font-medium">{r.source}</p>
                        <p className="text-xs text-muted-foreground">
                          {[r.medium, r.campaign].filter(Boolean).join(" / ") || "no medium/campaign"}
                        </p>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.visits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.visitSessions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.productViews)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.addUnits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.attributedOrders)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.paidOrders)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinor(r.grossSalesMinor)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div data-tour="cmp-notes">
        <NotesCollapsible
          key={notesOpen ? "open" : "closed"}
          defaultOpen={notesOpen}
          title="How campaign attribution is measured"
          notes={notes}
        />
      </div>
    </div>
  );
}

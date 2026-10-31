"use client";
// ============================================================================
// Affiliate Hub — shared types, authed fetch helpers, public URL contract and
// small UI atoms (Task 2-A). Backend: /api/affiliate/** (all working).
//
// HONESTY RULES mirrored from lib/affiliate-queries.ts:
//   • Estimated analytics figures are always labelled "Estimated".
//   • Financial figures are ledger-authoritative — never invented.
//   • Empty database ⇒ zero metrics + an honest empty state, never fake data.
//
// PUBLIC URL CONTRACT (single-route app; handled in shopper-shell proceed()):
//   /?al={linkCode}     promotional link landing  → POST /api/affiliate/track
//   /?ref={joinCode}    referral join landing     → POST /api/affiliate/track-referral
//   /?aff={slug}        public showcase page      → aff-showcase view
//   /?affc={slug}       public collection page    → aff-collection view
//   (&src={channel}     optional channel tag on referral landings)
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, TriangleAlert } from "lucide-react";
import { formatMinor } from "@/lib/money";
import { authHeaders } from "@/lib/session-client";
import { fetchJson, postJson, EmptyState } from "./ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Authed fetch helpers — deviceHeaders come from fetchJson; affiliate routes
// are shopper-session scoped, so the Bearer session token rides along when it
// exists (same pattern the admin/seller portals + app-store refreshMe use).
// ---------------------------------------------------------------------------

export function affGet<T>(url: string): Promise<T> {
  return fetchJson<T>(url, { headers: authHeaders() });
}

export function affPost<T>(url: string, payload: unknown): Promise<T> {
  return postJson<T>(url, payload, authHeaders());
}

export function affPatch<T>(url: string, payload: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
}

export function affDelete<T>(url: string): Promise<T> {
  return fetchJson<T>(url, { method: "DELETE", headers: authHeaders() });
}

// ---------------------------------------------------------------------------
// Payload types (mirror the API routes — see src/app/api/affiliate/**)
// ---------------------------------------------------------------------------

export type AffiliateSettingsT = {
  enabled: boolean;
  sponsorEnabled: boolean;
  maxRateBps: number;
  attrWindowDays: number;
  sponsorWindowDays: number;
  reviewDays: number;
  minPayoutMinor: number;
  // P2 deferral flags: Collections & Showcase are gated features — when false
  // the hub hides those tabs and the link-creation dialog stops offering the
  // corresponding link types (the API 403s anyway; the UI simply fails closed).
  collectionsEnabled: boolean;
  showcaseEnabled: boolean;
};

export type AffiliateBalancesT = {
  pendingMinor: number;
  approvedMinor: number;
  availableMinor: number;
  payoutInFlightMinor: number;
  paidMinor: number;
  reversedMinor: number;
  heldMinor: number;
  recoveryMinor: number;
  requestableMinor: number;
};

export type AffiliateProfileT = {
  id: string;
  code: string;
  slug: string;
  status: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  payoutRef: string | null;
  payoutVerified: boolean;
  sponsorId: string | null;
  sponsorName: string | null;
  sponsorSlug: string | null;
  termsVersion: number;
  termsAcceptedAt: string;
  activatedAt: string;
};

export type AffiliateMeT =
  | { activated: false; settings: AffiliateSettingsT; invitedBy: string | null }
  | { activated: true; settings: AffiliateSettingsT; profile: AffiliateProfileT; balances: AffiliateBalancesT };

/** GET /api/affiliate/activate (public pre-activation context). */
export type AffiliateActivateCtxT = {
  enabled: boolean;
  sponsorEnabled: boolean;
  maxRateBps: number;
  invitedBy: string | null;
  invitedByCode: string | null;
};

export type HubOverviewT = {
  estimated: { clicks: number; uniqueVisitors: number; productViews: number; addToCart: number };
  commerce: { attributedOrders: number; paidOrders: number; eligibleSalesMinor: number; reversedMinor: number };
  earnings: AffiliateBalancesT & { personalDirectMinor: number; sponsorMinor: number };
  network: { directReferrals: number; activatedAffiliates: number; affiliatesWithSales: number };
  series: { date: string; clicks: number; orders: number; commissionMinor: number }[];
  days: number;
};

export type DiscoverProductT = {
  productId: string;
  title: string;
  slug: string;
  storeSlug: string;
  storeName: string;
  image: string | null;
  priceMinor: number;
  rateBps: number;
  estimatedCommissionMinor: number;
  salesCount: number;
  ratingAvg: number;
  isFeatured: boolean;
  addedAt: string | null;
};

export type DiscoverResT = { rows: DiscoverProductT[]; total: number; paused?: boolean; maxRateBps?: number };

export type LinkRowT = {
  id: string;
  code: string;
  type: "product" | "store" | "collection" | "showcase";
  channel: string;
  label: string | null;
  status: "active" | "archived";
  clicks: number;
  lastClickAt: string | null;
  createdAt: string;
  target:
    | { kind: "product"; title: string; slug: string | null; storeSlug: string | null }
    | { kind: "store"; title: string; slug: string | null }
    | { kind: "collection"; title: string; slug: string | null; status: string | null }
    | { kind: "showcase"; title: string; slug: string | null };
};

export type CollectionItemT = {
  productId: string;
  position: number;
  title: string;
  slug: string;
  priceMinor: number;
  image: string | null;
  storeName: string;
  storeSlug: string;
  eligible: boolean;
  rateBps: number;
};

export type CollectionRowT = {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  status: "draft" | "published" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  items: CollectionItemT[];
};

export type NetworkResT = {
  total: number;
  page: number;
  referrals: { displayName: string; slug: string; status: string; activatedAt: string; generatedSales: boolean }[];
  sponsorEarningsMinor: number;
};

export type EarningsRowT = {
  id: string;
  role: "direct" | "sponsor";
  status: "pending" | "approved" | "available" | "paid" | "reversed" | "held";
  amountMinor: number;
  reversedMinor: number;
  holdReason: string | null;
  availableAt: string | null;
  paidAt: string | null;
  payoutId: string | null;
  createdAt: string;
  orderNumber: string;
  rateBps: number;
  baseMinor: number;
  poolMinor: number;
  channel: string | null;
  linkType: string | null;
};

export type EarningsResT = {
  total: number;
  page: number;
  balances: AffiliateBalancesT;
  rows: EarningsRowT[];
};

export type PayoutRowT = {
  id: string;
  amountMinor: number;
  status: "requested" | "processing" | "paid" | "failed" | "rejected";
  method: string;
  reference: string | null;
  note: string | null;
  failReason: string | null;
  requestedAt: string;
  processedAt: string | null;
};

export type PayoutsResT = {
  balances: AffiliateBalancesT;
  minPayoutMinor: number;
  payouts: PayoutRowT[];
};

export type PubProductT = {
  productId: string;
  title: string;
  slug: string;
  priceMinor: number;
  storeName: string;
  storeSlug: string;
  image: string | null;
};

export type PubShowcaseResT = {
  found: boolean;
  showcase?: {
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    slug: string;
    pageType: "affiliate_recommendations";
    collections: { id: string; title: string; description: string | null; slug: string; products: PubProductT[] }[];
  };
};

export type PubCollectionResT = {
  found: boolean;
  collection?: {
    title: string;
    description: string | null;
    curatedBy: string;
    curatorSlug: string;
    curatorAvatar: string | null;
    pageType: "affiliate_collection";
    products: PubProductT[];
  };
};

// ---------------------------------------------------------------------------
// Public URL contract helpers (see header comment)
// ---------------------------------------------------------------------------

function withOrigin(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

/** Promotional link share URL — the money-grade attribution entry. */
export function promoLinkUrl(code: string): string {
  return withOrigin(`/?al=${encodeURIComponent(code)}`);
}

/** Referral join link (?ref=CODE) — first-touch sponsor relationship. */
export function referralJoinUrl(code: string): string {
  return withOrigin(`/?ref=${encodeURIComponent(code)}`);
}

/** Public showcase page URL (?aff=SLUG) — browse-only, no money-grade touch. */
export function showcaseUrl(slug: string): string {
  return withOrigin(`/?aff=${encodeURIComponent(slug)}`);
}

/** Public collection page URL (?affc=SLUG) — browse-only landing. */
export function collectionUrl(slug: string): string {
  return withOrigin(`/?affc=${encodeURIComponent(slug)}`);
}

export const LINK_CHANNELS = ["tiktok", "threads", "facebook", "telegram", "whatsapp", "blog", "website", "other"] as const;
export type LinkChannel = (typeof LINK_CHANNELS)[number];

export const CHANNEL_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  threads: "Threads",
  facebook: "Facebook",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  blog: "Blog",
  website: "Website",
  other: "Other",
};

export const LINK_TYPE_LABEL: Record<string, string> = {
  product: "Product",
  store: "Store",
  collection: "Collection",
  showcase: "Showcase",
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function ratePercent(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

export function money(minor: number | null | undefined): string {
  return formatMinor(minor ?? 0);
}

export function dateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
}

export function dateTimeShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return "—";
  }
}

/** Commission / payout status chips — tones mirror the seller affiliate report. */
const STATUS_CHIP_CLASS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  held: "bg-amber-100 text-amber-800 border-amber-200",
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  approved: "bg-teal-100 text-teal-800 border-teal-200",
  processing: "bg-teal-100 text-teal-800 border-teal-200",
  available: "bg-emerald-100 text-emerald-800 border-emerald-200",
  paid: "bg-emerald-100 text-emerald-800 border-emerald-200",
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  published: "bg-emerald-100 text-emerald-800 border-emerald-200",
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  archived: "bg-slate-100 text-slate-700 border-slate-200",
  reversed: "bg-rose-100 text-rose-800 border-rose-200",
  failed: "bg-rose-100 text-rose-800 border-rose-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
  suspended: "bg-rose-100 text-rose-800 border-rose-200",
  terminated: "bg-rose-100 text-rose-800 border-rose-200",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  available: "Available",
  paid: "Paid",
  reversed: "Reversed",
  held: "Held",
  requested: "Requested",
  processing: "Processing",
  failed: "Failed",
  rejected: "Rejected",
  active: "Active",
  draft: "Draft",
  published: "Published",
  archived: "Archived",
  suspended: "Suspended",
  terminated: "Terminated",
};

export function StatusChip({ status, className }: { status: string; className?: string }) {
  const s = (status ?? "").toLowerCase();
  return (
    <Badge variant="outline" className={cn("border font-medium", STATUS_CHIP_CLASS[s] ?? "bg-muted text-muted-foreground border-border", className)}>
      {STATUS_LABEL[s] ?? s.replace(/_/g, " ")}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Small shared UI atoms
// ---------------------------------------------------------------------------

/** Copy-to-clipboard button (shopper-side reimplementation of the seller
 *  ui-bits pattern — surfaces never cross-import). */
export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("h-8 gap-1 px-2 text-xs min-h-[32px]", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success("Copied to clipboard");
        } catch {
          toast.error("Could not copy");
        }
      }}
    >
      <Copy className="h-3.5 w-3.5" />
      {label ?? "Copy"}
    </Button>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "brand" | "warn" | "danger";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3.5 shadow-soft-card",
        tone === "brand" && "border-teal-200 bg-teal-50/60",
        tone === "warn" && "border-amber-200 bg-amber-50/60",
        tone === "danger" && "border-rose-200 bg-rose-50/60"
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="pt-1 text-lg font-extrabold tracking-tight text-slate-900 tabular-nums sm:text-xl">{value}</p>
      {hint ? <p className="pt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function EstBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-amber-200 bg-amber-50 text-[10px] font-semibold text-amber-800", className)}>
      Estimated
    </Badge>
  );
}

export function AuthoritativeBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-teal-200 bg-teal-50 text-[10px] font-semibold text-teal-800", className)}>
      Ledger
    </Badge>
  );
}

/** Hub section card with a consistent header row. */
export function SectionCard({
  title,
  badge,
  action,
  children,
  className,
}: {
  title: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card p-4 shadow-soft-card sm:p-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-extrabold text-slate-900">{title}</h3>
          {badge}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Full-tab loading skeleton. */
export function TabSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={`r${i}`} className="h-24 rounded-xl" />
      ))}
      <span className="sr-only">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </span>
    </div>
  );
}

const TriangleAlertIcon = TriangleAlert;

/** Inline tab error state with retry. */
export function TabError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={TriangleAlertIcon}
      title="Could not load this section"
      hint={message}
      action={
        <Button type="button" variant="outline" className="min-h-[44px]" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

/** Simple Prev/Next pager for client-paged lists. */
export function Pager({
  page,
  size,
  total,
  rowCount,
  onPrev,
  onNext,
}: {
  page: number;
  size: number;
  total: number;
  rowCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const hasPrev = page > 1;
  const hasNext = rowCount >= size; // server totals can lag post-filters — row count is honest
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = (page - 1) * size + rowCount;
  return (
    <div className="flex items-center justify-between gap-2 pt-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {total > 0 ? `${from}–${to} of ${total}` : "0 results"}
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" className="min-h-[44px] px-3" disabled={!hasPrev} onClick={onPrev}>
          Previous
        </Button>
        <Button type="button" variant="outline" size="sm" className="min-h-[44px] px-3" disabled={!hasNext} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}

/** Debounced value hook for search inputs. */
export function useDebouncedValue<T>(value: T, delay = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Collection-scope product picker shared by the Links dialog and the
 *  collection item manager — searches the discover endpoint. */
export function useDiscoverSearch(enabled: boolean) {
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 400);
  const [rows, setRows] = useState<DiscoverProductT[] | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const id = ++seq.current;
    const url = `/api/affiliate/discover?size=12${dq.trim() ? `&q=${encodeURIComponent(dq.trim())}` : ""}`;
    // The loading flag rides a microtask so no state is set synchronously in
    // the effect body (react-hooks/set-state-in-effect) — the fetch itself is
    // async, so the spinner still appears before the first response frame.
    void Promise.resolve().then(() => {
      if (seq.current === id) setLoading(true);
    });
    affGet<DiscoverResT>(url)
      .then((d) => {
        if (seq.current === id) setRows(d.paused ? [] : d.rows);
      })
      .catch(() => {
        if (seq.current === id) setRows([]);
      })
      .finally(() => {
        if (seq.current === id) setLoading(false);
      });
  }, [dq, enabled]);

  return { q, setQ, rows, loading };
}

/** Extract unique participating stores from discover rows (the API surface has
 *  no dedicated "opted-in store list" endpoint — derived honestly from data). */
export function deriveStores(rows: DiscoverProductT[]): { slug: string; name: string }[] {
  const map = new Map<string, string>();
  for (const r of rows) if (!map.has(r.storeSlug)) map.set(r.storeSlug, r.storeName);
  return [...map.entries()].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Shared discover-tab data loader used by Discover + pickers. */
export function useDiscoverFeed(params: {
  q: string;
  store: string;
  sort: string;
  minRateBps: number | null;
  maxPriceMinor: number | null;
  page: number;
  enabled: boolean;
}) {
  const { q, store, sort, minRateBps, maxPriceMinor, page, enabled } = params;
  const [data, setData] = useState<DiscoverResT | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  // Store directory accumulated from every response — held in STATE (refs must
  // never be read during render).
  const [storeMap, setStoreMap] = useState<Map<string, string>>(new Map());
  const seq = useRef(0);

  const load = useCallback(
    (pageOverride?: number) => {
      if (!enabled) return;
      const p = pageOverride ?? page;
      const id = ++seq.current;
      const sp = new URLSearchParams({ page: String(p), size: "24" });
      if (q.trim()) sp.set("q", q.trim());
      if (store) sp.set("store", store);
      if (sort) sp.set("sort", sort);
      if (minRateBps != null) sp.set("minRate", String(minRateBps));
      if (maxPriceMinor != null) sp.set("maxPrice", String(maxPriceMinor));
      // Async spinner flag (see useDiscoverSearch — keeps the effect body free
      // of synchronous setState while still showing the refreshing state).
      void Promise.resolve().then(() => {
        if (seq.current === id) setLoading(true);
      });
      affGet<DiscoverResT>(`/api/affiliate/discover?${sp.toString()}`)
        .then((d) => {
          if (seq.current !== id) return;
          setStoreMap((prev) => {
            const next = new Map(prev);
            let changed = false;
            for (const r of d.rows) {
              if (!next.has(r.storeSlug)) {
                next.set(r.storeSlug, r.storeName);
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          setData(d);
        })
        .catch((e) => {
          if (seq.current !== id) return;
          setError(e instanceof Error ? e.message : "Could not load products");
        })
        .finally(() => {
          if (seq.current === id) setLoading(false);
        });
    },
    [enabled, page, q, store, sort, minRateBps, maxPriceMinor]
  );

  useEffect(() => {
    load();
  }, [load]);

  return {
    data,
    loading,
    error,
    stores: [...storeMap.entries()].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name)),
    reload: load,
  };
}



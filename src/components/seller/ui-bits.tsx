"use client";
// Task 2-d — Seller surface shared bits: fetch helpers, status chips, stat cards,
// money inputs, date formats. Mirrors admin conventions (consistent chips).
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatMinor, toMinor } from "@/lib/money";
import { authHeaders } from "@/lib/session-client";
import { signalSessionExpired } from "@/lib/session-events";
import type { ApiPageMeta } from "@/lib/types/api-contract";
import { Copy, Inbox } from "lucide-react";

// ---------------------------------------------------------------- shared types

export type SellerWallet = {
  id: string;
  sellerId: string;
  currency: string;
  pendingMinor: number;
  availableMinor: number;
  reservedMinor: number;
  lifetimeEarnedMinor: number;
  lifetimeCommissionMinor: number;
  createdAt: string;
  updatedAt: string;
};

export type StoreMe = {
  seller: {
    id: string;
    email: string;
    fullName: string;
    displayName: string;
    phone: string | null;
    status: string;
    kycStatus: string | null;
    riskTier: string | null;
    planCode: string | null;
    marketplaceOptIn: boolean;
    submittedAt: string | null;
    rejectReason: string | null;
    // PHASE 2.3 (C2.7) — honest email-verification state from
    // /api/store/me. Absent/null timestamp → emailVerified false (the
    // dashboard then offers the verification card).
    emailVerified: boolean;
    emailVerifiedAt: string | null;
  };
  store: {
    id: string;
    name: string;
    slug: string;
    tagline: string | null;
    logoUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
    status: string;
    supportEmail: string | null;
    supportPhone: string | null;
    whatsapp: string | null;
    marketplaceOptIn: boolean;
    theme: string;
    // Seller store settings work order — storefront display + home
    // organization config (surfaced by /api/store/me for the Storefront tab).
    cardShowStars: boolean;
    cardMetric: "views" | "sold";
    homeShowFeatured: boolean;
    homeShowFresh: boolean;
    homeFeaturedFirst: boolean;
  };
  wallet: SellerWallet | null;
  onboarding: { step: string; checklist: { profile: boolean; storeIdentity: boolean; kyc: boolean; bank: boolean; products: boolean } };
  stats: { ordersCount: number; productCount: number; revenue30dMinor: number };
};

export type BankAccount = {
  id: string;
  holderName: string;
  bankName: string;
  accountNumberMasked: string;
  verified: boolean;
  createdAt: string;
};

export type SellerViewName =
  | "dashboard"
  | "insights" // Task 6 — Seller Store Insights (traffic / cart / sales / markets)
  | "imports"
  | "products"
  | "orders"
  | "seo"
  | "wallet"
  | "builder"
  | "coupons"
  | "vouchers"
  | "affiliate"
  | "integrations"
  | "messages"
  | "settings";

// ---------------------------------------------------------------- nav sub-tabs
// Consolidated nav (nav-reorg): four standalone views became tabbed sections
// inside their parent destination. The tab discriminator rides on SellerNav
// so deep links keep working exactly like the old flat views — SPA only,
// no new routes. Omitting the field renders the destination's default tab.

/** Wallet & Payouts tabs — "pending" = grace-period release schedule (R2-UI). */
export type WalletTab = "overview" | "pending";
/** Page Builder tabs — "cards" = product card style, "cart" = cart experience. */
export type BuilderTab = "pages" | "cards" | "cart";
/** Store Settings tabs — "domains" = custom domain management (SD-09),
 *  "storefront" = display + home organization (seller store settings WO). */
export type SettingsTab = "general" | "domains" | "storefront";
/** Affiliate programme tabs — opt-in/rate, product enrollment, report. */
export type AffiliateTab = "program" | "products" | "report";

export type SellerNav = {
  view: SellerViewName;
  pageId?: string;
  orderId?: string;
  productId?: string;
  activityId?: string;
  walletTab?: WalletTab;
  builderTab?: BuilderTab;
  settingsTab?: SettingsTab;
  affiliateTab?: AffiliateTab;
};

// ---------------------------------------------------------------- platform terms
// Structural mirror of src/lib/seller-terms.ts PlatformTerms (the server lib
// imports Prisma and must never enter the client bundle — same pattern as
// StoreMe mirroring /api/store/me). Served by GET /api/store/terms.

export type PlatformTerms = {
  commissionPercent: number;
  commissionSource: "seller_override" | "global_default";
  fixedFeeMinor: number;
  hasFixedFee: boolean;
  minCommissionMinor: number;
  hasMinCommission: boolean;
  holdDays: number;
  holdSource: "seller_override" | "global_default";
  payoutMinMinor: number;
  moderationFirstN: number;
};

/** "8" → "8%", "8.5" → "8.5%", "12.25" → "12.25%" (max 2 decimals, no trailing zeros). */
export function fmtCommissionPercent(p: number): string {
  const rounded = Math.round(p * 100) / 100;
  return `${rounded}%`;
}

/** 7 → "7 days", 1 → "1 day", 0 → "0 days". */
export function fmtHoldDays(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Hold-window phrase matching the RUNTIME rule (paidAt + holdDays):
 *  "7 days after payment" — never "after delivery" (that setting is stored
 *  but not implemented; see seller-terms.ts honesty note). */
export function holdAfterPayment(t: PlatformTerms | null): string {
  return t ? `${fmtHoldDays(t.holdDays)} after payment` : "after the clearing hold";
}

// ---------------------------------------------------------------- fetch helpers

type Envelope<T> = { data?: T; error?: { code: string; message: string; details?: unknown } };

/** Session Bearer header — keeps auth working where cookies are unavailable. */
function withAuth(extra?: Record<string, string>): Record<string, string> {
  return { ...authHeaders(), ...(extra ?? {}) };
}

/** A 401 means the session is gone/invalid — surface it so app-root can
 *  re-check identity and the portal auth gates take over immediately
 *  (instead of leaving a zombie dashboard behind). Throttled in the emitter. */
function noteUnauthorized(status: number): void {
  if (status === 401) signalSessionExpired();
}

export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", headers: withAuth() });
  const body = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!res.ok || body.error) {
    noteUnauthorized(res.status);
    throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  }
  return body.data as T;
}

/** Like apiGet but also returns the pagination meta when present (okPaged).
 *  Meta type is the centralized contract ApiPageMeta (single source of truth). */
export async function apiGetPaged<T>(url: string): Promise<{ rows: T; meta: ApiPageMeta | null }> {
  const res = await fetch(url, { cache: "no-store", headers: withAuth() });
  const body = (await res.json().catch(() => ({}))) as Envelope<T> & { meta?: ApiPageMeta };
  if (!res.ok || body.error) {
    noteUnauthorized(res.status);
    throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  }
  return { rows: body.data as T, meta: body.meta ?? null };
}

export async function apiSend<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: withAuth({ "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!res.ok || payload.error) {
    noteUnauthorized(res.status);
    throw new Error(payload.error?.message ?? `Request failed (${res.status})`);
  }
  return payload.data as T;
}

/** Mutation wrapper: runs fn, toasts success/error, returns success boolean. */
export async function runMutation(fn: () => Promise<unknown>, successMsg: string): Promise<boolean> {
  try {
    await fn();
    toast.success(successMsg);
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Something went wrong");
    return false;
  }
}

// ---------------------------------------------------------------- data hook

export function useApi<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch reset
    setLoading(true);
    apiGet<T>(url)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [url, tick, ...deps]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch, setData };
}

// ---------------------------------------------------------------- terms hook

/** Module-level terms cache + in-flight dedupe: every seller view that needs
 *  platform parameters (dashboard, wallet, orders, settings, onboarding)
 *  shares ONE request per 60 s window instead of one per component mount.
 *  A view switch never re-fires while the cache is warm; a failed fetch
 *  clears nothing (components keep their graceful generic copy). */
const TERMS_TTL_MS = 60_000;
let termsCache: { at: number; data: PlatformTerms } | null = null;
let termsInflight: Promise<PlatformTerms> | null = null;

export function useSellerTerms(): { terms: PlatformTerms | null; loading: boolean } {
  const [terms, setTerms] = useState<PlatformTerms | null>(termsCache ? termsCache.data : null);

  useEffect(() => {
    const cached = termsCache;
    if (cached && Date.now() - cached.at < TERMS_TTL_MS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- cache-hit sync reset
      setTerms(cached.data);
      return;
    }
    if (!termsInflight) {
      termsInflight = apiGet<PlatformTerms>("/api/store/terms")
        .then((d) => {
          termsCache = { at: Date.now(), data: d };
          return d;
        })
        .finally(() => {
          termsInflight = null;
        });
    }
    let alive = true;
    termsInflight
      .then((d) => {
        if (alive) setTerms(d);
      })
      .catch(() => {
        /* keep graceful generic copy — never break a view over terms */
      });
    return () => {
      alive = false;
    };
  }, []);

  return { terms, loading: terms === null };
}

// ---------------------------------------------------------------- status chip

const STATUS_STYLES: Record<string, string> = {
  // positive — soft mint tints
  active: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  live: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  paid: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  delivered: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  received: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  verified: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  issued: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  succeeded: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  done: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  // in-progress / attention — amber
  processing: "bg-amber-50 text-amber-700 border-amber-200/70",
  shipped: "bg-amber-50 text-amber-700 border-amber-200/70",
  pending_review: "bg-amber-50 text-amber-700 border-amber-200/70",
  verifying: "bg-amber-50 text-amber-700 border-amber-200/70",
  onboarding: "bg-amber-50 text-amber-700 border-amber-200/70",
  requested: "bg-amber-50 text-amber-700 border-amber-200/70",
  processing_payout: "bg-amber-50 text-amber-700 border-amber-200/70",
  // neutral — slate
  draft: "bg-slate-100 text-slate-600 border-slate-200/70",
  pending: "bg-slate-100 text-slate-600 border-slate-200/70",
  payment_pending: "bg-slate-100 text-slate-600 border-slate-200/70",
  requires_payment: "bg-slate-100 text-slate-600 border-slate-200/70",
  // warning money — amber (in-flight refunds)
  refunding: "bg-amber-50 text-amber-700 border-amber-200/70",
  partially_refunded: "bg-amber-50 text-amber-700 border-amber-200/70",
  // negative — rose
  refunded: "bg-rose-50 text-rose-600 border-rose-200/70",
  cancelled: "bg-rose-50 text-rose-600 border-rose-200/70",
  rejected: "bg-rose-50 text-rose-600 border-rose-200/70",
  banned: "bg-rose-50 text-rose-600 border-rose-200/70",
  failed: "bg-rose-50 text-rose-600 border-rose-200/70",
  archived: "bg-rose-50 text-rose-600 border-rose-200/70",
  suspended: "bg-rose-50 text-rose-600 border-rose-200/70",
  terminated: "bg-rose-50 text-rose-600 border-rose-200/70",
  closed: "bg-rose-50 text-rose-600 border-rose-200/70",
};

const STATUS_LABELS: Record<string, string> = {
  payment_pending: "Unpaid",
  pending_review: "In review",
  partially_refunded: "Partly refunded",
  received: "Buyer received",
};

export function StatusChip({ status, className }: { status: string | null | undefined; className?: string }) {
  const s = (status ?? "unknown").toLowerCase();
  return (
    <Badge variant="outline" className={cn("border font-semibold capitalize", STATUS_STYLES[s] ?? "bg-slate-100 text-slate-600 border-slate-200/70", className)}>
      {STATUS_LABELS[s] ?? s.replace(/_/g, " ")}
    </Badge>
  );
}

// ---------------------------------------------------------------- small parts

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  /** Task 6 — widened to ReactNode so Insights cards can pass delta chips
   *  (spans/badges) as the sub line; plain strings keep working. */
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "default" | "warn" | "bad";
  /** R2-UI — optional click target (e.g. Pending → release schedule). When
   *  provided the card renders as an accessible button (keyboard Enter/Space,
   *  focus ring); visuals stay identical when omitted. */
  onClick?: () => void;
}) {
  const interactive = typeof onClick === "function";
  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card",
        interactive &&
          "cursor-pointer transition-colors hover:bg-teal-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
      )}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
        {icon ? (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">{icon}</span>
        ) : null}
      </div>
      <p
        className={cn(
          "mt-2 text-2xl font-extrabold tracking-tight text-slate-900 tabular-nums",
          tone === "bad" && "text-rose-600",
          tone === "warn" && "text-amber-600"
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 p-10 text-center">
      <div className="text-slate-400">{icon ?? <Inbox className="h-8 w-8" />}</div>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function RowsSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  );
}

/** RM input: displays a decimal string, reports minor units. */
export function MoneyInput({
  valueMinor,
  onChangeMinor,
  placeholder,
  className,
  id,
}: {
  valueMinor: number | null;
  onChangeMinor: (minor: number) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [text, setText] = useState<string>(valueMinor == null ? "" : (valueMinor / 100).toFixed(2));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setText(valueMinor == null ? "" : (valueMinor / 100).toFixed(2));
  }, [valueMinor]);
  return (
    <div className={cn("relative", className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">RM</span>
      <Input
        id={id}
        inputMode="decimal"
        className="pl-10"
        placeholder={placeholder ?? "0.00"}
        value={text}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, "");
          setText(v);
          onChangeMinor(toMinor(v));
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- dates

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  try {
    return format(new Date(v), "d MMM yyyy");
  } catch {
    return "—";
  }
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  try {
    return format(new Date(v), "d MMM yyyy, HH:mm");
  } catch {
    return "—";
  }
}

export function ageOf(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const ms = Date.now() - new Date(v).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------- copy button

export function CopyButton({ text, label }: { text: string; label?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 gap-1 px-2 text-xs"
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

/** Debounced callback ref helper (used by the builder autosave). */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const run = useCallback(
    (...args: A) => {
      cancel();
      timer.current = setTimeout(() => fnRef.current(...args), delayMs);
    },
    [cancel, delayMs]
  );
  useEffect(() => cancel, [cancel]);
  return { run, cancel };
}

export { formatMinor, toMinor };

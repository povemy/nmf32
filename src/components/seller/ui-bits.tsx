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
  | "products"
  | "orders"
  | "wallet"
  | "builder"
  | "domains"
  | "coupons"
  | "integrations"
  | "settings";

export type SellerNav = { view: SellerViewName; pageId?: string; orderId?: string; productId?: string };

// ---------------------------------------------------------------- fetch helpers

type Envelope<T> = { data?: T; error?: { code: string; message: string; details?: unknown } };

export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  return body.data as T;
}

/** Like apiGet but also returns the pagination meta when present (okPaged). */
export async function apiGetPaged<T>(url: string): Promise<{ rows: T; meta: { page: number; size: number; total: number } | null }> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Envelope<T> & { meta?: { page: number; size: number; total: number } };
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  return { rows: body.data as T, meta: body.meta ?? null };
}

export async function apiSend<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!res.ok || payload.error) throw new Error(payload.error?.message ?? `Request failed (${res.status})`);
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

// ---------------------------------------------------------------- status chip

const STATUS_STYLES: Record<string, string> = {
  // positive
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  live: "bg-emerald-100 text-emerald-800 border-emerald-200",
  paid: "bg-emerald-100 text-emerald-800 border-emerald-200",
  completed: "bg-emerald-100 text-emerald-800 border-emerald-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  verified: "bg-emerald-100 text-emerald-800 border-emerald-200",
  issued: "bg-emerald-100 text-emerald-800 border-emerald-200",
  success: "bg-emerald-100 text-emerald-800 border-emerald-200",
  succeeded: "bg-emerald-100 text-emerald-800 border-emerald-200",
  done: "bg-emerald-100 text-emerald-800 border-emerald-200",
  // in-progress / attention
  processing: "bg-amber-100 text-amber-800 border-amber-200",
  shipped: "bg-amber-100 text-amber-800 border-amber-200",
  pending_review: "bg-amber-100 text-amber-800 border-amber-200",
  verifying: "bg-amber-100 text-amber-800 border-amber-200",
  onboarding: "bg-amber-100 text-amber-800 border-amber-200",
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  processing_payout: "bg-amber-100 text-amber-800 border-amber-200",
  // neutral
  draft: "bg-muted text-muted-foreground border-border",
  pending: "bg-muted text-muted-foreground border-border",
  payment_pending: "bg-muted text-muted-foreground border-border",
  requires_payment: "bg-muted text-muted-foreground border-border",
  // warning money
  refunding: "bg-orange-100 text-orange-800 border-orange-200",
  partially_refunded: "bg-orange-100 text-orange-800 border-orange-200",
  // negative
  refunded: "bg-rose-100 text-rose-800 border-rose-200",
  cancelled: "bg-rose-100 text-rose-800 border-rose-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
  banned: "bg-rose-100 text-rose-800 border-rose-200",
  failed: "bg-rose-100 text-rose-800 border-rose-200",
  archived: "bg-rose-100 text-rose-800 border-rose-200",
  suspended: "bg-rose-100 text-rose-800 border-rose-200",
  terminated: "bg-rose-100 text-rose-800 border-rose-200",
  closed: "bg-rose-100 text-rose-800 border-rose-200",
};

const STATUS_LABELS: Record<string, string> = {
  payment_pending: "Unpaid",
  pending_review: "In review",
  partially_refunded: "Partly refunded",
};

export function StatusChip({ status, className }: { status: string | null | undefined; className?: string }) {
  const s = (status ?? "unknown").toLowerCase();
  return (
    <Badge variant="outline" className={cn("border font-medium capitalize", STATUS_STYLES[s] ?? "bg-muted text-muted-foreground border-border", className)}>
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
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  tone?: "default" | "warn" | "bad";
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <p
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums sm:text-2xl",
          tone === "bad" && "text-rose-600",
          tone === "warn" && "text-amber-600"
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-10 text-center">
      <div className="text-muted-foreground">{icon ?? <Inbox className="h-8 w-8" />}</div>
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function RowsSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
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

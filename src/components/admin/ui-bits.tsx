"use client";
// Shared UI primitives for the admin command centre (chips, money, dialogs, states).
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, Copy, Inbox, Loader2, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { parseJsonSafe } from "./use-api";

/* ------------------------------------------------------------------ tones */

type Tone = "emerald" | "amber" | "red" | "gray" | "teal" | "slate" | "violet";

export const TONE_CLASS: Record<Tone, string> = {
  emerald:
    "border-emerald-200/70 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
  amber:
    "border-amber-200/70 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
  red: "border-rose-200/70 bg-rose-50 text-rose-600 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300",
  gray: "border-slate-200/70 bg-slate-100 text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400",
  teal: "border-teal-200/70 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300",
  slate:
    "border-slate-200/70 bg-slate-100 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
  violet:
    "border-violet-200/70 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300",
};

const EMERALD_STATUSES = new Set([
  "active", "live", "paid", "approved", "verified", "completed", "delivered", "received", "success",
  "succeeded", "sent", "processed", "resolved", "issued", "ok", "done", "match",
]);
const AMBER_STATUSES = new Set([
  "pending", "pending_review", "processing", "verifying", "open", "queued", "requires_payment",
  "onboarding", "under_review", "refunding", "partially_refunded", "payment_pending", "requested",
  "running", "partial",
]);
const RED_STATUSES = new Set([
  "suspended", "rejected", "banned", "failed", "dead", "terminated", "urgent", "high",
  "mismatch", "drift",
]);
const TEAL_STATUSES = new Set(["shipped", "medium"]);

export function statusTone(status?: string | null): Tone {
  const s = (status ?? "").toLowerCase();
  if (EMERALD_STATUSES.has(s)) return "emerald";
  if (AMBER_STATUSES.has(s)) return "amber";
  if (RED_STATUSES.has(s)) return "red";
  if (TEAL_STATUSES.has(s)) return "teal";
  return "gray";
}

export function StatusChip({ status, className }: { status?: string | null; className?: string }) {
  const tone = statusTone(status);
  const label = (status ?? "unknown").replace(/_/g, " ");
  return (
    <Badge variant="outline" className={cn(TONE_CLASS[tone], "capitalize", className)}>
      {label}
    </Badge>
  );
}

export function RiskChip({ tier }: { tier?: string | null }) {
  const t = (tier ?? "low").toLowerCase();
  const tone: Tone = t === "high" ? "red" : t === "medium" ? "amber" : "emerald";
  return (
    <Badge variant="outline" className={cn(TONE_CLASS[tone], "capitalize")}>
      risk: {t}
    </Badge>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  const tone: Tone = channel === "email" ? "teal" : channel === "whatsapp" ? "emerald" : "violet";
  return <Badge variant="outline" className={TONE_CLASS[tone]}>{channel}</Badge>;
}

/* ------------------------------------------------------------------ money */

export function Money({
  minor,
  className,
  muted,
  bold,
}: {
  minor: number | null | undefined;
  className?: string;
  muted?: boolean;
  bold?: boolean;
}) {
  const v = minor ?? 0;
  return (
    <span
      className={cn(
        "tabular-nums whitespace-nowrap",
        bold && "font-semibold",
        v < 0 && "text-red-600 dark:text-red-400",
        muted && "text-muted-foreground",
        className
      )}
    >
      {formatMinor(v)}
    </span>
  );
}

/* ------------------------------------------------------------------ dates */

export function fmtDT(iso?: string | Date | null): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-MY", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function fmtDate(iso?: string | Date | null): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

export function timeAgo(iso?: string | Date | null): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 30) return `${Math.floor(secs / 86400)}d ago`;
  return fmtDate(d);
}

/* --------------------------------------------------------------- layout */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-extrabold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Vertically scrollable region with the app scrollbar styling (long lists). */
export function ScrollY({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "max-h-[480px] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:rgba(20,184,166,0.45)_transparent]",
        "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent",
        "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/30 hover:[&::-webkit-scrollbar-thumb]:bg-teal-600/50",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] leading-tight text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- KPIs */

export function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  onClick,
  tone = "plain",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  onClick?: () => void;
  tone?: Tone | "plain";
}) {
  const clickable = Boolean(onClick);
  // Tone-tinted icon chip (recipe 4): soft 50-tint background + 600/700 text.
  const chipTone =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400"
      : tone === "amber"
        ? "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
        : tone === "red"
          ? "bg-rose-50 text-rose-600 dark:bg-red-950/40 dark:text-red-400"
          : tone === "teal"
            ? "bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300"
            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (clickable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={cn(
        "rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card transition-shadow",
        clickable && "cursor-pointer hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
        {Icon ? (
          <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", chipTone)}>
            <Icon className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <div className="mt-2 text-2xl font-extrabold tracking-tight tabular-nums text-slate-900">{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- states */

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300">
        <Inbox className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-50 text-rose-600 dark:bg-red-950/50 dark:text-red-400">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-medium">Could not load data</p>
        <p className="mt-0.5 max-w-md text-xs text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="min-h-[44px] sm:min-h-0">
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      ) : null}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {Array.from({ length: cols }).map((_, i) => (
            <TableHead key={i}>
              <Skeleton className="h-3.5 w-16" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r}>
            {Array.from({ length: cols }).map((_, c) => (
              <TableCell key={c}>
                <Skeleton className={cn("h-4", c === 0 ? "w-28" : "w-16")} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function CardsSkeleton({ n = 6, className }: { n?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="mt-4 flex gap-2">
            <Skeleton className="h-9 flex-1" />
            <Skeleton className="h-9 flex-1" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Pager({
  page,
  size,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  size: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, size)));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
      <p className="text-xs text-muted-foreground">
        {total} record{total === 1 ? "" : "s"} · page {Math.min(page, pages)} of {pages}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" disabled={page <= 1} onClick={onPrev}>
          Previous
        </Button>
        <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" disabled={page >= pages} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- dialogs */

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className={cn(destructive && "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600")}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Destructive confirm where the user must type the object id exactly. */
export function TypingConfirm({
  open,
  onOpenChange,
  title,
  description,
  expected,
  confirmLabel = "Delete",
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  expected: string;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <TypingConfirmInner
          title={title}
          description={description}
          expected={expected}
          confirmLabel={confirmLabel}
          loading={loading}
          onConfirm={onConfirm}
        />
      ) : null}
    </AlertDialog>
  );
}

function TypingConfirmInner({
  title,
  description,
  expected,
  confirmLabel = "Delete",
  loading,
  onConfirm,
}: {
  title: string;
  description?: string;
  expected: string;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
}) {
  const [text, setText] = useState("");
  const match = text.trim() === expected;
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2">
          <TriangleAlert className="h-4 w-4 text-red-600" /> {title}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {description ?? "This action is irreversible."} Type{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-semibold text-foreground">{expected}</code>{" "}
          to confirm.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={expected}
        aria-label={`Type ${expected} to confirm`}
        className="min-h-[44px]"
        autoComplete="off"
      />
      <AlertDialogFooter>
        <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          disabled={!match || loading}
          onClick={(e) => {
            e.preventDefault();
            if (match) onConfirm();
          }}
          className="bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  submitLabel = "Submit",
  destructive,
  loading,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  placeholder?: string;
  submitLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onSubmit: (reason: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ReasonDialogInner
          onOpenChange={onOpenChange}
          title={title}
          description={description}
          placeholder={placeholder}
          submitLabel={submitLabel}
          destructive={destructive}
          loading={loading}
          onSubmit={onSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function ReasonDialogInner({
  onOpenChange,
  title,
  description,
  placeholder,
  submitLabel = "Submit",
  destructive,
  loading,
  onSubmit,
}: {
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  placeholder?: string;
  submitLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={placeholder ?? "Reason…"}
        rows={4}
        className="resize-none"
      />
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading} className="min-h-[44px] sm:min-h-0">
          Cancel
        </Button>
        <Button
          onClick={() => onSubmit(reason.trim())}
          disabled={loading || !reason.trim()}
          className={cn("min-h-[44px] sm:min-h-0", destructive && "bg-red-600 text-white hover:bg-red-700")}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : submitLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      aria-label={label ?? "Copy"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success("Copied to clipboard", { description: text });
        } catch {
          toast.error("Could not copy");
        }
      }}
    >
      <Copy className="h-3.5 w-3.5" />
    </Button>
  );
}

/* -------------------------------------------------------------- breakdown */

const BREAKDOWN_MONEY_KEYS = new Set([
  "base", "percent_part", "fixed_fee_allocated", "discount_allocated", "shipping_allocated",
]);

function breakdownValue(key: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (key === "flags") {
    const arr = Array.isArray(v) ? v.map(String) : [];
    return arr.length ? arr.join(", ") : null;
  }
  if (BREAKDOWN_MONEY_KEYS.has(key)) return formatMinor(Number(v));
  if (typeof v === "number") return key === "percent" ? `${v}%` : String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Renders a commission breakdownJson payload as key:value chips. */
export function BreakdownChips({ json, className }: { json?: string | null; className?: string }) {
  const data = parseJsonSafe<Record<string, unknown>>(json, {});
  const entries = Object.entries(data).filter(([k, v]) => breakdownValue(k, v) !== null);
  if (entries.length === 0) return <span className="text-xs text-muted-foreground">No breakdown snapshot</span>;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {entries.map(([k, v]) => {
        const val = breakdownValue(k, v) as string;
        const highlight = k === "rule_source";
        return (
          <span
            key={k}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]",
              highlight ? TONE_CLASS.teal : "bg-muted/60 text-muted-foreground"
            )}
          >
            <span className="font-medium capitalize">{k.replace(/_/g, " ")}</span>
            <span className="tabular-nums">{val}</span>
          </span>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- diff view */

function flatObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function diffVal(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  if (key.endsWith("Minor")) return formatMinor(Number(v));
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Field-by-field before/after viewer for audit log rows. */
export function DiffViewer({ beforeJson, afterJson }: { beforeJson?: string | null; afterJson?: string | null }) {
  const before = flatObj(parseJsonSafe<unknown>(beforeJson, {}));
  const after = flatObj(parseJsonSafe<unknown>(afterJson, {}));
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  if (keys.length === 0) {
    return <p className="text-xs text-muted-foreground">No structured before/after snapshot recorded for this entry.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-40">Field</TableHead>
            <TableHead>Before</TableHead>
            <TableHead>After</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((k) => {
            const b = k in before ? diffVal(k, before[k]) : null;
            const a = k in after ? diffVal(k, after[k]) : null;
            const changed = b !== a;
            const added = b === null;
            const removed = a === null;
            return (
              <TableRow key={k} className={cn(changed && !removed && "bg-amber-50/60 dark:bg-amber-950/20")}>
                <TableCell className="font-mono text-[11px] font-medium">{k}</TableCell>
                <TableCell className={cn("text-xs tabular-nums", removed && "text-red-600 line-through dark:text-red-400")}>
                  {b ?? "—"}
                </TableCell>
                <TableCell className={cn("text-xs tabular-nums", added && "font-medium text-emerald-700 dark:text-emerald-400")}>
                  {a ?? "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Green/red health dot used across dashboard + health screens. */
export function HealthDot({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" aria-label={label ?? (ok ? "Healthy" : "Problem")}>
      <span className={cn("relative flex h-2 w-2 rounded-full", ok ? "bg-emerald-500" : "bg-red-500")}>
        {!ok ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" /> : null}
      </span>
      <span className={ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
        {ok ? "Healthy" : "Problem"}
      </span>
    </span>
  );
}

export function CheckRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", ok ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
      <Check className="h-3.5 w-3.5" /> {children}
    </span>
  );
}

"use client";
// SYS-01 Settings · SYS-02 Feature Flags · SYS-03 Audit Log (with diff viewer)
// SYS-04 Activity Log · SYS-05 Notifications · SYS-06 System Health.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity as ActivityIcon,
  ArrowDown,
  ArrowUp,
  Banknote,
  Check,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  EyeOff,
  HeartPulse,
  Loader2,
  Mail,
  MessageCircle,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  Trash2,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-store";
import {
  HOME_SECTIONS,
  sectionOrderFromSetting,
  type HomeSectionId,
} from "@/lib/home-layout";
import {
  SETTING_GROUPS,
  settingMetaFor,
  validateSettingValue,
  type SettingGroup,
  type SettingMeta,
} from "@/lib/settings-registry";
import { apiSend, apiGet, useApi } from "./use-api";
import { qs } from "./nav";
import { MfaCard } from "./mfa-card";
import {
  CardsSkeleton,
  DiffViewer,
  EmptyState,
  ErrorState,
  HealthDot,
  KpiCard,
  PageHeader,
  Pager,
  StatusChip,
  TableSkeleton,
  fmtDT,
  timeAgo,
} from "./ui-bits";

/* ------------------------------------------------------------- SettingsView */

type SettingRow = {
  key: string;
  valueJson: string;
  description?: string | null;
  updatedAt?: string | null;
  meta: SettingMeta;
};

function parseVal<T>(raw: string | undefined, fallback: T): T {
  if (raw === undefined || raw === null || raw === "") return fallback;
  try {
    const v = JSON.parse(raw) as T;
    return (v === null || v === undefined ? fallback : v) as T;
  } catch {
    return fallback;
  }
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const GROUP_ICON: Record<SettingGroup["icon"], LucideIcon> = {
  store: Store,
  banknote: Banknote,
  shield: ShieldCheck,
  "credit-card": CreditCard,
  sliders: SlidersHorizontal,
  activity: ActivityIcon,
  wrench: Wrench,
};

function WiredBadge({ wired }: { wired: boolean }) {
  return wired ? (
    <Badge
      variant="outline"
      className="border-emerald-200 bg-emerald-50 text-[10px] font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
    >
      Active
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="border-amber-200 bg-amber-50 text-[10px] font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
    >
      Not wired yet
    </Badge>
  );
}

function DangerBadge() {
  return (
    <Badge
      variant="outline"
      className="border-red-200 bg-red-50 text-[10px] font-semibold text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300"
    >
      Careful
    </Badge>
  );
}

/** Numeric input with local text state so typing stays smooth; commits a
 *  clamped number on blur or Enter. `decimals` controls echo formatting. */
function NumberInput({
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  prefix,
  disabled,
  onCommit,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  prefix?: string;
  disabled?: boolean;
  onCommit: (n: number) => void;
  className?: string;
}) {
  const fmt = (n: number) => n.toFixed(decimals);
  const [text, setText] = useState(fmt(value));
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync when the stored value changes externally (save/refetch)
  useEffect(() => setText(fmt(value)), [value]);
  const commit = (t: string) => {
    const n = parseFloat(t);
    if (!Number.isFinite(n)) {
      setText(fmt(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    onCommit(clamped);
    setText(fmt(clamped));
  };
  return (
    <div className={cn("relative", className)}>
      {prefix ? (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">{prefix}</span>
      ) : null}
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        aria-label="Setting value"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn("min-h-[44px] sm:min-h-[36px]", prefix && "pl-8")}
      />
    </div>
  );
}

/* --------------------------------------------------------- friendly JSON */

/** Split a camelCase JSON key into a readable label ("durationMs" → "Duration ms"). */
function jsonKeyLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** One friendly value cell: timestamps → readable date-time, durations →
 *  seconds, booleans → Yes/No, numbers → grouped digits, null → em dash. */
function JsonValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-muted-foreground/60">—</span>;
  if (typeof v === "boolean") {
    return (
      <Badge
        variant="outline"
        className={cn(
          "text-[10px] font-semibold",
          v ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300" : "border-muted-foreground/30 bg-muted text-muted-foreground"
        )}
      >
        {v ? "Yes" : "No"}
      </Badge>
    );
  }
  if (typeof v === "number") {
    const label = v >= 10_000 && Number.isInteger(v) ? v.toLocaleString("en-MY") : String(v);
    return <span className="tabular-nums">{label}</span>;
  }
  if (typeof v === "string") {
    if (ISO_RE.test(v)) return <span>{new Date(v).toLocaleString("en-MY", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>;
    return <span className="break-all">{v}</span>;
  }
  return <span className="break-all font-mono text-[11px]">{JSON.stringify(v)}</span>;
}

/** Friendly renderer for system-written JSON settings (cron last-run blobs,
 *  id lists) — key/value rows in plain language instead of a raw JSON blob.
 *  The raw payload stays one toggle away for debugging. */
function SystemStateView({ valueJson }: { valueJson: string }) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(valueJson) as unknown;
    } catch {
      return undefined;
    }
  }, [valueJson]);

  if (parsed === undefined) {
    return (
      <pre className="max-h-32 w-full overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed [scrollbar-width:thin]">{valueJson}</pre>
    );
  }

  const rows: Array<{ label: string; value: unknown }> = [];
  if (Array.isArray(parsed)) {
    rows.push({ label: "Items", value: parsed.length });
    for (const [i, item] of parsed.slice(0, 6).entries()) rows.push({ label: `#${i + 1}`, value: item });
    if (parsed.length > 6) rows.push({ label: "Remaining", value: `${parsed.length - 6} more…` });
  } else if (parsed !== null && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      rows.push({ label: k === "durationMs" ? "Duration" : k === "at" || k === "ranAt" ? "Ran at" : jsonKeyLabel(k), value: v });
    }
  } else {
    rows.push({ label: "Value", value: parsed });
  }

  return (
    <div className="w-full space-y-2">
      <div className="rounded-lg border bg-muted/40 p-0">
        <dl className="divide-y [&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-4 [&>div]:px-3 [&>div]:py-1.5">
          {rows.map((r) => {
            const isDur = /duration/i.test(r.label);
            return (
              <div key={r.label}>
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="text-right text-xs font-medium">
                  {isDur && typeof r.value === "number" ? `${(r.value / 1000).toFixed(2)} s` : <JsonValue v={r.value} />}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-[36px] items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" /> Raw JSON
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="max-h-40 w-full overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed [scrollbar-width:thin]">{prettyJson(valueJson)}</pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/* ------------------------------------------------- homepage order editor */

const SECTION_LABEL: Record<HomeSectionId, string> = HOME_SECTIONS.reduce(
  (acc, s) => ({ ...acc, [s.id]: s.label }),
  {} as Record<HomeSectionId, string>
);

/** Friendly editor for Setting `home.section_order` — an ordered list with
 *  up/down/hide controls plus an add-back shelf, serialising to the same JSON
 *  array the homepage reads. Replaces the raw-JSON textarea for newbies. */
function SectionOrderEditor({
  valueJson,
  disabled,
  onChange,
}: {
  valueJson: string;
  disabled?: boolean;
  onChange: (nextJson: string) => void;
}) {
  const order = useMemo(() => sectionOrderFromSetting(valueJson), [valueJson]);
  const inlineCount = order.filter((s) => s === "inline").length;
  const available = HOME_SECTIONS.filter((s) => {
    if (s.id === "hero") return false; // hero is mandatory — always in the list
    if (s.id === "inline") return inlineCount < 3;
    return !order.includes(s.id);
  });

  const move = (i: number, dir: -1 | 1) => {
    const next = [...order];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    // Hero is pinned to slot 0 — nothing may move above it.
    if (next[j] === "hero") return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(JSON.stringify(next));
  };
  const hide = (i: number) => {
    const next = [...order];
    if (next[i] === "hero") return; // hero cannot be hidden
    next.splice(i, 1);
    onChange(JSON.stringify(next));
  };
  const add = (id: HomeSectionId) => {
    const next = [...order, id];
    if (id === "hero") {
      // defensive: normalize would pin hero first anyway
      next.splice(next.indexOf("hero"), 1);
      next.unshift("hero");
    }
    onChange(JSON.stringify(next));
  };

  const Row = ({ id, i }: { id: HomeSectionId; i: number }) => {
    const isHero = id === "hero";
    const meta = HOME_SECTIONS.find((s) => s.id === id);
    return (
      <li className="flex min-h-[44px] items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-600/10 text-[11px] font-semibold text-teal-700 dark:text-teal-300" aria-hidden="true">
          {i + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{SECTION_LABEL[id]}</p>
          <p className="truncate text-[11px] text-muted-foreground">{meta?.description}</p>
        </div>
        {isHero ? (
          <Badge variant="outline" className="shrink-0 border-teal-200 bg-teal-50 text-[10px] font-semibold text-teal-800 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300">
            Always first
          </Badge>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move ${SECTION_LABEL[id]} up`} disabled={disabled || order[i - 1] === "hero"} onClick={() => move(i, -1)}>
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move ${SECTION_LABEL[id]} down`} disabled={disabled || i === order.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-rose-600 hover:text-rose-700" aria-label={`Hide ${SECTION_LABEL[id]} from the homepage`} disabled={disabled} onClick={() => hide(i)}>
              <EyeOff className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="w-full space-y-3">
      <ol className="space-y-1.5" aria-label="Homepage section order">
        {order.map((id, i) => (
          <Row key={`${id}-${i}`} id={id} i={i} />
        ))}
      </ol>
      {available.length > 0 ? (
        <div className="rounded-lg border border-dashed p-2.5">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Hidden sections — click to add back to the homepage</p>
          <div className="flex flex-wrap gap-1.5">
            {available.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={disabled}
                onClick={() => add(s.id)}
                className="inline-flex min-h-[32px] items-center gap-1 rounded-full border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-teal-300 hover:bg-teal-50 hover:text-teal-900 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:border-teal-800 dark:hover:bg-teal-950/60 dark:hover:text-teal-200"
              >
                <Plus className="h-3 w-3" /> {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">Sections render top-to-bottom in this order. Hiding a section here removes it from the homepage immediately (within the 60 s cache).</p>
    </div>
  );
}

/* ------------------------------------------------------------------ row bits */

function SettingHead({ meta }: { meta: SettingMeta }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium leading-tight">{meta.label}</p>
        <WiredBadge wired={meta.wired} />
        {meta.danger ? <DangerBadge /> : null}
      </div>
      <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-muted-foreground">{meta.description}</p>
      {meta.wiredNote ? <p className="mt-1 text-[11px] italic text-muted-foreground/80">{meta.wiredNote}</p> : null}
      <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">{meta.key}</p>
    </div>
  );
}

function UpdatedNote({ updatedAt }: { updatedAt?: string | null }) {
  if (!updatedAt) return null;
  return <span className="shrink-0 text-[10px] text-muted-foreground/70">saved {timeAgo(updatedAt)}</span>;
}

/* -------------------------------------------------------------- SettingsView */

export function SettingsView() {
  const me = useApp((s) => s.me);
  const canEdit = Boolean(me.loaded && me.admin?.role === "superadmin");

  const { data, error, loading, refetch } = useApi<SettingRow[]>("/api/admin/settings");
  const rows = data ?? [];

  // drafts[key] holds the edited valueJson — only present while a row is dirty.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState<string[]>([]);

  const current = (r: SettingRow) => drafts[r.key] ?? r.valueJson;
  const isDirty = (r: SettingRow) => drafts[r.key] !== undefined && drafts[r.key] !== r.valueJson;
  const draftError = (r: SettingRow): string | null => {
    if (!isDirty(r)) return null;
    if (r.meta.field.kind === "readonly") return "Read-only — written by the system.";
    const res = validateSettingValue(r.key, current(r));
    return res.ok ? null : res.error;
  };

  const setValue = (r: SettingRow, valueJson: string) =>
    setDrafts((d) => ({ ...d, [r.key]: valueJson }));
  const resetRow = (key: string) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });

  const saveKeys = async (groupRows: SettingRow[]) => {
    const keys = groupRows.filter(isDirty).map((r) => r.key);
    if (!canEdit || keys.length === 0) return;
    setSavingKeys((s) => [...new Set([...s, ...keys])]);
    try {
      await apiSend("/api/admin/settings", "PUT", {
        settings: keys.map((key) => ({ key, valueJson: drafts[key] })),
      });
      toast.success(keys.length === 1 ? "Setting saved" : `${keys.length} settings saved`, { description: keys.join(", ") });
      setDrafts((d) => {
        const next = { ...d };
        for (const k of keys) delete next[k];
        return next;
      });
      void refetch();
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingKeys((s) => s.filter((k) => !keys.includes(k)));
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, SettingRow[]>();
    for (const r of rows) {
      const g = r.meta?.group ?? "advanced";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(r);
    }
    return map;
  }, [rows]);
  const groupsWithRows = SETTING_GROUPS.filter((g) => (grouped.get(g.id) ?? []).length > 0);

  /* ---- individual control renderers ------------------------------------- */

  const renderControl = (r: SettingRow) => {
    const field = r.meta.field;
    const disabled = !canEdit || !r.meta.wired || savingKeys.includes(r.key);
    const valueJson = current(r);

    switch (field.kind) {
      case "boolean": {
        const on = parseVal<boolean>(valueJson, field.default);
        return (
          <Switch
            checked={on}
            disabled={disabled}
            onCheckedChange={(v) => setValue(r, JSON.stringify(v))}
            aria-label={r.meta.label}
          />
        );
      }
      case "integer": {
        const n = parseVal<number>(valueJson, field.default);
        if (field.major) {
          const f = field.major.factor;
          return (
            <NumberInput
              value={n / f}
              min={field.min / f}
              max={field.max / f}
              step={1}
              decimals={field.major.decimals}
              prefix={field.major.label}
              disabled={disabled}
              onCommit={(v) => setValue(r, JSON.stringify(Math.round(v * f)))}
              className="w-32"
            />
          );
        }
        return (
          <NumberInput
            value={n}
            min={field.min}
            max={field.max}
            step={1}
            decimals={0}
            disabled={disabled}
            onCommit={(v) => setValue(r, JSON.stringify(Math.round(v)))}
            className="w-24"
          />
        );
      }
      case "enum": {
        const v = parseVal<string>(valueJson, field.default);
        return (
          <Select value={v} disabled={disabled} onValueChange={(val) => setValue(r, JSON.stringify(val))}>
            <SelectTrigger className="min-h-[44px] w-full sm:w-56 sm:min-h-[36px]" aria-label={r.meta.label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {field.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }
      case "weights": {
        const w = parseVal<Record<string, number>>(valueJson, field.default);
        const sum = field.keys.reduce((acc, k) => acc + (Number(w[k.key]) || 0), 0);
        return (
          <div className="w-full space-y-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {field.keys.map((k) => (
                <div key={k.key} className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{k.label}</Label>
                  <NumberInput
                    value={Number(w[k.key]) || 0}
                    min={0}
                    max={1}
                    step={0.05}
                    decimals={2}
                    disabled={disabled}
                    onCommit={(v) => setValue(r, JSON.stringify({ ...w, [k.key]: v }))}
                  />
                </div>
              ))}
            </div>
            <p className={cn("text-[11px]", Math.abs(sum - 1) < 0.001 ? "text-muted-foreground" : "font-medium text-amber-700 dark:text-amber-400")}>
              Weights sum to {sum.toFixed(2)} — 1.00 is the usual setup.
            </p>
          </div>
        );
      }
      case "string_list": {
        const list = parseVal<string[]>(valueJson, field.default);
        const toggle = (v: string) =>
          setValue(r, JSON.stringify(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]));
        return (
          <div className="flex w-full flex-wrap gap-2">
            {field.options.map((o) => {
              const active = list.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() => toggle(o.value)}
                  className={cn(
                    "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-teal-600 bg-teal-50 text-teal-900 dark:border-teal-500 dark:bg-teal-950/60 dark:text-teal-200"
                      : "border-border bg-background text-muted-foreground hover:bg-muted"
                  )}
                >
                  {active ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                  {o.label}
                </button>
              );
            })}
          </div>
        );
      }
      case "readonly": {
        return <SystemStateView valueJson={valueJson} />;
      }
      case "json":
      default: {
        // The homepage section order gets the friendly reorder editor — raw
        // JSON stays only for genuinely unknown Advanced keys.
        if (r.key === "home.section_order") {
          return <SectionOrderEditor valueJson={valueJson} disabled={!canEdit || savingKeys.includes(r.key)} onChange={(next) => setValue(r, next)} />;
        }
        return (
          <div className="w-full space-y-1.5">
            <Textarea
              value={valueJson}
              onChange={(e) => setValue(r, e.target.value)}
              rows={3}
              className="resize-y font-mono text-xs"
              aria-label={`${r.key} (JSON)`}
              placeholder='e.g. "friday" or 1000 or {"weights":{}}'
              disabled={!canEdit || savingKeys.includes(r.key)}
            />
            <p className="text-[11px] text-muted-foreground">Raw JSON — strings need quotes, numbers/booleans stay bare.</p>
          </div>
        );
      }
    }
  };

  const renderRow = (r: SettingRow) => {
    const err = draftError(r);
    const wide = ["weights", "string_list", "readonly", "json"].includes(r.meta.field.kind);
    const busy = savingKeys.includes(r.key);
    return (
      <div key={r.key} className={cn("flex flex-col gap-3 px-4 py-4 sm:px-6", wide ? "sm:flex-col" : "sm:flex-row sm:items-center")}>
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <SettingHead meta={r.meta} />
          <div className="hidden shrink-0 flex-col items-end sm:flex">
            <UpdatedNote updatedAt={r.updatedAt} />
          </div>
        </div>
        <div className={cn("flex items-center gap-2", wide ? "w-full flex-col items-stretch sm:flex-row sm:items-start" : "shrink-0")}>
          {renderControl(r)}
          {isDirty(r) ? (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-[44px] shrink-0 text-muted-foreground sm:min-h-[36px]"
              onClick={() => resetRow(r.key)}
              disabled={busy}
            >
              Undo
            </Button>
          ) : null}
          <div className="sm:hidden">
            <UpdatedNote updatedAt={r.updatedAt} />
          </div>
        </div>
        {err ? (
          <p className="text-xs font-medium text-red-600 dark:text-red-400" role="alert">
            {err}
          </p>
        ) : null}
      </div>
    );
  };

  /* ---- view -------------------------------------------------------------- */

  // Tabbed groups — one tab per settings group. The first group with rows is
  // the default tab. A small amber dot marks tabs with unsaved changes so a
  // newbie can never lose track of where their edits live.
  const defaultTab = groupsWithRows[0]?.id ?? "storefront";

  const renderGroupCard = (group: (typeof SETTING_GROUPS)[number]) => {
    const groupRows = grouped.get(group.id)!;
    const dirty = groupRows.filter(isDirty);
    const hasError = dirty.some((r) => draftError(r) !== null);
    const Icon = GROUP_ICON[group.icon] ?? Wrench;
    return (
      <Card key={group.id} className="py-0">
        <CardHeader className="px-4 pb-0 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="h-4 w-4 text-teal-600 dark:text-teal-400" /> {group.label}
          </CardTitle>
          <CardDescription>{group.description}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">{groupRows.map(renderRow)}</div>
          {dirty.length > 0 ? (
            <div className="flex flex-col gap-2 border-t bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p className="text-xs text-muted-foreground">
                {dirty.length} unsaved {dirty.length === 1 ? "change" : "changes"}
                {hasError ? " · fix the highlighted error first" : ""}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-[44px] sm:min-h-0"
                  onClick={() => groupRows.forEach((r) => isDirty(r) && resetRow(r.key))}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="min-h-[44px] sm:min-h-0"
                  disabled={!canEdit || hasError}
                  onClick={() => void saveKeys(groupRows)}
                >
                  {savingKeys.some((k) => dirty.some((d) => d.key === k)) ? "Saving…" : `Save ${dirty.length > 1 ? `all ${dirty.length}` : ""}`}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        description="Platform configuration — payouts, moderation, payments and storefront chrome. Changes are audited."
      />

      {/* C4: per-administrator TOTP MFA management — the signed-in admin's OWN
          account security (current-password reauth on every change), independent
          of the settings.manage capability that gates the platform config below. */}
      <MfaCard />

      {!canEdit ? (
        <Card className="py-0 border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30">
          <CardContent className="flex items-start gap-2 p-4 text-sm text-amber-900 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              You are viewing settings as <strong className="capitalize">{me.loaded && me.admin ? me.admin.role : "guest"}</strong>. Only superadmins can
              change values.
            </span>
          </CardContent>
        </Card>
      ) : null}

      {error ? (
        <Card className="py-0">
          <CardContent className="p-4">
            <ErrorState message={error} onRetry={() => void refetch()} />
          </CardContent>
        </Card>
      ) : loading ? (
        <CardsSkeleton n={4} />
      ) : rows.length === 0 ? (
        <Card className="py-0">
          <CardContent className="p-4">
            <EmptyState title="No settings" hint="Nothing is configured yet." />
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue={defaultTab}>
          <TabsList className="h-auto w-full flex-wrap sm:w-fit">
            {groupsWithRows.map((group) => {
              const dirtyCount = (grouped.get(group.id) ?? []).filter(isDirty).length;
              const Icon = GROUP_ICON[group.icon] ?? Wrench;
              return (
                <TabsTrigger
                  key={group.id}
                  value={group.id}
                  className="min-h-[44px] gap-1.5 px-3 text-xs sm:px-4 sm:text-sm"
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="whitespace-nowrap">{group.label}</span>
                  {dirtyCount > 0 ? (
                    <span
                      className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white"
                      aria-label={`${dirtyCount} unsaved changes`}
                    >
                      {dirtyCount}
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {groupsWithRows.map((group) => (
            <TabsContent key={group.id} value={group.id} className="mt-4">
              {renderGroupCard(group)}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- FlagsView

REMOVED (F-07 remediation): the Feature Flags admin page was a dead control —
zero runtime code read db.featureFlag outside its own CRUD route, while the
page promised "runtime switches for progressive delivery". Per the audit
rule ("never ship dead controls") the page, its nav entry and its API route
were removed; the underlying table + seed rows are inert and left in place
(restorable from git if real flag consumers ever ship).

-------------------------------------------------------------------------- */

/* ---------------------------------------------------------------- AuditView */

type AuditRow = {
  id: string;
  adminEmail: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  createdAt: string;
};

/** Audit rows deliver parsed objects; DiffViewer expects JSON strings. */
function asJsonStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

export function AuditView() {
  const [adminEmail, setAdminEmail] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [page, setPage] = useState(1);

  const url = useMemo(
    () => `/api/admin/audit-logs${qs({ adminEmail, action, entityType, page, size: 20 })}`,
    [adminEmail, action, entityType, page]
  );
  const { data, meta, error, loading, refetch } = useApi<AuditRow[]>(url);
  const rows = data ?? [];

  const [detail, setDetail] = useState<AuditRow | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit Log"
        description="Every privileged admin action with a before/after snapshot."
        actions={
          <Input
            value={adminEmail}
            onChange={(e) => {
              setAdminEmail(e.target.value);
              setPage(1);
            }}
            placeholder="Filter by admin email…"
            className="min-h-[44px] w-full sm:w-56"
            aria-label="Filter by admin email"
          />
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
              placeholder="Action contains… e.g. payout"
              className="min-h-[44px]"
              aria-label="Filter by action"
            />
            <Input
              value={entityType}
              onChange={(e) => {
                setEntityType(e.target.value);
                setPage(1);
              }}
              placeholder="Entity type… e.g. payout"
              className="min-h-[44px]"
              aria-label="Filter by entity type"
            />
          </div>

          <div className="mt-4 overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={6} />
            ) : rows.length === 0 ? (
              <EmptyState title="No audit entries" hint="Adjust the filters above." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Admin</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="hidden md:table-cell">Entity</TableHead>
                      <TableHead className="hidden lg:table-cell">Entity ID</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetail(r)}>
                        <TableCell className="max-w-[180px] truncate text-sm">{r.adminEmail}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">{r.action}</Badge>
                        </TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{r.entityType ?? "—"}</TableCell>
                        <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                          {r.entityId ? `${r.entityId.slice(0, 10)}…` : "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pager
                  page={meta?.page ?? page}
                  size={meta?.size ?? 20}
                  total={meta?.total ?? rows.length}
                  onPrev={() => setPage((p) => Math.max(1, p - 1))}
                  onNext={() => setPage((p) => p + 1)}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl [scrollbar-width:thin]">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 font-mono text-sm">
              {detail?.action}
              <Badge variant="outline">{detail?.entityType ?? "—"}</Badge>
            </DialogTitle>
            <DialogDescription>
              {detail ? `${detail.adminEmail} · ${fmtDT(detail.createdAt)} · entity ${detail.entityId?.slice(0, 12) ?? "—"}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? <DiffViewer beforeJson={asJsonStr(detail.before)} afterJson={asJsonStr(detail.after)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------- ActivityView */

type ActivityRow = {
  id: string;
  actorType: string;
  actorLabel?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  meta?: unknown;
  createdAt: string;
};

const ACTOR_TYPES = ["all", "admin", "seller", "customer", "system"];

type PurgeStats = { total: number; byActor: { actorType: string; count: number }[] };

export function ActivityView() {
  const me = useApp((s) => s.me);
  const isSuper = Boolean(me.loaded && me.admin?.role === "superadmin");

  const [actorType, setActorType] = useState("all");
  const [page, setPage] = useState(1);
  const url = useMemo(() => `/api/admin/activity-logs${qs({ actorType: actorType === "all" ? "" : actorType, page, size: 25 })}`, [actorType, page]);
  const { data, meta, error, loading, refetch } = useApi<ActivityRow[]>(url);
  const rows = data ?? [];

  // ---- Clear All (permanent purge, superadmin + password re-check) ----------
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeStats, setPurgeStats] = useState<PurgeStats | null>(null);
  const [purgeLoading, setPurgeLoading] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgePassword, setPurgePassword] = useState("");
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const openPurge = async () => {
    setPurgeOpen(true);
    setPurgeError(null);
    setPurgePassword("");
    setPurgeStats(null);
    setPurgeLoading(true);
    try {
      const { data: stats } = await apiGet<PurgeStats>("/api/admin/activity-logs/purge");
      setPurgeStats(stats);
    } catch (e) {
      setPurgeError(e instanceof Error ? e.message : "Failed to load log counts");
    } finally {
      setPurgeLoading(false);
    }
  };

  const runPurge = async () => {
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      const res = await apiSend<{ deleted: number; remaining: number }>("/api/admin/activity-logs/purge", "POST", { password: purgePassword });
      toast.success("Activity log cleared", {
        description: `${res.deleted.toLocaleString()} entries permanently deleted — the log starts fresh now.`,
      });
      setPurgeOpen(false);
      setPurgePassword("");
      setPage(1);
      void refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Purge failed";
      setPurgeError(msg);
    } finally {
      setPurgeBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity Log"
        description="Who did what across the platform — logins, exports, webhooks and more."
        actions={
          <div className="flex items-center gap-2">
            {isSuper ? (
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 sm:min-h-0 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                onClick={() => void openPurge()}
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear All
              </Button>
            ) : null}
            <Select
              value={actorType}
              onValueChange={(v) => {
                setActorType(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="min-h-[44px] w-40" aria-label="Actor type filter">
                <SelectValue placeholder="Actor" />
              </SelectTrigger>
              <SelectContent>
                {ACTOR_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="capitalize">{t === "all" ? "All actors" : t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={5} />
            ) : rows.length === 0 ? (
              <EmptyState title="No activity" hint="Nothing recorded for this filter yet." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Actor</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="hidden md:table-cell">Entity</TableHead>
                      <TableHead className="hidden xl:table-cell">Meta</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <p className="max-w-[200px] truncate text-sm font-medium">{r.actorLabel ?? "—"}</p>
                          <p className="text-xs capitalize text-muted-foreground">{r.actorType}</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">{r.action}</Badge>
                        </TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                          {r.entityType ? `${r.entityType}${r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ""}` : "—"}
                        </TableCell>
                        <TableCell className="hidden max-w-[220px] truncate font-mono text-[11px] text-muted-foreground xl:table-cell">
                          {r.meta ? (typeof r.meta === "string" ? r.meta : JSON.stringify(r.meta)) : "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pager
                  page={meta?.page ?? page}
                  size={meta?.size ?? 25}
                  total={meta?.total ?? rows.length}
                  onPrev={() => setPage((p) => Math.max(1, p - 1))}
                  onNext={() => setPage((p) => p + 1)}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---- Clear All Activity Log (permanent, password-gated) ---- */}
      <Dialog
        open={purgeOpen}
        onOpenChange={(o) => {
          if (!o && !purgeBusy) setPurgeOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-red-600" /> Clear all activity log?
            </DialogTitle>
            <DialogDescription>
              Permanently deletes every activity entry across the whole platform — admin, seller, shopper and system. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {purgeLoading ? (
                <p className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Counting entries…
                </p>
              ) : purgeStats ? (
                <>
                  <p className="font-semibold">{purgeStats.total.toLocaleString()} entries will be permanently deleted:</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {purgeStats.byActor.map((a) => (
                      <Badge
                        key={a.actorType}
                        variant="outline"
                        className="border-red-300 capitalize text-red-800 dark:border-red-800 dark:text-red-300"
                      >
                        {a.actorType}: {a.count.toLocaleString()}
                      </Badge>
                    ))}
                  </div>
                </>
              ) : null}
              <p className="mt-2">
                Kept: the admin Audit Log (compliance trail), notification and webhook logs. A single reset record will be written after clearing.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="purge-password">Confirm with your admin password</Label>
              <Input
                id="purge-password"
                type="password"
                autoComplete="current-password"
                value={purgePassword}
                onChange={(e) => setPurgePassword(e.target.value)}
                placeholder="••••••••"
                className="min-h-[44px]"
                disabled={purgeBusy}
              />
            </div>

            {purgeError ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
                {purgeError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPurgeOpen(false)} disabled={purgeBusy} className="min-h-[44px] sm:min-h-0">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runPurge()}
              disabled={purgeBusy || purgeLoading || !purgePassword || !purgeStats || purgeStats.total === 0}
              className="min-h-[44px] sm:min-h-0"
            >
              {purgeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {purgeBusy ? "Clearing…" : `Permanently clear${purgeStats ? ` (${purgeStats.total.toLocaleString()})` : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------- NotificationsView */

type NotificationRow = {
  id: string;
  event: string;
  channel: string;
  recipient: string;
  subject?: string | null;
  status: string;
  error?: string | null;
  createdAt: string;
};

export function NotificationsView() {
  const { data, error, loading, refetch } = useApi<NotificationRow[]>("/api/admin/notifications");
  const rows = data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notifications"
        description="Outbound notification log (email + in-app) — deliveries are simulated in this sandbox."
        actions={
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => void refetch()} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={5} />
            ) : rows.length === 0 ? (
              <EmptyState title="No notifications yet" hint="Order and payout events will appear here." />
            ) : (
              <div className="max-h-[560px] overflow-y-auto [scrollbar-width:thin]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead className="w-10">Channel</TableHead>
                      <TableHead>Recipient</TableHead>
                      <TableHead className="hidden md:table-cell">Subject</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((n) => (
                      <TableRow key={n.id}>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">{n.event}</Badge>
                        </TableCell>
                        <TableCell>
                          {n.channel === "email" ? (
                            <Mail className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-label="email" />
                          ) : (
                            <MessageCircle className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-label={n.channel} />
                          )}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-sm">{n.recipient}</TableCell>
                        <TableCell className="hidden max-w-[280px] truncate text-sm text-muted-foreground md:table-cell">
                          {n.subject ?? "—"}
                          {n.error ? <span className="block text-[11px] text-red-600 dark:text-red-400">{n.error}</span> : null}
                        </TableCell>
                        <TableCell><StatusChip status={n.status} /></TableCell>
                        <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">{timeAgo(n.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- HealthView */

type HealthAuditRow = {
  id: string;
  adminEmail?: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  beforeJson?: string | null;
  afterJson?: string | null;
  createdAt: string;
};

type HealthBody = {
  status?: string;
  db?: string | boolean | { ok?: boolean };
  counts?: { sellers?: number; stores?: number; products?: number; orders?: number };
  ledger?: { ok?: boolean; problems?: string[]; txnCount?: number; walletCount?: number };
  recentAudit?: HealthAuditRow[];
};

export function HealthView() {
  const { data, error, loading, refetch } = useApi<HealthBody>("/api/admin/system/health");
  const [detail, setDetail] = useState<HealthAuditRow | null>(null);

  // light polling keeps the health board fresh (30s)
  useEffect(() => {
    const t = setInterval(() => void refetch(), 30000);
    return () => clearInterval(t);
  }, [refetch]);

  const dbOk = data?.db === "up" || data?.db === true || (typeof data?.db === "object" && data?.db?.ok === true);
  const ledgerOk = data?.ledger?.ok ?? true;
  const problems = data?.ledger?.problems ?? [];
  const counts = data?.counts ?? {};
  const recent = data?.recentAudit ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="System Health"
        description="Database, ledger invariants and platform counters — auto-refreshes every 30s."
        actions={
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => void refetch()} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      {error ? (
        <Card className="py-0"><CardContent className="p-4"><ErrorState message={error} onRetry={() => void refetch()} /></CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card className="py-0">
              <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
                <CardTitle className="flex items-center gap-2 text-base">
                  <HeartPulse className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Database
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 sm:px-6 sm:pb-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Connection</span>
                  <HealthDot ok={dbOk} label="Database" />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Overall status: <span className="font-medium capitalize">{data?.status ?? "unknown"}</span></p>
              </CardContent>
            </Card>

            <Card className="py-0">
              <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
                <CardTitle className="text-base">Ledger invariant</CardTitle>
                <CardDescription>Double-entry integrity across {data?.ledger?.txnCount ?? "—"} txns · {data?.ledger?.walletCount ?? "—"} wallets</CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4 sm:px-6 sm:pb-5">
                <HealthDot ok={ledgerOk} label="Ledger invariant" />
                {problems.length > 0 ? (
                  <ul className="mt-3 space-y-1.5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                    {problems.map((p, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                        <span className="font-mono">{p}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> No drift detected — debits equal credits.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Sellers" value={<span className="tabular-nums">{counts.sellers ?? 0}</span>} />
            <KpiCard label="Stores" value={<span className="tabular-nums">{counts.stores ?? 0}</span>} />
            <KpiCard label="Products" value={<span className="tabular-nums">{counts.products ?? 0}</span>} />
            <KpiCard label="Orders" value={<span className="tabular-nums">{counts.orders ?? 0}</span>} />
          </div>

          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="flex items-center gap-2 text-base">
                <ScrollText className="h-4 w-4 text-muted-foreground" /> Recent admin audit
              </CardTitle>
              <CardDescription>Click a row to inspect the before/after snapshot.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {recent.length === 0 ? (
                <EmptyState title="No audit entries yet" />
              ) : (
                <Table>
                  <TableBody>
                    {recent.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetail(r)}>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">{r.action}</Badge>
                        </TableCell>
                        <TableCell className="hidden max-w-[180px] truncate text-sm text-muted-foreground sm:table-cell">{r.adminEmail ?? "—"}</TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{r.entityType ?? "—"}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ActivityIcon className="h-3 w-3" /> Polling active — latest check {fmtDT(new Date())}
          </p>
        </>
      )}

      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl [scrollbar-width:thin]">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{detail?.action}</DialogTitle>
            <DialogDescription>{detail ? `${detail.adminEmail ?? ""} · ${fmtDT(detail.createdAt)}` : ""}</DialogDescription>
          </DialogHeader>
          {detail ? <DiffViewer beforeJson={detail.beforeJson} afterJson={detail.afterJson} /> : null}
        </DialogContent>
      </Dialog>

    </div>
  );
}

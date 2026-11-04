"use client";
// ============================================================================
// MKT-04 Campaigns (work order 14 rebuild) — the Admin Campaign / Festive
// Season system as the SINGLE source of truth for homepage merchandising.
//
// Capabilities (all through /api/admin/campaigns[/id], RBAC campaigns.manage):
//   • create AND edit (the previous view could only create/toggle/delete);
//   • homepage placement (hero / hero_secondary / promo_tile / showcase /
//     inline) + priority + displayOrder — the deterministic selection rule;
//   • creative: desktop banner, mobile banner, thumbnail — paste a URL,
//     shuffle a placeholder, or genuinely upload a file
//     (/api/admin/campaign-media, png/jpeg/webp ≤ 3 MB);
//   • CTA destination with a kind picker (browse/search/category/store/deals/
//     vouchers/external-https) — validated server-side, resolved for shoppers
//     server-side;
//   • inline product shelves via a product query (a CURATED shelf of real
//     active products — never a price rule);
//   • per-placement LIVE PREVIEW in the dialog (draft campaigns are never
//     exposed to shoppers — the public API filters isPublished + window);
//   • soft-archive (ended campaigns vanish from public placements and the
//     default list without destructive deletes).
//
// Date inputs are Malaysia time (Asia/Kuala_Lumpur, UTC+8) — the same anchor
// the festive presets use — so scheduling boundaries are identical for admin,
// database and public homepage regardless of the admin's browser timezone.
// ============================================================================
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ExternalLink,
  ImagePlus,
  Loader2,
  PartyPopper,
  Pencil,
  Plus,
  Search,
  Shuffle,
  Trash2,
  Upload,
} from "lucide-react";
import { authHeaders } from "@/lib/session-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  CAMPAIGN_PLACEMENTS,
  CAMPAIGN_PRESETS,
  findCampaignPreset,
  findPlacement,
  presetDateRange,
  type CampaignPlacement,
  type CampaignThemeT,
} from "@/lib/campaigns";
import { apiSend, useApi, useDebounced } from "./use-api";
import { qs } from "./nav";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Pager,
  StatusChip,
  TableSkeleton,
  fmtDT,
} from "./ui-bits";

/* ------------------------------------------------------------------ types */

type CampaignRow = {
  id: string;
  name: string;
  description: string | null;
  presetId: string | null;
  isPublished: boolean;
  archivedAt: string | null;
  placement: string;
  priority: number;
  displayOrder: number;
  ctaLabel: string | null;
  ctaHref: string | null;
  bannerDesktopUrl: string | null;
  bannerMobileUrl: string | null;
  thumbnailUrl: string | null;
  productQuery: string | null;
  startAt: string;
  endAt: string;
  theme: CampaignThemeT;
  status: "draft" | "scheduled" | "live" | "ended" | "archived";
  daysUntilStart: number;
  daysLeft: number;
};

const CAMPAIGN_STATUS_CLASS: Record<CampaignRow["status"], string> = {
  draft: "border-muted-foreground/30 bg-muted text-muted-foreground",
  scheduled: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
  live: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
  ended: "border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400",
  archived: "border-neutral-400 bg-neutral-200 text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};

const PLACEMENT_CLASS: Record<string, string> = {
  hero: "border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-300",
  hero_secondary: "border-cyan-300 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-300",
  promo_tile: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-800 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  showcase: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  inline: "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
};

/** Mutations/list failures that are really RBAC rejections (403 envelope). */
function isCapabilityError(e: unknown): boolean {
  return e instanceof Error && /campaigns\.manage|Capability|forbidden/i.test(e.message);
}

function campaignStatusChip(status: CampaignRow["status"]) {
  return (
    <Badge variant="outline" className={cn("capitalize", CAMPAIGN_STATUS_CLASS[status])}>
      {status}
    </Badge>
  );
}

function placementChip(placement: string) {
  const meta = findPlacement(placement);
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap", PLACEMENT_CLASS[placement] ?? "")}>
      {meta?.label ?? placement}
    </Badge>
  );
}

/* ---------------------------------------------------- MYT datetime helpers */

const p2 = (n: number) => String(n).padStart(2, "0");

/** ISO → "YYYY-MM-DDTHH:mm" as observed in Asia/Kuala_Lumpur (UTC+8). */
function toMYTInput(d: Date | string): string {
  const date = new Date(d);
  const myt = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${myt.getUTCFullYear()}-${p2(myt.getUTCMonth() + 1)}-${p2(myt.getUTCDate())}T${p2(myt.getUTCHours())}:${p2(myt.getUTCMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm" (MYT) → ISO string, or undefined when blank/invalid. */
function fromMYTInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(`${v}:00+08:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/* ---------------------------------------------------------- CTA token glue */

const CTA_KINDS = [
  { value: "", label: "No CTA (falls back to browse-all)" },
  { value: "search", label: "Browse all products" },
  { value: "search_kw", label: "Product search (keywords)" },
  { value: "category", label: "Category page (slug)" },
  { value: "store", label: "Storefront (slug)" },
  { value: "deals", label: "Flash-deals section (homepage)" },
  { value: "vouchers", label: "My vouchers (account)" },
  { value: "external", label: "External https:// link" },
] as const;

function composeCtaHref(kind: string, value: string): string | null {
  const v = value.trim();
  switch (kind) {
    case "search":
      return "search";
    case "search_kw":
      return v ? `search:${v}` : null;
    case "category":
      return v ? `category:${v}` : null;
    case "store":
      return v ? `store:${v}` : null;
    case "deals":
      return "deals";
    case "vouchers":
      return "vouchers";
    case "external":
      return v || null;
    default:
      return null;
  }
}

function decomposeCtaHref(href: string | null): { kind: string; value: string } {
  if (!href) return { kind: "", value: "" };
  if (href === "search" || href === "deals" || href === "vouchers") return { kind: href, value: "" };
  if (href.startsWith("search:")) return { kind: "search_kw", value: href.slice("search:".length) };
  if (href.startsWith("category:")) return { kind: "category", value: href.slice("category:".length) };
  if (href.startsWith("store:")) return { kind: "store", value: href.slice("store:".length) };
  if (/^https:\/\//i.test(href)) return { kind: "external", value: href };
  return { kind: "", value: "" };
}

const CTA_KIND_HINTS: Record<string, string> = {
  "": "Shoppers who click get the default browse-all destination.",
  search: "Opens the full marketplace product listing.",
  search_kw: "Opens product search for these keywords, e.g. raya",
  category: "Category slug, e.g. electronics (lowercase, dashes).",
  store: "Store slug, e.g. bytebazaar.",
  deals: "Scrolls the shopper to the flash-deals section on the homepage.",
  vouchers: "Opens My vouchers in the shopper account area (sign-in for guests).",
  external: "Approved external https:// URL — opens in a new tab. http:// is rejected.",
};

/* ------------------------------------------------------------- media input */

async function uploadCampaignMedia(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/admin/campaign-media", {
    method: "POST",
    headers: authHeaders(), // no Content-Type — the browser sets the multipart boundary
    body: fd,
  });
  let body: { data?: { url?: string }; error?: { message?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error */
  }
  if (!res.ok || !body.data?.url) {
    throw new Error(body.error?.message ?? `Upload failed (${res.status})`);
  }
  return body.data.url;
}

function MediaInput({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  aspect,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: () => string;
  aspect: "wide" | "square";
}) {
  const [uploading, setUploading] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  const doUpload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadCampaignMedia(file);
      onChange(url);
      toast.success(`${label} uploaded`, { description: url });
    } catch (e) {
      toast.error("Upload failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
      setFileKey((k) => k + 1);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/api/img/… or /uploads/… or https://…"
          className="min-h-[44px] font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" className="min-h-[44px] shrink-0" onClick={() => onChange(placeholder())} aria-label={`Shuffle placeholder ${label}`}>
          <Shuffle className="h-4 w-4" />
        </Button>
        <label
          className={cn(
            "inline-flex min-h-[44px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
            uploading && "pointer-events-none opacity-60"
          )}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          <span className="hidden sm:inline">{uploading ? "Uploading…" : "Upload"}</span>
          <input
            key={fileKey}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(e) => void doUpload(e.target.files?.[0])}
            aria-label={`Upload ${label} file`}
          />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      {value ? (
        <div className={cn("overflow-hidden rounded-lg border", aspect === "wide" ? "aspect-[1400/480] max-h-40" : "aspect-[600/420] max-h-32")}>
          <img src={value} alt={`${label} preview`} className="h-full w-full object-cover" />
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- form + preview */

const BLANK_THEME: CampaignThemeT = {
  accent: "#0D9488",
  accentSoft: "#CCFBF1",
  gradientFrom: "#0D9488",
  gradientTo: "#115E59",
  greeting: "",
  greetingBm: "",
  tagline: "",
  taglineBm: "",
  ornament: "✨",
};

type CampaignForm = {
  name: string;
  presetId: string;
  description: string;
  placement: CampaignPlacement;
  priority: string;
  displayOrder: string;
  startAt: string;
  endAt: string;
  ctaLabel: string;
  ctaKind: string;
  ctaValue: string;
  bannerDesktopUrl: string;
  bannerMobileUrl: string;
  thumbnailUrl: string;
  productQuery: string;
  theme: CampaignThemeT;
  publish: boolean;
};

function blankForm(): CampaignForm {
  return {
    name: "",
    presetId: "",
    description: "",
    placement: "showcase",
    priority: "0",
    displayOrder: "0",
    startAt: "",
    endAt: "",
    ctaLabel: "",
    ctaKind: "",
    ctaValue: "",
    bannerDesktopUrl: "",
    bannerMobileUrl: "",
    thumbnailUrl: "",
    productQuery: "",
    theme: { ...BLANK_THEME },
    publish: false,
  };
}

function rowToForm(c: CampaignRow): CampaignForm {
  const cta = decomposeCtaHref(c.ctaHref);
  return {
    name: c.name,
    presetId: c.presetId ?? "",
    description: c.description ?? "",
    placement: (findPlacement(c.placement)?.id ?? "showcase") as CampaignPlacement,
    priority: String(c.priority ?? 0),
    displayOrder: String(c.displayOrder ?? 0),
    startAt: toMYTInput(c.startAt),
    endAt: toMYTInput(c.endAt),
    ctaLabel: c.ctaLabel ?? "",
    ctaKind: cta.kind,
    ctaValue: cta.value,
    bannerDesktopUrl: c.bannerDesktopUrl ?? "",
    bannerMobileUrl: c.bannerMobileUrl ?? "",
    thumbnailUrl: c.thumbnailUrl ?? "",
    productQuery: c.productQuery ?? "",
    theme: { ...BLANK_THEME, ...c.theme },
    publish: c.isPublished,
  };
}

function randomSeed(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Live per-placement preview — the SAME visual language the shopper
 *  homepage renders (gradient + greeting + ornament + CTA chip), at a small
 *  scale. Draft-only state never reaches shoppers; this is admin-side. */
function PlacementPreview({ f }: { f: CampaignForm }) {
  const t = f.theme;
  const heading = t.greeting || f.name || "Campaign heading";
  const sub = f.description || t.tagline || "Supporting copy…";
  const cta = f.ctaLabel || "Shop now";
  const gradient = `linear-gradient(135deg, ${t.gradientFrom}, ${t.gradientTo})`;

  if (f.placement === "promo_tile") {
    return (
      <div className="flex w-28 flex-col items-center gap-2 rounded-xl border-2 bg-card p-3" style={{ borderColor: t.accentSoft }}>
        <span className="flex h-9 w-9 items-center justify-center rounded-full text-base" style={{ background: t.accentSoft, color: t.accent }}>
          {t.ornament}
        </span>
        <span className="text-center text-[11px] font-semibold leading-tight line-clamp-2">{f.name || "Campaign name"}</span>
      </div>
    );
  }

  if (f.placement === "showcase") {
    return (
      <div className="w-56 overflow-hidden rounded-xl border bg-card text-left">
        <div className="relative h-24">
          {f.thumbnailUrl ? (
            <img src={f.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-3xl" style={{ background: gradient }}>
              {t.ornament}
            </span>
          )}
          <span className="absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: t.accentSoft, color: t.accent }}>
            Ends in Nd
          </span>
        </div>
        <div className="space-y-1 p-3">
          <p className="text-sm font-bold leading-tight line-clamp-1">{f.name || "Campaign name"}</p>
          <p className="text-xs text-muted-foreground line-clamp-2">{sub}</p>
          <p className="pt-1 text-xs font-semibold" style={{ color: t.accent }}>
            {cta} →
          </p>
        </div>
      </div>
    );
  }

  // hero / hero_secondary / inline — banner-shaped preview.
  return (
    <div className="relative w-full max-w-md overflow-hidden rounded-xl border text-left">
      <div className="relative h-28">
        {f.bannerDesktopUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={f.bannerDesktopUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0" style={{ background: gradient }} />
        )}
        {f.bannerDesktopUrl ? <span className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent" /> : null}
        {!f.bannerDesktopUrl ? (
          <span aria-hidden className="pointer-events-none absolute -left-1 -top-2 select-none text-4xl opacity-20">
            {t.ornament}
          </span>
        ) : null}
        <span className="absolute inset-0 flex flex-col justify-center gap-1 p-4">
          <span className="text-[10px] font-bold uppercase tracking-widest text-white/75">
            {t.ornament} {f.name || "Campaign"}
          </span>
          <span className="text-sm font-extrabold text-white line-clamp-1">{heading}</span>
          <span className="hidden text-[11px] text-white/85 line-clamp-1 sm:inline">{sub}</span>
          <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-white/95 px-3 py-1 text-[11px] font-semibold" style={{ color: t.accent }}>
            {cta} →
          </span>
        </span>
      </div>
      {f.placement === "inline" && f.productQuery ? (
        <div className="border-t bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          + product shelf: real active products matching “{f.productQuery}”
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- view */

const SIZE = 10;

export function CampaignsView() {
  const [status, setStatus] = useState("all");
  const [placementFilter, setPlacementFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput.trim(), 350);

  const listUrl = `/api/admin/campaigns${qs({ page, size: SIZE, status: status === "all" ? "" : status, placement: placementFilter === "all" ? "" : placementFilter, q })}`;
  const { data, meta, error, loading, refetch } = useApi<CampaignRow[]>(listUrl);
  const rows = data ?? [];
  const forbidden = error !== null && isCapabilityError(new Error(error));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CampaignRow | null>(null);
  const [form, setForm] = useState<CampaignForm>(blankForm());
  const [saving, setSaving] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CampaignRow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<CampaignRow | null>(null);

  const setF = <K extends keyof CampaignForm>(key: K, value: CampaignForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const openCreate = () => {
    setEditing(null);
    setForm(blankForm());
    setDialogOpen(true);
  };

  const openEdit = (c: CampaignRow) => {
    setEditing(c);
    setForm(rowToForm(c));
    setDialogOpen(true);
  };

  const applyPreset = (id: string) => {
    setF("presetId", id);
    const preset = findCampaignPreset(id);
    if (!preset) return;
    const range = presetDateRange(preset);
    if (range) {
      setForm((f) => ({ ...f, startAt: toMYTInput(range.start), endAt: toMYTInput(range.end) }));
    }
    setForm((f) => ({ ...f, theme: { ...preset.theme } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        presetId: form.presetId || null,
        description: form.description.trim() || null,
        placement: form.placement,
        priority: Number(form.priority) || 0,
        displayOrder: Number(form.displayOrder) || 0,
        startAt: fromMYTInput(form.startAt),
        endAt: fromMYTInput(form.endAt),
        ctaLabel: form.ctaLabel.trim() || null,
        ctaHref: composeCtaHref(form.ctaKind, form.ctaValue),
        bannerDesktopUrl: form.bannerDesktopUrl.trim() || null,
        bannerMobileUrl: form.bannerMobileUrl.trim() || null,
        thumbnailUrl: form.thumbnailUrl.trim() || null,
        productQuery: form.placement === "inline" ? form.productQuery.trim() || null : null,
        theme: form.theme,
        isPublished: form.publish,
      };
      if (editing) {
        await apiSend(`/api/admin/campaigns/${editing.id}`, "PATCH", payload);
        toast.success("Campaign updated", { description: `${form.name.trim()} — changes reach the homepage within the cache window (seconds; ≤ 60 s worst case)` });
      } else {
        await apiSend("/api/admin/campaigns", "POST", payload);
        toast.success("Campaign created", {
          description: form.publish ? `${form.name.trim()} is scheduled/live` : `${form.name.trim()} saved as draft — invisible to shoppers until published`,
        });
      }
      setDialogOpen(false);
      void refetch();
    } catch (e) {
      if (isCapabilityError(e)) {
        toast.info("Ops/superadmin only", { description: "Campaign management needs the campaigns.manage permission." });
      } else {
        toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setSaving(false);
    }
  };

  const togglePublish = async (c: CampaignRow) => {
    setBusyId(c.id);
    try {
      await apiSend(`/api/admin/campaigns/${c.id}`, "PATCH", { isPublished: !c.isPublished });
      toast.success(`Campaign ${c.isPublished ? "unpublished" : "published"}`, { description: c.name });
      void refetch();
    } catch (e) {
      if (isCapabilityError(e)) {
        toast.info("Ops/superadmin only", { description: "Publishing campaigns needs the campaigns.manage permission." });
      } else {
        toast.error("Update failed", { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setBusyId(null);
    }
  };

  const toggleArchive = async (c: CampaignRow) => {
    setBusyId(c.id);
    try {
      await apiSend(`/api/admin/campaigns/${c.id}`, "PATCH", { archived: !c.archivedAt });
      toast.success(c.archivedAt ? "Campaign restored" : "Campaign archived", {
        description: c.archivedAt
          ? `${c.name} is back in the normal lifecycle`
          : `${c.name} removed from all public homepage placements`,
      });
      setArchiveTarget(null);
      void refetch();
    } catch (e) {
      toast.error("Update failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await apiSend(`/api/admin/campaigns/${deleteTarget.id}`, "DELETE");
      toast.success("Campaign deleted", { description: deleteTarget.name });
      setDeleteTarget(null);
      void refetch();
    } catch (e) {
      if (isCapabilityError(e)) {
        toast.info("Ops/superadmin only", { description: "Deleting campaigns needs the campaigns.manage permission." });
      } else {
        toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setBusyId(null);
    }
  };

  const countdown = (c: CampaignRow) => {
    if (c.status === "scheduled") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
          <CalendarClock className="h-3 w-3" /> starts in {c.daysUntilStart}d
        </span>
      );
    }
    if (c.status === "live") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
          <CalendarClock className="h-3 w-3" /> ends in {c.daysLeft}d
        </span>
      );
    }
    return <span className="text-xs text-muted-foreground">—</span>;
  };

  const placementHint = useMemo(() => findPlacement(form.placement)?.hint ?? "", [form.placement]);

  const canSave = form.name.trim() !== "" && form.startAt !== "" && form.endAt !== "";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Campaigns"
        description="Festive & seasonal campaigns — the single source of truth for homepage hero banners, promo tiles, the campaign showcase and inline shelves."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={openCreate}>
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        }
      />

      <Card className="py-0">
        <CardHeader className="gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <PartyPopper className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Campaigns ({meta?.total ?? rows.length})
          </CardTitle>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative flex-1 lg:max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={qInput}
                onChange={(e) => {
                  setQInput(e.target.value);
                  setPage(1);
                }}
                placeholder="Search by name…"
                className="min-h-[44px] pl-9"
                aria-label="Search campaigns"
              />
            </div>
            <Select
              value={placementFilter}
              onValueChange={(v) => {
                setPlacementFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="min-h-[44px] lg:w-52" aria-label="Filter campaigns by placement">
                <SelectValue placeholder="All placements" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All placements</SelectItem>
                {CAMPAIGN_PLACEMENTS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="min-h-[44px] lg:w-44" aria-label="Filter campaigns by status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="live">Live</SelectItem>
                <SelectItem value="ended">Ended</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            forbidden ? (
              <EmptyState
                title="Ops/superadmin only"
                hint="Campaigns need the campaigns.manage permission (superadmin or ops role)."
              />
            ) : (
              <ErrorState message={error} onRetry={() => void refetch()} />
            )
          ) : loading ? (
            <TableSkeleton rows={3} cols={6} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No campaigns"
              hint="Create one from a festive preset — Raya, CNY, 11.11 and more — then place it on the homepage."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead className="hidden md:table-cell">Placement</TableHead>
                    <TableHead className="hidden md:table-cell">Window (MYT)</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="hidden text-center sm:table-cell">Countdown</TableHead>
                    <TableHead className="text-center">Published</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => (
                    <TableRow key={c.id} className={cn(c.status === "archived" && "opacity-60")}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm"
                            style={{ background: c.theme.accentSoft, color: c.theme.accent }}
                            aria-hidden="true"
                          >
                            {c.theme.ornament || "✨"}
                          </span>
                          <div className="min-w-0">
                            <p className="max-w-[220px] truncate font-medium">{c.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {findCampaignPreset(c.presetId)?.name ?? "Custom theme"}
                              {c.priority !== 0 ? ` · P${c.priority}` : ""}
                              {c.displayOrder !== 0 ? ` · #${c.displayOrder}` : ""}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{placementChip(c.placement)}</TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                        {fmtDT(c.startAt)} → {fmtDT(c.endAt)}
                      </TableCell>
                      <TableCell className="text-center">{campaignStatusChip(c.status)}</TableCell>
                      <TableCell className="hidden text-center sm:table-cell">{countdown(c)}</TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={c.isPublished && !c.archivedAt}
                          disabled={busyId === c.id || c.archivedAt != null}
                          onCheckedChange={() => void togglePublish(c)}
                          aria-label={`Toggle campaign ${c.name}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-h-[44px] sm:min-h-0"
                            onClick={() => openEdit(c)}
                            aria-label={`Edit ${c.name}`}
                          >
                            <Pencil className="h-4 w-4" />
                            <span className="sr-only">Edit</span>
                          </Button>
                          {c.archivedAt ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="min-h-[44px] text-teal-700 hover:bg-teal-50 sm:min-h-0"
                              disabled={busyId === c.id}
                              onClick={() => setArchiveTarget(c)}
                              aria-label={`Restore ${c.name}`}
                            >
                              <ArchiveRestore className="h-4 w-4" />
                              <span className="sr-only">Restore</span>
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="min-h-[44px] text-amber-700 hover:bg-amber-50 sm:min-h-0"
                              disabled={busyId === c.id}
                              onClick={() => setArchiveTarget(c)}
                              aria-label={`Archive ${c.name}`}
                            >
                              <Archive className="h-4 w-4" />
                              <span className="sr-only">Archive</span>
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                            onClick={() => setDeleteTarget(c)}
                            aria-label={`Delete ${c.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                            <span className="sr-only">Delete</span>
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

      {(meta?.total ?? 0) > SIZE && !error ? (
        <Pager
          page={page}
          size={SIZE}
          total={meta?.total ?? 0}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => p + 1)}
        />
      ) : null}

      {/* ------------------------------------------------- create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl [scrollbar-width:thin]">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit campaign — ${editing.name}` : "New campaign"}</DialogTitle>
            <DialogDescription>
              Placement + window control where and when this appears on the public homepage. Drafts are never visible to
              shoppers; changes propagate within the cache window (seconds, ≤ 60 s worst case).
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="basics" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="basics" className="flex-1">
                Basics
              </TabsTrigger>
              <TabsTrigger value="creative" className="flex-1">
                Creative
              </TabsTrigger>
              <TabsTrigger value="destination" className="flex-1">
                Destination
              </TabsTrigger>
              <TabsTrigger value="theme" className="flex-1">
                Theme
              </TabsTrigger>
            </TabsList>

            <TabsContent value="basics" className="space-y-3 pt-3">
              <div className="space-y-1.5">
                <Label htmlFor="campaign-name">Name</Label>
                <Input
                  id="campaign-name"
                  value={form.name}
                  onChange={(e) => setF("name", e.target.value)}
                  placeholder="e.g. Raya Mega Sale 2027"
                  className="min-h-[44px]"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-preset">Festive preset</Label>
                  <Select value={form.presetId} onValueChange={(v) => applyPreset(v)}>
                    <SelectTrigger id="campaign-preset" className="min-h-[44px]" aria-label="Campaign preset">
                      <SelectValue placeholder="Choose a preset…" />
                    </SelectTrigger>
                    <SelectContent>
                      {CAMPAIGN_PRESETS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">Auto-fills the MYT window + theme. Fully editable.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-placement">Homepage placement</Label>
                  <Select value={form.placement} onValueChange={(v) => setF("placement", v as CampaignPlacement)}>
                    <SelectTrigger id="campaign-placement" className="min-h-[44px]" aria-label="Homepage placement">
                      <SelectValue placeholder="Where does this appear?" />
                    </SelectTrigger>
                    <SelectContent>
                      {CAMPAIGN_PLACEMENTS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">{placementHint}</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-description">Short description</Label>
                <Input
                  id="campaign-description"
                  value={form.description}
                  onChange={(e) => setF("description", e.target.value)}
                  placeholder="One line shoppers see under the campaign name (≤ 280 chars)"
                  className="min-h-[44px]"
                  maxLength={280}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-start">Starts at (MYT)</Label>
                  <Input
                    id="campaign-start"
                    type="datetime-local"
                    value={form.startAt}
                    onChange={(e) => setF("startAt", e.target.value)}
                    className="min-h-[44px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-end">Ends at (MYT)</Label>
                  <Input
                    id="campaign-end"
                    type="datetime-local"
                    value={form.endAt}
                    onChange={(e) => setF("endAt", e.target.value)}
                    className="min-h-[44px]"
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Malaysia time (UTC+8) — the same anchor the festive presets use. Campaigns appear/disappear automatically
                at these boundaries; no manual cleanup.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-priority">Priority (−100…100)</Label>
                  <Input
                    id="campaign-priority"
                    type="number"
                    value={form.priority}
                    onChange={(e) => setF("priority", e.target.value)}
                    className="min-h-[44px]"
                  />
                  <p className="text-[11px] text-muted-foreground">Higher wins when a placement is full.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-order">Display order (0…9999)</Label>
                  <Input
                    id="campaign-order"
                    type="number"
                    value={form.displayOrder}
                    onChange={(e) => setF("displayOrder", e.target.value)}
                    className="min-h-[44px]"
                  />
                  <p className="text-[11px] text-muted-foreground">Ascending, after priority.</p>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">{editing ? "Published" : "Publish immediately"}</p>
                  <p className="text-xs text-muted-foreground">
                    {editing
                      ? "Unpublished campaigns are drafts — hidden from every public surface."
                      : "Live the moment the window starts (scheduled until then)."}
                  </p>
                </div>
                <Switch checked={form.publish} onCheckedChange={(v) => setF("publish", v)} aria-label="Publish campaign" />
              </div>
            </TabsContent>

            <TabsContent value="creative" className="space-y-4 pt-3">
              <MediaInput
                id="campaign-desktop"
                label="Desktop hero banner"
                hint="Wide creative for the hero carousel / inline banner (≈1400×480). Falls back to a themed gradient when empty."
                value={form.bannerDesktopUrl}
                onChange={(v) => setF("bannerDesktopUrl", v)}
                placeholder={() => `/api/img/${randomSeed("campaign-hero")}?w=1400&h=480&label=Campaign%20banner`}
                aspect="wide"
              />
              <MediaInput
                id="campaign-mobile"
                label="Mobile banner (optional)"
                hint="Shown on phones instead of the desktop image. Empty = reuse the desktop creative."
                value={form.bannerMobileUrl}
                onChange={(v) => setF("bannerMobileUrl", v)}
                placeholder={() => `/api/img/${randomSeed("campaign-mobile")}?w=800&h=480&label=Mobile%20banner`}
                aspect="wide"
              />
              <MediaInput
                id="campaign-thumb"
                label="Showcase thumbnail (optional)"
                hint="Square-ish card image for the campaign showcase grid. Empty = themed gradient with the ornament."
                value={form.thumbnailUrl}
                onChange={(v) => setF("thumbnailUrl", v)}
                placeholder={() => `/api/img/${randomSeed("campaign-tile")}?w=600&h=420&label=Campaign`}
                aspect="square"
              />
              {form.placement === "inline" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-query">Product shelf query (optional)</Label>
                  <Input
                    id="campaign-query"
                    value={form.productQuery}
                    onChange={(e) => setF("productQuery", e.target.value)}
                    placeholder='e.g. lamp — renders a shelf of REAL active products matching this'
                    className="min-h-[44px]"
                    maxLength={60}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Curation only: products come from the standard active-product search with the same eligibility as
                    every other section. Prices and stock are never modified.
                  </p>
                </div>
              ) : null}
              <p className="flex items-start gap-1.5 rounded-lg border bg-muted/40 p-3 text-[11px] text-muted-foreground">
                <ImagePlus className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Uploads accept PNG/JPEG/WebP up to 3 MB and are stored as /uploads/campaigns/… URLs (the codebase's
                existing URL-string convention). Pasting a URL works too — site-relative (/…) or https:// only.
              </p>
            </TabsContent>

            <TabsContent value="destination" className="space-y-3 pt-3">
              <div className="space-y-1.5">
                <Label htmlFor="campaign-cta-label">CTA button label</Label>
                <Input
                  id="campaign-cta-label"
                  value={form.ctaLabel}
                  onChange={(e) => setF("ctaLabel", e.target.value)}
                  placeholder="Shop now"
                  className="min-h-[44px]"
                  maxLength={40}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-cta-kind">Destination</Label>
                <Select
                  value={form.ctaKind === "" ? "none" : form.ctaKind}
                  onValueChange={(v) => setF("ctaKind", v === "none" ? "" : v)}
                >
                  <SelectTrigger id="campaign-cta-kind" className="min-h-[44px]" aria-label="Campaign destination">
                    <SelectValue placeholder="Where does the CTA go?" />
                  </SelectTrigger>
                  <SelectContent>
                    {CTA_KINDS.map((k) => (
                      <SelectItem key={k.value || "none"} value={k.value || "none"}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{CTA_KIND_HINTS[form.ctaKind] ?? ""}</p>
              </div>
              {form.ctaKind === "search_kw" || form.ctaKind === "category" || form.ctaKind === "store" || form.ctaKind === "external" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-cta-value">
                    {form.ctaKind === "search_kw" ? "Search keywords" : form.ctaKind === "category" ? "Category slug" : form.ctaKind === "store" ? "Store slug" : "https:// URL"}
                  </Label>
                  <Input
                    id="campaign-cta-value"
                    value={form.ctaValue}
                    onChange={(e) => setF("ctaValue", e.target.value)}
                    placeholder={
                      form.ctaKind === "search_kw"
                        ? "raya"
                        : form.ctaKind === "category"
                          ? "electronics"
                          : form.ctaKind === "store"
                            ? "bytebazaar"
                            : "https://example.com/sale"
                    }
                    className="min-h-[44px]"
                  />
                </div>
              ) : null}
              {composeCtaHref(form.ctaKind, form.ctaValue) ? (
                <p className="flex items-center gap-1.5 rounded-lg border bg-muted/40 p-2.5 font-mono text-[11px] text-muted-foreground">
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  token → {composeCtaHref(form.ctaKind, form.ctaValue)}
                </p>
              ) : null}
            </TabsContent>

            <TabsContent value="theme" className="space-y-3 pt-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ["accent", "Accent"],
                    ["accentSoft", "Soft chip"],
                    ["gradientFrom", "Hero from"],
                    ["gradientTo", "Hero to"],
                  ] as [keyof CampaignThemeT, string][]
                ).map(([field, label]) => (
                  <div key={field} className="space-y-1.5">
                    <Label htmlFor={`campaign-${field}`}>{label}</Label>
                    <div className="flex items-center gap-2">
                      <input
                        id={`campaign-${field}`}
                        type="color"
                        value={form.theme[field] as string}
                        onChange={(e) => setF("theme", { ...form.theme, [field]: e.target.value })}
                        className="h-9 w-9 shrink-0 cursor-pointer rounded border bg-background p-0.5"
                        aria-label={`${label} colour`}
                      />
                      <span className="truncate font-mono text-[11px] text-muted-foreground">{form.theme[field] as string}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-greeting">Heading (EN)</Label>
                  <Input
                    id="campaign-greeting"
                    value={form.theme.greeting}
                    onChange={(e) => setF("theme", { ...form.theme, greeting: e.target.value })}
                    placeholder="Selamat Hari Raya"
                    className="min-h-[44px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-tagline">Subheading (EN)</Label>
                  <Input
                    id="campaign-tagline"
                    value={form.theme.tagline}
                    onChange={(e) => setF("theme", { ...form.theme, tagline: e.target.value })}
                    placeholder="Festive deals up to 70% off"
                    className="min-h-[44px]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-ornament">Ornament (emoji)</Label>
                  <Input
                    id="campaign-ornament"
                    value={form.theme.ornament}
                    onChange={(e) => setF("theme", { ...form.theme, ornament: e.target.value })}
                    placeholder="🌙"
                    className="min-h-[44px]"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="campaign-greeting-bm">Heading (BM)</Label>
                  <Input
                    id="campaign-greeting-bm"
                    value={form.theme.greetingBm}
                    onChange={(e) => setF("theme", { ...form.theme, greetingBm: e.target.value })}
                    placeholder="Salam Aidilfitri"
                    className="min-h-[44px]"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-tagline-bm">Subheading (BM)</Label>
                <Input
                  id="campaign-tagline-bm"
                  value={form.theme.taglineBm}
                  onChange={(e) => setF("theme", { ...form.theme, taglineBm: e.target.value })}
                  placeholder="Tawaran istimewa"
                  className="min-h-[44px]"
                />
              </div>
            </TabsContent>
          </Tabs>

          {/* live per-placement preview */}
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Live preview — {findPlacement(form.placement)?.label ?? form.placement}
            </p>
            <PlacementPreview f={form} />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving} className="min-h-[44px] sm:min-h-0">
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving || !canSave} className="min-h-[44px] sm:min-h-0">
              {saving ? "Saving…" : editing ? "Save changes" : "Create campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete campaign?"
        description={
          deleteTarget
            ? `“${deleteTarget.name}” will be permanently removed. Prefer Archive for ended campaigns — history is preserved and it disappears from public placements the same way.`
            : ""
        }
        confirmLabel="Delete"
        destructive
        loading={busyId !== null}
        onConfirm={() => void doDelete()}
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(o) => !o && setArchiveTarget(null)}
        title={archiveTarget?.archivedAt ? "Restore campaign?" : "Archive campaign?"}
        description={
          archiveTarget?.archivedAt
            ? `“${archiveTarget.name}” returns to its normal lifecycle (draft/scheduled/live/ended by window).`
            : `“${archiveTarget?.name ?? ""}” disappears from every public homepage placement immediately and from this default list (find it under the Archived filter). Nothing is deleted.`
        }
        confirmLabel={archiveTarget?.archivedAt ? "Restore" : "Archive"}
        destructive={!archiveTarget?.archivedAt}
        loading={busyId !== null}
        onConfirm={() => {
          const target = archiveTarget;
          if (target) void toggleArchive(target);
        }}
      />
    </div>
  );
}

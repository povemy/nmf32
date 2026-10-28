"use client";
// Task 10-e — Campaign engine admin view: festive site themes with windows,
// presets (MY festive + mega-sale calendar), publish toggles and live status.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, PartyPopper, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  CAMPAIGN_PRESETS,
  campaignStatusOf,
  daysUntil,
  presetDateRange,
  type CampaignPreset,
  type CampaignThemeT,
} from "@/lib/campaigns";
import { apiSend, useApi } from "./use-api";
import { TONE_CLASS, ConfirmDialog, EmptyState, ErrorState, PageHeader, ScrollY, fmtDT } from "./ui-bits";

/* ---------------------------------------------------------------- types */

type CampaignRow = {
  id: string;
  name: string;
  description: string | null;
  isPublished: boolean;
  themeJson: string;
  theme?: CampaignThemeT;
  startAt: string;
  endAt: string;
  status: "draft" | "scheduled" | "live" | "ended";
  createdByAdminId: string | null;
  createdAt: string;
  updatedAt: string;
};

const ORNAMENT_CHOICES = ["🌙", "🏮", "🪔", "🇲🇾", "🕌", "🧧", "⛩️", "🎁", "🛍️", "⚡", "🎂", "✨", "🎆", "🪁"];

const STATUS_CLASSES: Record<CampaignRow["status"], string> = {
  live: TONE_CLASS.emerald,
  scheduled: TONE_CLASS.amber,
  ended: TONE_CLASS.gray,
  draft: TONE_CLASS.slate,
};

type FormState = {
  name: string;
  description: string;
  startAt: string; // datetime-local value
  endAt: string;
  accent: string;
  accentSoft: string;
  bannerText: string;
  greeting: string;
  ornament: string;
  ornamentCustom: boolean;
  emoji: string;
  isPublished: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  startAt: "",
  endAt: "",
  accent: "#0D9488",
  accentSoft: "#CCFBF1",
  bannerText: "",
  greeting: "",
  ornament: "🎁",
  ornamentCustom: false,
  emoji: "✨",
  isPublished: false,
};

/* ------------------------------------------------------------ helpers */

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "Starts in 3d" / "Ends in 5h" style countdown. */
function countdownLabel(target: Date, verb: "Starts" | "Ends"): string | null {
  const diff = target.getTime() - Date.now();
  if (diff <= 0) return null;
  const d = daysUntil(target);
  if (d >= 1) return `${verb} in ${d}d`;
  const h = Math.max(1, Math.ceil(diff / 3_600_000));
  return `${verb} in ${h}h`;
}

function themeOf(row: CampaignRow): CampaignThemeT {
  if (row.theme) return row.theme;
  try {
    return JSON.parse(row.themeJson) as CampaignThemeT;
  } catch {
    return { accent: "#0D9488", accentSoft: "#CCFBF1", bannerText: row.name, ornament: "🎁", greeting: "", emoji: "✨" };
  }
}

function rowOfPreset(p: CampaignPreset, form: FormState): FormState {
  const { startAt, endAt } = presetDateRange(p);
  return {
    ...form,
    name: p.name,
    description: p.description,
    startAt: toLocalInput(startAt),
    endAt: toLocalInput(endAt),
    accent: p.theme.accent,
    accentSoft: p.theme.accentSoft,
    bannerText: p.theme.bannerText,
    greeting: p.theme.greeting,
    ornament: p.theme.ornament,
    ornamentCustom: !ORNAMENT_CHOICES.includes(p.theme.ornament),
    emoji: p.theme.emoji,
  };
}

/* ---------------------------------------------------------------- view */

export function CampaignsView() {
  const { data, error, loading, refetch } = useApi<CampaignRow[]>("/api/admin/campaigns");
  const rows = useMemo(() => data ?? [], [data]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CampaignRow | null>(null);
  const [presetKey, setPresetKey] = useState<string>("");

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const openCreate = () => {
    setEditingId(null);
    setPresetKey("");
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (row: CampaignRow) => {
    const t = themeOf(row);
    setEditingId(row.id);
    setPresetKey("");
    setForm({
      name: row.name,
      description: row.description ?? "",
      startAt: toLocalInput(new Date(row.startAt)),
      endAt: toLocalInput(new Date(row.endAt)),
      accent: t.accent,
      accentSoft: t.accentSoft,
      bannerText: t.bannerText,
      greeting: t.greeting,
      ornament: t.ornament,
      ornamentCustom: !ORNAMENT_CHOICES.includes(t.ornament),
      emoji: t.emoji,
      isPublished: row.isPublished,
    });
    setDialogOpen(true);
  };

  const applyPreset = (key: string) => {
    setPresetKey(key);
    const p = CAMPAIGN_PRESETS.find((x) => x.key === key);
    if (p) setForm((f) => rowOfPreset(p, f));
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        startAt: new Date(form.startAt).toISOString(),
        endAt: new Date(form.endAt).toISOString(),
        isPublished: form.isPublished,
        theme: {
          accent: form.accent,
          accentSoft: form.accentSoft,
          bannerText: form.bannerText.trim(),
          greeting: form.greeting.trim(),
          ornament: form.ornament,
          emoji: form.emoji,
        },
      };
      if (editingId) {
        await apiSend(`/api/admin/campaigns/${editingId}`, "PATCH", payload);
        toast.success("Campaign updated", { description: payload.name });
      } else {
        await apiSend("/api/admin/campaigns", "POST", payload);
        toast.success("Campaign created", { description: payload.name });
      }
      setDialogOpen(false);
      setEditingId(null);
      void refetch();
    } catch (e) {
      toast.error(editingId ? "Update failed" : "Create failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const togglePublish = async (row: CampaignRow) => {
    setBusyId(row.id);
    try {
      await apiSend(`/api/admin/campaigns/${row.id}`, "PATCH", { isPublished: !row.isPublished });
      toast.success(row.isPublished ? "Campaign unpublished" : "Campaign published", { description: row.name });
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
      toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Campaigns"
        description="Festive site theming — announcement bar, colours and ornaments shoppers see during Malaysian festive & mega-sale windows."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={openCreate}>
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        }
      />

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <PartyPopper className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Campaigns ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <EmptyState title="Loading campaigns…" hint="Fetching the festive calendar." />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No campaigns yet"
              hint="Create one from a preset — Raya, CNY, 11.11 and more fill the theme for you."
            />
          ) : (
            <ScrollY>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead className="hidden md:table-cell">Theme</TableHead>
                    <TableHead className="hidden lg:table-cell">Window</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">Published</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const t = themeOf(row);
                    const status = campaignStatusOf({
                      isPublished: row.isPublished,
                      startAt: new Date(row.startAt),
                      endAt: new Date(row.endAt),
                    });
                    const isLive = status === "live";
                    const isScheduled = status === "scheduled";
                    const countdown = isLive
                      ? countdownLabel(new Date(row.endAt), "Ends")
                      : isScheduled
                        ? countdownLabel(new Date(row.startAt), "Starts")
                        : null;
                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          <p className="max-w-[260px] truncate font-medium">{row.name}</p>
                          {row.description ? (
                            <p className="max-w-[260px] truncate text-xs text-muted-foreground">{row.description}</p>
                          ) : null}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="flex items-center gap-2">
                            <span
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-base"
                              style={{ background: `linear-gradient(135deg, ${t.accent}, ${t.accentSoft})` }}
                              aria-hidden="true"
                            >
                              {t.ornament}
                            </span>
                            <div className="min-w-0">
                              <p className="max-w-[160px] truncate text-xs font-medium">{t.bannerText}</p>
                              <p className="font-mono text-[10px] text-muted-foreground">
                                {t.accent} · {t.accentSoft}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                          <p>{fmtDT(row.startAt)}</p>
                          <p>→ {fmtDT(row.endAt)}</p>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant="outline" className={cn("capitalize", STATUS_CLASSES[status])}>
                              {status}
                            </Badge>
                            {countdown ? (
                              <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                                <CalendarClock className="h-3 w-3" /> {countdown}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <Switch
                            checked={row.isPublished}
                            disabled={busyId === row.id}
                            onCheckedChange={() => void togglePublish(row)}
                            aria-label={`Toggle campaign ${row.name}`}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="min-h-[44px] sm:min-h-0"
                              onClick={() => openEdit(row)}
                              aria-label={`Edit campaign ${row.name}`}
                            >
                              <Pencil className="h-4 w-4" />
                              <span className="sr-only">Edit</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                              onClick={() => setDeleteTarget(row)}
                              aria-label={`Delete campaign ${row.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                              <span className="sr-only">Delete</span>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollY>
          )}
        </CardContent>
      </Card>

      {/* create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit campaign" : "New campaign"}</DialogTitle>
            <DialogDescription>
              Themes the shopper site during the window: announcement bar, accent colours and hanging ornaments.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!editingId ? (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" /> Start from preset
                </Label>
                <Select value={presetKey} onValueChange={applyPreset}>
                  <SelectTrigger className="min-h-[44px] w-full" aria-label="Start from preset">
                    <SelectValue placeholder="Pick a festive preset (fills everything)…" />
                  </SelectTrigger>
                  <SelectContent>
                    {CAMPAIGN_PRESETS.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.theme.ornament} {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="camp-name">Name</Label>
                <Input
                  id="camp-name"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. Raya Mega Sale 2026"
                  className="min-h-[44px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="camp-desc">Description (internal)</Label>
                <Input
                  id="camp-desc"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="Optional note for the team"
                  className="min-h-[44px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="camp-start">Starts</Label>
                <Input
                  id="camp-start"
                  type="datetime-local"
                  value={form.startAt}
                  onChange={(e) => set("startAt", e.target.value)}
                  className="min-h-[44px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="camp-end">Ends</Label>
                <Input
                  id="camp-end"
                  type="datetime-local"
                  value={form.endAt}
                  onChange={(e) => set("endAt", e.target.value)}
                  className="min-h-[44px]"
                />
              </div>
            </div>

            <div className="rounded-xl border bg-muted/30 p-3">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Theme</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="camp-accent">Accent colour</Label>
                  <div className="flex items-center gap-2">
                    <input
                      id="camp-accent"
                      type="color"
                      value={form.accent}
                      onChange={(e) => set("accent", e.target.value)}
                      className="h-10 w-12 shrink-0 cursor-pointer rounded-md border bg-card p-0.5"
                      aria-label="Accent colour"
                    />
                    <Input
                      value={form.accent}
                      onChange={(e) => set("accent", e.target.value)}
                      className="min-h-[44px] flex-1 font-mono text-xs"
                      aria-label="Accent hex"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="camp-accent-soft">Accent soft (light tint)</Label>
                  <div className="flex items-center gap-2">
                    <input
                      id="camp-accent-soft"
                      type="color"
                      value={form.accentSoft}
                      onChange={(e) => set("accentSoft", e.target.value)}
                      className="h-10 w-12 shrink-0 cursor-pointer rounded-md border bg-card p-0.5"
                      aria-label="Accent soft colour"
                    />
                    <Input
                      value={form.accentSoft}
                      onChange={(e) => set("accentSoft", e.target.value)}
                      className="min-h-[44px] flex-1 font-mono text-xs"
                      aria-label="Accent soft hex"
                    />
                  </div>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="camp-banner">Banner text</Label>
                  <Input
                    id="camp-banner"
                    value={form.bannerText}
                    onChange={(e) => set("bannerText", e.target.value)}
                    placeholder="e.g. Balik kampung sales live now — Raya deals up to 70% off"
                    className="min-h-[44px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="camp-ornament">Ornament (hanging emoji)</Label>
                  <div className="flex items-center gap-2">
                    <Select
                      value={form.ornamentCustom ? "__custom" : form.ornament}
                      onValueChange={(v) =>
                        v === "__custom" ? set("ornamentCustom", true) : (set("ornament", v), set("ornamentCustom", false))
                      }
                    >
                      <SelectTrigger className="min-h-[44px] flex-1" aria-label="Ornament emoji">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ORNAMENT_CHOICES.map((o) => (
                          <SelectItem key={o} value={o}>
                            {o}
                          </SelectItem>
                        ))}
                        <SelectItem value="__custom">Custom…</SelectItem>
                      </SelectContent>
                    </Select>
                    {form.ornamentCustom ? (
                      <Input
                        value={form.ornament}
                        onChange={(e) => set("ornament", e.target.value)}
                        placeholder="🪁"
                        className="min-h-[44px] w-24 text-center"
                        aria-label="Custom ornament"
                      />
                    ) : null}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="camp-emoji">Festive emoji</Label>
                  <Input
                    id="camp-emoji"
                    value={form.emoji}
                    onChange={(e) => set("emoji", e.target.value)}
                    placeholder="🧧"
                    className="min-h-[44px]"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="camp-greeting">Greeting</Label>
                  <Textarea
                    id="camp-greeting"
                    value={form.greeting}
                    onChange={(e) => set("greeting", e.target.value)}
                    placeholder="e.g. Selamat Hari Raya Aidilfitri! Maaf zahir & batin from NOMOFEE"
                    className="min-h-[60px] resize-none"
                  />
                </div>
              </div>

              {/* live theme preview */}
              <div
                className="mt-3 flex items-center gap-2 overflow-hidden rounded-lg px-3 py-2 text-white"
                style={{ background: `linear-gradient(90deg, ${form.accent}, ${form.accentSoft})` }}
              >
                <span aria-hidden="true">{form.ornament}</span>
                <span className="truncate text-xs font-semibold">
                  {form.bannerText.trim() || "Your announcement bar text appears here"}
                </span>
                {form.greeting.trim() ? (
                  <span className="ml-auto hidden truncate text-[11px] text-white/85 lg:block">{form.greeting}</span>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <Label htmlFor="camp-published" className="text-sm font-medium">
                  Publish immediately
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Off = draft. Published + window active = live for shoppers.
                </p>
              </div>
              <Switch
                id="camp-published"
                checked={form.isPublished}
                onCheckedChange={(v) => set("isPublished", v)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving} className="min-h-[44px] sm:min-h-0">
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={
                saving ||
                !form.name.trim() ||
                !form.startAt ||
                !form.endAt ||
                new Date(form.endAt).getTime() <= new Date(form.startAt).getTime()
              }
              className="min-h-[44px] sm:min-h-0"
            >
              {saving ? "Saving…" : editingId ? "Save changes" : "Create campaign"}
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
            ? `“${deleteTarget.name}” and its theme will be removed. This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        destructive
        loading={busyId !== null}
        onConfirm={() => void doDelete()}
      />
    </div>
  );
}

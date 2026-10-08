"use client";
// Task 2-d — SD-08 Page Builder (flagship): page list + 3-pane editor.
// LEFT section library (add/drag-reorder/ops) · CENTER device-framed canvas ·
// RIGHT props form. Autosave (debounced 3s), publish/revert, theme dialog.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { DEFAULT_THEME, SECTION_REGISTRY, createSection, sectionDef, type Section, type SectionField, type ThemeTokens, parseTheme } from "@/lib/sections";
import {
  apiGet,
  apiSend,
  RowsSkeleton,
  StatusChip,
  useApi,
  useDebouncedCallback,
  type SellerNav,
} from "./ui-bits";
import { SectionPreview } from "./builder-render";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  GripVertical,
  Layers,
  Loader2,
  Monitor,
  Palette,
  Plus,
  RotateCcw,
  Smartphone,
  Trash2,
} from "lucide-react";

// ---------------------------------------------------------------- page list

type PageRow = {
  id: string;
  slug: string;
  title: string;
  pageType: string;
  draftVersion: number;
  publishedVersion: number;
  hasUnpublished: boolean;
  published: boolean;
  sectionCount: number;
  updatedAt: string;
};

type PageDetail = {
  page: Omit<PageRow, "sectionCount" | "updatedAt">;
  draft: { sections: Section[]; version: number };
  published: { sections: Section[]; version: number } | null;
};

export default function PageBuilder({
  pageId,
  onNavigate,
  storeSlug,
  storeName,
}: {
  pageId?: string;
  onNavigate: (n: SellerNav) => void;
  storeSlug: string;
  storeName: string;
}) {
  if (pageId) {
    return <BuilderEditor key={pageId} pageId={pageId} onNavigate={onNavigate} storeSlug={storeSlug} storeName={storeName} />;
  }
  return <PageList onNavigate={onNavigate} />;
}

function PageList({ onNavigate }: { onNavigate: (n: SellerNav) => void }) {
  const { data, loading, error } = useApi<PageRow[]>("/api/store/pages");

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every page is an ordered stack of sections. Edit the draft, then publish to push it live to shoppers.
      </p>
      {loading ? (
        <RowsSkeleton rows={4} />
      ) : error ? (
        <Card><CardContent className="p-6 text-sm text-rose-600">Failed to load pages: {error}</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(data ?? []).map((p) => (
            <button
              key={p.id}
              onClick={() => onNavigate({ view: "builder", pageId: p.id })}
              className="group rounded-2xl border bg-card p-4 text-left transition-all hover:border-primary/50 hover:shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{p.title}</p>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {p.pageType}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">/{p.slug} · {p.sectionCount} sections</p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <StatusChip status={p.published ? "live" : "draft"} />
                <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">draft v{p.draftVersion}</span>
                {p.publishedVersion > 0 ? (
                  <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">published v{p.publishedVersion}</span>
                ) : null}
                {p.hasUnpublished ? (
                  <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> unpublished changes
                  </span>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- editor

function BuilderEditor({
  pageId,
  onNavigate,
  storeSlug,
  storeName,
}: {
  pageId: string;
  onNavigate: (n: SellerNav) => void;
  storeSlug: string;
  storeName: string;
}) {
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [sections, setSections] = useState<Section[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [theme, setTheme] = useState<ThemeTokens>(DEFAULT_THEME);
  const [themeOpen, setThemeOpen] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [publishing, setPublishing] = useState(false);
  const skipFirst = useRef(true);

  // initial load: page doc + theme
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [d, t] = await Promise.all([
          apiGet<PageDetail>(`/api/store/pages/${pageId}`),
          apiGet<{ theme: ThemeTokens }>("/api/store/theme"),
        ]);
        if (!alive) return;
        setDetail(d);
        setSections(d.draft.sections);
        setTheme(parseTheme(JSON.stringify(t.theme)));
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Failed to load page");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [pageId]);

  const saveDraft = useCallback(
    async (secs: Section[], silent = false) => {
      setSaveState("saving");
      try {
        const res = await apiSend<{ doc: { sections: Section[]; version: number } }>(
          "PUT",
          `/api/store/pages/${pageId}/draft`,
          { sections: secs }
        );
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                draft: res.doc,
                page: { ...prev.page, draftVersion: res.doc.version, hasUnpublished: true },
              }
            : prev
        );
        setSaveState("saved");
        if (!silent) toast.success("Draft saved");
      } catch (e) {
        setSaveState("dirty");
        if (!silent) toast.error(e instanceof Error ? e.message : "Save failed");
      }
    },
    [pageId]
  );

  const { run: scheduleSave } = useDebouncedCallback((secs: Section[]) => saveDraft(secs, true), 3000);

  // autosave on any sections change (skip the initial load assignment)
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    setSaveState("dirty");
    scheduleSave(sections);
  }, [sections, scheduleSave]);

  const mutate = useCallback((updater: (prev: Section[]) => Section[]) => {
    setSections((prev) => updater(prev));
  }, []);

  const addSection = (type: string) => {
    const s = createSection(type);
    if (!s) return;
    mutate((prev) => [...prev, s]);
    setSelectedId(s.id);
    toast.success(`${sectionDef(type)?.label ?? type} added`);
  };

  const duplicateSection = (id: string) => {
    mutate((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const copy: Section = JSON.parse(JSON.stringify(prev[idx]));
      copy.id = `sec_${Math.random().toString(36).slice(2, 10)}`;
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    toast.success("Section duplicated");
  };

  const removeSection = (id: string) => {
    mutate((prev) => prev.filter((s) => s.id !== id));
    setSelectedId((sel) => (sel === id ? null : sel));
  };

  const updateProp = (id: string, key: string, value: unknown) => {
    mutate((prev) => prev.map((s) => (s.id === id ? { ...s, props: { ...s.props, [key]: value } } : s)));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    mutate((prev) => {
      const from = prev.findIndex((s) => s.id === active.id);
      const to = prev.findIndex((s) => s.id === over.id);
      return from < 0 || to < 0 ? prev : arrayMove(prev, from, to);
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const publish = async () => {
    setPublishing(true);
    await saveDraft(sections, true);
    try {
      const res = await apiSend<{ publishedVersion: number; hasUnpublished: boolean }>(
        "POST",
        `/api/store/pages/${pageId}/publish`
      );
      setDetail((prev) => (prev ? { ...prev, page: { ...prev.page, publishedVersion: res.publishedVersion, hasUnpublished: res.hasUnpublished, published: true } } : prev));
      setSaveState("saved");
      toast.success(`Published v${res.publishedVersion} — live on your storefront`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  };

  const discardDraft = async () => {
    try {
      const res = await apiSend<{ doc: { sections: Section[]; version: number } }>("POST", `/api/store/pages/${pageId}/revert`);
      setSections(res.doc.sections);
      skipFirst.current = true; // don't autosave the reverted state right back
      setSaveState("saved");
      toast.success("Draft reverted to the published version");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Revert failed");
    }
  };

  const previewStorefront = () => {
    const app = useApp.getState();
    app.setActiveStoreSlug(storeSlug || null);
    app.setSurface("shopper");
    if (!detail?.page.published) {
      toast.info("Heads up: this page has never been published — shoppers see it only after you press Publish.");
    }
  };

  const selected = sections.find((s) => s.id === selectedId) ?? null;

  if (loading) return <RowsSkeleton rows={6} />;
  if (!detail) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" onClick={() => onNavigate({ view: "builder" })} className="gap-1.5"><ArrowLeft className="h-4 w-4" /> Pages</Button>
        <Card><CardContent className="p-6 text-sm text-rose-600">Could not load this page.</CardContent></Card>
      </div>
    );
  }

  const topbar = (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2.5">
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onNavigate({ view: "builder" })}>
        <ArrowLeft className="h-4 w-4" /> Pages
      </Button>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{detail.page.title}</p>
        <p className="text-[11px] text-muted-foreground">/{detail.page.slug}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">draft v{detail.page.draftVersion}</span>
        {detail.page.publishedVersion > 0 ? (
          <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">published v{detail.page.publishedVersion}</span>
        ) : (
          <StatusChip status="draft" />
        )}
        {detail.page.hasUnpublished ? (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> unpublished
          </span>
        ) : null}
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium",
            saveState === "saved" && "bg-emerald-100 text-emerald-700",
            saveState === "dirty" && "bg-muted text-muted-foreground",
            saveState === "saving" && "bg-muted text-muted-foreground"
          )}
        >
          {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved"}
        </span>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <div className="flex rounded-lg border p-0.5">
          <Button variant="ghost" size="sm" className={cn("h-7 gap-1 px-2", device === "desktop" && "bg-muted")} onClick={() => setDevice("desktop")} aria-label="Desktop preview">
            <Monitor className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className={cn("h-7 gap-1 px-2", device === "mobile" && "bg-muted")} onClick={() => setDevice("mobile")} aria-label="Mobile preview">
            <Smartphone className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setThemeOpen(true)}>
          <Palette className="h-3.5 w-3.5" /> Theme
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={previewStorefront}>
          <ExternalLink className="h-3.5 w-3.5" /> Preview
        </Button>
        {detail.page.publishedVersion > 0 ? (
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={discardDraft}>
            <RotateCcw className="h-3.5 w-3.5" /> Discard draft
          </Button>
        ) : null}
        <Button size="sm" onClick={publish} disabled={publishing} className="gap-1.5">
          {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Publish
        </Button>
      </div>
    </div>
  );

  const library = (
    <div className="space-y-4">
      {(["structure", "content", "commerce", "social"] as const).map((cat) => (
        <div key={cat}>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{cat}</p>
          <div className="space-y-1">
            {SECTION_REGISTRY.filter((d) => d.category === cat).map((d) => (
              <button
                key={d.type}
                onClick={() => addSection(d.type)}
                className="group flex w-full items-center gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-muted/60"
                title={d.description}
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{d.label}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{d.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const canvas = (
    <div
      className={cn(
        "mx-auto min-h-full bg-neutral-100",
        device === "mobile" ? "max-w-[420px] border-x" : "w-full"
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedId(null);
      }}
    >
      {sections.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          Empty page — add sections from the library on the left.
        </div>
      ) : (
        sections.map((s) => {
          const isHidden = hiddenIds.includes(s.id);
          return (
            <div
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={cn(
                "relative cursor-pointer transition-shadow",
                selectedId === s.id ? "z-10 ring-2 ring-inset ring-primary" : "hover:ring-1 hover:ring-inset hover:ring-primary/30",
                isHidden && "opacity-40"
              )}
            >
              {selectedId === s.id ? (
                <span className="absolute left-2 top-2 z-20 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow">
                  {sectionDef(s.type)?.label ?? s.type}
                </span>
              ) : null}
              <SectionPreview section={s} theme={theme} storeName={storeName} />
            </div>
          );
        })
      )}
    </div>
  );

  const moveSection = (id: string, dir: 1 | -1) =>
    mutate((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      return arrayMove(prev, i, j);
    });

  const toggleHidden = (id: string) =>
    setHiddenIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const rowProps = (s: Section) => ({
    section: s,
    selected: selectedId === s.id,
    onSelect: () => setSelectedId(s.id),
    hidden: hiddenIds.includes(s.id),
    onToggleHidden: () => toggleHidden(s.id),
    onDuplicate: () => duplicateSection(s.id),
    onDelete: () => removeSection(s.id),
    onMove: (dir: 1 | -1) => moveSection(s.id, dir),
  });

  const layersPanel = (
    <div>
      <p className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        <Layers className="h-3 w-3" /> Sections ({sections.length})
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {sections.map((s) => (
              <SortableRow key={s.id} {...rowProps(s)} />
            ))}
            {sections.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                No sections yet — add one from the library below.
              </p>
            ) : null}
          </div>
        </SortableContext>
      </DndContext>
      <p className="mt-1.5 text-[10px] text-muted-foreground">Drag the grip to reorder · arrows as fallback</p>
    </div>
  );

  return (
    <div className="-m-4 sm:-m-6">
      {topbar}
      {/* desktop 3-pane */}
      <div className="hidden lg:grid lg:grid-cols-[260px_1fr_320px] xl:grid-cols-[280px_1fr_340px]" style={{ height: "calc(100vh - 122px)" }}>
        <aside className="overflow-y-auto border-r bg-background p-3">
          {layersPanel}
          <div className="my-3 border-t" />
          {library}
        </aside>
        <div className="overflow-y-auto bg-neutral-100">{canvas}</div>
        <aside className="overflow-y-auto border-l bg-background p-3">
          {selected ? (
            <PropsForm section={selected} updateProp={updateProp} />
          ) : (
            <p className="p-4 text-center text-xs text-muted-foreground">Select a section on the canvas to edit its content.</p>
          )}
        </aside>
      </div>

      {/* mobile stacked tabs */}
      <div className="lg:hidden">
        <Tabs defaultValue="canvas" className="p-3">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="sections" className="gap-1"><Layers className="h-3.5 w-3.5" /> Sections</TabsTrigger>
            <TabsTrigger value="canvas">Canvas</TabsTrigger>
            <TabsTrigger value="props">Content</TabsTrigger>
          </TabsList>
          <TabsContent value="sections" className="mt-3 max-h-[70vh] space-y-4 overflow-y-auto">
            {layersPanel}
            <div className="border-t" />
            {library}
          </TabsContent>
          <TabsContent value="canvas" className="mt-3 max-h-[70vh] overflow-y-auto border">{canvas}</TabsContent>
          <TabsContent value="props" className="mt-3 max-h-[65vh] overflow-y-auto">
            {selected ? <PropsForm section={selected} updateProp={updateProp} /> : <p className="p-4 text-center text-xs text-muted-foreground">Select a section first (Canvas tab → tap a block).</p>}
          </TabsContent>
        </Tabs>
      </div>

      <ThemeDialog open={themeOpen} onOpenChange={setThemeOpen} theme={theme} onThemeChange={setTheme} />
    </div>
  );
}

// ---------------------------------------------------------------- sortable row

function SortableRow({
  section,
  selected,
  onSelect,
  hidden,
  onToggleHidden,
  onDuplicate,
  onDelete,
  onMove,
}: {
  section: Section;
  selected: boolean;
  onSelect: () => void;
  hidden: boolean;
  onToggleHidden: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (dir: 1 | -1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5",
        selected && "border-primary ring-1 ring-primary/40",
        isDragging && "z-50 shadow-lg",
        hidden && "opacity-50"
      )}
    >
      <button
        className="touch-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-xs font-medium">
        {sectionDef(section.type)?.label ?? section.type}
      </button>
      <button onClick={onToggleHidden} aria-label={hidden ? "Show section" : "Hide section"} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button onClick={() => onMove(-1)} aria-label="Move up" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <ArrowUp className="h-3 w-3" />
      </button>
      <button onClick={() => onMove(1)} aria-label="Move down" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <ArrowDown className="h-3 w-3" />
      </button>
      <button onClick={onDuplicate} aria-label="Duplicate section" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <Copy className="h-3 w-3" />
      </button>
      <button onClick={onDelete} aria-label="Delete section" className="rounded p-1 text-rose-500 hover:bg-rose-50 hover:text-rose-600">
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- props form

type FieldProps = {
  section: Section;
  updateProp: (id: string, key: string, value: unknown) => void;
};

function PropsForm({ section, updateProp }: FieldProps) {
  const def = sectionDef(section.type);
  if (!def) return <p className="text-xs text-muted-foreground">Unknown section type.</p>;

  return (
    <div className="space-y-3.5">
      <div className="rounded-lg bg-muted/60 p-2.5">
        <p className="text-xs font-semibold">{def.label}</p>
        <p className="text-[11px] text-muted-foreground">{def.description}</p>
      </div>
      {def.fields.map((f) => {
        const value = section.props[f.key];
        return (
          <div key={f.key} className="space-y-1.5">
            <Label className="text-xs" htmlFor={`f-${section.id}-${f.key}`}>{f.label}</Label>
            <FieldControl field={f} value={value} sectionId={section.id} updateProp={updateProp} />
            {f.help ? <p className="text-[10px] text-muted-foreground">{f.help}</p> : null}
          </div>
        );
      })}
      <p className="border-t pt-2 text-[10px] text-muted-foreground">Changes autosave to the draft after 3s. Publish to go live.</p>
    </div>
  );
}

function FieldControl({
  field,
  value,
  sectionId,
  updateProp,
}: {
  field: SectionField;
  value: unknown;
  sectionId: string;
  updateProp: (id: string, key: string, value: unknown) => void;
}) {
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [imgBust, setImgBust] = useState(0);

  switch (field.type) {
    case "switch":
      return <Switch checked={value === true} onCheckedChange={(v) => updateProp(sectionId, field.key, v)} aria-label={field.label} />;

    case "textarea":
      return (
        <Textarea
          id={`f-${sectionId}-${field.key}`}
          rows={4}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => updateProp(sectionId, field.key, e.target.value)}
          placeholder={field.placeholder}
        />
      );

    case "number":
      return (
        <Input
          id={`f-${sectionId}-${field.key}`}
          type="number"
          value={typeof value === "number" || typeof value === "string" ? String(value) : ""}
          onChange={(e) => updateProp(sectionId, field.key, e.target.value === "" ? "" : Number(e.target.value))}
        />
      );

    case "select":
      return (
        <Select value={String(value ?? "")} onValueChange={(v) => updateProp(sectionId, field.key, v)}>
          <SelectTrigger id={`f-${sectionId}-${field.key}`} aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "color":
      return (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={field.label}
            className="h-9 w-10 cursor-pointer rounded border bg-card"
            value={typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
            onChange={(e) => updateProp(sectionId, field.key, e.target.value)}
          />
          <Input
            className="h-9 font-mono text-xs"
            value={String(value ?? "")}
            onChange={(e) => updateProp(sectionId, field.key, e.target.value)}
          />
        </div>
      );

    case "image": {
      const url = typeof value === "string" ? value : "";
      const seedMatch = url.match(/\/api\/img\/([^?]*)/);
      const regenerate = () => {
        if (!seedMatch) return;
        const base = seedMatch[1].replace(/-v\d+$/, "");
        const next = url.replace(/\/api\/img\/[^?]*/, `/api/img/${base}-v${Math.floor(Math.random() * 9000 + 1000)}`);
        updateProp(sectionId, field.key, next);
        setImgBust((b) => b + 1);
      };
      return (
        <div className="space-y-1.5">
          {url ? (
            <img key={imgBust} src={url} alt="Section image preview" className="h-16 w-full rounded-lg border object-cover" />
          ) : (
            <div className="flex h-16 items-center justify-center rounded-lg border border-dashed text-[10px] text-muted-foreground">No image</div>
          )}
          <Input
            id={`f-${sectionId}-${field.key}`}
            className="h-8 font-mono text-[11px]"
            value={url}
            onChange={(e) => updateProp(sectionId, field.key, e.target.value)}
          />
          {seedMatch ? (
            <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-[11px]" onClick={regenerate}>
              <RotateCcw className="h-3 w-3" /> Regenerate placeholder
            </Button>
          ) : null}
        </div>
      );
    }

    case "json": {
      const text = jsonText ?? (value === undefined ? "" : JSON.stringify(value, null, 2));
      return (
        <div className="space-y-1">
          <Textarea
            id={`f-${sectionId}-${field.key}`}
            rows={6}
            className={cn("font-mono text-[11px]", jsonError && "border-rose-400 focus-visible:ring-rose-300")}
            value={text}
            onChange={(e) => setJsonText(e.target.value)}
            onBlur={() => {
              try {
                const parsed = JSON.parse(text);
                setJsonError(null);
                setJsonText(null);
                updateProp(sectionId, field.key, parsed);
              } catch (err) {
                setJsonError(err instanceof Error ? err.message : "Invalid JSON");
              }
            }}
          />
          {jsonError ? <p className="text-[10px] text-rose-600">Invalid JSON — {jsonError}</p> : null}
        </div>
      );
    }

    // text + url
    default:
      return (
        <Input
          id={`f-${sectionId}-${field.key}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => updateProp(sectionId, field.key, e.target.value)}
          placeholder={field.placeholder}
        />
      );
  }
}

// ---------------------------------------------------------------- theme dialog

function ThemeDialog({
  open,
  onOpenChange,
  theme,
  onThemeChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  theme: ThemeTokens;
  onThemeChange: (t: ThemeTokens) => void;
}) {
  const [draft, setDraft] = useState<ThemeTokens>(theme);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setDraft(theme);
  }, [open, theme]);

  const save = async () => {
    setBusy(true);
    try {
      await apiSend("PUT", "/api/store/theme", { theme: draft });
      onThemeChange(draft);
      toast.success("Theme saved — storefront updated");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save theme");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Store theme</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Primary color</Label>
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Primary color" className="h-9 w-10 cursor-pointer rounded border" value={draft.primaryColor} onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })} />
                <Input className="h-9 font-mono text-xs" value={draft.primaryColor} onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Accent color</Label>
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Accent color" className="h-9 w-10 cursor-pointer rounded border" value={draft.accentColor} onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })} />
                <Input className="h-9 font-mono text-xs" value={draft.accentColor} onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })} />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Corner radius</Label>
              <Select value={draft.radius} onValueChange={(v) => setDraft({ ...draft, radius: v as ThemeTokens["radius"] })}>
                <SelectTrigger aria-label="Corner radius"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="sm">Small</SelectItem>
                  <SelectItem value="md">Medium</SelectItem>
                  <SelectItem value="lg">Large</SelectItem>
                  <SelectItem value="full">Pill</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Button style</Label>
              <Select value={draft.buttonStyle} onValueChange={(v) => setDraft({ ...draft, buttonStyle: v as ThemeTokens["buttonStyle"] })}>
                <SelectTrigger aria-label="Button style"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="solid">Solid</SelectItem>
                  <SelectItem value="outline">Outline</SelectItem>
                  <SelectItem value="pill">Pill</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="rounded-xl border p-3" style={{ backgroundColor: draft.primaryColor + "10" }}>
            <p className="text-xs font-semibold" style={{ color: draft.primaryColor }}>Live preview</p>
            <span className="mt-1.5 inline-block px-4 py-1.5 text-xs font-semibold text-white" style={{ backgroundColor: draft.primaryColor, borderRadius: draft.radius === "full" ? 9999 : draft.radius === "none" ? 0 : draft.radius === "sm" ? 4 : draft.radius === "md" ? 10 : 16 }}>
              Button
            </span>
          </div>
          <Button onClick={save} disabled={busy} className="w-full min-h-[44px] gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save theme
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

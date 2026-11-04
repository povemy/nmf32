"use client";
// ============================================================================
// MKT-05 Homepage Layout (work order 14 §4B/§5) — the admin-controlled
// homepage section ORDER. Stored as Setting "home.section_order" through
// PUT /api/admin/home-layout (RBAC campaigns.manage, audited, cache-busted).
//
// Rules (enforced server-side by normalizeSectionOrder — the SAME normalizer
// the public read path uses, so this UI can never produce an order the
// homepage rejects):
//   • hero is mandatory and always renders first (locked at the top);
//   • every other section can be reordered, hidden (removed) or re-added;
//   • up to 3 "inline" promo slots sit between sections — each consumes the
//     next live inline campaign (banner or product shelf).
// ============================================================================
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, LayoutTemplate, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DEFAULT_SECTION_ORDER, type HomeSectionId, type HomeSectionMeta } from "@/lib/home-layout";
import { apiSend, useApi } from "./use-api";
import { EmptyState, ErrorState, PageHeader } from "./ui-bits";

type LayoutPayload = {
  order: HomeSectionId[];
  defaults: HomeSectionId[];
  sections: HomeSectionMeta[];
};

/** Sections that are NOT currently placed — candidates for re-adding. */
function availableSections(order: HomeSectionId[], sections: HomeSectionMeta[]): HomeSectionMeta[] {
  const inOrder = new Set(order.filter((s) => s !== "inline"));
  return sections.filter((s) => s.id !== "inline" && !inOrder.has(s.id));
}

function inlineCount(order: HomeSectionId[]): number {
  return order.filter((s) => s === "inline").length;
}

export function HomepageLayoutView() {
  const { data, error, loading, refetch } = useApi<LayoutPayload>("/api/admin/home-layout");
  const [order, setOrder] = useState<HomeSectionId[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setOrder(data.order);
  }, [data]);

  const sections = data?.sections ?? [];
  const metaFor = (id: HomeSectionId) => sections.find((s) => s.id === id);

  const move = (index: number, dir: -1 | 1) => {
    setOrder((o) => {
      if (!o) return o;
      const next = [...o];
      const j = index + dir;
      if (j < 0 || j >= next.length) return o;
      // hero (index 0) is locked — nothing may move above it.
      if (j === 0) return o;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  };

  const remove = (index: number) => {
    setOrder((o) => {
      if (!o) return o;
      const next = [...o];
      if (index === 0) return o; // hero is mandatory
      next.splice(index, 1);
      return next;
    });
  };

  const addInline = () => {
    setOrder((o) => {
      if (!o || inlineCount(o) >= 3) return o;
      // insert after the first section (hero) by default — admin then moves it
      const next = [...o];
      next.splice(1, 0, "inline");
      return next;
    });
  };

  const addSection = (id: HomeSectionId) => {
    setOrder((o) => {
      if (!o) return o;
      const next = [...o];
      next.push(id);
      return next;
    });
  };

  const resetDefaults = () => {
    setOrder([...DEFAULT_SECTION_ORDER]);
    toast.info("Default order staged", { description: "Press Save changes to apply." });
  };

  const save = async () => {
    if (!order) return;
    setSaving(true);
    try {
      const res = await apiSend<{ order: HomeSectionId[] }>("/api/admin/home-layout", "PUT", { order });
      setOrder(res.order);
      toast.success("Homepage layout saved", {
        description: "The public homepage follows this order within the cache window (seconds; ≤ 60 s worst case).",
      });
      void refetch();
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const dirty = data != null && order != null && JSON.stringify(order) !== JSON.stringify(data.order);
  const available = order ? availableSections(order, sections) : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Homepage Layout"
        description="Reorder, hide or re-add homepage sections — and place inline promo slots between them. Hero always renders first."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="min-h-[44px]" onClick={resetDefaults}>
              <RotateCcw className="h-4 w-4" /> Reset default
            </Button>
            <Button size="sm" className="min-h-[44px]" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </Button>
          </div>
        }
      />

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <LayoutTemplate className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Section order
          </CardTitle>
          <CardDescription>
            Omitted sections are hidden on the public homepage. Data-empty sections also auto-hide (e.g. no live showcase
            campaigns → the showcase disappears without any change here).
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-5 sm:px-6">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading || order == null ? (
            <EmptyState title="Loading layout…" hint="Fetching the current homepage section order." />
          ) : (
            <div className="space-y-3">
              <ol className="space-y-2">
                {order.map((id, i) => {
                  const meta = metaFor(id);
                  const isHero = id === "hero";
                  const isInline = id === "inline";
                  return (
                    <li
                      key={`${id}-${i}`}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border bg-card p-3",
                        isHero && "border-teal-300 bg-teal-50/50 dark:border-teal-800 dark:bg-teal-950/30",
                        isInline && "border-dashed border-orange-300 bg-orange-50/40 dark:border-orange-800 dark:bg-orange-950/20"
                      )}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">
                          {isInline ? "Inline promo slot" : (meta?.label ?? id)}
                          {isHero ? <span className="ml-2 text-[11px] font-normal text-muted-foreground">always first — locked</span> : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {isInline ? "Renders the next live inline campaign (banner or product shelf)." : (meta?.description ?? "")}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-[44px] px-2 sm:min-h-0"
                          disabled={i <= 1}
                          onClick={() => move(i, -1)}
                          aria-label={`Move ${meta?.label ?? id} up`}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-[44px] px-2 sm:min-h-0"
                          disabled={i === 0 || i === order.length - 1}
                          onClick={() => move(i, 1)}
                          aria-label={`Move ${meta?.label ?? id} down`}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-[44px] px-2 text-red-600 hover:bg-red-50 sm:min-h-0 dark:hover:bg-red-950/40"
                          disabled={isHero}
                          onClick={() => remove(i)}
                          aria-label={`Remove ${meta?.label ?? id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>

              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <Button size="sm" variant="outline" className="min-h-[44px]" disabled={inlineCount(order) >= 3} onClick={addInline}>
                  <Plus className="h-4 w-4" /> Inline promo slot ({inlineCount(order)}/3)
                </Button>
                {available.map((s) => (
                  <Button key={s.id} size="sm" variant="outline" className="min-h-[44px]" onClick={() => addSection(s.id)}>
                    <Plus className="h-4 w-4" /> {s.label}
                  </Button>
                ))}
                {available.length === 0 && inlineCount(order) >= 3 ? (
                  <p className="text-xs text-muted-foreground">All sections are placed and inline slots are full.</p>
                ) : null}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

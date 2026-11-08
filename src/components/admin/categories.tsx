"use client";
// CAT-03 Categories — tree table with inline commission edit, create + delete.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiSend, useApi } from "./use-api";
import type {
  AdminCategoryDeleteData,
  AdminCategoryDetail,
  AdminCategoryNode,
  CategoryCreateBody,
  CategoryUpdateBody,
} from "@/lib/types/api-contract";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
  TypingConfirm,
  TONE_CLASS,
} from "./ui-bits";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** Flat taxonomy row the tree builder consumes — the contract GET
 *  /api/admin/categories returns nested AdminCategoryNode trees, so
 *  `parentId` stays optional (tree nodes do not carry it). */
type CatRow = AdminCategoryNode & { parentId?: string | null };

type CatNode = CatRow & { children: CatNode[]; depth: number };

function buildTree(rows: CatRow[]): CatNode[] {
  const byParent = new Map<string | null, CatRow[]>();
  for (const r of rows) {
    const key = r.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(r);
    byParent.set(key, list);
  }
  const sortFn = (a: CatRow, b: CatRow) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name);
  const attach = (parent: string | null, depth: number): CatNode[] =>
    (byParent.get(parent) ?? []).sort(sortFn).map((r) => ({ ...r, depth, children: attach(r.id, depth + 1) }));
  return attach(null, 0);
}

function flatten(nodes: CatNode[]): CatNode[] {
  const out: CatNode[] = [];
  const walk = (list: CatNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function CategoriesView() {
  const { data, error, loading, refetch } = useApi<AdminCategoryNode[]>("/api/admin/categories");
  const rows = data ?? [];
  const nodes = useMemo(() => buildTree(rows), [rows]);
  const flat = useMemo(() => flatten(nodes), [nodes]);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("root");
  const [creating, setCreating] = useState(false);

  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<CatRow | null>(null);
  const [busy, setBusy] = useState(false);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = async () => {
    setCreating(true);
    try {
      await apiSend<AdminCategoryDetail>("/api/admin/categories", "POST", {
        name: newName.trim(),
        parentId: newParent === "root" ? undefined : newParent,
      } satisfies CategoryCreateBody);
      toast.success("Category created", { description: newName.trim() });
      setCreateOpen(false);
      setNewName("");
      setNewParent("root");
      void refetch();
    } catch (e) {
      toast.error("Create failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  };

  const saveCommission = async (cat: CatRow, value: string) => {
    const percent = value.trim() === "" ? null : Number(value);
    if (percent !== null && (Number.isNaN(percent) || percent < 0 || percent > 100)) {
      toast.error("Percent must be between 0 and 100");
      return;
    }
    if ((cat.commissionPercent ?? null) === percent) return;
    try {
      await apiSend<AdminCategoryDetail>(`/api/admin/categories/${cat.id}`, "PATCH", { commissionPercent: percent } satisfies CategoryUpdateBody);
      toast.success(percent === null ? "Commission reset to inherit" : `Commission set to ${percent}%`);
      void refetch();
    } catch (e) {
      toast.error("Update failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await apiSend<AdminCategoryDeleteData>(`/api/admin/categories/${deleting.id}`, "DELETE");
      toast.success("Category deleted", { description: "Products under it were unlinked." });
      setDeleting(null);
      void refetch();
    } catch (e) {
      toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const visible = flat.filter((n) => {
    // hide children of collapsed ancestors
    let p = n.parentId;
    while (p) {
      if (collapsed.has(p)) return false;
      p = flat.find((f) => f.id === p)?.parentId ?? null;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Categories"
        description="Catalog taxonomy with per-category commission rates (nearest ancestor wins in M09)."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New category
          </Button>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <TableSkeleton rows={6} cols={4} />
          ) : rows.length === 0 ? (
            <EmptyState title="No categories yet" hint="Create top-level categories, then nest children." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="hidden w-40 md:table-cell">Slug</TableHead>
                    <TableHead className="w-44">Commission %</TableHead>
                    <TableHead className="w-10 text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((n) => {
                    const hasKids = n.children.length > 0;
                    const isCollapsed = collapsed.has(n.id);
                    return (
                      <TableRow key={n.id}>
                        <TableCell>
                          <div className="flex items-center gap-1.5" style={{ paddingLeft: n.depth * 20 }}>
                            {hasKids ? (
                              <button
                                onClick={() => toggleCollapse(n.id)}
                                aria-label={isCollapsed ? `Expand ${n.name}` : `Collapse ${n.name}`}
                                className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
                              >
                                {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                              </button>
                            ) : (
                              <span className="inline-block h-6 w-6" />
                            )}
                            <span className="font-medium">{n.name}</span>
                            {n.depth > 0 ? (
                              <Badge variant="outline" className="ml-1 text-[10px] text-muted-foreground">
                                child
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{n.slug}</TableCell>
                        <TableCell>
                          {editing?.id === n.id ? (
                            <Input
                              autoFocus
                              inputMode="decimal"
                              value={editing.value}
                              onChange={(e) => setEditing({ id: n.id, value: e.target.value })}
                              onBlur={() => {
                                void saveCommission(n, editing.value);
                                setEditing(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") setEditing(null);
                              }}
                              className="h-9 w-28"
                              aria-label={`Commission percent for ${n.name}`}
                            />
                          ) : (
                            <button
                              onClick={() => setEditing({ id: n.id, value: n.commissionPercent != null ? String(n.commissionPercent) : "" })}
                              className="group inline-flex min-h-[36px] items-center gap-1.5 rounded px-1.5 text-sm hover:bg-muted"
                              aria-label={`Edit commission for ${n.name}`}
                            >
                              {n.commissionPercent != null ? (
                                <Badge variant="outline" className={cn(TONE_CLASS.teal, "tabular-nums")}>{n.commissionPercent}%</Badge>
                              ) : (
                                <span className="text-muted-foreground">inherit</span>
                              )}
                              <RotateCcw className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-0" />
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                            onClick={() => setDeleting(n)}
                            aria-label={`Delete ${n.name}`}
                          >
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New category</DialogTitle>
            <DialogDescription>Top-level categories group the marketplace; children refine commission resolution.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cat-name">Name</Label>
              <Input id="cat-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Home & Living" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label>Parent</Label>
              <Select value={newParent} onValueChange={setNewParent}>
                <SelectTrigger className="min-h-[44px]" aria-label="Parent category"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="root">— top level —</SelectItem>
                  {flat.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {"\u00A0".repeat(c.depth * 2)}
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} className="min-h-[44px] sm:min-h-0">Cancel</Button>
            <Button onClick={() => void create()} disabled={creating || !newName.trim()} className="min-h-[44px] sm:min-h-0">
              {creating ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmTypingDelete
        target={deleting}
        busy={busy}
        onOpenChange={(o) => !o && setDeleting(null)}
        onConfirm={() => void doDelete()}
      />
    </div>
  );
}

function ConfirmTypingDelete({
  target,
  busy,
  onOpenChange,
  onConfirm,
}: {
  target: CatRow | null;
  busy: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: () => void;
}) {
  if (!target) return null;
  return (
    <TypingConfirm
      open={target !== null}
      onOpenChange={onOpenChange}
      title={`Delete “${target.name}”?`}
      description="Products in this category will be unlinked. Child categories are re-parented to its parent."
      expected={target.id}
      confirmLabel="Delete category"
      loading={busy}
      onConfirm={onConfirm}
    />
  );
}

"use client";
// FIN-02 Commission Overrides + FIN-03 Fee Holidays.
import { useMemo, useState } from "react";
import { CalendarClock, Package, Plus, Store as StoreIcon, Tags } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMinor, toMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { apiSend, useApi } from "./use-api";
import { EmptyState, ErrorState, Money, PageHeader, TableSkeleton, TONE_CLASS, TypingConfirm, fmtDate } from "./ui-bits";
import type {
  AdminCategoryNode,
  AdminProductsData,
  AdminSellersData,
  HolidayCreateBody,
  HolidayCreateData,
  HolidayDeleteData,
  HolidayPatchBody,
  HolidayPatchData,
  HolidaysData,
  OverrideCreateBody,
  OverrideCreateData,
  OverrideDeleteData,
  OverridePatchBody,
  OverridePatchData,
  OverridesData,
} from "@/lib/types/api-contract";

/* ------------------------------------------------------------------ shared */

function useTargetMaps() {
  const cats = useApi<AdminCategoryNode[]>("/api/admin/categories");
  const sellers = useApi<AdminSellersData[]>("/api/admin/sellers?size=100");
  const products = useApi<AdminProductsData[]>("/api/admin/products?status=all&size=100");
  return {
    catName: (id: string) => cats.data?.find((c) => c.id === id)?.name,
    sellerName: (id: string) => sellers.data?.find((s) => s.id === id)?.displayName,
    productName: (id: string) => products.data?.find((p) => p.id === id)?.title,
    ready: !cats.loading && !sellers.loading && !products.loading,
  };
}

/* ---------------------------------------------------------------- FIN-02 */

const SCOPE_ICON = { category: Tags, seller: StoreIcon, product: Package };

export function OverridesView() {
  const { data, error, loading, refetch } = useApi<OverridesData[]>("/api/admin/commission/overrides");
  const maps = useTargetMaps();
  const rows = data ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<OverridesData | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async (o: OverridesData) => {
    try {
      const body: OverridePatchBody = { isActive: !o.isActive };
      await apiSend<OverridePatchData>(`/api/admin/commission/overrides/${o.id}`, "PATCH", body);
      toast.success(o.isActive ? "Override disabled" : "Override enabled");
      void refetch();
    } catch (e) {
      toast.error("Toggle failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const targetLabel = (o: OverridesData): string => {
    if (o.scope === "category") return maps.catName(o.categoryId ?? "") ?? o.categoryId ?? "—";
    if (o.scope === "seller") return maps.sellerName(o.sellerId ?? "") ?? o.sellerId ?? "—";
    return maps.productName(o.productId ?? "") ?? o.productId ?? "—";
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Commission Overrides"
        description="Per category, seller or product rates that outrank the global default (below fee holidays)."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New override
          </Button>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={5} cols={6} />
            ) : rows.length === 0 ? (
              <EmptyState title="No overrides" hint="Create scoped commission overrides for specific categories, sellers or products." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scope</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead className="text-right">Percent</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Fixed fee</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Hold days</TableHead>
                    <TableHead className="hidden lg:table-cell">Valid window</TableHead>
                    <TableHead className="text-right">Active</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((o) => {
                    const Icon = SCOPE_ICON[o.scope as keyof typeof SCOPE_ICON] ?? Tags;
                    return (
                      <TableRow key={o.id}>
                        <TableCell>
                          <Badge variant="outline" className={cn("capitalize", TONE_CLASS.teal)}>
                            <Icon className="h-3 w-3" /> {o.scope}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate font-medium">{targetLabel(o)}</TableCell>
                        <TableCell className="text-right">{o.percent != null ? <Badge variant="outline" className="tabular-nums">{o.percent}%</Badge> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="hidden text-right sm:table-cell">{o.fixedFeeMinor != null ? <Money minor={o.fixedFeeMinor} /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="hidden text-right tabular-nums sm:table-cell">{o.holdDays ?? "—"}</TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                          {o.validFrom || o.validTo ? `${o.validFrom ? fmtDate(o.validFrom) : "…"} → ${o.validTo ? fmtDate(o.validTo) : "…"}` : "always"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch checked={o.isActive} onCheckedChange={() => void toggle(o)} aria-label="Toggle override" />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                            onClick={() => setDeleting(o)}
                            aria-label="Delete override"
                          >
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <OverrideCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          void refetch();
        }}
      />

      <TypingConfirm
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete override?"
        description="The affected scope falls back to the next rule in the M09 chain."
        expected={deleting?.id ?? ""}
        confirmLabel="Delete override"
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await apiSend<OverrideDeleteData>(`/api/admin/commission/overrides/${deleting.id}`, "DELETE");
            toast.success("Override deleted");
            setDeleting(null);
            void refetch();
          } catch (e) {
            toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
          } finally {
            setBusy(false);
          }
        }}
        loading={busy}
      />
    </div>
  );
}

function OverrideCreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const cats = useApi<AdminCategoryNode[]>("/api/admin/categories");
  const sellers = useApi<AdminSellersData[]>("/api/admin/sellers?size=100");
  const products = useApi<AdminProductsData[]>("/api/admin/products?status=all&size=100");

  const [scope, setScope] = useState<"category" | "seller" | "product">("category");
  const [targetId, setTargetId] = useState("");
  const [percent, setPercent] = useState("");
  const [fixedFee, setFixedFee] = useState("");
  const [holdDays, setHoldDays] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [saving, setSaving] = useState(false);

  const targetOptions =
    scope === "category"
      ? (cats.data ?? []).map((c) => ({ id: c.id, label: c.name }))
      : scope === "seller"
        ? (sellers.data ?? []).map((s) => ({ id: s.id, label: s.displayName }))
        : (products.data ?? []).map((p) => ({ id: p.id, label: p.title }));

  const submit = async () => {
    setSaving(true);
    try {
      const body: OverrideCreateBody = { scope };
      if (scope === "category") body.categoryId = targetId;
      if (scope === "seller") body.sellerId = targetId;
      if (scope === "product") body.productId = targetId;
      if (percent !== "") body.percent = Number(percent);
      if (fixedFee !== "") body.fixedFeeMinor = toMinor(fixedFee);
      if (holdDays !== "") body.holdDays = Number(holdDays);
      if (validFrom) body.validFrom = new Date(validFrom).toISOString();
      if (validTo) body.validTo = new Date(validTo).toISOString();
      await apiSend<OverrideCreateData>("/api/admin/commission/overrides", "POST", body);
      toast.success("Override created");
      setTargetId("");
      setPercent("");
      setFixedFee("");
      setHoldDays("");
      setValidFrom("");
      setValidTo("");
      onCreated();
    } catch (e) {
      toast.error("Create failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New commission override</DialogTitle>
          <DialogDescription>Leave a field blank to inherit that part from the chain below this override.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Scope</Label>
              <Select
                value={scope}
                onValueChange={(v) => {
                  setScope(v as typeof scope);
                  setTargetId("");
                }}
              >
                <SelectTrigger className="min-h-[44px]" aria-label="Scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="seller">Seller</SelectItem>
                  <SelectItem value="product">Product</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Target</Label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger className="min-h-[44px]" aria-label="Target"><SelectValue placeholder="Pick…" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {targetOptions.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <span className="max-w-[220px] truncate">{t.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Percent</Label>
              <Input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="—" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Fixed (RM)</Label>
              <Input inputMode="decimal" value={fixedFee} onChange={(e) => setFixedFee(e.target.value)} placeholder="—" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Hold days</Label>
              <Input inputMode="numeric" value={holdDays} onChange={(e) => setHoldDays(e.target.value)} placeholder="—" className="min-h-[44px]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Valid from</Label>
              <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Valid to</Label>
              <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} className="min-h-[44px]" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving} className="min-h-[44px] sm:min-h-0">Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || !targetId} className="min-h-[44px] sm:min-h-0">
            {saving ? "Creating…" : "Create override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- FIN-03 */

export function FeeHolidaysView() {
  const { data, error, loading, refetch } = useApi<HolidaysData[]>("/api/admin/commission/holidays");
  const maps = useTargetMaps();
  const rows = data ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<HolidaysData | null>(null);
  const [busy, setBusy] = useState(false);

  const scopeLabel = (h: HolidaysData): string => {
    if (h.scope === "all") return "everything";
    const ids = parseIds(h.scopeIds);
    if (ids.length === 0) return h.scope;
    const names = ids
      .map((id) => (h.scope === "sellers" ? maps.sellerName(id) : maps.catName(id)))
      .filter(Boolean) as string[];
    return names.length > 0 ? names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "") : `${ids.length} target${ids.length === 1 ? "" : "s"}`;
  };

  const toggle = async (h: HolidaysData) => {
    try {
      const body: HolidayPatchBody = { isActive: !h.isActive };
      await apiSend<HolidayPatchData>(`/api/admin/commission/holidays/${h.id}`, "PATCH", body);
      toast.success(h.isActive ? "Holiday disabled" : "Holiday enabled");
      void refetch();
    } catch (e) {
      toast.error("Toggle failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Fee Holidays"
        description="Zero-commission windows — the highest priority rule in the M09 engine."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={() => setCreateOpen(true)}>
            <CalendarClock className="h-4 w-4" /> New holiday
          </Button>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={4} cols={6} />
            ) : rows.length === 0 ? (
              <EmptyState title="No fee holidays" hint="Campaign windows with 0% commission appear here." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead className="hidden sm:table-cell">Window</TableHead>
                    <TableHead className="text-right">Percent</TableHead>
                    <TableHead className="text-right">Active</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((h) => (
                    <TableRow key={h.id} className={cn(h.isActive && "bg-emerald-50/50 dark:bg-emerald-950/20")}>
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          {h.name}
                          {h.isActive ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-label="active" /> : null}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        <Badge variant="outline" className="capitalize">{h.scope}</Badge>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{scopeLabel(h)}</p>
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                        {fmtDate(h.startsAt)} → {fmtDate(h.endsAt)}
                      </TableCell>
                      <TableCell className="text-right"><Badge variant="outline" className="tabular-nums">{h.percent}%</Badge></TableCell>
                      <TableCell className="text-right">
                        <Switch checked={h.isActive} onCheckedChange={() => void toggle(h)} aria-label="Toggle holiday" />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                          onClick={() => setDeleting(h)}
                          aria-label="Delete holiday"
                        >
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <HolidayCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          void refetch();
        }}
      />

      <TypingConfirm
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description="Commission returns to the normal chain for the affected scope."
        expected={deleting?.id ?? ""}
        confirmLabel="Delete holiday"
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await apiSend<HolidayDeleteData>(`/api/admin/commission/holidays/${deleting.id}`, "DELETE");
            toast.success("Fee holiday deleted");
            setDeleting(null);
            void refetch();
          } catch (e) {
            toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
          } finally {
            setBusy(false);
          }
        }}
        loading={busy}
      />
    </div>
  );
}

function parseIds(json: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function HolidayCreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const cats = useApi<AdminCategoryNode[]>("/api/admin/categories");
  const sellers = useApi<AdminSellersData[]>("/api/admin/sellers?size=100");

  const [name, setName] = useState("");
  const [scope, setScope] = useState<"all" | "sellers" | "categories">("all");
  const [targets, setTargets] = useState<string[]>([]);
  const [percent, setPercent] = useState("0");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [saving, setSaving] = useState(false);

  const options =
    scope === "sellers"
      ? (sellers.data ?? []).map((s) => ({ id: s.id, label: s.displayName }))
      : (cats.data ?? []).map((c) => ({ id: c.id, label: c.name }));

  const submit = async () => {
    setSaving(true);
    try {
      const body: HolidayCreateBody = {
        name: name.trim(),
        scope,
        scopeIds: scope === "all" ? [] : targets,
        percent: Number(percent || "0"),
        startsAt: startsAt ? new Date(startsAt).toISOString() : new Date().toISOString(),
        endsAt: endsAt ? new Date(endsAt).toISOString() : new Date(Date.now() + 7 * 86400000).toISOString(),
      };
      await apiSend<HolidayCreateData>("/api/admin/commission/holidays", "POST", body);
      toast.success("Fee holiday created");
      setName("");
      setScope("all");
      setTargets([]);
      setPercent("0");
      setStartsAt("");
      setEndsAt("");
      onCreated();
    } catch (e) {
      toast.error("Create failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New fee holiday</DialogTitle>
          <DialogDescription>Active windows force 0% commission — useful for campaigns.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Raya campaign" className="min-h-[44px]" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Scope</Label>
              <Select
                value={scope}
                onValueChange={(v) => {
                  setScope(v as typeof scope);
                  setTargets([]);
                }}
              >
                <SelectTrigger className="min-h-[44px]" aria-label="Scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everything</SelectItem>
                  <SelectItem value="sellers">Selected sellers</SelectItem>
                  <SelectItem value="categories">Selected categories</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Percent</Label>
              <Input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} className="min-h-[44px]" />
            </div>
          </div>
          {scope !== "all" ? (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Targets ({targets.length} selected)</Label>
              <ScrollArea className="h-44 rounded-lg border p-2">
                <div className="space-y-1.5 pr-2">
                  {options.map((o) => (
                    <label key={o.id} className="flex min-h-[36px] cursor-pointer items-center gap-2 rounded px-1.5 text-sm hover:bg-muted">
                      <Checkbox
                        checked={targets.includes(o.id)}
                        onCheckedChange={(v) => setTargets((prev) => (v ? [...prev, o.id] : prev.filter((x) => x !== o.id)))}
                        aria-label={o.label}
                      />
                      <span className="truncate">{o.label}</span>
                    </label>
                  ))}
                </div>
              </ScrollArea>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Starts</Label>
              <Input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Ends</Label>
              <Input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="min-h-[44px]" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving} className="min-h-[44px] sm:min-h-0">Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || !name.trim()} className="min-h-[44px] sm:min-h-0">
            {saving ? "Creating…" : "Create holiday"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

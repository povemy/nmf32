"use client";
// MKT-01 Banners · MKT-02 Featured slots · MKT-03 Platform coupons · MKT-04
// Campaigns (Task 10-e: festive campaign presets + publish + theme editor).
import { useMemo, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { ImagePlus, Megaphone, Plus, Search, Star, Ticket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";
import { formatMinor, toMinor } from "@/lib/money";
import { apiSend, useApi, useDebounced } from "./use-api";
import { qs } from "./nav";
import type {
  AdminBannerDeleteData,
  AdminBannerRow,
  AdminCouponDeleteData,
  AdminCouponDetail,
  AdminCouponRow,
  AdminFeaturedDeleteData,
  AdminFeaturedRow,
  AdminProductsData,
  BannerCreateBody,
  BannerUpdateBody,
  CouponCreateBody,
  CouponUpdateBody,
  FeaturedCreateBody,
  FeaturedCreateData,
} from "@/lib/types/api-contract";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Pager,
  StatusChip,
  TableSkeleton,
  fmtDT,
} from "./ui-bits";

/* ------------------------------------------------------------- BannersView */

/** MKT-01 banner row — aliases the contract AdminBannerRow. */
type BannerRow = AdminBannerRow;

function randomBannerSeed(): string {
  return `banner-${Math.random().toString(36).slice(2, 8)}`;
}

export function BannersView() {
  const { data, error, loading, refetch } = useApi<BannerRow[]>("/api/admin/banners");
  const rows = data ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [imageUrl, setImageUrl] = useState(`/api/img/${randomBannerSeed()}?w=1400&h=400`);
  const [linkUrl, setLinkUrl] = useState("/market");
  const [sortOrder, setSortOrder] = useState("0");
  const [creating, setCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<BannerRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const regenerate = () => setImageUrl(`/api/img/${randomBannerSeed()}?w=1400&h=400`);

  const create = async () => {
    setCreating(true);
    try {
      await apiSend<AdminBannerRow>("/api/admin/banners", "POST", {
        title: title.trim(),
        imageUrl: imageUrl.trim() || undefined,
        linkUrl: linkUrl.trim() || undefined,
        sortOrder: Number(sortOrder) || 0,
        isActive: true,
      } satisfies BannerCreateBody);
      toast.success("Banner created", { description: title.trim() });
      setCreateOpen(false);
      setTitle("");
      setLinkUrl("/market");
      setSortOrder("0");
      regenerate();
      void refetch();
    } catch (e) {
      toast.error("Create failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (b: BannerRow) => {
    setBusyId(b.id);
    try {
      await apiSend<AdminBannerRow>(`/api/admin/banners/${b.id}`, "PATCH", { isActive: !b.isActive } satisfies BannerUpdateBody);
      toast.success(`Banner ${b.isActive ? "hidden" : "activated"}`, { description: b.title });
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
      await apiSend<AdminBannerDeleteData>(`/api/admin/banners/${deleteTarget.id}`, "DELETE");
      toast.success("Banner deleted", { description: deleteTarget.title });
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
        title="Banners"
        description="Marketplace hero banners shown on the market home."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New banner
          </Button>
        }
      />

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Banners ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <TableSkeleton rows={3} cols={5} />
          ) : rows.length === 0 ? (
            <EmptyState title="No banners yet" hint="Create the first marketplace banner." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Preview</TableHead>
                  <TableHead>Banner</TableHead>
                  <TableHead className="hidden md:table-cell">Link</TableHead>
                  <TableHead className="hidden text-center sm:table-cell">Order</TableHead>
                  <TableHead className="hidden lg:table-cell">Created</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <div className="relative h-10 w-24 overflow-hidden rounded-md border bg-muted">
                        <Image src={b.imageUrl} alt={b.title} fill unoptimized sizes="96px" className="object-cover" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <p className="max-w-[280px] truncate font-medium">{b.title}</p>
                      <p className="max-w-[280px] truncate font-mono text-[11px] text-muted-foreground">{b.imageUrl}</p>
                    </TableCell>
                    <TableCell className="hidden max-w-[160px] truncate text-sm text-muted-foreground md:table-cell">
                      {b.linkUrl ?? "—"}
                    </TableCell>
                    <TableCell className="hidden text-center tabular-nums sm:table-cell">{b.sortOrder}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{fmtDT(b.createdAt)}</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={b.isActive}
                        disabled={busyId === b.id}
                        onCheckedChange={() => void toggle(b)}
                        aria-label={`Toggle banner ${b.title}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                        onClick={() => setDeleteTarget(b)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New banner</DialogTitle>
            <DialogDescription>Served from the built-in placeholder image service — no uploads needed for the demo.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="banner-title">Title</Label>
              <Input id="banner-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Raya Mega Sale" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="banner-img" className="flex items-center gap-1.5">
                <ImagePlus className="h-3.5 w-3.5" /> Image URL
              </Label>
              <div className="flex gap-2">
                <Input id="banner-img" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="min-h-[44px] flex-1 font-mono text-xs" />
                <Button type="button" variant="outline" className="min-h-[44px]" onClick={regenerate}>
                  Shuffle
                </Button>
              </div>
              <div className="relative mt-1 h-24 w-full overflow-hidden rounded-lg border bg-muted">
                <Image src={imageUrl} alt="Banner preview" fill unoptimized sizes="480px" className="object-cover" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="banner-link">Link URL</Label>
                <Input id="banner-link" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="/market" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="banner-order">Sort order</Label>
                <Input id="banner-order" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="min-h-[44px]" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating} className="min-h-[44px] sm:min-h-0">Cancel</Button>
            <Button onClick={() => void create()} disabled={creating || !title.trim()} className="min-h-[44px] sm:min-h-0">
              {creating ? "Creating…" : "Create banner"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete banner?"
        description={deleteTarget ? `“${deleteTarget.title}” will be removed from the marketplace.` : ""}
        confirmLabel="Delete"
        destructive
        loading={busyId !== null}
        onConfirm={() => void doDelete()}
      />
    </div>
  );
}

/* ------------------------------------------------------------ FeaturedView */

/** MKT-02 featured slot row — aliases the contract AdminFeaturedRow. */
type FeaturedRow = AdminFeaturedRow;

/** Product picker row — the contract list element (AdminProductsData) plus
 *  the legacy `storeName`/`imageUrl` fallbacks the picker reads. */
type ProductOption = AdminProductsData & {
  storeName?: string | null;
  imageUrl?: string | null;
};

export function FeaturedView() {
  const { data, error, loading, refetch } = useApi<FeaturedRow[]>("/api/admin/featured");
  const rows = data ?? [];
  const featuredIds = useMemo(() => new Set(rows.map((r) => r.product?.id).filter(Boolean) as string[]), [rows]);

  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput.trim(), 350);
  const productsUrl = search ? `/api/admin/products${qs({ status: "active", search, size: 10 })}` : null;
  const products = useApi<ProductOption[]>(productsUrl);

  const [addingId, setAddingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FeaturedRow | null>(null);

  const add = async (p: ProductOption) => {
    setAddingId(p.id);
    try {
      await apiSend<FeaturedCreateData>("/api/admin/featured", "POST", { productId: p.id, slot: "home_grid" } satisfies FeaturedCreateBody);
      toast.success("Added to featured", { description: p.title });
      void refetch();
    } catch (e) {
      toast.error("Could not feature product", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAddingId(null);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await apiSend<AdminFeaturedDeleteData>(`/api/admin/featured/${deleteTarget.id}`, "DELETE");
      toast.success("Removed from featured", { description: deleteTarget.product?.title ?? "" });
      setDeleteTarget(null);
      void refetch();
    } catch (e) {
      toast.error("Remove failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Featured"
        description="Curated products shown in the marketplace home grid."
      />

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Star className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Featured products ({rows.length})
          </CardTitle>
          <CardDescription>Ordered by slot position — removal unsets isFeatured on the product.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <TableSkeleton rows={4} cols={5} />
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing featured" hint="Search and add products below." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">Thumb</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="hidden md:table-cell">Store</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="hidden sm:table-cell">Slot</TableHead>
                  <TableHead className="hidden lg:table-cell">Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>
                      <div className="relative h-10 w-10 overflow-hidden rounded-md border bg-muted">
                        {f.product?.imageUrl ? (
                          <Image src={f.product.imageUrl} alt={f.product.title} fill unoptimized sizes="40px" className="object-cover" />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate font-medium">{f.product?.title ?? "(deleted product)"}</TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{f.product?.storeName ?? "—"}</TableCell>
                    <TableCell className="text-right"><Money minor={f.product?.priceMinor ?? 0} /></TableCell>
                    <TableCell className="hidden text-sm sm:table-cell">
                      <Badge variant="outline">{f.slot}</Badge> <span className="text-xs text-muted-foreground">#{f.sortOrder}</span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell"><StatusChip status={f.product?.status ?? "unknown"} /></TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                        onClick={() => setDeleteTarget(f)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="text-base">Add a product</CardTitle>
          <CardDescription>Search active products across the marketplace, then feature them.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search products by title or slug…"
              className="min-h-[44px] pl-9"
              aria-label="Search products to feature"
            />
          </div>
          <div className="mt-3 max-h-[300px] space-y-2 overflow-y-auto [scrollbar-width:thin]">
            {!search ? (
              <p className="py-4 text-center text-xs text-muted-foreground">Type at least a few characters to search.</p>
            ) : products.loading ? (
              Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />)
            ) : (products.data ?? []).length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No active products match “{search}”.</p>
            ) : (
              (products.data ?? []).map((p) => {
                const featured = featuredIds.has(p.id);
                return (
                  <div key={p.id} className="flex items-center gap-3 rounded-lg border p-2.5">
                    <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md border bg-muted">
                      {p.images?.[0]?.url || p.imageUrl ? (
                        <Image src={(p.images?.[0]?.url ?? p.imageUrl) as string} alt={p.title} fill unoptimized sizes="44px" className="object-cover" />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{p.store?.name ?? p.storeName ?? "—"} · <Money minor={p.priceMinor} muted /></p>
                    </div>
                    <Button
                      size="sm"
                      variant={featured ? "outline" : "default"}
                      className="min-h-[36px] w-20 sm:min-h-0"
                      disabled={featured || addingId !== null}
                      onClick={() => void add(p)}
                    >
                      {featured ? "Featured" : addingId === p.id ? "Adding…" : "Add"}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Remove from featured?"
        description={deleteTarget?.product ? `“${deleteTarget.product.title}” will leave the marketplace home grid.` : ""}
        confirmLabel="Remove"
        destructive
        loading={busyId !== null}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/* ------------------------------------------------------------- CouponsView */

/** MKT-03 coupon row — aliases the contract AdminCouponRow. */
type CouponRow = AdminCouponRow;

function couponValue(c: CouponRow): string {
  if (c.type === "percent") return `${c.percent ?? 0}% off`;
  if (c.type === "fixed") return formatMinor(c.amountMinor ?? 0) + " off";
  return "Free shipping";
}

export function CouponsView() {
  const { data, error, loading, refetch } = useApi<CouponRow[]>("/api/admin/coupons?size=50");
  const rows = data ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"percent" | "fixed" | "freeship">("percent");
  const [percent, setPercent] = useState("10");
  const [amount, setAmount] = useState("10.00");
  const [minSpend, setMinSpend] = useState("0");
  const [perCustomerLimit, setPerCustomerLimit] = useState("1");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CouponRow | null>(null);

  const resetForm = () => {
    setCode("");
    setDescription("");
    setType("percent");
    setPercent("10");
    setAmount("10.00");
    setMinSpend("0");
    setPerCustomerLimit("1");
    setStartsAt("");
    setEndsAt("");
  };

  const create = async () => {
    setCreating(true);
    try {
      const body: CouponCreateBody = {
        code: code.trim().toUpperCase(),
        description: description.trim() || undefined,
        type,
        minSpendMinor: toMinor(minSpend || "0"),
        perCustomerLimit: Math.max(1, Number(perCustomerLimit) || 1),
      };
      if (type === "percent") body.percent = Number(percent);
      if (type === "fixed") body.amountMinor = toMinor(amount || "0");
      if (startsAt) body.startsAt = new Date(startsAt).toISOString();
      if (endsAt) body.endsAt = new Date(`${endsAt}T23:59:59`).toISOString();
      await apiSend<AdminCouponDetail>("/api/admin/coupons", "POST", body);
      toast.success("Coupon created", { description: body.code as string });
      setCreateOpen(false);
      resetForm();
      void refetch();
    } catch (e) {
      toast.error("Create failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (c: CouponRow) => {
    setBusyId(c.id);
    try {
      await apiSend<AdminCouponDetail>(`/api/admin/coupons/${c.id}`, "PATCH", { isActive: !c.isActive } satisfies CouponUpdateBody);
      toast.success(`Coupon ${c.isActive ? "disabled" : "enabled"}`, { description: c.code });
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
      await apiSend<AdminCouponDeleteData>(`/api/admin/coupons/${deleteTarget.id}`, "DELETE");
      toast.success("Coupon deleted", { description: deleteTarget.code });
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
        title="Coupons"
        description="Platform-wide promo codes — store-scoped coupons are managed in the seller portal."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={() => setCreateOpen(true)}>
            <Ticket className="h-4 w-4" /> New coupon
          </Button>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={4} cols={7} />
            ) : rows.length === 0 ? (
              <EmptyState title="No coupons" hint="Create a platform coupon to attract first orders." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead className="hidden md:table-cell">Scope</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Min spend</TableHead>
                    <TableHead className="hidden text-center lg:table-cell">Used</TableHead>
                    <TableHead className="hidden xl:table-cell">Window</TableHead>
                    <TableHead className="text-center">Active</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <p className="font-mono text-sm font-semibold">{c.code}</p>
                        <p className="max-w-[200px] truncate text-xs text-muted-foreground">{c.description ?? "—"}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">{c.type}</Badge>
                        <p className="mt-1 text-sm">{couponValue(c)}</p>
                      </TableCell>
                      <TableCell className="hidden text-sm md:table-cell">
                        {c.scope === "store" ? c.store?.name ?? "store" : <Badge variant="outline">platform</Badge>}
                      </TableCell>
                      <TableCell className="hidden text-right sm:table-cell"><Money minor={c.minSpendMinor ?? 0} muted /></TableCell>
                      <TableCell className="hidden text-center tabular-nums lg:table-cell">{c.timesUsed ?? 0}</TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                        {c.startsAt || c.endsAt ? `${c.startsAt ? fmtDT(c.startsAt) : "∞"} → ${c.endsAt ? fmtDT(c.endsAt) : "∞"}` : "always"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch checked={c.isActive} disabled={busyId === c.id} onCheckedChange={() => void toggle(c)} aria-label={`Toggle coupon ${c.code}`} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                          onClick={() => setDeleteTarget(c)}
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg [scrollbar-width:thin]">
          <DialogHeader>
            <DialogTitle>New platform coupon</DialogTitle>
            <DialogDescription>Applies at checkout across all storefronts (unless a store scope is chosen server-side).</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="coupon-code">Code</Label>
                <Input
                  id="coupon-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="RAYA25"
                  className="min-h-[44px] font-mono uppercase"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
                  <SelectTrigger className="min-h-[44px]" aria-label="Coupon type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percent">Percent off</SelectItem>
                    <SelectItem value="fixed">Fixed amount off</SelectItem>
                    <SelectItem value="freeship">Free shipping</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="coupon-desc">Description</Label>
              <Input id="coupon-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shown at checkout" className="min-h-[44px]" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {type === "percent" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="coupon-percent">Percent (%)</Label>
                  <Input id="coupon-percent" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} className="min-h-[44px]" />
                </div>
              ) : null}
              {type === "fixed" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="coupon-amount">Amount (RM)</Label>
                  <Input id="coupon-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="min-h-[44px]" />
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="coupon-min">Min spend (RM)</Label>
                <Input id="coupon-min" inputMode="decimal" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="coupon-limit">Per-customer limit</Label>
                <Input id="coupon-limit" inputMode="numeric" value={perCustomerLimit} onChange={(e) => setPerCustomerLimit(e.target.value)} className="min-h-[44px]" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="coupon-start">Starts at (optional)</Label>
                <Input id="coupon-start" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="coupon-end">Ends at (optional)</Label>
                <Input id="coupon-end" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="min-h-[44px]" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating} className="min-h-[44px] sm:min-h-0">Cancel</Button>
            <Button
              onClick={() => void create()}
              disabled={
                creating ||
                !code.trim() ||
                (type === "percent" && !(Number(percent) >= 0)) ||
                (type === "fixed" && !(Number(amount) >= 0))
              }
              className="min-h-[44px] sm:min-h-0"
            >
              {creating ? "Creating…" : "Create coupon"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete coupon?"
        description={deleteTarget ? `Code ${deleteTarget.code} will stop working immediately.` : ""}
        confirmLabel="Delete"
        destructive
        loading={busyId !== null}
        onConfirm={() => void doDelete()}
      />
    </div>
  );
}


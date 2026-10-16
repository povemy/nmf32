"use client";
// MKT-01 Banners · MKT-02 Featured slots · MKT-03 Platform coupons · MKT-04
// Campaigns (Task 10-e: festive campaign presets + publish + theme editor).
import { useMemo, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { CalendarClock, ImagePlus, Megaphone, PartyPopper, Plus, Search, Star, Ticket } from "lucide-react";
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
import {
  CAMPAIGN_PRESETS,
  findCampaignPreset,
  presetDateRange,
  type CampaignThemeT,
} from "@/lib/campaigns";
import { apiSend, useApi, useDebounced } from "./use-api";
import { qs } from "./nav";
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

type BannerRow = {
  id: string;
  title: string;
  imageUrl: string;
  linkUrl?: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt?: string;
};

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
      await apiSend("/api/admin/banners", "POST", {
        title: title.trim(),
        imageUrl: imageUrl.trim() || undefined,
        linkUrl: linkUrl.trim() || undefined,
        sortOrder: Number(sortOrder) || 0,
        isActive: true,
      });
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
      await apiSend(`/api/admin/banners/${b.id}`, "PATCH", { isActive: !b.isActive });
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
      await apiSend(`/api/admin/banners/${deleteTarget.id}`, "DELETE");
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

type FeaturedRow = {
  id: string;
  slot: string;
  sortOrder: number;
  isActive: boolean;
  createdAt?: string;
  product: {
    id: string;
    title: string;
    slug: string;
    priceMinor: number;
    status: string;
    imageUrl: string | null;
    storeName: string;
    storeSlug: string;
  } | null;
};

type ProductOption = {
  id: string;
  title: string;
  slug: string;
  priceMinor: number;
  status: string;
  store?: { name: string } | null;
  storeName?: string | null;
  images?: { url: string }[];
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
      await apiSend("/api/admin/featured", "POST", { productId: p.id, slot: "home_grid" });
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
      await apiSend(`/api/admin/featured/${deleteTarget.id}`, "DELETE");
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

type CouponRow = {
  id: string;
  scope: string;
  code: string;
  description?: string | null;
  type: "percent" | "fixed" | "freeship" | string;
  percent?: number | null;
  amountMinor?: number | null;
  minSpendMinor?: number;
  maxRedemptions?: number | null;
  perCustomerLimit?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive: boolean;
  timesUsed?: number;
  createdAt?: string;
  store?: { id: string; name: string } | null;
};

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
      const body: Record<string, unknown> = {
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
      await apiSend("/api/admin/coupons", "POST", body);
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
      await apiSend(`/api/admin/coupons/${c.id}`, "PATCH", { isActive: !c.isActive });
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
      await apiSend(`/api/admin/coupons/${deleteTarget.id}`, "DELETE");
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

/* ------------------------------------------------------------ CampaignsView */

type CampaignRow = {
  id: string;
  name: string;
  presetId: string | null;
  isPublished: boolean;
  startAt: string;
  endAt: string;
  theme: CampaignThemeT;
  status: "draft" | "scheduled" | "live" | "ended";
  daysUntilStart: number;
  daysLeft: number;
};

const CAMPAIGN_STATUS_CLASS: Record<CampaignRow["status"], string> = {
  draft: "border-muted-foreground/30 bg-muted text-muted-foreground",
  scheduled:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
  live: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
  ended: "border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400",
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

/** Date → value for <input type="datetime-local"> (browser-local time). */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local value → ISO string (undefined when blank/invalid). */
function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

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

export function CampaignsView() {
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput.trim(), 350);
  const SIZE = 10;

  const listUrl = `/api/admin/campaigns${qs({ page, size: SIZE, status: status === "all" ? "" : status, q })}`;
  const { data, meta, error, loading, refetch } = useApi<CampaignRow[]>(listUrl);
  const rows = data ?? [];
  const forbidden = error !== null && isCapabilityError(new Error(error));

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [theme, setTheme] = useState<CampaignThemeT>({ ...BLANK_THEME });
  const [publishNow, setPublishNow] = useState(false);
  const [creating, setCreating] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CampaignRow | null>(null);

  const resetForm = () => {
    setName("");
    setPresetId("");
    setStartAt("");
    setEndAt("");
    setTheme({ ...BLANK_THEME });
    setPublishNow(false);
  };

  // Pure + client-safe (RECOVERY.md Task 10-e): presetDateRange never touches
  // the db import, so auto-filling dates here needs no server round-trip.
  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = findCampaignPreset(id);
    if (!preset) return;
    const range = presetDateRange(preset);
    if (range) {
      setStartAt(toLocalInput(range.start));
      setEndAt(toLocalInput(range.end));
    }
    setTheme({ ...preset.theme });
  };

  const create = async () => {
    setCreating(true);
    try {
      await apiSend("/api/admin/campaigns", "POST", {
        name: name.trim(),
        presetId: presetId || undefined,
        startAt: fromLocalInput(startAt),
        endAt: fromLocalInput(endAt),
        theme,
        isPublished: publishNow,
      });
      toast.success("Campaign created", { description: publishNow ? `${name.trim()} is live` : `${name.trim()} saved as draft` });
      setCreateOpen(false);
      resetForm();
      void refetch();
    } catch (e) {
      if (isCapabilityError(e)) {
        toast.info("Ops/superadmin only", { description: "Creating campaigns needs the campaigns.manage permission." });
      } else {
        toast.error("Create failed", { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setCreating(false);
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="Campaigns"
        description="Festive marketplace campaigns — the published live one themes the shopper market home."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        }
      />

      <Card className="py-0">
        <CardHeader className="gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <PartyPopper className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Campaigns ({meta?.total ?? rows.length})
          </CardTitle>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1 sm:max-w-xs">
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
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="min-h-[44px] sm:w-44" aria-label="Filter campaigns by status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="live">Live</SelectItem>
                <SelectItem value="ended">Ended</SelectItem>
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
            <EmptyState title="No campaigns" hint="Create one from a festive preset — Raya, CNY, 11.11 and more." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead className="hidden md:table-cell">Window</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="hidden text-center sm:table-cell">Countdown</TableHead>
                  <TableHead className="text-center">Published</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
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
                          <p className="max-w-[240px] truncate font-medium">{c.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {findCampaignPreset(c.presetId)?.name ?? "Custom theme"} · {c.theme.greeting || "—"}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                      {fmtDT(c.startAt)} → {fmtDT(c.endAt)}
                    </TableCell>
                    <TableCell className="text-center">{campaignStatusChip(c.status)}</TableCell>
                    <TableCell className="hidden text-center sm:table-cell">{countdown(c)}</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={c.isPublished}
                        disabled={busyId === c.id}
                        onCheckedChange={() => void togglePublish(c)}
                        aria-label={`Toggle campaign ${c.name}`}
                      />
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl [scrollbar-width:thin]">
          <DialogHeader>
            <DialogTitle>New campaign</DialogTitle>
            <DialogDescription>
              Pick a preset to auto-fill the window and theme — everything stays editable.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-name">Name</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Raya Mega Sale 2027"
                className="min-h-[44px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaign-preset">Preset</Label>
              <Select value={presetId} onValueChange={(v) => applyPreset(v)}>
                <SelectTrigger id="campaign-preset" className="min-h-[44px]" aria-label="Campaign preset">
                  <SelectValue placeholder="Choose a festive preset…" />
                </SelectTrigger>
                <SelectContent>
                  {CAMPAIGN_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="campaign-start">Starts at</Label>
                <Input
                  id="campaign-start"
                  type="datetime-local"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                  className="min-h-[44px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-end">Ends at</Label>
                <Input
                  id="campaign-end"
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  className="min-h-[44px]"
                />
              </div>
            </div>

            {/* live preview strip */}
            <div
              className="relative overflow-hidden rounded-xl border p-4 text-white"
              style={{ background: `linear-gradient(135deg, ${theme.gradientFrom}, ${theme.gradientTo})` }}
              aria-label="Campaign theme preview"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-white/75">NOMOFEE campaign</p>
                  <p className="truncate text-lg font-extrabold leading-snug">{theme.greeting || "Greeting copy…"}</p>
                  <p className="truncate text-xs text-white/85">{theme.tagline || "Subheading copy…"}</p>
                </div>
                <span
                  className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold"
                  style={{ background: theme.accentSoft, color: theme.accent }}
                >
                  {theme.ornament || "✨"} Shop now
                </span>
              </div>
            </div>

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
                      value={theme[field] as string}
                      onChange={(e) => setTheme((t) => ({ ...t, [field]: e.target.value }))}
                      className="h-9 w-9 shrink-0 cursor-pointer rounded border bg-background p-0.5"
                      aria-label={`${label} colour`}
                    />
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{theme[field] as string}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="campaign-greeting">Heading (EN)</Label>
                <Input
                  id="campaign-greeting"
                  value={theme.greeting}
                  onChange={(e) => setTheme((t) => ({ ...t, greeting: e.target.value }))}
                  placeholder="Selamat Hari Raya"
                  className="min-h-[44px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-tagline">Subheading (EN)</Label>
                <Input
                  id="campaign-tagline"
                  value={theme.tagline}
                  onChange={(e) => setTheme((t) => ({ ...t, tagline: e.target.value }))}
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
                  value={theme.ornament}
                  onChange={(e) => setTheme((t) => ({ ...t, ornament: e.target.value }))}
                  placeholder="🌙"
                  className="min-h-[44px]"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="campaign-greeting-bm">Heading (BM)</Label>
                <Input
                  id="campaign-greeting-bm"
                  value={theme.greetingBm}
                  onChange={(e) => setTheme((t) => ({ ...t, greetingBm: e.target.value }))}
                  placeholder="Salam Aidilfitri"
                  className="min-h-[44px]"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaign-tagline-bm">Subheading (BM)</Label>
              <Input
                id="campaign-tagline-bm"
                value={theme.taglineBm}
                onChange={(e) => setTheme((t) => ({ ...t, taglineBm: e.target.value }))}
                placeholder="Tawaran istimewa"
                className="min-h-[44px]"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Publish immediately</p>
                <p className="text-xs text-muted-foreground">Live the moment the window starts (scheduled until then).</p>
              </div>
              <Switch checked={publishNow} onCheckedChange={setPublishNow} aria-label="Publish campaign immediately" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating} className="min-h-[44px] sm:min-h-0">
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={creating || !name.trim() || !startAt || !endAt}
              className="min-h-[44px] sm:min-h-0"
            >
              {creating ? "Creating…" : "Create campaign"}
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
            ? `“${deleteTarget.name}” will be removed and ${deleteTarget.status === "live" ? "the shopper theme reverts to the default look" : "won't go live"}.`
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

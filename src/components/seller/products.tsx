"use client";
// Task 2-d — SD-02/03 Products: catalog table + create/edit dialog with images,
// variants, category, moderation status. Archive = soft delete.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  apiGet,
  apiGetPaged,
  apiSend,
  EmptyState,
  MoneyInput,
  RowsSkeleton,
  runMutation,
  StatusChip,
  formatMinor,
  toMinor,
  type SellerNav,
} from "./ui-bits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Archive, ImageIcon, Loader2, Package, Plus, Search, Sparkles, Trash2 } from "lucide-react";

// ---------------------------------------------------------------- types

type Variant = {
  id?: string;
  name: string;
  optionValue: string;
  price: string; // RM decimal as typed
  compareAt: string;
  stock: string;
  /** Minimum order quantity the buyer must purchase (1 = no minimum). */
  moq: string;
  sku: string;
};

type ProductRow = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  status: string;
  rejectReason: string | null;
  priceMinor: number;
  salesCount: number;
  flagsJson: string;
  images: { url: string }[];
  variants: { id: string; name: string; optionValue: string | null; priceMinor: number; stock: number; moq: number; sku: string | null }[];
  category: { id: string; name: string } | null;
};

type Category = { id: string; label: string };

type Paged<T> = { rows: T[]; total: number };

function slugifyTitle(t: string): string {
  return t.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
}

// ---------------------------------------------------------------- list view

export default function SellerProducts({
  focusProductId,
  onNavigate,
}: {
  focusProductId?: string;
  onNavigate: (n: SellerNav) => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ product: ProductRow | null; open: boolean }>({ product: null, open: false });
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refetch = () => setTick((t) => t + 1);

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setLoading(true);
    apiGetPaged<ProductRow[]>(`/api/store/products?search=${encodeURIComponent(search)}&status=${statusFilter}&page=${page}&size=10`)
      .then(({ rows: r, meta }) => {
        if (!alive) return;
        setRows(r);
        setTotal(meta?.total ?? r.length);
      })
      .catch(() => alive && setRows([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [search, statusFilter, page, tick]);

  useEffect(() => {
    if (focusProductId && rows.length > 0) {
      const found = rows.find((r) => r.id === focusProductId);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
      if (found) setEditing({ product: found, open: true });
    }
  }, [focusProductId, rows]);

  const totalPages = Math.max(1, Math.ceil(total / 10));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search products…"
            className="pl-8"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="pending_review">In review</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
        <Button
          onClick={() => setEditing({ product: null, open: true })}
          className="min-h-[44px] gap-1.5"
        >
          <Plus className="h-4 w-4" /> New product
        </Button>
      </div>

      {loading ? (
        <RowsSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Package className="h-8 w-8" />}
          title="No products yet"
          hint="Create your first product — you can generate placeholder images and add variants in seconds."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead className="text-right">Sales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => setEditing({ product: p, open: true })}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                        {p.images[0] ? (
                          <img src={p.images[0].url} alt={p.title} className="h-full w-full object-cover" />
                        ) : (
                          <ImageIcon className="h-4 w-4 text-muted-foreground" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="max-w-56 truncate font-medium">{p.title}</p>
                        <p className="max-w-56 truncate text-xs text-muted-foreground">
                          {p.category?.name ?? "Uncategorised"} · {p.variants.length} variant{p.variants.length === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><StatusChip status={p.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{formatMinor(p.priceMinor)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.variants.reduce((s, v) => s + v.stock, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.salesCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{total} product{total === 1 ? "" : "s"} · page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      ) : null}

      <ProductEditor
        open={editing.open}
        product={editing.product}
        onOpenChange={(open) => setEditing((prev) => ({ ...prev, open }))}
        onSaved={() => {
          refetch();
        }}
        onArchived={() => {
          setEditing({ product: null, open: false });
          refetch();
        }}
        onNavigate={onNavigate}
      />
    </div>
  );
}

// ---------------------------------------------------------------- editor

const emptyVariants: Variant[] = [{ name: "Default", optionValue: "", price: "", compareAt: "", stock: "0", moq: "1", sku: "" }];

function ProductEditor({
  open,
  product,
  onOpenChange,
  onSaved,
  onArchived,
  onNavigate,
}: {
  open: boolean;
  product: ProductRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onArchived: () => void;
  onNavigate: (n: SellerNav) => void;
}) {
  const isNew = !product;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [variants, setVariants] = useState<Variant[]>(emptyVariants);
  const [customUrl, setCustomUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setTitle(product?.title ?? "");
    setDescription(product?.description ?? "");
    setCategoryId(product?.category?.id ?? "");
    setImages(product?.images.map((i) => i.url) ?? []);
    setVariants(
      product && product.variants.length > 0
        ? product.variants.map((v) => ({
            id: v.id,
            name: v.name,
            optionValue: v.optionValue ?? "",
            price: (v.priceMinor / 100).toFixed(2),
            compareAt: "",
            stock: String(v.stock),
            moq: String(Math.max(1, v.moq ?? 1)),
            sku: v.sku ?? "",
          }))
        : [{ ...emptyVariants[0] }]
    );
  }, [open, product]);

  useEffect(() => {
    if (!open) return;
    apiGet<{ categories: { id: string; name: string; children?: { id: string; name: string }[] }[] }>("/api/market/home")
      .then((d) => {
        const flat: Category[] = [];
        for (const c of d.categories) {
          flat.push({ id: c.id, label: c.name });
          for (const ch of c.children ?? []) flat.push({ id: ch.id, label: `${c.name} / ${ch.name}` });
        }
        setCategories(flat);
      })
      .catch(() => setCategories([]));
  }, [open]);

  const status = product?.status ?? null;

  const addGenerated = () => {
    const seed = slugifyTitle(title || "product");
    const n = images.length + 1;
    const label = encodeURIComponent(title || "Product");
    setImages((prev) => [...prev, `/api/img/${seed}-${n}?w=900&h=900&label=${label}`]);
  };

  const setVariant = (i: number, patch: Partial<Variant>) =>
    setVariants((prev) => prev.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));

  const save = async () => {
    if (!title.trim()) {
      toast.error("Product title is required");
      return;
    }
    const payloadVariants = variants.map((v) => ({
      name: v.name.trim() || "Default",
      optionName: v.optionValue ? "Variant" : null,
      optionValue: v.optionValue || null,
      priceMinor: toMinor(v.price),
      compareAtPriceMinor: v.compareAt ? toMinor(v.compareAt) : null,
      stock: Math.max(0, Math.round(Number(v.stock) || 0)),
      moq: Math.max(1, Math.round(Number(v.moq) || 1)),
      sku: v.sku || null,
    }));
    if (payloadVariants.some((v) => v.priceMinor <= 0)) {
      toast.error("Every variant needs a price above RM 0");
      return;
    }
    setBusy(true);
    const ok = await runMutation(async () => {
      if (isNew) {
        await apiSend("POST", "/api/store/products", {
          title: title.trim(),
          description: description || null,
          categoryId: categoryId || null,
          images,
          variants: payloadVariants,
        });
      } else {
        await apiSend("PATCH", `/api/store/products/${product!.id}`, {
          title: title.trim(),
          description: description || null,
          categoryId: categoryId || null,
          images,
          variants: payloadVariants,
        });
      }
    }, isNew ? "Product created" : "Product updated");
    setBusy(false);
    if (ok) {
      onOpenChange(false);
      onSaved();
    }
  };

  const archive = async () => {
    if (!product) return;
    setBusy(true);
    const ok = await runMutation(() => apiSend("DELETE", `/api/store/products/${product.id}`), "Product archived");
    setBusy(false);
    setConfirmArchive(false);
    if (ok) onArchived();
  };

  const generatedPreview = useMemo(() => {
    if (images.length === 0) return null;
    return images[images.length - 1];
  }, [images]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92vh] w-[min(880px,94vw)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {isNew ? "New product" : `Edit — ${product?.title}`}
              {status ? <StatusChip status={status} /> : null}
            </DialogTitle>
          </DialogHeader>

          {status === "pending_review" ? (
            <Alert>
              <AlertDescription className="text-xs">
                This product is waiting for moderation. New and updated products are reviewed before going
                live{product?.rejectReason ? ` — rejection reason: “${product.rejectReason}”` : ""}. It will appear on your storefront once approved.
              </AlertDescription>
            </Alert>
          ) : null}
          {status === "active" ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Live on your storefront — edits to price/stock go live immediately.
            </p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* left column: identity */}
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label htmlFor="prod-title">Title *</Label>
                <Input id="prod-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Olive Wood Spoons (Set of 3)" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prod-desc">Description</Label>
                <Textarea id="prod-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Materials, dimensions, care instructions…" />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={categoryId || undefined} onValueChange={(v) => setCategoryId(v === "__none" ? "" : v)}>
                  <SelectTrigger aria-label="Category">
                    <SelectValue placeholder="Uncategorised" />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="__none">Uncategorised</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Commission rates can differ per category.</p>
              </div>
            </div>

            {/* right column: images */}
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label>Images ({images.length})</Label>
                {images.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {images.map((u, i) => (
                      <div key={`${u}-${i}`} className="group relative overflow-hidden rounded-lg border">
                        <img src={u} alt={`Product image ${i + 1}`} className="aspect-square w-full object-cover" />
                        <button
                          aria-label={`Remove image ${i + 1}`}
                          className="absolute right-1 top-1 rounded-full bg-background/90 p-1 text-rose-600 shadow hover:bg-background"
                          onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
                    No images yet
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={addGenerated} className="gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" /> Add generated image
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      if (!customUrl.trim()) return;
                      setImages((prev) => [...prev, customUrl.trim()]);
                      setCustomUrl("");
                    }}
                  >
                    <ImageIcon className="h-3.5 w-3.5" /> Add custom URL
                  </Button>
                </div>
                {generatedPreview ? (
                  <p className="truncate text-[11px] text-muted-foreground">Last added: {generatedPreview}</p>
                ) : null}
                <Input
                  placeholder="https://… or /api/img/seed?w=900&h=900"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            </div>
          </div>

          {/* variants */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Variants ({variants.length})</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => setVariants((prev) => [...prev, { name: "Variant", optionValue: "", price: "", compareAt: "", stock: "0", moq: "1", sku: "" }])}
              >
                <Plus className="h-3.5 w-3.5" /> Add variant
              </Button>
            </div>
            <div className="space-y-2">
              {variants.map((v, i) => (
                <div key={v.id ?? `new-${i}`} className="grid grid-cols-2 items-end gap-2 rounded-xl border p-3 sm:grid-cols-12">
                  <div className="col-span-2 space-y-1 sm:col-span-2">
                    <Label className="text-[11px] text-muted-foreground">Name</Label>
                    <Input className="h-9" value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} placeholder="Default" />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-[11px] text-muted-foreground">Option</Label>
                    <Input className="h-9" value={v.optionValue} onChange={(e) => setVariant(i, { optionValue: e.target.value })} placeholder="Red / M" />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-[11px] text-muted-foreground">Price RM *</Label>
                    <MoneyInput valueMinor={v.price ? toMinor(v.price) : null} onChangeMinor={(m) => setVariant(i, { price: (m / 100).toFixed(2) })} className="h-9" />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-[11px] text-muted-foreground">Compare at</Label>
                    <MoneyInput valueMinor={v.compareAt ? toMinor(v.compareAt) : null} onChangeMinor={(m) => setVariant(i, { compareAt: m ? (m / 100).toFixed(2) : "" })} className="h-9" />
                  </div>
                  <div className="space-y-1 sm:col-span-1">
                    <Label className="text-[11px] text-muted-foreground">Stock</Label>
                    <Input className="h-9" inputMode="numeric" value={v.stock} onChange={(e) => setVariant(i, { stock: e.target.value.replace(/[^0-9]/g, "") })} />
                  </div>
                  <div className="space-y-1 sm:col-span-1">
                    <Label className="text-[11px] text-muted-foreground" title="Buyers must order at least this many of this item">Min. order</Label>
                    <Input
                      className="h-9"
                      inputMode="numeric"
                      value={v.moq}
                      onChange={(e) => setVariant(i, { moq: e.target.value.replace(/[^0-9]/g, "") })}
                      placeholder="1"
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-1">
                    <Label className="text-[11px] text-muted-foreground">SKU</Label>
                    <Input className="h-9" value={v.sku} onChange={(e) => setVariant(i, { sku: e.target.value })} />
                  </div>
                  <div className="col-span-2 flex justify-end sm:col-span-1">
                    {v.id ? (
                      <span
                        className="flex h-9 items-center px-1 text-[10px] leading-tight text-muted-foreground"
                        title="Existing variants can't be removed — orders may reference them"
                      >
                        saved
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-rose-600"
                        aria-label="Remove variant"
                        onClick={() => setVariants((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {!isNew ? (
              <p className="text-xs text-muted-foreground">
                Existing variants are updated in place; newly added rows are created on save. Total stock: {variants.reduce((s, v) => s + (Number(v.stock) || 0), 0)}.
              </p>
            ) : null}
          </div>

          {/* footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            {!isNew ? (
              <Button variant="ghost" className="gap-1.5 text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={() => setConfirmArchive(true)}>
                <Archive className="h-4 w-4" /> Archive
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button onClick={save} disabled={busy} className="min-h-[44px] gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isNew ? "Create product" : "Save changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this product?</AlertDialogTitle>
            <AlertDialogDescription>
              “{product?.title}” will be hidden from your storefront and the marketplace. Order history is kept.
              You can&apos;t unarchive from this demo — contact support to restore.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep product</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 text-white hover:bg-rose-700" onClick={archive}>
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

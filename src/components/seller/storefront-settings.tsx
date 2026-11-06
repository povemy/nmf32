"use client";
// ============================================================================
// SELLER STORE SETTINGS WORK ORDER — "Storefront" tab of Store Settings.
// Four independent blocks, every seller configures their own store:
//   1. Product cards — rating stars on/off + views-or-units-sold badge;
//   2. Homepage sections — Featured (new) and/or Fresh arrivals (default),
//      plus which section stacks on top;
//   3. Storefront categories — the inline chip row below the storefront hero;
//   4. Product organizer — assign products to categories + feature them.
// Every control saves immediately (optimistic + rollback on failure), the
// same pattern as the marketplace opt-in switch on the General tab.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  LayoutList,
  Loader2,
  Package,
  Pencil,
  Plus,
  Save,
  ShoppingBag,
  Star,
  Tags,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiGet, apiGetPaged, apiSend, runMutation, type StoreMe } from "./ui-bits";

type StoreCategoryRow = { id: string; name: string; sortOrder: number; productCount: number };

type OrganizedProduct = {
  id: string;
  title: string;
  status: string;
  isFeatured: boolean;
  storeCategoryId: string | null;
  salesCount: number;
  viewCount: number;
  images: { url: string }[];
};

const NO_CATEGORY = "__none__";

export default function StorefrontSettings({
  storeMe,
  refreshStoreMe,
}: {
  storeMe: StoreMe;
  refreshStoreMe: () => Promise<void>;
}) {
  const store = storeMe.store;

  // ---- 1. product cards -----------------------------------------------------
  const [showStars, setShowStars] = useState(store.cardShowStars);
  const [metric, setMetric] = useState<"views" | "sold">(store.cardMetric);

  useEffect(() => {
    setShowStars(store.cardShowStars);
    setMetric(store.cardMetric);
  }, [store.cardShowStars, store.cardMetric]);

  const patchSettings = useCallback(
    async (payload: Record<string, unknown>, revert: () => void, successMsg: string) => {
      const ok = await runMutation(() => apiSend("PATCH", "/api/store/settings", payload), successMsg);
      if (!ok) revert();
      else await refreshStoreMe();
    },
    [refreshStoreMe]
  );

  const saveShowStars = (next: boolean) => {
    setShowStars(next);
    void patchSettings({ cardShowStars: next }, () => setShowStars(!next), next ? "Rating stars shown on your cards" : "Rating stars hidden on your cards");
  };

  const saveMetric = (next: "views" | "sold") => {
    if (next === metric) return;
    setMetric(next);
    void patchSettings({ cardMetric: next }, () => setMetric(metric), next === "views" ? "Cards now show product views" : "Cards now show units sold");
  };

  // ---- 2. homepage sections --------------------------------------------------
  const [showFeatured, setShowFeatured] = useState(store.homeShowFeatured);
  const [showFresh, setShowFresh] = useState(store.homeShowFresh);
  const [featuredFirst, setFeaturedFirst] = useState(store.homeFeaturedFirst);

  useEffect(() => {
    setShowFeatured(store.homeShowFeatured);
    setShowFresh(store.homeShowFresh);
    setFeaturedFirst(store.homeFeaturedFirst);
  }, [store.homeShowFeatured, store.homeShowFresh, store.homeFeaturedFirst]);

  const saveHomeFlag = (
    key: "homeShowFeatured" | "homeShowFresh" | "homeFeaturedFirst",
    current: boolean,
    set: (v: boolean) => void,
    successMsg: string
  ) => {
    const next = !current;
    set(next);
    void patchSettings({ [key]: next }, () => set(current), successMsg);
  };

  return (
    <div className="space-y-6">
      {/* 1. Product cards */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Eye className="h-4 w-4 text-primary" /> Product cards
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
            <div>
              <p className="text-sm font-medium">Show rating stars</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Rating stars appear on your store&apos;s product cards (storefront grids).
              </p>
            </div>
            <Switch checked={showStars} onCheckedChange={saveShowStars} aria-label="Show rating stars on product cards" />
          </div>

          <div className="rounded-xl border p-4">
            <p className="text-sm font-medium">Card badge</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Choose the little figure shown beside the stars on each product card.
            </p>
            <RadioGroup
              value={metric}
              onValueChange={(v) => saveMetric(v === "sold" ? "sold" : "views")}
              className="mt-3 grid gap-2 sm:grid-cols-2"
              aria-label="Card badge metric"
            >
              <Label
                htmlFor="metric-views"
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors has-[button[data-state=checked]]:border-primary has-[button[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem id="metric-views" value="views" />
                <Eye className="h-4 w-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">Product views</span>
              </Label>
              <Label
                htmlFor="metric-sold"
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors has-[button[data-state=checked]]:border-primary has-[button[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem id="metric-sold" value="sold" />
                <ShoppingBag className="h-4 w-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">Units sold</span>
              </Label>
            </RadioGroup>
          </div>
        </CardContent>
      </Card>

      {/* 2. Homepage sections */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <LayoutList className="h-4 w-4 text-primary" /> Homepage sections
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Organize what shoppers see under your hero. <span className="font-medium text-foreground">Fresh arrivals</span> (your
            newest products) is on by default; add a <span className="font-medium text-foreground">Featured</span> section for products
            you star in the organizer below.
          </p>

          <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
            <div>
              <p className="text-sm font-medium">Fresh arrivals section</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Your latest products, newest first.</p>
            </div>
            <Switch
              checked={showFresh}
              onCheckedChange={() => saveHomeFlag("homeShowFresh", showFresh, setShowFresh, "Fresh arrivals section updated")}
              aria-label="Show Fresh arrivals section"
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
            <div>
              <p className="text-sm font-medium">Featured products section</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Products you mark as featured — great for promotions and hero items.
              </p>
            </div>
            <Switch
              checked={showFeatured}
              onCheckedChange={() => saveHomeFlag("homeShowFeatured", showFeatured, setShowFeatured, "Featured section updated")}
              aria-label="Show Featured products section"
            />
          </div>

          {showFeatured && showFresh ? (
            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium">Which section goes on top?</p>
              <RadioGroup
                value={featuredFirst ? "featured" : "fresh"}
                onValueChange={(v) => {
                  if ((v === "featured") === featuredFirst) return;
                  const next = v === "featured";
                  setFeaturedFirst(next);
                  void patchSettings(
                    { homeFeaturedFirst: next },
                    () => setFeaturedFirst(!next),
                    next ? "Featured section moved to the top" : "Fresh arrivals moved to the top"
                  );
                }}
                className="mt-3 grid gap-2 sm:grid-cols-2"
                aria-label="Homepage section order"
              >
                <Label
                  htmlFor="order-featured"
                  className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors has-[button[data-state=checked]]:border-primary has-[button[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem id="order-featured" value="featured" />
                  <span className="text-sm font-medium">Featured on top</span>
                </Label>
                <Label
                  htmlFor="order-fresh"
                  className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors has-[button[data-state=checked]]:border-primary has-[button[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem id="order-fresh" value="fresh" />
                  <span className="text-sm font-medium">Fresh arrivals on top</span>
                </Label>
              </RadioGroup>
            </div>
          ) : null}

          {!showFeatured && !showFresh ? (
            <p className="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              Both sections are off — your homepage will not show a product grid. Turn at least one back on so shoppers can browse.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* 3 + 4. categories + product organizer */}
      <CategoriesManager />
      <ProductOrganizer />
    </div>
  );
}

// ============================================================================
// Categories manager — inline chip row below the storefront hero
// ============================================================================

function CategoriesManager() {
  const [cats, setCats] = useState<StoreCategoryRow[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<StoreCategoryRow | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await apiGet<StoreCategoryRow[]>("/api/store/categories");
      setCats(rows);
    } catch {
      setCats([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    const ok = await runMutation(() => apiSend("POST", "/api/store/categories", { name }), `Category “${name}” added`);
    setBusy(false);
    if (ok) {
      setNewName("");
      await load();
    }
  };

  const rename = async (cat: StoreCategoryRow) => {
    const name = renameValue.trim();
    if (!name || name === cat.name) {
      setRenamingId(null);
      return;
    }
    const ok = await runMutation(() => apiSend("PATCH", `/api/store/categories/${cat.id}`, { name }), "Category renamed");
    if (ok) {
      setRenamingId(null);
      await load();
    }
  };

  const move = async (cat: StoreCategoryRow, direction: "up" | "down") => {
    await runMutation(() => apiSend("PATCH", `/api/store/categories/${cat.id}`, { direction }), "Category order updated");
    await load();
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const cat = deleteTarget;
    setDeleteTarget(null);
    await runMutation(() => apiSend("DELETE", `/api/store/categories/${cat.id}`), `Category “${cat.name}” deleted`);
    await load();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Tags className="h-4 w-4 text-primary" /> Storefront categories
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your categories appear as an inline row of chips just below the storefront hero. Shoppers tap a chip to instantly
          view that group of products — with none selected, your homepage shows the sections above.
        </p>

        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            placeholder="New category name (e.g. Lighting)"
            aria-label="New category name"
            maxLength={40}
            className="min-h-[44px]"
          />
          <Button onClick={() => void add()} disabled={busy || !newName.trim()} className="min-h-[44px] gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
          </Button>
        </div>

        {cats == null ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : cats.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No categories yet — add your first one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {cats.map((cat, i) => (
              <li key={cat.id} className="flex items-center gap-2 rounded-xl border p-2.5">
                <div className="flex flex-col gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={i === 0}
                    onClick={() => void move(cat, "up")}
                    aria-label={`Move ${cat.name} up`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={i === cats.length - 1}
                    onClick={() => void move(cat, "down")}
                    aria-label={`Move ${cat.name} down`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {renamingId === cat.id ? (
                  <div className="flex flex-1 items-center gap-2">
                    <Input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void rename(cat);
                        }
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      autoFocus
                      maxLength={40}
                      className="min-h-[40px]"
                      aria-label="Category name"
                    />
                    <Button size="sm" className="h-9 gap-1.5" onClick={() => void rename(cat)}>
                      <Save className="h-3.5 w-3.5" /> Save
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1 truncate text-sm font-medium">{cat.name}</span>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                      {cat.productCount} product{cat.productCount === 1 ? "" : "s"}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      onClick={() => {
                        setRenamingId(cat.id);
                        setRenameValue(cat.name);
                      }}
                      aria-label={`Rename ${cat.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-rose-500 hover:text-rose-600"
                      onClick={() => setDeleteTarget(cat)}
                      aria-label={`Delete ${cat.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The category is removed from your storefront chip row. Its {deleteTarget?.productCount ?? 0} assigned
              product{deleteTarget?.productCount === 1 ? "" : "s"} stay live — they simply show under “All products”.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep category</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()} className="bg-rose-600 hover:bg-rose-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ============================================================================
// Product organizer — assign categories + feature products
// ============================================================================

function ProductOrganizer() {
  const [cats, setCats] = useState<StoreCategoryRow[] | null>(null);
  const [products, setProducts] = useState<OrganizedProduct[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hiddenCount, setHiddenCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const catRows = await apiGet<StoreCategoryRow[]>("/api/store/categories");
      setCats(catRows);
    } catch {
      setCats([]);
    }
    try {
      const { rows, meta } = await apiGetPaged<OrganizedProduct[]>("/api/store/products?page=1&size=100");
      const visible = rows.filter((p) => p.status !== "archived");
      setProducts(visible);
      setTotal(meta?.total ?? visible.length);
      setHiddenCount(Math.max(0, (meta?.total ?? visible.length) - visible.length));
    } catch {
      setProducts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reloadCategories = async () => {
    try {
      setCats(await apiGet<StoreCategoryRow[]>("/api/store/categories"));
    } catch {
      /* keep the previous list — productCount is advisory here */
    }
  };

  const assignCategory = async (product: OrganizedProduct, value: string) => {
    const next = value === NO_CATEGORY ? null : value;
    if (next === product.storeCategoryId) return;
    setProducts((rows) => (rows ? rows.map((p) => (p.id === product.id ? { ...p, storeCategoryId: next } : p)) : rows));
    const ok = await runMutation(
      () => apiSend("PATCH", `/api/store/products/${product.id}`, { storeCategoryId: next }),
      next ? `Moved to ${cats?.find((c) => c.id === next)?.name ?? "category"}` : "Category removed"
    );
    if (!ok) {
      setProducts((rows) => (rows ? rows.map((p) => (p.id === product.id ? { ...p, storeCategoryId: product.storeCategoryId } : p)) : rows));
    } else {
      await reloadCategories();
    }
  };

  const toggleFeatured = async (product: OrganizedProduct) => {
    const next = !product.isFeatured;
    setProducts((rows) => (rows ? rows.map((p) => (p.id === product.id ? { ...p, isFeatured: next } : p)) : rows));
    const ok = await runMutation(
      () => apiSend("PATCH", `/api/store/products/${product.id}`, { isFeatured: next }),
      next ? "Added to your Featured section" : "Removed from your Featured section"
    );
    if (!ok) {
      setProducts((rows) => (rows ? rows.map((p) => (p.id === product.id ? { ...p, isFeatured: product.isFeatured } : p)) : rows));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Package className="h-4 w-4 text-primary" /> Organize products
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Assign each product to a storefront category and star the ones that should appear in your Featured section
          (shown when the Featured toggle above is on).
        </p>

        {products == null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : products.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No products yet — add products first, then organize them here.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto pr-1 [scrollbar-width:thin]">
            <ul className="space-y-2">
              {products.map((product) => (
                <li
                  key={product.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl border p-2.5 sm:flex-nowrap"
                >
                  {product.images[0]?.url ? (
                    // plain <img> — product mockups / placeholder service, never next/image
                    <img
                      src={product.images[0].url}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded-lg border object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted">
                      <Package className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{product.title}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {product.status === "active" ? "Active" : product.status === "pending_review" ? "Pending review" : product.status}
                      {" · "}
                      {product.viewCount.toLocaleString("en-MY")} views · {product.salesCount.toLocaleString("en-MY")} sold
                    </p>
                  </div>

                  <Select
                    value={product.storeCategoryId ?? NO_CATEGORY}
                    onValueChange={(v) => void assignCategory(product, v)}
                    disabled={cats != null && cats.length === 0}
                  >
                    <SelectTrigger className="h-9 w-[150px] shrink-0 text-xs" aria-label={`Category for ${product.title}`}>
                      <SelectValue placeholder="No category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                      {(cats ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Button
                    variant="outline"
                    size="icon"
                    className={`h-9 w-9 shrink-0 ${product.isFeatured ? "border-amber-300 text-amber-500 hover:text-amber-600" : "text-muted-foreground"}`}
                    onClick={() => void toggleFeatured(product)}
                    aria-pressed={product.isFeatured}
                    aria-label={product.isFeatured ? `Remove ${product.title} from Featured` : `Feature ${product.title}`}
                    title={product.isFeatured ? "Featured — click to remove" : "Click to feature"}
                  >
                    <Star className={`h-4 w-4 ${product.isFeatured ? "fill-amber-400" : ""}`} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {hiddenCount > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {hiddenCount} archived product{hiddenCount === 1 ? "" : "s"} hidden · showing {total > 100 ? "first 100 of" : ""}{" "}
            {products?.length ?? 0} of {total}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

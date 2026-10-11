"use client";
// Phase 10b — Seller SEO EDITOR: store-level defaults + per-product metadata with
// lock overrides (locked fields survive re-imports), validation warnings.
import { useCallback, useEffect, useState } from "react";
import { Lock, LockOpen, Save, Search, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { apiGet, apiSend, runMutation, type SellerNav } from "./ui-bits";

type ProductSeo = {
  id: string;
  title: string;
  slug: string;
  status: string;
  image: string | null;
  seoTitle: string;
  seoDescription: string;
  ogImage: string | null;
  noindex: boolean;
  lockedFields: string[];
  warnings: string[];
};

type Payload = {
  store: { seoTitle: string; seoDescription: string; ogImage: string | null; canonicalUrl: string | null; noindex: boolean; lockedFields: string[]; warnings: string[] };
  products: ProductSeo[];
};

const CHAR_HINT = { title: 60, description: 155 };

export default function SellerSeo({ onNavigate }: { onNavigate: (nav: SellerNav) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [storeForm, setStoreForm] = useState<{ seoTitle: string; seoDescription: string } | null>(null);
  const [productForms, setProductForms] = useState<Record<string, { seoTitle: string; seoDescription: string }>>({});

  const refresh = useCallback(async () => {
    try {
      const d = await apiGet<Payload>("/api/store/seo");
      setData(d);
      setStoreForm({ seoTitle: d.store.seoTitle ?? "", seoDescription: d.store.seoDescription ?? "" });
      setProductForms(
        Object.fromEntries(d.products.map((p) => [p.id, { seoTitle: p.seoTitle ?? "", seoDescription: p.seoDescription ?? "" }]))
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initial data fetch
    refresh();
  }, [refresh]);

  async function saveStore(lock?: boolean) {
    if (!storeForm) return;
    const ok = await runMutation(
      () =>
        apiSend("PATCH", "/api/store/seo", {
          target: "store",
          seoTitle: storeForm.seoTitle,
          seoDescription: storeForm.seoDescription,
          ...(lock === true ? { lock: ["seoTitle", "seoDescription"] } : {}),
          ...(lock === false ? { unlock: ["seoTitle", "seoDescription"] } : {}),
        }),
      "Store SEO saved"
    );
    if (ok) await refresh();
  }

  async function saveProduct(p: ProductSeo, lock?: boolean) {
    const form = productForms[p.id];
    if (!form) return;
    const ok = await runMutation(
      () =>
        apiSend("PATCH", "/api/store/seo", {
          target: "product",
          productId: p.id,
          seoTitle: form.seoTitle,
          seoDescription: form.seoDescription,
          ...(lock === true ? { lock: ["seoTitle", "seoDescription"] } : {}),
          ...(lock === false ? { unlock: ["seoTitle", "seoDescription"] } : {}),
        }),
      `SEO saved for “${p.title.slice(0, 30)}”`
    );
    if (ok) await refresh();
  }

  if (failed) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">Could not load SEO settings.</div>
    );
  }
  if (!data || !storeForm) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4 sm:p-5">
        <header className="pb-1">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Search className="h-4 w-4 text-teal-700" /> SEO — store defaults
          </h2>
          <p className="text-xs text-muted-foreground">
            Used for the storefront home page, sitemap and social previews. Imported products get generated metadata automatically —
            edit any field to override it; lock it to protect it from future re-imports.
          </p>
        </header>
        <div className="mt-3 space-y-3">
          <div>
            <Label htmlFor="seo-store-title" className="text-xs">
              Store SEO title <span className={cn("ml-1 tabular-nums", storeForm.seoTitle.length > CHAR_HINT.title ? "text-rose-600" : "text-muted-foreground")}>{storeForm.seoTitle.length}/{CHAR_HINT.title}</span>
            </Label>
            <Input
              id="seo-store-title"
              value={storeForm.seoTitle}
              onChange={(e) => setStoreForm({ ...storeForm, seoTitle: e.target.value })}
              className="mt-1"
              maxLength={80}
            />
          </div>
          <div>
            <Label htmlFor="seo-store-desc" className="text-xs">
              Meta description <span className={cn("ml-1 tabular-nums", storeForm.seoDescription.length > CHAR_HINT.description ? "text-rose-600" : "text-muted-foreground")}>{storeForm.seoDescription.length}/{CHAR_HINT.description}</span>
            </Label>
            <Textarea
              id="seo-store-desc"
              value={storeForm.seoDescription}
              onChange={(e) => setStoreForm({ ...storeForm, seoDescription: e.target.value })}
              className="mt-1 min-h-[72px]"
              maxLength={200}
            />
          </div>
          {data.store.warnings.length > 0 ? (
            <ul className="space-y-1 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">
              {data.store.warnings.map((w, i) => (
                <li key={i} className="flex gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => saveStore()} className="min-h-[40px] bg-brand-gradient-deep hover:brightness-110">
              <Save className="mr-1.5 h-4 w-4" /> Save store SEO
            </Button>
            <Button variant="outline" onClick={() => saveStore(true)} className="min-h-[40px]">
              <Lock className="mr-1.5 h-3.5 w-3.5" /> Save & lock
            </Button>
            {data.store.lockedFields.length > 0 ? (
              <>
                <Badge variant="outline" className="gap-1">
                  <Lock className="h-3 w-3" /> locked: {data.store.lockedFields.join(", ")}
                </Badge>
                <Button variant="ghost" size="sm" onClick={() => saveStore(false)} className="min-h-[36px]">
                  <LockOpen className="mr-1 h-3.5 w-3.5" /> Unlock
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="pb-3 text-sm font-bold">
          Product metadata <span className="font-normal text-muted-foreground">({data.products.length})</span>
        </h2>
        {data.products.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">No products yet.</p>
        ) : (
          <Tabs defaultValue={data.products[0]?.id}>
            <TabsList className="flex w-full flex-wrap justify-start gap-1 overflow-x-auto max-h-24">
              {data.products.map((p) => (
                <TabsTrigger key={p.id} value={p.id} className="max-w-[160px] truncate text-xs">
                  {p.title}
                  {p.lockedFields.length > 0 ? <Lock className="ml-1 inline h-3 w-3" /> : null}
                </TabsTrigger>
              ))}
            </TabsList>
            {data.products.map((p) => {
              const form = productForms[p.id] ?? { seoTitle: "", seoDescription: "" };
              const locked = p.lockedFields.length > 0;
              return (
                <TabsContent key={p.id} value={p.id} className="mt-3 space-y-3">
                  <div className="flex items-center gap-3">
                    {p.image ? (
                      <img src={p.image} alt="" className="h-10 w-10 rounded-md object-cover" loading="lazy" />
                    ) : null}
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{p.title}</p>
                      <p className="truncate text-[11px] text-muted-foreground">/{p.slug}</p>
                    </div>
                  </div>
                  <div>
                    <Label htmlFor={`t-${p.id}`} className="text-xs">
                      SEO title <span className={cn("ml-1 tabular-nums", form.seoTitle.length > CHAR_HINT.title ? "text-rose-600" : "text-muted-foreground")}>{form.seoTitle.length}/{CHAR_HINT.title}</span>
                    </Label>
                    <Input id={`t-${p.id}`} value={form.seoTitle} onChange={(e) => setProductForms({ ...productForms, [p.id]: { ...form, seoTitle: e.target.value } })} className="mt-1" maxLength={80} />
                  </div>
                  <div>
                    <Label htmlFor={`d-${p.id}`} className="text-xs">
                      Meta description <span className={cn("ml-1 tabular-nums", form.seoDescription.length > CHAR_HINT.description ? "text-rose-600" : "text-muted-foreground")}>{form.seoDescription.length}/{CHAR_HINT.description}</span>
                    </Label>
                    <Textarea id={`d-${p.id}`} value={form.seoDescription} onChange={(e) => setProductForms({ ...productForms, [p.id]: { ...form, seoDescription: e.target.value } })} className="mt-1 min-h-[64px]" maxLength={200} />
                  </div>
                  {p.warnings.length > 0 ? (
                    <ul className="space-y-1 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">
                      {p.warnings.map((w, i) => (
                        <li key={i} className="flex gap-1.5">
                          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => saveProduct(p)} className="min-h-[36px] bg-brand-gradient-deep hover:brightness-110">
                      <Save className="mr-1 h-3.5 w-3.5" /> Save
                    </Button>
                    {locked ? (
                      <>
                        <Badge variant="outline" className="gap-1">
                          <Lock className="h-3 w-3" /> protected from re-import
                        </Badge>
                        <Button variant="ghost" size="sm" onClick={() => saveProduct(p, false)} className="min-h-[36px]">
                          <LockOpen className="mr-1 h-3.5 w-3.5" /> Unlock
                        </Button>
                      </>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => saveProduct(p, true)} className="min-h-[36px]">
                        <Lock className="mr-1 h-3.5 w-3.5" /> Save & lock
                      </Button>
                    )}
                  </div>
                </TabsContent>
              );
            })}
          </Tabs>
        )}
      </div>
      <p className="pb-2 text-center text-[11px] text-muted-foreground">
        Technical SEO: /sitemap.xml lists published stores + active products automatically; private claim pages are noindex.
        {" "}
        <button type="button" onClick={() => onNavigate({ view: "imports" })} className="font-semibold text-teal-700 underline-offset-2 hover:underline">
          Back to imports
        </button>
      </p>
    </div>
  );
}

void Switch;

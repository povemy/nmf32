"use client";
// Seller Backend — "Product Cards": typography customization for the product
// cards in the seller's OWN storefront catalogue. Font family / size /
// alignment for the product name and the price, chosen via plain dropdowns +
// alignment buttons (no code, no JSON — vendors see words and previews only).
// A live preview card renders exactly what shoppers will see.
import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Type } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import { ProductCard, type ProductCardT, type CardStyleTokens } from "@/components/shopper/ui-bits";
import { fontLabel } from "@/lib/fonts";
import { apiGet, apiSend } from "./ui-bits";

type StyleRow = CardStyleTokens;

type Payload = {
  style: StyleRow | null;
  fonts: { id: string; label: string; kind: string }[];
};

const DEFAULT_STYLE: StyleRow = {
  nameFont: "inter",
  nameSize: "md",
  nameAlign: "left",
  priceFont: "inter",
  priceSize: "md",
  priceAlign: "left",
};

const SAMPLE_PRODUCT: ProductCardT = {
  id: "preview",
  slug: "preview",
  title: "Aria Ceramic Vase — Nordic Matte Collection",
  priceMinor: 8900,
  compareAtPriceMinor: 12900,
  imageUrl: "/api/img/preview-vase?w=600&h=600&label=Preview",
  storeName: "Your store",
  storeSlug: "your-store",
  ratingAvg: 4.7,
  ratingCount: 128,
  salesCount: 342,
  categoryName: "Home & Living",
};

const SIZE_OPTIONS = [
  { id: "sm", label: "Small" },
  { id: "md", label: "Medium (default)" },
  { id: "lg", label: "Large" },
];

export default function SellerCardStyle() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fonts, setFonts] = useState<{ id: string; label: string; kind: string }[]>([]);
  const [style, setStyle] = useState<StyleRow>({ ...DEFAULT_STYLE });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiGet<Payload>("/api/store/card-style")
      .then((d) => {
        if (!alive) return;
        setFonts(d.fonts ?? []);
        if (d.style) setStyle({ ...DEFAULT_STYLE, ...d.style });
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not load card style"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const fontGroups = useMemo(() => {
    const groups = new Map<string, { id: string; label: string }[]>();
    for (const f of fonts) {
      const kind = f.kind === "serif" ? "Serif" : f.kind === "display" ? "Display" : f.kind === "mono" ? "Monospace" : f.kind === "handwriting" ? "Handwriting" : "Sans-serif";
      const list = groups.get(kind) ?? [];
      list.push(f);
      groups.set(kind, list);
    }
    return [...groups.entries()];
  }, [fonts]);

  const set = (patch: Partial<StyleRow>) => setStyle((s) => ({ ...s, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      await apiSend("PUT", "/api/store/card-style", style);
      toast.success("Product cards updated", { description: "Your storefront catalogue now uses this typography." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Type className="h-5 w-5 text-primary" /> Product cards
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how product names and prices look across your store's catalogue — font, size and alignment. Shoppers see this on your storefront, product grid and related products.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* controls */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Typography</CardTitle>
            <CardDescription>Pick from curated, web-ready fonts — nothing to install.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <fieldset className="space-y-3">
              <legend className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Product name</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="cs-name-font">Font</Label>
                  <Select value={style.nameFont} onValueChange={(v) => set({ nameFont: v })}>
                    <SelectTrigger id="cs-name-font" aria-label="Product name font">
                      <SelectValue placeholder="Select font" />
                    </SelectTrigger>
                    <SelectContent>
                      {fontGroups.map(([kind, items]) => (
                        <SelectGroup key={kind}>
                          <SelectLabel>{kind}</SelectLabel>
                          {items.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {fontLabel(f.id)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cs-name-size">Size</Label>
                  <Select value={style.nameSize} onValueChange={(v) => set({ nameSize: v })}>
                    <SelectTrigger id="cs-name-size" aria-label="Product name size">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SIZE_OPTIONS.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Alignment</Label>
                  <ToggleGroup
                    type="single"
                    value={style.nameAlign}
                    onValueChange={(v) => v && set({ nameAlign: v })}
                    aria-label="Product name alignment"
                    className="justify-start"
                  >
                    <ToggleGroupItem value="left" aria-label="Left align"><AlignLeft className="h-4 w-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="center" aria-label="Center align"><AlignCenter className="h-4 w-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="right" aria-label="Right align"><AlignRight className="h-4 w-4" /></ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Price</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="cs-price-font">Font</Label>
                  <Select value={style.priceFont} onValueChange={(v) => set({ priceFont: v })}>
                    <SelectTrigger id="cs-price-font" aria-label="Price font">
                      <SelectValue placeholder="Select font" />
                    </SelectTrigger>
                    <SelectContent>
                      {fontGroups.map(([kind, items]) => (
                        <SelectGroup key={kind}>
                          <SelectLabel>{kind}</SelectLabel>
                          {items.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {fontLabel(f.id)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cs-price-size">Size</Label>
                  <Select value={style.priceSize} onValueChange={(v) => set({ priceSize: v })}>
                    <SelectTrigger id="cs-price-size" aria-label="Price size">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SIZE_OPTIONS.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Alignment</Label>
                  <ToggleGroup
                    type="single"
                    value={style.priceAlign}
                    onValueChange={(v) => v && set({ priceAlign: v })}
                    aria-label="Price alignment"
                    className="justify-start"
                  >
                    <ToggleGroupItem value="left" aria-label="Left align"><AlignLeft className="h-4 w-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="center" aria-label="Center align"><AlignCenter className="h-4 w-4" /></ToggleGroupItem>
                    <ToggleGroupItem value="right" aria-label="Right align"><AlignRight className="h-4 w-4" /></ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
            </fieldset>

            <Button onClick={save} disabled={saving} className="min-h-[44px] gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save card style
            </Button>
          </CardContent>
        </Card>

        {/* live preview */}
        <Card className="bg-muted/30">
          <CardHeader>
            <CardTitle className="text-sm">Live preview</CardTitle>
            <CardDescription>Exactly how your catalogue cards render to shoppers.</CardDescription>
          </CardHeader>
          <CardContent className="flex items-start justify-center gap-6">
            <div className="w-40 sm:w-44">
              <ProductCard p={SAMPLE_PRODUCT} showStore={false} onOpen={() => {}} cardStyle={style} />
            </div>
            <div className="hidden w-40 sm:block" aria-hidden>
              <ProductCard p={{ ...SAMPLE_PRODUCT, id: "preview-2" }} showStore={false} onOpen={() => {}} cardStyle={style} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

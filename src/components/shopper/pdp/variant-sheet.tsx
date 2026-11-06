"use client";
// ============================================================================
// PDP makeover — variant-selection BOTTOM SHEET (Phase 3).
//
// Built on the existing shadcn Sheet (Radix Dialog, side="bottom") which
// already provides: slide-from-bottom animation, dark backdrop, escape-key +
// backdrop dismissal, focus trap, body scroll-lock and the built-in close X —
// no new dependency. On desktop the sheet centers as a max-w-lg modal.
//
// SKU model honesty: NOMOFEE variants are FLAT rows (optionName + optionValue
// per variant, e.g. "Size: M") — there is no multi-dimensional option matrix
// in the data model, so the compatibility engine operates on the real rows:
// each option value IS a resolvable SKU; sold-out rows are disabled with a
// clear visual state and cannot be purchased. Per-SKU price / compare-at /
// stock / MOQ / imagery update the header immediately on every change.
// ============================================================================
import { useMemo } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { QtyStepper } from "../ui-bits";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { PdpVariantT } from "./types";

export function PdpVariantSheet({
  open,
  onOpenChange,
  title,
  productImage,
  variants,
  variantId,
  onSelectVariant,
  qty,
  onQtyChange,
  onAddToCart,
  onBuyNow,
  adding,
  onOosInteraction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  productImage: string | null;
  variants: PdpVariantT[];
  variantId: string | null;
  onSelectVariant: (id: string) => void;
  qty: number;
  onQtyChange: (v: number) => void;
  /** Shared, server-validated handlers (identical to the inline buttons). */
  onAddToCart: () => Promise<boolean>;
  onBuyNow: () => void;
  adding: boolean;
  /** Fired when a shopper taps a genuinely sold-out option. */
  onOosInteraction: (variantId: string) => void;
}) {
  const variant = useMemo(() => variants.find((v) => v.id === variantId) ?? null, [variants, variantId]);
  const moq = Math.max(1, variant?.moq ?? 1);
  const maxQty = variant ? Math.max(moq, variant.stock) : 99;
  const price = variant?.priceMinor ?? null;
  const compareAt = variant?.compareAtPriceMinor ?? null;
  const off = compareAt && price != null && compareAt > price ? Math.round(100 - (price / compareAt) * 100) : null;

  // Group rows by optionName. The normal case is ONE group ("Size", "Colour"
  // …). Pathological multi-group data (rows spanning different optionNames)
  // collapses into a single "Variant" list labelled by each row's own name —
  // honest to the flat model, never inventing combinations.
  const groups = useMemo(() => {
    const byName = new Map<string, PdpVariantT[]>();
    for (const v of variants) {
      const key = v.optionName ?? "Option";
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(v);
    }
    const entries = [...byName.entries()];
    if (entries.length <= 1) return entries;
    return [["Variant", variants] as [string, PdpVariantT[]]];
  }, [variants]);

  const headerImage = variant?.imageUrl ?? productImage;

  const pick = (v: PdpVariantT) => {
    if (v.stock <= 0) {
      onOosInteraction(v.id);
      toast.info("That option is sold out", { description: "Pick another one — it restocks when the seller replenishes stock." });
      return;
    }
    onSelectVariant(v.id);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto flex max-h-[88dvh] gap-0 rounded-t-3xl px-0 pb-0 sm:max-w-lg sm:rounded-t-3xl"
        aria-label="Select product options"
      >
        <SheetHeader className="space-y-0 border-b px-4 pb-3 pt-3">
          <SheetTitle className="sr-only">{title} — select options</SheetTitle>
          <SheetDescription className="sr-only">Choose an option and quantity, then add to cart or buy now.</SheetDescription>
          {/* dynamic product header — reflects the CURRENT selection */}
          <div className="flex items-start gap-3 pr-10">
            <span className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border bg-muted">
              {headerImage ? <img src={headerImage} alt="" className="h-full w-full object-cover" /> : null}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
              {price != null ? (
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xl font-extrabold text-teal-700">{formatMinor(price)}</span>
                  {compareAt && compareAt > price ? (
                    <>
                      <span className="text-sm text-muted-foreground line-through">{formatMinor(compareAt)}</span>
                      {off ? <Badge className="bg-brand-gradient-deep hover:bg-brand-gradient-deep">-{off}%</Badge> : null}
                    </>
                  ) : null}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Select an option to see pricing</span>
              )}
              {/* real inventory state */}
              {variant ? (
                variant.stock > 0 ? (
                  <p className={cn("text-xs font-semibold", variant.stock <= variant.lowStockThreshold ? "text-amber-600" : "text-muted-foreground")}>
                    {variant.stock <= variant.lowStockThreshold ? `Only ${variant.stock} left` : `${variant.stock} available`}
                  </p>
                ) : (
                  <p className="text-xs font-semibold text-rose-600">Out of stock</p>
                )
              ) : null}
              {/* current selected-option summary */}
              <p className="truncate text-xs text-muted-foreground">
                {variant ? `${variant.optionName ?? "Option"}: ${variant.optionValue ?? variant.name}` : "Not selected"}
                {variant && qty > 1 ? ` · ×${qty}` : ""}
              </p>
            </div>
          </div>
        </SheetHeader>

        {/* scrollable body: option groups + quantity */}
        <div className="space-y-5 overflow-y-auto px-4 py-4">
          {groups.map(([groupName, rows]) => (
            <div key={groupName} className="space-y-2.5">
              <p className="text-sm font-semibold">
                {groupName}
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {variant && rows.some((r) => r.id === variant.id) ? `— ${variant.optionValue ?? variant.name}` : "— not selected"}
                </span>
              </p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`Choose ${groupName.toLowerCase()}`}>
                {rows.map((v) => {
                  const soldOut = v.stock <= 0;
                  const selected = v.id === variantId;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-disabled={soldOut}
                      data-disabled={soldOut || undefined}
                      onClick={() => pick(v)}
                      className={cn(
                        "inline-flex min-h-[44px] items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-all",
                        selected
                          ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                          : "bg-background hover:border-teal-600/60",
                        soldOut && "cursor-not-allowed opacity-40"
                      )}
                    >
                      {v.imageUrl ? (
                        <img src={v.imageUrl} alt="" className={cn("h-6 w-6 rounded-full border object-cover", selected ? "border-white/60" : "border-neutral-200")} loading="lazy" />
                      ) : null}
                      <span className={cn(soldOut && "line-through")}>{v.optionValue ?? v.name}</span>
                      {soldOut ? <span className="rounded bg-rose-100 px-1 py-0.5 text-[10px] font-bold uppercase text-rose-700">out</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">
              Quantity
              {moq > 1 ? <span className="ml-1.5 font-normal text-muted-foreground">· min {moq}</span> : null}
            </p>
            <QtyStepper value={Math.max(qty, moq)} min={moq} onChange={onQtyChange} max={maxQty} />
          </div>
          {variant && variant.stock > 0 && variant.stock <= variant.lowStockThreshold ? (
            <p className="text-xs font-semibold text-amber-600">Only {variant.stock} left — order soon.</p>
          ) : null}
        </div>

        {/* purchase actions — the SAME server-validated handlers as the page */}
        <div className="mt-auto grid grid-cols-2 gap-2.5 border-t bg-background p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <Button
            size="lg"
            disabled={adding || !variant || variant.stock <= 0}
            onClick={async () => {
              if (await onAddToCart()) onOpenChange(false);
            }}
            className="min-h-[48px] border-teal-700/40 bg-card text-teal-800 hover:bg-teal-50"
            variant="outline"
          >
            {adding ? "Adding…" : "Add to cart"}
          </Button>
          <Button
            size="lg"
            disabled={adding || !variant || variant.stock <= 0}
            onClick={onBuyNow}
            className="min-h-[48px] bg-brand-gradient text-white shadow-md hover:brightness-110"
          >
            Buy now
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

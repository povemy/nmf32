"use client";
// ============================================================================
// HomeCategoryGrid (work order 14 §6) — category discovery from the EXISTING
// category tree (no second category system). Root categories with the shared
// icon heuristic; children remain reachable via the header dropdown/sheet and
// the category listing itself. When roots exceed 12 the grid caps and shows a
// View-all that opens the full category browser (the header's categories
// menu pattern is reused via a lightweight inline expansion).
//
// Desktop revamp (reference layout): md+ renders bare SOFT-TINTED circles
// (rotating palette) in the WO1 grid.
// MOBILE homepage work order 2 (reference layout): below md the categories
// render as ONE horizontally-scrollable row of pastel circles — the
// reference "Shop by Category" band. Sub-category counts stay desktop-only
// (the reference keeps mobile labels clean).
// ============================================================================
import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { categoryIcon } from "../market";
import { SectionShell } from "./section-shell";
import type { CategoryT, ShopperCtx } from "../ui-bits";

const CAP = 12;

// Rotating circle tints — applied at BASE (mobile row + desktop grid share
// the same accent families: teal/amber/rose/emerald/sky/violet/orange) so the
// variety reads intentional rather than random. Exported for the mobile
// header category strip (same style family everywhere).
export const CATEGORY_TINTS = [
  "bg-teal-100 text-teal-700",
  "bg-amber-100 text-amber-600",
  "bg-rose-100 text-rose-600",
  "bg-emerald-100 text-emerald-600",
  "bg-sky-100 text-sky-600",
  "bg-violet-100 text-violet-600",
  "bg-orange-100 text-orange-600",
] as const;

export function HomeCategoryGrid({ categories, ctx }: { categories: CategoryT[]; ctx: ShopperCtx }) {
  const [expanded, setExpanded] = useState(false);
  if (categories.length === 0) return null;

  const capped = categories.length > CAP;
  const shown = expanded || !capped ? categories : categories.slice(0, CAP);

  return (
    <SectionShell
      id="home-categories"
      title="Shop by category"
      subtitle="Everything our sellers offer, organised"
      icon={<LayoutGrid className="h-5 w-5 text-teal-700" />}
      viewAll={
        capped
          ? {
              label: expanded ? "Show fewer" : "View all categories",
              onClick: () => setExpanded((e) => !e),
            }
          : undefined
      }
    >
      {/* Mobile (<md): single scrollable circle row (reference layout).
          Desktop (md+): the WO1 bare-circle grid. */}
      <div className="flex snap-x gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:grid md:snap-none md:grid-cols-6 md:gap-2.5 md:overflow-visible md:pb-0 lg:grid-cols-8">
        {shown.map((cat, i) => {
          const Icon = categoryIcon(cat.name);
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => ctx.nav({ name: "category", categorySlug: cat.slug, label: cat.name })}
              className={cn(
                "group flex w-[5.25rem] shrink-0 snap-start flex-col items-center gap-1.5 md:w-auto md:min-h-[44px] md:gap-2 md:p-2 md:hover:-translate-y-0.5"
              )}
              aria-label={`Browse ${cat.name}`}
            >
              <span
                className={cn(
                  "flex h-12 w-12 items-center justify-center rounded-full transition-all group-hover:bg-brand-gradient group-hover:text-white md:h-12 md:w-12",
                  CATEGORY_TINTS[i % CATEGORY_TINTS.length]
                )}
              >
                <Icon className="h-6 w-6 md:h-6 md:w-6" />
              </span>
              <span className="text-center text-xs font-medium leading-tight line-clamp-2">{cat.name}</span>
              {cat.children.length > 0 ? (
                <span className="hidden text-[10px] text-muted-foreground md:block">
                  {cat.children.length} sub-categor{cat.children.length === 1 ? "y" : "ies"}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </SectionShell>
  );
}

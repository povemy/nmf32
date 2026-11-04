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
// (rotating palette, like the reference's "Shop by Category" row) with the
// card chrome dissolved; below md the original white-card tiles are
// byte-for-byte unchanged (mobile styling is out of scope).
// ============================================================================
import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { categoryIcon } from "../market";
import { SectionShell } from "./section-shell";
import type { CategoryT, ShopperCtx } from "../ui-bits";

const CAP = 12;

// Rotating desktop-only circle tints — the same accent families the rest of
// the homepage already uses (teal/amber/rose/emerald/sky/violet/orange), so
// the variety reads intentional rather than random.
const MD_TINTS = [
  "md:bg-teal-100 md:text-teal-700",
  "md:bg-amber-100 md:text-amber-600",
  "md:bg-rose-100 md:text-rose-600",
  "md:bg-emerald-100 md:text-emerald-600",
  "md:bg-sky-100 md:text-sky-600",
  "md:bg-violet-100 md:text-violet-600",
  "md:bg-orange-100 md:text-orange-600",
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
      <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {shown.map((cat, i) => {
          const Icon = categoryIcon(cat.name);
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => ctx.nav({ name: "category", categorySlug: cat.slug, label: cat.name })}
              className={cn(
                "group flex min-h-[44px] flex-col items-center gap-2 rounded-xl border bg-card shadow-soft p-3 transition-all",
                "hover:border-teal-600/50 hover:shadow-md",
                // Desktop (md+): reference-layout bare tinted circles.
                "md:border-transparent md:bg-transparent md:p-2 md:shadow-none md:hover:shadow-none md:hover:border-transparent md:hover:-translate-y-0.5"
              )}
              aria-label={`Browse ${cat.name}`}
            >
              <span
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-teal-700 transition-all",
                  "group-hover:bg-brand-gradient group-hover:text-white md:h-12 md:w-12",
                  MD_TINTS[i % MD_TINTS.length]
                )}
              >
                <Icon className="h-5 w-5 md:h-6 md:w-6" />
              </span>
              <span className="text-center text-xs font-medium leading-tight line-clamp-2">{cat.name}</span>
              {cat.children.length > 0 ? (
                <span className="text-[10px] text-muted-foreground">
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

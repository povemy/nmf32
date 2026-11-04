"use client";
// ============================================================================
// HomeQuickAccess (work order 14 §3) — permanent marketplace shortcuts with
// REAL destinations only (every tile navigates or scrolls somewhere that
// exists). Admin-managed PROMO TILES (campaign placement "promo_tile") are
// appended AFTER the permanent shortcuts — temporary festive promotions stay
// clearly separated from permanent navigation, never mixed into one confusing
// row.
//
// MOBILE homepage work order 2 (reference layout): below md the shortcuts
// render as ONE horizontally-scrollable row of coloured circles inside a
// white rounded card (reference "quick access" band). Desktop (md+) keeps
// the WO1 bare-circle grid — byte-for-byte unchanged.
// ============================================================================
import { motion } from "framer-motion";
import {
  LayoutGrid,
  Zap,
  TrendingUp,
  Sparkles,
  Store,
  Ticket,
  PackageSearch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ShopperCtx } from "../ui-bits";
import { HOME_SECTION_IDS, isExternalCta, scrollHomeSection, useCampaignNav, ExternalCtaLink } from "./cta";
import type { PromoTileT } from "./types";

type Shortcut = {
  key: string;
  label: string;
  icon: typeof Zap;
  action: (ctx: ShopperCtx) => void;
  /** Tinted circle (reference layout: coloured quick-entry circles) —
   *  applied at BASE so mobile and desktop share the same accent families
   *  (amber = deals, rose = popular, emerald = new, sky = stores, …). */
  tint?: string;
};

// Permanent shortcuts — each maps to a real shopper view or homepage section.
// Tints reuse the SAME accent families the homepage section icons already use
// (amber = deals, rose = popular, emerald = new, sky = stores, …) so the
// variety reads intentional, not random.
const SHORTCUTS: Shortcut[] = [
  {
    key: "categories",
    label: "Categories",
    icon: LayoutGrid,
    action: () => scrollHomeSection(HOME_SECTION_IDS.categories),
    tint: "bg-teal-100 text-teal-700",
  },
  {
    key: "deals",
    label: "Flash Deals",
    icon: Zap,
    action: () => scrollHomeSection(HOME_SECTION_IDS.flashDeals),
    tint: "bg-amber-100 text-amber-600",
  },
  {
    key: "popular",
    label: "Popular",
    icon: TrendingUp,
    action: (ctx) => ctx.nav({ name: "search", q: "", sort: "popular" }),
    tint: "bg-rose-100 text-rose-600",
  },
  {
    key: "new",
    label: "New Arrivals",
    icon: Sparkles,
    action: (ctx) => ctx.nav({ name: "search", q: "", sort: "newest" }),
    tint: "bg-emerald-100 text-emerald-600",
  },
  {
    key: "stores",
    label: "Featured Stores",
    icon: Store,
    action: () => scrollHomeSection(HOME_SECTION_IDS.stores),
    tint: "bg-sky-100 text-sky-600",
  },
  {
    key: "vouchers",
    label: "Vouchers",
    icon: Ticket,
    action: (ctx) => ctx.nav({ name: "me", tab: "vouchers" }),
    tint: "bg-violet-100 text-violet-600",
  },
  {
    key: "track",
    label: "Track Order",
    icon: PackageSearch,
    action: (ctx) => ctx.nav({ name: "lookup" }),
    tint: "bg-orange-100 text-orange-600",
  },
];

export function HomeQuickAccess({
  ctx,
  promoTiles,
}: {
  ctx: ShopperCtx;
  promoTiles: PromoTileT[];
}) {
  const campaignNav = useCampaignNav(ctx);
  const tiles = promoTiles.slice(0, 2);

  return (
    <section aria-label="Quick access" className="mx-auto max-w-7xl px-4">
      {/* Mobile (<md): single scrollable row inside one white card (reference
          quick-access band). Desktop (md+): the WO1 bare-circle grid. */}
      <div className="flex snap-x gap-1 overflow-x-auto rounded-2xl border bg-card p-2.5 shadow-soft [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:grid md:snap-none md:grid-cols-8 md:gap-2.5 md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none lg:grid-cols-9">
        {SHORTCUTS.map(({ key, label, icon: Icon, action, tint }) => (
          <button
            key={key}
            type="button"
            onClick={() => action(ctx)}
            className={cn(
              "group flex w-[4.5rem] shrink-0 snap-start flex-col items-center gap-1.5 rounded-xl p-1 transition-all md:w-auto md:min-h-[44px] md:gap-2 md:p-2 md:hover:-translate-y-0.5"
            )}
            aria-label={label}
          >
            <span
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-full transition-all group-hover:bg-brand-gradient group-hover:text-white md:h-11 md:w-11",
                tint
              )}
            >
              <Icon className="h-5 w-5 md:h-5 md:w-5" />
            </span>
            <span className="text-center text-[11px] font-medium leading-tight line-clamp-2">{label}</span>
          </button>
        ))}

        {/* Admin-managed promo tiles — visually distinct festive shortcuts.
            Mobile: same scroll row (the themed ornament circle carries the
            distinction); desktop: WO1 bare-circle grid behaviour. */}
        {tiles.map((tile) => {
          const inner = (
            <>
              <span
                className="flex h-11 w-11 items-center justify-center rounded-full text-base md:h-11 md:w-11"
                style={{ background: tile.theme.accentSoft, color: tile.theme.accent }}
                aria-hidden="true"
              >
                {tile.theme.ornament}
              </span>
              <span className="text-center text-[11px] font-semibold leading-tight line-clamp-2">{tile.name}</span>
            </>
          );
          return isExternalCta(tile.cta) ? (
            <ExternalCtaLink
              key={tile.id}
              url={tile.cta.url}
              ariaLabel={tile.name}
              className="group flex w-[4.5rem] shrink-0 snap-start flex-col items-center gap-1.5 rounded-xl p-1 transition-all md:w-auto md:min-h-[44px] md:gap-2 md:bg-transparent md:p-2 md:hover:-translate-y-0.5"
            >
              {inner}
            </ExternalCtaLink>
          ) : (
            <motion.button
              key={tile.id}
              type="button"
              whileTap={{ scale: 0.96 }}
              onClick={() => campaignNav(tile.cta)}
              aria-label={`${tile.name} — promotional shortcut`}
              className="group flex w-[4.5rem] shrink-0 snap-start flex-col items-center gap-1.5 rounded-xl p-1 transition-all md:w-auto md:min-h-[44px] md:gap-2 md:p-2 md:hover:-translate-y-0.5"
              style={{ borderColor: tile.theme.accentSoft }}
            >
              {inner}
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}

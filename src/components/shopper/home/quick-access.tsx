"use client";
// ============================================================================
// HomeQuickAccess (work order 14 §3) — permanent marketplace shortcuts with
// REAL destinations only (every tile navigates or scrolls somewhere that
// exists). Admin-managed PROMO TILES (campaign placement "promo_tile") are
// appended AFTER the permanent shortcuts — temporary festive promotions stay
// clearly separated from permanent navigation, never mixed into one confusing
// row.
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
};

// Permanent shortcuts — each maps to a real shopper view or homepage section.
const SHORTCUTS: Shortcut[] = [
  {
    key: "categories",
    label: "Categories",
    icon: LayoutGrid,
    action: () => scrollHomeSection(HOME_SECTION_IDS.categories),
  },
  {
    key: "deals",
    label: "Flash Deals",
    icon: Zap,
    action: () => scrollHomeSection(HOME_SECTION_IDS.flashDeals),
  },
  {
    key: "popular",
    label: "Popular",
    icon: TrendingUp,
    action: (ctx) => ctx.nav({ name: "search", q: "", sort: "popular" }),
  },
  {
    key: "new",
    label: "New Arrivals",
    icon: Sparkles,
    action: (ctx) => ctx.nav({ name: "search", q: "", sort: "newest" }),
  },
  {
    key: "stores",
    label: "Featured Stores",
    icon: Store,
    action: () => scrollHomeSection(HOME_SECTION_IDS.stores),
  },
  {
    key: "vouchers",
    label: "Vouchers",
    icon: Ticket,
    action: (ctx) => ctx.nav({ name: "me", tab: "vouchers" }),
  },
  {
    key: "track",
    label: "Track Order",
    icon: PackageSearch,
    action: (ctx) => ctx.nav({ name: "lookup" }),
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
      <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-9">
        {SHORTCUTS.map(({ key, label, icon: Icon, action }) => (
          <button
            key={key}
            type="button"
            onClick={() => action(ctx)}
            className="group flex min-h-[44px] flex-col items-center gap-2 rounded-xl border bg-card shadow-soft p-3 transition-all hover:border-teal-600/50 hover:shadow-md"
            aria-label={label}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-50 text-teal-700 transition-all group-hover:bg-brand-gradient group-hover:text-white">
              <Icon className="h-4 w-4" />
            </span>
            <span className="text-center text-[11px] font-medium leading-tight line-clamp-2">{label}</span>
          </button>
        ))}

        {/* Admin-managed promo tiles — visually distinct festive shortcuts. */}
        {tiles.map((tile) => {
          const inner = (
            <>
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full text-base"
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
              className="group flex min-h-[44px] flex-col items-center gap-2 rounded-xl border-2 bg-card p-3 shadow-soft transition-all hover:shadow-md"
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
              className="group flex min-h-[44px] flex-col items-center gap-2 rounded-xl border-2 bg-card p-3 shadow-soft transition-all hover:shadow-md"
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

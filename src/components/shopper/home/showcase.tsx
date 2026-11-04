"use client";
// ============================================================================
// HomeShowcase (work order 14 §4) — the festive & seasonal campaign grid.
// Every card is a LIVE campaign from the Admin Campaign system (placement
// "showcase"): the public API only returns campaigns inside their scheduled
// window, so expired/scheduled/draft campaigns disappear/appear automatically
// — no manual cleanup, no hardcoded seasons. The client-side "ends in" chip
// is cosmetic; eligibility is decided server-side.
// ============================================================================
import { motion } from "framer-motion";
import { ChevronRight, PartyPopper } from "lucide-react";
import { cn } from "@/lib/utils";
import { daysUntil } from "@/lib/campaigns";
import { SectionShell } from "./section-shell";
import { ExternalCtaLink, isExternalCta, useCampaignNav } from "./cta";
import type { ShopperCtx } from "../ui-bits";
import type { ShowcaseCardT } from "./types";

export function HomeShowcase({ cards, ctx }: { cards: ShowcaseCardT[]; ctx: ShopperCtx }) {
  const campaignNav = useCampaignNav(ctx);
  if (cards.length === 0) return null;

  return (
    <SectionShell
      id="home-showcase"
      title="Festive & seasonal campaigns"
      subtitle="Celebration sales curated by the NOMOFEE team"
      icon={<PartyPopper className="h-5 w-5 text-teal-700" />}
    >
      {/* Desktop homepage work order: three-column banner layout on md+ (the
          reference layout); MOBILE homepage work order 2: below md each card
          becomes a compact promo BANNER (reference dual-banner row) — artwork
          fills the tile, text overlays a bottom scrim, CTA pill on white. When
          fewer campaigns are live the grid simply renders fewer cards (no
          fabricated padding banners). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {cards.map((c, i) => {
          const days = daysUntil(c.endsAt);
          // Odd count below sm: the lone last banner spans full width instead
          // of dangling at half width (reference pairs its banners).
          const loneTail = cards.length % 2 === 1 && i === cards.length - 1;
          const cardCls = loneTail ? "col-span-2 sm:col-span-1" : "";
          const body = (
            <>
              {/* artwork — fills the card below md (banner mode); static
                  image block with fixed heights on md+ (WO1 card layout). */}
              <div className="absolute inset-0 overflow-hidden md:relative md:h-36 lg:h-40">
                {c.thumbnailUrl ? (
                  <img src={c.thumbnailUrl} alt={c.name} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <span
                    className="flex h-full w-full items-center justify-center text-4xl"
                    style={{ background: `linear-gradient(135deg, ${c.theme.gradientFrom}, ${c.theme.gradientTo})` }}
                    aria-hidden="true"
                  >
                    {c.theme.ornament}
                  </span>
                )}
                <span
                  className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold shadow-sm"
                  style={{ background: c.theme.accentSoft, color: c.theme.accent }}
                >
                  {days > 0 ? `Ends in ${days}d` : "Final hours"}
                </span>
              </div>
              {/* text — overlaid on the artwork below md; card body on md+. */}
              <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/75 via-black/40 to-transparent p-3 pt-7 md:static md:flex-1 md:gap-1 md:bg-none md:p-3 md:pt-3">
                <p className="text-sm font-bold leading-tight line-clamp-1 text-white md:text-base md:text-foreground">{c.name}</p>
                {c.description ? (
                  <p className="text-xs line-clamp-1 text-white/80 md:text-muted-foreground md:line-clamp-1">{c.description}</p>
                ) : (
                  <p className="text-xs line-clamp-1 text-white/80 md:text-muted-foreground">{c.theme.tagline}</p>
                )}
                {/* CTA — solid white pill below md (readable over the scrim);
                    WO1 accent-outline pill on md+. */}
                <span
                  className="mt-auto inline-flex w-fit items-center gap-1 rounded-full border bg-white/95 px-3 py-1 text-xs font-semibold transition-colors md:bg-transparent"
                  style={{ borderColor: c.theme.accent, color: c.theme.accent }}
                >
                  {c.ctaLabel} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </div>
            </>
          );

          return isExternalCta(c.cta) ? (
            <ExternalCtaLink
              key={c.id}
              url={c.cta.url}
              ariaLabel={`${c.ctaLabel} — ${c.name}`}
              className={cn("relative flex h-32 flex-col overflow-hidden rounded-xl border bg-card shadow-soft text-left transition-all hover:shadow-md md:h-auto", cardCls)}
            >
              {body}
            </ExternalCtaLink>
          ) : (
            <motion.button
              key={c.id}
              type="button"
              whileTap={{ scale: 0.98 }}
              onClick={() => campaignNav(c.cta)}
              aria-label={`${c.ctaLabel} — ${c.name}`}
              className={cn("relative flex h-32 flex-col overflow-hidden rounded-xl border bg-card shadow-soft text-left transition-all hover:shadow-md md:h-auto", cardCls)}
            >
              {body}
            </motion.button>
          );
        })}
      </div>
    </SectionShell>
  );
}

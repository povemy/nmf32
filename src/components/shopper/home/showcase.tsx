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
          reference layout); mobile keeps the original 2-column grid — and when
          fewer than three campaigns are live the grid simply renders fewer
          cards (no fabricated padding banners). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {cards.map((c) => {
          const days = daysUntil(c.endsAt);
          const body = (
            <>
              <div className="relative h-24 overflow-hidden sm:h-28 md:h-36 lg:h-40">
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
              <div className="flex flex-1 flex-col gap-1 p-3">
                <p className="text-sm font-bold leading-tight line-clamp-1 md:text-base">{c.name}</p>
                {c.description ? (
                  <p className="text-xs text-muted-foreground line-clamp-2 md:line-clamp-1">{c.description}</p>
                ) : (
                  <p className="text-xs text-muted-foreground line-clamp-1">{c.theme.tagline}</p>
                )}
                {/* Desktop revamp (reference layout): pill CTA button in the
                    campaign's own accent colour instead of a plain text link. */}
                <span
                  className="mt-auto inline-flex w-fit items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold transition-colors"
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
              className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-soft text-left transition-all hover:shadow-md"
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
              className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-soft text-left transition-all hover:shadow-md"
            >
              {body}
            </motion.button>
          );
        })}
      </div>
    </SectionShell>
  );
}

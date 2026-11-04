"use client";
// ============================================================================
// HomeInline (work order 14 §9) — modular promo slots rendered BETWEEN
// homepage sections, driven by live campaigns with placement "inline":
//   • banner mode  — desktop/mobile creative (or themed gradient), CTA;
//   • shelf mode   — the campaign carries a product query; a real product
//                    rail renders below the banner from the SAME active-product
//                    eligibility as every other section (a curated shelf, NOT
//                    a discount rule — prices are untouched).
// The number of inline slots and their positions are admin-controlled via
// the homepage section order (Setting home.section_order).
// ============================================================================
import { motion } from "framer-motion";
import { ChevronRight, Store } from "lucide-react";
import { HomeProductRail } from "./product-rail";
import { ExternalCtaLink, isExternalCta, useCampaignNav } from "./cta";
import type { ShopperCtx } from "../ui-bits";
import type { InlineModuleT } from "./types";

export function HomeInline({ mod, ctx }: { mod: InlineModuleT; ctx: ShopperCtx }) {
  const campaignNav = useCampaignNav(ctx);
  const t = mod.theme;

  const bannerBody = (
    <>
      {mod.bannerDesktopUrl ? (
        <img src={mod.bannerDesktopUrl} alt={mod.heading} className="absolute inset-0 hidden h-full w-full object-cover sm:block" loading="lazy" />
      ) : null}
      {mod.bannerMobileUrl ?? mod.bannerDesktopUrl ? (
        <img
          src={mod.bannerMobileUrl ?? (mod.bannerDesktopUrl as string)}
          alt={mod.heading}
          className="absolute inset-0 h-full w-full object-cover sm:hidden"
          loading="lazy"
        />
      ) : (
        <span className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${t.gradientFrom}, ${t.gradientTo})` }} aria-hidden="true" />
      )}
      {mod.bannerDesktopUrl ? <span className="absolute inset-0 bg-gradient-to-r from-black/50 via-black/20 to-transparent" aria-hidden="true" /> : null}
      {!mod.bannerDesktopUrl ? (
        <>
          <span aria-hidden="true" className="pointer-events-none absolute -left-2 -top-3 select-none text-5xl opacity-20">
            {t.ornament}
          </span>
          <span aria-hidden="true" className="pointer-events-none absolute -bottom-4 right-10 select-none text-6xl opacity-15">
            {t.ornament}
          </span>
        </>
      ) : null}
      <span className="relative flex h-full flex-col items-start justify-center gap-1 p-4 sm:p-6">
        <span className="text-[11px] font-bold uppercase tracking-widest text-white/75">
          {t.ornament} {mod.name}
        </span>
        <span className="text-base font-extrabold leading-snug text-white line-clamp-1 sm:text-xl">{mod.heading}</span>
        {mod.subtext ? <span className="hidden text-xs text-white/85 line-clamp-1 sm:inline">{mod.subtext}</span> : null}
        <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-white/95 px-3 py-1.5 text-xs font-semibold text-teal-800 shadow-sm">
          {mod.ctaLabel} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </span>
    </>
  );

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="space-y-2.5 sm:space-y-3"
      aria-label={`${mod.name} promotion`}
    >
      {isExternalCta(mod.cta) ? (
        <ExternalCtaLink
          url={mod.cta.url}
          ariaLabel={`${mod.ctaLabel} — ${mod.name}`}
          className="relative block h-32 overflow-hidden rounded-2xl border shadow-soft sm:h-40"
        >
          {bannerBody}
        </ExternalCtaLink>
      ) : (
        <button
          type="button"
          onClick={() => campaignNav(mod.cta)}
          aria-label={`${mod.ctaLabel} — ${mod.name}`}
          className="relative block h-32 w-full overflow-hidden rounded-2xl border text-left shadow-soft sm:h-40"
        >
          {bannerBody}
        </button>
      )}

      {mod.products.length > 0 ? (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-teal-700" aria-hidden="true" />
            <p className="text-sm font-bold tracking-tight">
              Curated for {mod.name}
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">picked with “{mod.productQuery}”</span>
            </p>
          </div>
          <HomeProductRail products={mod.products} ctx={ctx} ariaLabel={`${mod.name} product shelf`} />
        </div>
      ) : null}
    </motion.section>
  );
}

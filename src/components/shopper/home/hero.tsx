"use client";
// ============================================================================
// HomeHero — the main promotional area (work order 14 §2). Campaign slides
// come from the Admin Campaign system (placement "hero"); legacy
// MarketplaceBanners pad the carousel; when neither exists a default branded
// slide renders (never an empty section). Desktop/mobile image variants,
// CTA per slide, autoplay with pause controls + reduced-motion respect,
// touch swipe, dots + arrows. Secondary promo tiles (placement
// "hero_secondary") sit beside the carousel on desktop.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ShopperCtx } from "../ui-bits";
import { ExternalCtaLink, isExternalCta, useCampaignNav } from "./cta";
import type { HeroSlideT, HeroTileT } from "./types";

const AUTOPLAY_MS = 6000;
const SWIPE_THRESHOLD_PX = 44;

function DefaultSlide({ ctx }: { ctx: ShopperCtx }) {
  return (
    <button
      type="button"
      onClick={() => ctx.nav({ name: "search", q: "" })}
      className="absolute inset-0 flex w-full flex-col items-center justify-center gap-2 bg-brand-gradient p-5 text-center"
      aria-label="Browse all NOMOFEE products"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15">
        <ShoppingBag className="h-6 w-6 text-white" aria-hidden="true" />
      </span>
      <span className="text-lg font-extrabold text-white sm:text-2xl">Discover the marketplace</span>
      <span className="max-w-md text-xs text-white/85 sm:text-sm">
        Thousands of products from independent Malaysian shops — fresh finds every day.
      </span>
      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-white/95 px-4 py-1.5 text-xs font-semibold text-teal-800 shadow-sm">
        Start shopping <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </button>
  );
}

function SlideBody({
  slide,
  ctx,
  campaignNav,
}: {
  slide: HeroSlideT;
  ctx: ShopperCtx;
  campaignNav: ReturnType<typeof useCampaignNav>;
}) {
  const t = slide.theme;
  const ctaChip = (
    <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-white/95 px-3 py-1.5 text-xs font-semibold text-teal-800 shadow-sm">
      {slide.ctaLabel} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );

  // Image slide (campaign creative or legacy banner).
  if (slide.imageUrl) {
    const mobile = slide.mobileImageUrl ?? slide.imageUrl;
    return (
      <>
        <img src={slide.imageUrl} alt={slide.title} className="hidden h-full w-full object-cover sm:block" loading="eager" />
        <img src={mobile} alt={slide.title} className="h-full w-full object-cover sm:hidden" loading="eager" />
        <span className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent" aria-hidden="true" />
        <span className="absolute inset-0 flex flex-col justify-center gap-1.5 p-5 max-w-lg sm:p-8">
          {slide.kind === "campaign" ? (
            <span className="text-[11px] font-bold uppercase tracking-widest text-amber-300">
              {t?.ornament} {slide.name}
            </span>
          ) : (
            <span className="text-[11px] font-bold uppercase tracking-widest text-amber-300">NOMOFEE picks</span>
          )}
          <span className="text-lg sm:text-2xl font-extrabold text-white leading-snug drop-shadow line-clamp-2">{slide.title}</span>
          {slide.subtext ? <span className="hidden text-xs text-white/85 sm:inline line-clamp-2">{slide.subtext}</span> : null}
          {ctaChip}
        </span>
      </>
    );
  }

  // Themed gradient slide (campaign without creative) — festive colours.
  return (
    <>
      <span
        className="absolute inset-0"
        style={{ background: `linear-gradient(135deg, ${t?.gradientFrom ?? "#00647A"}, ${t?.gradientTo ?? "#00A8C6"})` }}
        aria-hidden="true"
      />
      <span aria-hidden="true" className="pointer-events-none absolute -left-2 -top-4 select-none text-6xl opacity-20">
        {t?.ornament}
      </span>
      <span aria-hidden="true" className="pointer-events-none absolute -bottom-6 right-8 select-none text-7xl opacity-15">
        {t?.ornament}
      </span>
      <span className="absolute inset-0 flex flex-col justify-center gap-1.5 p-5 max-w-lg sm:p-8">
        <span className="text-[11px] font-bold uppercase tracking-widest text-white/75">
          {t?.ornament} {slide.name}
        </span>
        <span className="text-lg sm:text-2xl font-extrabold text-white leading-snug drop-shadow line-clamp-2">{slide.title}</span>
        {slide.subtext ? <span className="hidden text-xs text-white/85 sm:inline line-clamp-2">{slide.subtext}</span> : null}
        {ctaChip}
      </span>
    </>
  );
}

export function HomeHero({
  slides,
  secondary,
  ctx,
}: {
  slides: HeroSlideT[];
  secondary: HeroTileT[];
  ctx: ShopperCtx;
}) {
  const campaignNav = useCampaignNav(ctx);
  const [idx, setIdx] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const touchStartX = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const n = slides.length;

  const go = useCallback(
    (next: number) => {
      if (n === 0) return;
      setIdx(((next % n) + n) % n);
    },
    [n]
  );

  // Autoplay — paused on hover/focus, disabled for reduced-motion users.
  useEffect(() => {
    if (n <= 1 || paused || reducedMotion) return;
    timer.current = setInterval(() => setIdx((i) => (i + 1) % n), AUTOPLAY_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [n, paused, reducedMotion]);

  if (n === 0) {
    // No campaigns, no banners — the default branded slide (never empty).
    return (
      <div className="mx-auto max-w-7xl px-4 pt-4">
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="relative h-44 overflow-hidden rounded-2xl border bg-muted sm:h-56 lg:h-72" aria-roledescription="banner">
            <DefaultSlide ctx={ctx} />
          </div>
          <SecondaryTiles tiles={secondary} ctx={ctx} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pt-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div
          className="relative overflow-hidden rounded-2xl border bg-muted"
          aria-roledescription="carousel"
          aria-label="Featured promotions"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
          onTouchStart={(e) => {
            touchStartX.current = e.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            const start = touchStartX.current;
            touchStartX.current = null;
            if (start == null) return;
            const dx = (e.changedTouches[0]?.clientX ?? start) - start;
            if (Math.abs(dx) >= SWIPE_THRESHOLD_PX) go(idx + (dx < 0 ? 1 : -1));
          }}
        >
          <div className="relative h-44 sm:h-56 lg:h-72" aria-live="polite">
            {slides.map((s, i) => {
              const active = i === idx;
              const inner = <SlideBody slide={s} ctx={ctx} campaignNav={campaignNav} />;
              if (isExternalCta(s.cta)) {
                return (
                  <div
                    key={s.id}
                    aria-hidden={!active}
                    className={cn(
                      "absolute inset-0 w-full transition-opacity duration-700",
                      active ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
                    )}
                  >
                    <ExternalCtaLink url={s.cta.url} ariaLabel={`${s.ctaLabel} — ${s.title}`} className="block h-full w-full">
                      {inner}
                    </ExternalCtaLink>
                  </div>
                );
              }
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-hidden={!active}
                  tabIndex={active ? 0 : -1}
                  aria-label={`${s.ctaLabel} — ${s.title}`}
                  onClick={() => campaignNav(s.cta)}
                  className={cn(
                    "absolute inset-0 w-full text-left transition-opacity duration-700",
                    active ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
                  )}
                >
                  {inner}
                </button>
              );
            })}
          </div>

          {n > 1 ? (
            <>
              <button
                type="button"
                onClick={() => go(idx - 1)}
                aria-label="Previous promotion"
                className="absolute left-2 top-1/2 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-background/85 shadow hover:bg-background transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => go(idx + 1)}
                aria-label="Next promotion"
                className="absolute right-2 top-1/2 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-background/85 shadow hover:bg-background transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5">
                {slides.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => go(i)}
                    aria-label={`Go to promotion ${i + 1}`}
                    aria-current={i === idx}
                    className={cn("h-1.5 rounded-full transition-all", i === idx ? "w-6 bg-white" : "w-1.5 bg-white/60")}
                  />
                ))}
              </div>
              {paused || reducedMotion ? null : (
                <span className="sr-only">Promotions rotate automatically every {AUTOPLAY_MS / 1000} seconds</span>
              )}
            </>
          ) : null}
        </div>

        <SecondaryTiles tiles={secondary} ctx={ctx} />
      </div>
    </div>
  );
}

function SecondaryTiles({ tiles, ctx }: { tiles: HeroTileT[]; ctx: ShopperCtx }) {
  const campaignNav = useCampaignNav(ctx);
  if (tiles.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-1">
      {tiles.slice(0, 2).map((tile) => {
        const inner = (
          <>
            {tile.imageUrl ? (
              <img
                src={tile.imageUrl}
                alt={tile.heading}
                className="absolute inset-0 hidden h-full w-full object-cover sm:block"
                loading="lazy"
              />
            ) : null}
            {tile.mobileImageUrl ?? tile.imageUrl ? (
              <img
                src={tile.mobileImageUrl ?? (tile.imageUrl as string)}
                alt={tile.heading}
                className="absolute inset-0 h-full w-full object-cover sm:hidden"
                loading="lazy"
              />
            ) : (
              <span
                className="absolute inset-0"
                style={{ background: `linear-gradient(135deg, ${tile.theme.gradientFrom}, ${tile.theme.gradientTo})` }}
                aria-hidden="true"
              />
            )}
            {tile.imageUrl ? <span className="absolute inset-0 bg-black/35" aria-hidden="true" /> : null}
            <span className="relative flex h-full flex-col justify-end gap-0.5 p-3 sm:p-4">
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/75">
                {tile.theme.ornament} {tile.name}
              </span>
              <span className="text-sm font-extrabold leading-tight text-white line-clamp-2">{tile.heading}</span>
              <span className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-teal-800">
                {tile.ctaLabel}
              </span>
            </span>
          </>
        );
        if (isExternalCta(tile.cta)) {
          return (
            <ExternalCtaLink
              key={tile.id}
              url={tile.cta.url}
              ariaLabel={`${tile.ctaLabel} — ${tile.name}`}
              className="relative h-28 overflow-hidden rounded-2xl border lg:h-full lg:min-h-[8.5rem]"
            >
              {inner}
            </ExternalCtaLink>
          );
        }
        return (
          <button
            key={tile.id}
            type="button"
            onClick={() => campaignNav(tile.cta)}
            aria-label={`${tile.ctaLabel} — ${tile.name}`}
            className="relative h-28 overflow-hidden rounded-2xl border text-left lg:h-full lg:min-h-[8.5rem]"
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

// Kept for animation parity with the rest of the homepage sections.
export function HomeHeroWrapper(props: React.ComponentProps<typeof HomeHero>) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      <HomeHero {...props} />
    </motion.section>
  );
}

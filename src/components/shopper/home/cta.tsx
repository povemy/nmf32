"use client";
// ============================================================================
// Campaign CTA navigation (work order 14) — ONE resolver shared by every
// homepage campaign surface (hero, tiles, showcase, inline modules). The
// server sends a structured {kind, value}; this hook maps it onto the
// shopper view machine. External links render as real anchors (new tab,
// noopener) via <ExternalCtaLink>; everything else is an in-app button.
// ============================================================================
import { useCallback } from "react";
import { ArrowUpRight } from "lucide-react";
import type { CampaignCta } from "@/lib/campaigns";
import type { ShopperCtx } from "../ui-bits";

/** Scroll a homepage section into view (sections carry stable DOM ids). */
export function scrollHomeSection(id: string): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export const HOME_SECTION_IDS = {
  flashDeals: "home-flash-deals",
  categories: "home-categories",
  stores: "home-stores",
  showcase: "home-showcase",
} as const;

/** Navigate a resolved campaign CTA. `fallback` runs for null CTAs (default:
 *  browse all products — same behaviour the old campaign strip had). */
export function useCampaignNav(ctx: ShopperCtx) {
  return useCallback(
    (cta: CampaignCta | null, fallback?: () => void) => {
      const go = fallback ?? (() => ctx.nav({ name: "search", q: "" }));
      if (!cta) {
        go();
        return;
      }
      switch (cta.kind) {
        case "search":
          ctx.nav({ name: "search", q: cta.q });
          break;
        case "category":
          ctx.nav({ name: "category", categorySlug: cta.slug });
          break;
        case "store":
          ctx.nav({ name: "storefront", slug: cta.slug });
          break;
        case "deals":
          scrollHomeSection(HOME_SECTION_IDS.flashDeals);
          break;
        case "vouchers":
          ctx.nav({ name: "me", tab: "vouchers" });
          break;
        case "external":
          // Validated https-only at write AND read time (lib/campaigns).
          window.open(cta.url, "_blank", "noopener,noreferrer");
          break;
        default:
          go();
      }
    },
    [ctx]
  );
}

/** External CTAs render as anchors so they are real links (middle-click,
 *  long-press, SEO) — never window.open from a click handler only. */
export function ExternalCtaLink({
  url,
  children,
  className,
  ariaLabel,
}: {
  url: string;
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className} aria-label={ariaLabel}>
      {children}
      <ArrowUpRight className="ml-1 inline h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

/** True when a CTA should render as an external anchor instead of a button. */
export function isExternalCta(cta: CampaignCta | null): cta is { kind: "external"; url: string } {
  return cta != null && cta.kind === "external";
}

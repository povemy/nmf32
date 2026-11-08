// ============================================================================
// Homepage public payload types (work order 14) — the client-side view of
// GET /api/market/home, DERIVED from the contract's MarketHomeData
// (src/lib/types/api-contract.ts §4). All campaign CTAs arrive PRE-RESOLVED
// server-side ({kind, value}) — the browser never parses an admin-supplied
// URL — so the only local override is `cta`: the contract's flat transport
// shape (MarketCta) is narrowed to the discriminated CampaignCta union from
// the client-safe campaigns lib (zero runtime Prisma) for type-safe
// navigation. Everything else is the contract type as-is.
// ============================================================================
import type { MarketHomeData } from "@/lib/types/api-contract";
import type { CampaignCta } from "@/lib/campaigns";

/** Hero slide — MarketHomeData["hero"][number] with the pre-resolved CTA. */
export type HeroSlideT = Omit<MarketHomeData["hero"][number], "cta"> & {
  cta: CampaignCta | null;
};

/** Hero secondary tile — MarketHomeData["heroSecondary"][number] + CTA. */
export type HeroTileT = Omit<MarketHomeData["heroSecondary"][number], "cta"> & {
  cta: CampaignCta | null;
};

/** Quick-access promo tile — MarketHomeData["promoTiles"][number] + CTA. */
export type PromoTileT = Omit<MarketHomeData["promoTiles"][number], "cta"> & {
  cta: CampaignCta | null;
};

/** Showcase card — MarketHomeData["showcase"][number] + CTA. */
export type ShowcaseCardT = Omit<MarketHomeData["showcase"][number], "cta"> & {
  cta: CampaignCta | null;
};

/** Inline campaign module — MarketHomeData["inline"][number] + CTA. */
export type InlineModuleT = Omit<MarketHomeData["inline"][number], "cta"> & {
  cta: CampaignCta | null;
};

/** GET /api/market/home payload as the homepage renders it: the contract
 *  MarketHomeData with the five campaign slots carrying the narrowed CTA
 *  union (banners/categories/products/stores/sectionOrder/flashDeals stay
 *  the contract types verbatim). */
export type HomePayload = Omit<MarketHomeData, "hero" | "heroSecondary" | "promoTiles" | "showcase" | "inline"> & {
  hero: HeroSlideT[];
  heroSecondary: HeroTileT[];
  promoTiles: PromoTileT[];
  showcase: ShowcaseCardT[];
  inline: InlineModuleT[];
};

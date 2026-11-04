// ============================================================================
// Homepage public payload types (work order 14) — the client-side mirror of
// GET /api/market/home. Type-only imports from the client-safe campaigns lib
// (zero runtime Prisma). All campaign CTAs arrive PRE-RESOLVED server-side
// ({kind, value}) — the browser never parses an admin-supplied URL.
// ============================================================================
import type { CampaignCta, CampaignThemeT } from "@/lib/campaigns";
import type { HomeSectionId } from "@/lib/home-layout";
import type { CategoryT, ProductCardT, StoreCardT } from "../ui-bits";

export type HeroSlideT = {
  id: string;
  kind: "campaign" | "banner";
  name: string;
  description: string | null;
  ctaLabel: string;
  cta: CampaignCta | null;
  endsAt: string;
  title: string;
  subtext: string | null;
  imageUrl: string | null;
  mobileImageUrl: string | null;
  theme: CampaignThemeT | null;
};

export type HeroTileT = {
  id: string;
  name: string;
  description: string | null;
  ctaLabel: string;
  cta: CampaignCta | null;
  endsAt: string;
  heading: string;
  subtext: string | null;
  imageUrl: string | null;
  mobileImageUrl: string | null;
  theme: CampaignThemeT;
};

export type PromoTileT = {
  id: string;
  name: string;
  theme: CampaignThemeT;
  cta: CampaignCta | null;
};

export type ShowcaseCardT = {
  id: string;
  name: string;
  description: string | null;
  ctaLabel: string;
  cta: CampaignCta | null;
  endsAt: string;
  thumbnailUrl: string | null;
  theme: CampaignThemeT;
};

export type InlineModuleT = {
  id: string;
  name: string;
  description: string | null;
  ctaLabel: string;
  cta: CampaignCta | null;
  endsAt: string;
  heading: string;
  subtext: string | null;
  bannerDesktopUrl: string | null;
  bannerMobileUrl: string | null;
  productQuery: string | null;
  products: ProductCardT[];
  theme: CampaignThemeT;
};

export type HomePayload = {
  banners: { id: string; title: string; imageUrl: string; linkUrl: string | null }[];
  categories: CategoryT[];
  featured: ProductCardT[];
  latest: ProductCardT[];
  featuredStores: StoreCardT[];
  sectionOrder: HomeSectionId[];
  hero: HeroSlideT[];
  heroSecondary: HeroTileT[];
  promoTiles: PromoTileT[];
  showcase: ShowcaseCardT[];
  inline: InlineModuleT[];
  flashDeals: { products: ProductCardT[]; campaign: { name: string; endAt: string } | null };
  trending: ProductCardT[];
};

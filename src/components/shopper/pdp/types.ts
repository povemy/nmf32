// ============================================================================
// PDP makeover — shared types for the product detail page composition.
// The payload mirrors GET /api/sf/[slug]/products/[pSlug] (the ONLY data
// source — no mock products, no invented SKUs; pricing/stock stay
// server-authoritative and are revalidated by the cart + checkout routes).
// ============================================================================
import type { CardStyleTokens, ProductCardT } from "../ui-bits";

export type PdpVariantT = {
  id: string;
  name: string;
  optionName: string | null;
  optionValue: string | null;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  stock: number;
  moq: number;
  sku: string | null;
  isActive: boolean;
  /** Seller-uploaded variant imagery (schema field; null → product gallery). */
  imageUrl: string | null;
  /** Seller's real low-stock threshold for this variant. */
  lowStockThreshold: number;
};

export type PdpReviewT = {
  id: string;
  /** orderId != null ⇒ verified purchase — renders the badge. */
  orderId: string | null;
  customerName: string;
  rating: number;
  title: string | null;
  body: string | null;
  reply: string | null;
  createdAt: string;
};

export type PdpPayloadT = {
  product: {
    id: string;
    title: string;
    slug: string;
    description: string;
    priceMinor: number;
    compareAtPriceMinor: number | null;
    ratingAvg: number;
    ratingCount: number;
    salesCount: number;
    /** RAW impressions — post-increment per-GET count (buyer work order). */
    viewCount: number;
    categoryId: string | null;
    categoryName: string | null;
    images: string[];
    /** index i = star i+1; counts over ALL published reviews (server groupBy). */
    ratingDist: number[];
    variants: PdpVariantT[];
  };
  reviews: PdpReviewT[];
  related: ProductCardT[];
  store: {
    id: string;
    name: string;
    slug: string;
    tagline: string | null;
    logoUrl: string | null;
    whatsapp: string | null;
    cardStyle?: CardStyleTokens | null;
  };
};

// ---------------------------------------------------------------------------
// Voucher centre (client projection of GET /api/me/vouchers — wallet + pool)
// ---------------------------------------------------------------------------
export type PdpVoucherT = {
  id: string;
  code: string;
  title: string;
  kind: string; // "discount" | "freeshipping"
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: string;
  startsAt: string | null;
  scope: string; // "PLATFORM" | "STORE"
  storeId: string | null;
  regionLimit: string | null;
  store?: { name: string; slug: string; logoUrl: string | null } | null;
  // claim-centre entries
  quotaRemaining?: number | null;
  claimable?: boolean;
  claimedByMe?: boolean;
  // wallet ("mine") entries
  userVoucherId?: string;
  status?: string; // AVAILABLE | USED | EXPIRED
};

/** Advisory eligibility snapshot for ONE voucher against the live PDP total.
 *  Final eligibility is always revalidated server-side at checkout quote —
 *  this only decides what the PDP may PRESENT as applicable. */
export type VoucherEligibility = {
  claimable: boolean; // can the shopper claim it right now
  expired: boolean;
  quotaExhausted: boolean;
  minSpendMet: boolean;
  /** Estimated best-case discount in minor units (0 for freeshipping). */
  estDiscountMinor: number;
  freeshipping: boolean;
  regionNote: string | null;
};

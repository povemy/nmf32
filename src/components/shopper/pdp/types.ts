// ============================================================================
// PDP makeover — shared types for the product detail page composition.
// The payload is the CONTRACT type for GET /api/sf/[slug]/products/[pSlug]
// (src/lib/types/api-contract.ts §4: PdpData / PdpVariant / SfReviewItem) —
// the ONLY data source (no mock products, no invented SKUs; pricing/stock
// stay server-authoritative and are revalidated by the cart + checkout
// routes). Only the voucher-centre projection below is local: it flattens
// the /api/me/vouchers rows for the merged wallet + claim-centre strip.
// ============================================================================
import type { MeClaimableVoucher } from "@/lib/types/api-contract";

// ---------------------------------------------------------------------------
// Voucher centre (client projection of GET /api/me/vouchers — wallet + pool)
// ---------------------------------------------------------------------------
/** Flat voucher row consumed by the PDP voucher centre. The claim-centre
 *  pool rows ARE this shape (contract MeClaimableVoucher); the wallet rows
 *  (contract MeWalletVoucher) nest the same fields under `.voucher` and are
 *  read flat here exactly as before — kept as-is so runtime behaviour is
 *  unchanged (documented mismatch in the Wave-4 sync report). */
export type PdpVoucherT = MeClaimableVoucher & {
  /** Wallet-detail-only field (MeVoucherDetail.storeId). */
  storeId?: string | null;
  /** Wallet ("mine") rows carry the applied user-voucher id. */
  userVoucherId?: string;
  /** Wallet ("mine") rows carry the availability status. */
  status?: string;
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

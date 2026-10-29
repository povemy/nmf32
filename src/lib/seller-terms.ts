// ============================================================================
// SELLER-FACING PLATFORM TERMS (ADDENDUM #8) — the single server-side source
// for every platform parameter the seller backend displays: commission rate,
// payout hold (grace period), payout minimum and the new-seller moderation
// window. The Seller Dashboard, Wallet, Orders, Settings, Onboarding and the
// pre-auth portal screens all render from this view so an admin change
// (Admin → Commission, Admin → Settings) reflects everywhere automatically.
//
// Authority rules (RX-CHECKLIST #8):
// - Commission %: Seller.commissionOverridePercent ?? CommissionSetting.
//   defaultPercent — the seller's effective DEFAULT rate. Per-item snapshots
//   (order_item.commissionMinor) stay authoritative for money math; product/
//   category/holiday overrides exist per item and cannot be summarized in one
//   number, so UI copy says "default rate" when no seller override applies.
// - Hold: runtime truth is holdUntil = paidAt + (Seller.holdDaysOverride ??
//   CommissionSetting.payoutHoldDays) at both T1 sites in the payment webhook.
//   holdReleaseRule="days_after_delivered" is stored but NOT implemented —
//   display copy must say "after payment".
// - Payout minimum + moderation window: Setting rows payout.min_minor /
//   moderation.first_n (friendly-UI registry keys, both wired).
// ============================================================================
import { db } from "./db";
import { getCommissionSettings } from "./commission";

export type PlatformTerms = {
  /** Effective default commission % for the viewer (seller override or global). */
  commissionPercent: number;
  commissionSource: "seller_override" | "global_default";
  /** Fixed per-order platform fee configured ( CommissionSetting.fixedFeeMinor ). */
  fixedFeeMinor: number;
  hasFixedFee: boolean;
  /** Per-order minimum commission floor ( CommissionSetting.minCommissionMinor ). */
  minCommissionMinor: number;
  hasMinCommission: boolean;
  /** Effective clearing hold — wallet funds mature paidAt + holdDays. */
  holdDays: number;
  holdSource: "seller_override" | "global_default";
  /** Minimum payout request amount ( Setting payout.min_minor ). */
  payoutMinMinor: number;
  /** A new seller's first N products go through review ( Setting moderation.first_n ). */
  moderationFirstN: number;
};

function readSettingNumber(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) return Math.round(v);
  } catch {
    // fall through to fallback — a corrupted row must never break the view
  }
  return fallback;
}

async function readPlatformSettings() {
  const [commission, payoutMinRow, moderationRow] = await Promise.all([
    getCommissionSettings(),
    db.setting.findUnique({ where: { key: "payout.min_minor" } }),
    db.setting.findUnique({ where: { key: "moderation.first_n" } }),
  ]);
  return {
    commission,
    payoutMinMinor: readSettingNumber(payoutMinRow?.valueJson, 1000, 0, 10_000_000),
    moderationFirstN: readSettingNumber(moderationRow?.valueJson, 5, 0, 100),
  };
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, p));
}

/** Seller-scoped effective terms (seller override ?? global default). */
export async function getSellerTerms(sellerId: string): Promise<PlatformTerms> {
  const [{ commission, payoutMinMinor, moderationFirstN }, seller] = await Promise.all([
    readPlatformSettings(),
    db.seller.findUnique({
      where: { id: sellerId },
      select: { commissionOverridePercent: true, holdDaysOverride: true },
    }),
  ]);

  const sellerPercent = seller?.commissionOverridePercent;
  const sellerHold = seller?.holdDaysOverride;

  return {
    commissionPercent: clampPercent(
      sellerPercent != null ? sellerPercent : commission.defaultPercent
    ),
    commissionSource: sellerPercent != null ? "seller_override" : "global_default",
    fixedFeeMinor: Math.max(0, Math.round(commission.fixedFeeMinor)),
    hasFixedFee: commission.fixedFeeMinor > 0,
    minCommissionMinor: Math.max(0, Math.round(commission.minCommissionMinor)),
    hasMinCommission: commission.minCommissionMinor > 0,
    holdDays: Math.min(60, Math.max(0, sellerHold != null ? Math.round(sellerHold) : Math.round(commission.payoutHoldDays))),
    holdSource: sellerHold != null ? "seller_override" : "global_default",
    payoutMinMinor,
    moderationFirstN,
  };
}

// ---------------------------------------------------------------------------
// Public (pre-auth) variant — GLOBAL defaults only, no seller row is read.
// Exposes only business-policy values already printed on the public seller
// landing page (commission %, hold days, fee flags + amounts, payout minimum,
// moderation window). No PII. Served behind a 60 s TTL cache so the unauth
// endpoint can never hammer the DB.
// ---------------------------------------------------------------------------

type PublicCacheEntry = { at: number; data: PlatformTerms };
const g = globalThis as unknown as { __nomofeePublicTermsCache?: PublicCacheEntry };
const PUBLIC_TTL_MS = 60_000;

export async function getPlatformTermsPublic(): Promise<PlatformTerms> {
  const cached = g.__nomofeePublicTermsCache;
  if (cached && Date.now() - cached.at < PUBLIC_TTL_MS) return cached.data;

  const { commission, payoutMinMinor, moderationFirstN } = await readPlatformSettings();
  const data: PlatformTerms = {
    commissionPercent: clampPercent(commission.defaultPercent),
    commissionSource: "global_default",
    fixedFeeMinor: Math.max(0, Math.round(commission.fixedFeeMinor)),
    hasFixedFee: commission.fixedFeeMinor > 0,
    minCommissionMinor: Math.max(0, Math.round(commission.minCommissionMinor)),
    hasMinCommission: commission.minCommissionMinor > 0,
    holdDays: Math.min(60, Math.max(0, Math.round(commission.payoutHoldDays))),
    holdSource: "global_default",
    payoutMinMinor,
    moderationFirstN,
  };
  g.__nomofeePublicTermsCache = { at: Date.now(), data };
  return data;
}

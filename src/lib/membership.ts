// Buyer membership tiers — computed from lifetime PAID spend (minor units).
// Thresholds: SILVER RM0 · GOLD RM500 · PLATINUM RM2,000. The stored
// ShopperUser.membershipLevel is auto-upgraded (never downgraded) when the
// lifetime spend crosses a threshold — surfaced via /api/me/profile.
export const MEMBERSHIP_TIERS = ["SILVER", "GOLD", "PLATINUM"] as const;
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

export const TIER_THRESHOLDS_MINOR: Record<MembershipTier, number> = {
  SILVER: 0,
  GOLD: 50_000,
  PLATINUM: 200_000,
};

/** Order statuses that count as real spend for membership + wallet stats. */
export const PAID_ORDER_STATUSES = ["paid", "processing", "shipped", "delivered", "received", "completed"];

export function tierForSpend(lifetimeSpendMinor: number): MembershipTier {
  if (lifetimeSpendMinor >= TIER_THRESHOLDS_MINOR.PLATINUM) return "PLATINUM";
  if (lifetimeSpendMinor >= TIER_THRESHOLDS_MINOR.GOLD) return "GOLD";
  return "SILVER";
}

export function nextTier(current: MembershipTier): MembershipTier | null {
  const idx = MEMBERSHIP_TIERS.indexOf(current);
  return idx >= 0 && idx < MEMBERSHIP_TIERS.length - 1 ? MEMBERSHIP_TIERS[idx + 1] : null;
}

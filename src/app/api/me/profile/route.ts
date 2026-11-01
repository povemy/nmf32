import { z } from "zod";
import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { sanitizeExternalUrl } from "@/lib/url-guard";
import { PAID_ORDER_STATUSES, tierForSpend, nextTier, TIER_THRESHOLDS_MINOR, MEMBERSHIP_TIERS, type MembershipTier } from "@/lib/membership";
import { getShopperEmailVerified } from "@/lib/guest-otp";

export const dynamic = "force-dynamic";

// GET /api/me/profile — the buyer dashboard profile card:
// identity + membership tier (auto-upgraded on spend) + follow stats + address count.
export const GET = handle(async () => {
  const me = await requireShopper();

  const [shopper, lifetime, addressCount] = await Promise.all([
    db.shopperUser.findUnique({
      where: { id: me.id },
      select: {
        id: true, email: true, fullName: true, username: true, avatarUrl: true,
        phone: true, membershipLevel: true, followingCount: true, followerCount: true,
        createdAt: true,
      },
    }),
    db.order.aggregate({
      where: { shopperId: me.id, status: { in: PAID_ORDER_STATUSES } },
      _sum: { totalMinor: true },
    }),
    db.address.count({ where: { shopperId: me.id } }),
  ]);
  if (!shopper) throw new ApiError(404, "NOT_FOUND", "Shopper not found");

  const lifetimeSpendMinor = lifetime._sum.totalMinor ?? 0;
  const computed = tierForSpend(lifetimeSpendMinor);
  const rank = (t: MembershipTier) => Object.keys(TIER_THRESHOLDS_MINOR).indexOf(t);
  // Never downgrade — keep the higher of stored vs spend-computed tier.
  let tier: MembershipTier = MEMBERSHIP_TIERS.includes(shopper.membershipLevel as MembershipTier)
    ? (shopper.membershipLevel as MembershipTier)
    : "SILVER";
  if (rank(computed) > rank(tier)) {
    tier = computed;
    await db.shopperUser.update({ where: { id: me.id }, data: { membershipLevel: tier } });
  }
  const upcoming = nextTier(tier);
  const tierSinceMinor = TIER_THRESHOLDS_MINOR[tier];
  const nextAtMinor = upcoming ? TIER_THRESHOLDS_MINOR[upcoming] : null;

  // FINAL CLOSURE §2: email-ownership state drives the Me-hub verification
  // card (fail-closed read: missing table → false → card shows, claiming gated).
  const emailVerified = await getShopperEmailVerified(me.id);

  return ok({
    id: shopper.id,
    email: shopper.email,
    emailVerified,
    fullName: shopper.fullName,
    username: shopper.username,
    avatarUrl: shopper.avatarUrl,
    phone: shopper.phone,
    membershipLevel: tier,
    followingCount: shopper.followingCount,
    followerCount: shopper.followerCount,
    memberSince: shopper.createdAt,
    addressCount,
    lifetimeSpendMinor,
    tierProgress: upcoming
      ? {
          nextTier: upcoming,
          nextThresholdMinor: nextAtMinor,
          remainingMinor: Math.max(0, (nextAtMinor ?? 0) - lifetimeSpendMinor),
          percent: Math.min(100, Math.round(((lifetimeSpendMinor - tierSinceMinor) / Math.max(1, (nextAtMinor ?? 0) - tierSinceMinor)) * 100)),
        }
      : null,
  });
});

const patchSchema = z.object({
  fullName: z.string().trim().min(2, "Name is too short").max(80).optional(),
  phone: z.string().trim().regex(/^[+()\d\s-]{6,20}$/, "Phone number is invalid").nullish(),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,24}$/, "Use 3–24 lowercase letters, numbers or underscores")
    .nullish(),
  avatarUrl: z.string().trim().max(500).nullish(),
});

/** D2 — avatar value space is {null, "", "grad:<key>", http(s) URL, site-relative
 *  path}. "grad:" values are platform gradient-avatar enums (rendered as fixed
 *  CSS classes, never as URLs) and must keep passing. Everything else goes
 *  through the URL guard with allowRelative ("/uploads/…" avatars are legal).
 *  A non-empty value that fails the guard is REJECTED (400 VALIDATION) — the
 *  shopper is actively editing the field, so a silent null would look like a
 *  save bug (same error style as the zod failures above). */
function sanitizeAvatarUrl(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  if (/^grad:[a-z0-9-]{1,24}$/.test(raw)) return raw;
  const safe = sanitizeExternalUrl(raw, { allowRelative: true });
  if (!safe) throw new ApiError(400, "VALIDATION", "avatarUrl must be a valid http(s) or site-relative URL");
  return safe;
}

// PATCH /api/me/profile — edit profile settings (name, phone, handle, avatar).
export const PATCH = handle(async (req: Request) => {
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as unknown;
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION", parsed.error.issues[0]?.message ?? "Invalid profile payload");
  }

  const { fullName, phone, username, avatarUrl } = parsed.data;
  const avatarSafe = avatarUrl === undefined ? undefined : sanitizeAvatarUrl(avatarUrl);
  if (username) {
    const clash = await db.shopperUser.findFirst({ where: { username, id: { not: me.id } } });
    if (clash) throw new ApiError(409, "USERNAME_TAKEN", "That username is already taken");
  }

  const updated = await db.shopperUser.update({
    where: { id: me.id },
    data: {
      ...(fullName != null ? { fullName } : {}),
      ...(phone !== undefined ? { phone: phone || null } : {}),
      ...(username !== undefined ? { username: username || null } : {}),
      ...(avatarSafe !== undefined ? { avatarUrl: avatarSafe || null } : {}),
    },
    select: { id: true, fullName: true, username: true, avatarUrl: true, phone: true },
  });
  return ok({ profile: updated });
});

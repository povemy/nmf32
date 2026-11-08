import { handle, ok } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAffiliateSettings, affiliateBalances, resolveReferralCookie } from "@/lib/affiliate";
import type { MeProfileData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/affiliate/me — the signed-in shopper's affiliate context: profile
// (or null), programme settings, sponsor identity, live balances, and the
// pending referral inviter for not-yet-activated users.
export const GET = handle(async () => {
  const me = await requireShopper();
  const [profile, settings] = await Promise.all([
    db.affiliateProfile.findUnique({ where: { userId: me.id } }),
    getAffiliateSettings(),
  ]);
  if (!profile) {
    const touch = await resolveReferralCookie();
    const payload: MeProfileData = { activated: false, settings, invitedBy: touch?.displayName ?? null };
    return ok(payload);
  }
  const [sponsor, balances] = await Promise.all([
    profile.sponsorId
      ? db.affiliateProfile.findUnique({ where: { id: profile.sponsorId }, select: { displayName: true, slug: true } })
      : null,
    affiliateBalances(profile.id),
  ]);
  const payload: MeProfileData = {
    activated: true,
    settings,
    profile: {
      id: profile.id, code: profile.code, slug: profile.slug, status: profile.status,
      displayName: profile.displayName, bio: profile.bio, avatarUrl: profile.avatarUrl,
      payoutRef: profile.payoutRef, payoutVerified: profile.payoutVerifiedAt != null,
      sponsorId: profile.sponsorId,
      sponsorName: sponsor?.displayName ?? null,
      sponsorSlug: sponsor?.slug ?? null,
      termsVersion: profile.termsVersion, termsAcceptedAt: profile.termsAcceptedAt.toISOString(),
      activatedAt: profile.activatedAt.toISOString(),
    },
    balances,
  };
  return ok(payload);
});

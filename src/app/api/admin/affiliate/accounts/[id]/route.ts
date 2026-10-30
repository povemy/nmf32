import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireCap } from "@/lib/auth";
import { affiliateBalances } from "@/lib/affiliate";

export const dynamic = "force-dynamic";

// GET /api/admin/affiliate/accounts/[id] — affiliate detail for investigation:
// profile, sponsor audit trail, commissions, payouts, balances.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireCap("affiliate.manage");
  const { id } = await ctx.params;
  const profile = await db.affiliateProfile.findUnique({
    where: { id },
    include: {
      user: { select: { email: true, fullName: true, createdAt: true } },
      sponsor: { select: { id: true, displayName: true, slug: true } },
    },
  });
  if (!profile) throw new ApiError(404, "NOT_FOUND", "Affiliate not found");

  const [sponsorAudit, commissions, payouts, balances, referralCount] = await Promise.all([
    db.affiliateSponsorAudit.findMany({
      where: { affiliateId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.affiliateCommission.findMany({
      where: { affiliateId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { entries: true },
    }),
    db.affiliatePayout.findMany({ where: { affiliateId: id }, orderBy: { requestedAt: "desc" }, take: 20 }),
    affiliateBalances(id),
    db.affiliateProfile.count({ where: { sponsorId: id } }),
  ]);

  return ok({
    profile: {
      id: profile.id, displayName: profile.displayName, slug: profile.slug, code: profile.code,
      email: profile.user.email, fullName: profile.user.fullName,
      status: profile.status, bio: profile.bio,
      sponsor: profile.sponsor ? { id: profile.sponsor.id, displayName: profile.sponsor.displayName } : null,
      sponsorSource: profile.sponsorSource,
      sponsorAssignedAt: profile.sponsorAssignedAt?.toISOString() ?? null,
      activatedAt: profile.activatedAt.toISOString(),
      suspendedReason: profile.suspendedReason,
      userCreatedAt: profile.user.createdAt.toISOString(),
    },
    balances,
    referralCount,
    sponsorAudit: sponsorAudit.map((a) => ({
      fromSponsorId: a.fromSponsorId, toSponsorId: a.toSponsorId, reason: a.reason,
      actorId: a.actorId, createdAt: a.createdAt.toISOString(),
    })),
    commissions: commissions.map((c) => ({
      id: c.id, orderNumber: c.orderNumber, status: c.status, poolMinor: c.poolMinor,
      rateBps: c.rateBps, createdAt: c.createdAt.toISOString(),
      directMinor: c.entries.find((e) => e.role === "direct")?.amountMinor ?? 0,
      sponsorMinor: c.entries.find((e) => e.role === "sponsor")?.amountMinor ?? 0,
    })),
    payouts: payouts.map((p) => ({
      id: p.id, amountMinor: p.amountMinor, status: p.status, reference: p.reference,
      requestedAt: p.requestedAt.toISOString(), processedAt: p.processedAt?.toISOString() ?? null,
    })),
  });
});

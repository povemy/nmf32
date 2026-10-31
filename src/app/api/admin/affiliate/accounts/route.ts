import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { requireCap } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/admin/affiliate/accounts?status=&q=&page= — affiliate review list
// (cap: affiliate.manage). Emails visible to admins for investigation;
// affiliate-facing surfaces never expose them.
export const GET = handle(async (req: Request) => {
  await requireCap("affiliate.manage");
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const q = url.searchParams.get("q") ?? undefined;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(50, Math.max(5, Number(url.searchParams.get("size") ?? 20) || 20));

  const where = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { displayName: { contains: q, mode: "insensitive" as const } },
            { code: { contains: q, mode: "insensitive" as const } },
            { slug: { contains: q, mode: "insensitive" as const } },
            { user: { email: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
  const [total, profiles] = await Promise.all([
    db.affiliateProfile.count({ where }),
    db.affiliateProfile.findMany({
      where,
      orderBy: { activatedAt: "desc" },
      skip: (page - 1) * size,
      take: size,
      include: {
        user: { select: { email: true } },
        sponsor: { select: { displayName: true, slug: true } },
      },
    }),
  ]);

  // Referral + commission aggregates in one batched pass each (no N+1).
  const ids = profiles.map((p) => p.id);
  const [refCounts, entryAgg] = await Promise.all([
    db.affiliateProfile.groupBy({ by: ["sponsorId"], where: { sponsorId: { in: ids } }, _count: true }),
    db.affiliateCommissionEntry.groupBy({
      by: ["beneficiaryAffiliateId"],
      where: { beneficiaryAffiliateId: { in: ids } },
      _sum: { amountMinor: true, reversedMinor: true },
    }),
  ]);
  const refMap = new Map(refCounts.map((r) => [r.sponsorId, r._count]));
  const earnMap = new Map(entryAgg.map((e) => [e.beneficiaryAffiliateId, (e._sum.amountMinor ?? 0) - (e._sum.reversedMinor ?? 0)]));

  return ok({
    total,
    page,
    accounts: profiles.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      slug: p.slug,
      code: p.code,
      email: p.user.email,
      status: p.status,
      sponsorName: p.sponsor?.displayName ?? null,
      referrals: refMap.get(p.id) ?? 0,
      lifetimeEarningsMinor: earnMap.get(p.id) ?? 0,
      activatedAt: p.activatedAt.toISOString(),
      suspendedReason: p.suspendedReason,
    })),
  });
});

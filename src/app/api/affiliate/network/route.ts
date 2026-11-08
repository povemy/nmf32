import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { requireAffiliate } from "@/lib/affiliate";
import type { NetworkData, AffiliateReferral } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/affiliate/network?page=1 — DIRECT referrals only (spec §3.F).
// Privacy: display names only — never emails, phones, addresses or payout
// data. No second-generation members are ever shown (one-level by design).
export const GET = handle(async (req: Request) => {
  const aff = await requireAffiliate();
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(50, Math.max(5, Number(url.searchParams.get("size") ?? 20) || 20));

  const [total, referrals] = await Promise.all([
    db.affiliateProfile.count({ where: { sponsorId: aff.id } }),
    db.affiliateProfile.findMany({
      where: { sponsorId: aff.id },
      orderBy: { activatedAt: "desc" },
      skip: (page - 1) * size,
      take: size,
      select: {
        id: true, displayName: true, slug: true, status: true,
        activatedAt: true,
        // has the referral generated any eligible sale (direct role only)?
      },
    }),
  ]);

  // Which referrals generated eligible sales (one batched query, no N+1).
  const ids = referrals.map((r) => r.id);
  const withSales = ids.length
    ? new Set(
        (await db.affiliateCommissionEntry.findMany({
          where: { beneficiaryAffiliateId: { in: ids }, role: "direct" },
          select: { beneficiaryAffiliateId: true },
          distinct: ["beneficiaryAffiliateId"],
        })).map((e) => e.beneficiaryAffiliateId)
      )
    : new Set<string>();

  // Sponsor earnings from this generation (authoritative).
  const sponsorEarned = await db.affiliateCommissionEntry.aggregate({
    where: { beneficiaryAffiliateId: aff.id, role: "sponsor" },
    _sum: { amountMinor: true },
  });

  const rows: AffiliateReferral[] = referrals.map((r) => ({
    displayName: r.displayName,
    slug: r.slug,
    status: r.status,
    activatedAt: r.activatedAt.toISOString(),
    generatedSales: withSales.has(r.id),
  }));
  const payload: NetworkData = {
    total,
    page,
    referrals: rows,
    sponsorEarningsMinor: sponsorEarned._sum.amountMinor ?? 0,
  };
  return ok(payload);
});

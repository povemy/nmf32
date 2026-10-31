import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { requireAffiliate, affiliateBalances } from "@/lib/affiliate";

export const dynamic = "force-dynamic";

// GET /api/affiliate/earnings?role=direct|sponsor&status=&page= — separate
// personal promotion vs direct sponsor earnings (spec §3.G). Buyer personal
// information is never included (order number + product/store only).
export const GET = handle(async (req: Request) => {
  const aff = await requireAffiliate();
  const url = new URL(req.url);
  const roleParam = url.searchParams.get("role");
  const role = roleParam === "sponsor" ? "sponsor" : roleParam === "direct" ? "direct" : undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(50, Math.max(5, Number(url.searchParams.get("size") ?? 20) || 20));

  const where = {
    beneficiaryAffiliateId: aff.id,
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
  };

  const [total, entries, balances] = await Promise.all([
    db.affiliateCommissionEntry.count({ where }),
    db.affiliateCommissionEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * size,
      take: size,
      include: {
        commission: {
          select: {
            orderNumber: true, rateBps: true, commissionableBaseMinor: true, poolMinor: true,
            storeId: true, channel: true, linkType: true, createdAt: true,
          },
        },
      },
    }),
    affiliateBalances(aff.id),
  ]);

  return ok({
    total,
    page,
    balances,
    rows: entries.map((e) => ({
      id: e.id,
      role: e.role,
      status: e.status,
      amountMinor: e.amountMinor,
      reversedMinor: e.reversedMinor,
      holdReason: e.holdReason,
      availableAt: e.availableAt?.toISOString() ?? null,
      paidAt: e.paidAt?.toISOString() ?? null,
      payoutId: e.payoutId,
      createdAt: e.createdAt.toISOString(),
      orderNumber: e.commission.orderNumber,
      rateBps: e.commission.rateBps,
      baseMinor: e.commission.commissionableBaseMinor,
      poolMinor: e.commission.poolMinor,
      channel: e.commission.channel,
      linkType: e.commission.linkType,
    })),
  });
});

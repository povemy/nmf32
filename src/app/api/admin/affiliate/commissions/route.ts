import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { requireAnyCap } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/admin/affiliate/commissions?status=&affiliateId=&page= — commission
// allocation inspector (spec §12). Financial review tier.
export const GET = handle(async (req: Request) => {
  await requireAnyCap("affiliate.manage", "affiliate.finance");
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const affiliateId = url.searchParams.get("affiliateId") ?? undefined;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(50, Math.max(5, Number(url.searchParams.get("size") ?? 20) || 20));

  const where = { ...(status ? { status } : {}), ...(affiliateId ? { affiliateId } : {}) };
  const [total, commissions] = await Promise.all([
    db.affiliateCommission.count({ where }),
    db.affiliateCommission.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * size,
      take: size,
      include: {
        entries: true,
        affiliate: { select: { displayName: true, slug: true } },
      },
    }),
  ]);
  return ok({
    total,
    page,
    rows: commissions.map((c) => ({
      id: c.id,
      orderNumber: c.orderNumber,
      orderItemId: c.orderItemId,
      affiliate: c.affiliate.displayName,
      status: c.status,
      rateBps: c.rateBps,
      baseMinor: c.commissionableBaseMinor,
      poolMinor: c.poolMinor,
      createdAt: c.createdAt.toISOString(),
      entries: c.entries.map((e) => ({
        role: e.role,
        status: e.status,
        amountMinor: e.amountMinor,
        reversedMinor: e.reversedMinor,
        availableAt: e.availableAt?.toISOString() ?? null,
        holdReason: e.holdReason,
      })),
    })),
  });
});

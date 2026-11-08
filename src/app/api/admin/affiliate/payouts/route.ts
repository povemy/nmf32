import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { requireCap } from "@/lib/auth";
import type {
  AdminAffPayoutsData,
  AdminAffPayoutsQuery,
  AdminAffPayoutRow,
} from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/admin/affiliate/payouts?status=&page= — the affiliate payout queue
// (cap: affiliate.finance — same tier as seller payouts).
export const GET = handle(async (req: Request) => {
  await requireCap("affiliate.finance");
  const url = new URL(req.url);
  const status: AdminAffPayoutsQuery["status"] = url.searchParams.get("status") ?? undefined;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(50, Math.max(5, Number(url.searchParams.get("size") ?? 20) || 20));

  const where = { ...(status ? { status } : {}) };
  const [total, payouts, queueStats] = await Promise.all([
    db.affiliatePayout.count({ where }),
    db.affiliatePayout.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      skip: (page - 1) * size,
      take: size,
      include: {
        affiliate: {
          select: { displayName: true, slug: true, code: true, payoutRef: true, user: { select: { email: true, fullName: true } } },
        },
      },
    }),
    db.affiliatePayout.groupBy({ by: ["status"], _count: true, _sum: { amountMinor: true } }),
  ]);
  const rows: AdminAffPayoutRow[] = payouts.map((p) => ({
    id: p.id,
    amountMinor: p.amountMinor,
    status: p.status,
    method: p.method,
    reference: p.reference,
    note: p.note,
    failReason: p.failReason,
    statementJson: p.statementJson,
    requestedAt: p.requestedAt.toISOString(),
    processedAt: p.processedAt?.toISOString() ?? null,
    affiliate: {
      displayName: p.affiliate.displayName,
      slug: p.affiliate.slug,
      code: p.affiliate.code,
      email: p.affiliate.user.email,
      fullName: p.affiliate.user.fullName,
      payoutRef: p.affiliate.payoutRef,
    },
  }));
  const payload: AdminAffPayoutsData = {
    total,
    page,
    queue: queueStats.map((g) => ({ status: g.status, count: g._count, amountMinor: g._sum.amountMinor ?? 0 })),
    payouts: rows,
  };
  return ok(payload);
});

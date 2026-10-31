import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { requireAnyCap } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/admin/affiliate/commissions?status=&affiliateId=&orderNumber=&storeId=&from=&to=&page=&size=
// Commission allocation inspector (spec §12). Financial review tier.
// POST-IMPLEMENTATION AUDIT (P9): all filters run SERVER-SIDE (the previous
// order-number search only filtered the current client page) and the response
// carries totals computed over the FULL filtered scope, not just the page.
const VALID_STATUSES = ["pending", "approved", "available", "paid", "reversed", "held"];

export const GET = handle(async (req: Request) => {
  await requireAnyCap("affiliate.manage", "affiliate.finance");
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? undefined;
  const status = statusParam && VALID_STATUSES.includes(statusParam) ? statusParam : undefined;
  const affiliateId = url.searchParams.get("affiliateId")?.trim() || undefined;
  const storeId = url.searchParams.get("storeId")?.trim() || undefined;
  // Order-number search: trimmed, case-insensitive CONTAINS on the frozen
  // orderNumber snapshot (e.g. "NM-2410" narrows to that order's items).
  const orderNumber = url.searchParams.get("orderNumber")?.trim() || undefined;
  const fromParam = url.searchParams.get("from") ?? undefined;
  const toParam = url.searchParams.get("to") ?? undefined;
  const fromMs = fromParam ? Date.parse(fromParam) : NaN;
  const toMs = toParam ? Date.parse(toParam) : NaN;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(50, Math.max(5, Number(url.searchParams.get("size") ?? 20) || 20));

  const where = {
    ...(status ? { status } : {}),
    ...(affiliateId ? { affiliateId } : {}),
    ...(storeId ? { storeId } : {}),
    ...(orderNumber ? { orderNumber: { contains: orderNumber, mode: "insensitive" as const } } : {}),
    ...(Number.isFinite(fromMs) ? { createdAt: { gte: new Date(fromMs) } } : {}),
    ...(Number.isFinite(toMs) ? { createdAt: { lte: new Date(toMs) } } : {}),
  };

  // Totals over the FULL filtered scope (not the page) so admin sees correct
  // sums for whatever filter combination is active. Aggregate in SQL — never
  // loads all rows into the browser.
  const [total, totals, commissions] = await Promise.all([
    db.affiliateCommission.count({ where }),
    db.affiliateCommission.aggregate({
      where,
      _sum: { poolMinor: true, commissionableBaseMinor: true },
    }),
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
    size,
    totals: {
      poolMinor: totals._sum.poolMinor ?? 0,
      baseMinor: totals._sum.commissionableBaseMinor ?? 0,
    },
    filters: {
      status: status ?? null,
      affiliateId: affiliateId ?? null,
      storeId: storeId ?? null,
      orderNumber: orderNumber ?? null,
      from: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null,
      to: Number.isFinite(toMs) ? new Date(toMs).toISOString() : null,
    },
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

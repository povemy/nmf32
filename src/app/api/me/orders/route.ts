import { db } from "@/lib/db";
import { handle, okPaged, ApiError, getPagination } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Purchase-hub buckets — SHOPMESH order statuses mapped onto the marketplace
// funnel the buyer dashboard uses (To Pay / To Ship / To Receive / To Rate).
export const BUCKETS: Record<string, string[]> = {
  to_pay: ["payment_pending"],
  to_ship: ["paid", "processing"],
  to_receive: ["shipped"],
  to_rate: ["delivered"],
  completed: ["completed"],
  cancelled: ["cancelled", "refunding", "partially_refunded", "refunded", "closed"],
};
const ALL_STATUSES = Object.values(BUCKETS).flat();

// GET /api/me/orders — signed-in buyer's purchases.
//   no params → bucket counts + the most recent orders (first page)
//   ?bucket=to_ship&page=2&size=10 → one bucket, paginated
// Ownership: rows are scoped to shopperId ONLY (claimed at login/checkout) —
// no id/URL tweaking can reach another buyer's orders.
export const GET = handle(async (req: Request) => {
  const me = await requireShopper();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url, 50);

  const bucketParam = url.searchParams.get("bucket");
  if (bucketParam && !BUCKETS[bucketParam]) {
    throw new ApiError(400, "VALIDATION", `bucket must be one of: ${Object.keys(BUCKETS).join(", ")}`);
  }
  const statuses = bucketParam ? BUCKETS[bucketParam] : ALL_STATUSES;
  const scope = { shopperId: me.id, status: { in: statuses } };

  const [counts, rows, total] = await Promise.all([
    db.order.groupBy({ by: ["status"], where: { shopperId: me.id }, _count: { _all: true } }),
    db.order.findMany({
      where: scope,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true, orderNumber: true, status: true, totalMinor: true, createdAt: true,
        paymentProvider: true, trackingNumber: true,
        store: { select: { id: true, name: true, slug: true } },
        items: { select: { id: true, title: true, variantLabel: true, qty: true, unitPriceMinor: true, productId: true } },
      },
    }),
    db.order.count({ where: scope }),
  ]);

  const byStatus = new Map(counts.map((c) => [c.status, c._count._all]));
  const countFor = (list: string[]) => list.reduce((s, st) => s + (byStatus.get(st) ?? 0), 0);
  const bucketCounts = Object.fromEntries(Object.entries(BUCKETS).map(([k, list]) => [k, countFor(list)]));

  return okPaged(
    {
      bucketCounts,
      orders: rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        totalMinor: o.totalMinor,
        createdAt: o.createdAt,
        paymentProvider: o.paymentProvider,
        trackingNumber: o.trackingNumber,
        store: o.store,
        items: o.items,
      })),
    },
    { page, size, total }
  );
});

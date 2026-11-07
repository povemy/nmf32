import { db } from "@/lib/db";
import { handle, okPaged, ApiError, getPagination } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { placeholderUrl } from "@/lib/placeholder";

export const dynamic = "force-dynamic";

// Purchase-hub buckets — NOMOFEE order statuses mapped onto the marketplace
// funnel the buyer dashboard uses (To Pay / To Ship / To Receive / To Rate).
// ORDER-FLOW CORRECTION (buyer-confirmed receipt): the courier's DELIVERED
// event no longer moves an order out of To Receive — "delivered" stays there
// until the buyer taps "Order received" (→ status "received", To Rate) or the
// 14-day auto-receipt sweep confirms for them. "received" (To Rate) then
// completes on the buyer's rating (review submission) or after the 30-day
// rating window (order-maintenance cron, stage 2).
export const BUCKETS: Record<string, string[]> = {
  to_pay: ["payment_pending"],
  to_ship: ["paid", "processing"],
  to_receive: ["shipped", "delivered"],
  to_rate: ["received"],
  completed: ["completed"],
  cancelled: ["cancelled", "refunding", "partially_refunded", "refunded", "closed"],
};
const ALL_STATUSES = Object.values(BUCKETS).flat();

// GET /api/me/orders — signed-in buyer's purchases.
//   no params → bucket counts + the most recent orders (first page)
//   ?bucket=to_ship&page=2&size=10 → one bucket, paginated
// Ownership: rows are scoped to shopperId ONLY (claimed at login/checkout) —
// no id/URL tweaking can reach another buyer's orders.
//
// PHASE 2 / A5: the two lazy maintenance duties that used to run on this
// request (global auto-complete sweep + shopper tracking tick — up to ~250
// sequential queries on the buyer's latency budget when the 60s throttle
// expired) moved to the scheduler rail: POST /api/cron/order-maintenance,
// ticked by mini-services/expiry-scheduler every 30s (Setting
// `cron.orders.last` carries the last outcome). Displayed order information
// stays eventually-consistent with the SAME cadence the lazy sweeps had —
// the buyer's request simply no longer performs the upkeep.
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
        paymentProvider: true, trackingNumber: true, receivedAt: true,
        store: { select: { id: true, name: true, slug: true } },
        shipment: { select: { status: true, courierName: true, awbNumber: true } },
        items: {
          select: {
            id: true, title: true, variantLabel: true, qty: true, unitPriceMinor: true, productId: true,
            product: { select: { slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } },
          },
        },
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
        receivedAt: o.receivedAt,
        paymentProvider: o.paymentProvider,
        trackingNumber: o.trackingNumber ?? o.shipment?.awbNumber ?? null,
        shipmentStatus: o.shipment?.status ?? null,
        shippingCourierName: o.shipment?.courierName ?? null,
        store: o.store,
        items: o.items.map((i) => ({
          id: i.id,
          title: i.title,
          variantLabel: i.variantLabel,
          qty: i.qty,
          unitPriceMinor: i.unitPriceMinor,
          productId: i.productId,
          imageUrl: i.product?.images[0]?.url ?? placeholderUrl(i.product?.slug ?? i.title, { w: 200, h: 200, label: i.title }),
        })),
      })),
    },
    { page, size, total }
  );
});

import { db } from "@/lib/db";
import { handle, okPaged, ApiError, getPagination, transitionOrder } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { maybeSyncTracking } from "@/lib/shipping";
import { placeholderUrl } from "@/lib/placeholder";

export const dynamic = "force-dynamic";

// Purchase-hub buckets — NOMOFEE order statuses mapped onto the marketplace
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
// Side duties (lazy, throttled, never fatal):
//   • auto-complete sweep — "delivered" orders older than 14 days → completed
//   • tracking tick — advance this shopper's in-flight mock shipments
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

  await lazyAutoCompleteSweep();
  await lazyTrackingTick(me.id);

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

/**
 * Auto-complete sweep: any "delivered" order whose deliveredAt is older than
 * 14 days becomes "completed" with an OrderStatusHistory row
 * {actorType:"system", note:"Auto-confirmed 14 days after delivery"}.
 * Guarded by a 60s in-memory throttle (globalThis — Turbopack duplicates
 * module instances per route, so module scope is not reliable).
 */
async function lazyAutoCompleteSweep(): Promise<void> {
  try {
    const g = globalThis as Record<string, unknown>;
    const last = typeof g.__ordersAutoCompleteAt === "number" ? g.__ordersAutoCompleteAt : 0;
    const now = Date.now();
    if (now - last < 60_000) return;
    g.__ordersAutoCompleteAt = now;

    const cutoff = new Date(now - 14 * 24 * 3600 * 1000);
    const stale = await db.order.findMany({
      where: { status: "delivered", deliveredAt: { lt: cutoff } },
      select: { id: true },
      take: 50,
      orderBy: { deliveredAt: "asc" },
    });
    for (const o of stale) {
      await transitionOrder({
        orderId: o.id,
        toStatus: "completed",
        actor: "system",
        note: "Auto-confirmed 14 days after delivery",
        timestamps: { completedAt: new Date() },
      });
    }
  } catch (e) {
    console.error("[me/orders] auto-complete sweep failed", e);
  }
}

/** Advance the shopper's in-flight mock shipments when they are stale (45s). */
async function lazyTrackingTick(shopperId: string): Promise<void> {
  try {
    const inflight = await db.shipment.findMany({
      where: { providerId: "mock", status: { in: ["BOOKED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"] }, order: { shopperId } },
      select: { id: true },
      take: 25,
      orderBy: { updatedAt: "asc" },
    });
    for (const s of inflight) {
      await maybeSyncTracking(s.id);
    }
  } catch (e) {
    console.error("[me/orders] tracking tick failed", e);
  }
}

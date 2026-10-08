import { db } from "@/lib/db";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Status group filters for seller order views. */
export function statusGroup(group: string): string[] {
  switch (group) {
    case "unpaid":
      return ["payment_pending"];
    case "to_fulfill":
      return ["paid", "processing"];
    case "shipped":
      return ["shipped"];
    case "done":
      return ["delivered", "completed"];
    case "refunds":
      return ["refunding", "partially_refunded", "refunded"];
    case "cancelled":
      return ["cancelled", "closed"];
    default:
      return [];
  }
}

// GET /api/store/orders?status=to_fulfill|shipped|done|refunds|<raw>&search=&page=&size=
export const GET = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const statusParam = url.searchParams.get("status")?.trim();
  const search = url.searchParams.get("search")?.trim();

  const where: Record<string, unknown> = { storeId: store.id };
  if (statusParam && statusParam !== "all") {
    const group = statusGroup(statusParam);
    where.status = group.length > 0 ? { in: group } : statusParam;
  }
  if (search) {
    where.OR = [
      { orderNumber: { contains: search } },
      { customerName: { contains: search } },
      { customerEmail: { contains: search } },
    ];
  }

  const [rows, total] = await Promise.all([
    db.order.findMany({
      where,
      include: { items: { select: { id: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.order.count({ where }),
  ]);

  return okPaged(
    rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      status: o.status,
      channel: o.channel,
      totalMinor: o.totalMinor,
      currency: o.currency,
      itemCount: o.items.length,
      trackingNumber: o.trackingNumber,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      shippedAt: o.shippedAt,
    })),
    { page, size, total }
  );
});

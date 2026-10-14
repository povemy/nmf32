import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

// GET /api/checkout/payments/[ref] — payment status for the hosted pay page.
// OPTION A: the ref may be a multi-seller PaymentGroup (one payment, N orders).
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ ref: string }> }) => {
  const { ref } = await ctx.params;

  const group = await db.paymentGroup.findUnique({
    where: { ref },
    include: {
      orders: {
        orderBy: { createdAt: "asc" },
        include: { store: { select: { name: true, slug: true } } },
      },
    },
  });
  if (group) {
    // An unpaid session past its expiry is reported as expired (computed, not stored —
    // a gateway callback could still reconcile it later).
    const expired = group.status === "requires_payment" && group.expiresAt.getTime() < Date.now();
    return ok({
      status: expired ? "expired" : group.status,
      isGroup: true,
      orderNumber: group.orders[0]?.orderNumber ?? "",
      orderNumbers: group.orders.map((o) => o.orderNumber),
      orderCount: group.orders.length,
      storeNames: [...new Set(group.orders.map((o) => o.store.name))],
      storeName: null,
      storeSlug: null,
      amountMinor: group.totalMinor,
      orderStatus: group.orders[0]?.status ?? "payment_pending",
      provider: group.provider,
      expiresAt: group.expiresAt,
    });
  }

  const intent = await db.paymentIntent.findUnique({
    where: { providerRef: ref },
    include: { order: { include: { store: { select: { name: true, slug: true } } } } },
  });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Payment not found");

  const expired = intent.status === "requires_payment" && intent.expiresAt.getTime() < Date.now();

  return ok({
    status: expired ? "expired" : intent.status,
    isGroup: false,
    orderNumber: intent.order.orderNumber,
    orderNumbers: [intent.order.orderNumber],
    orderCount: 1,
    storeNames: [intent.order.store.name],
    storeName: intent.order.store.name,
    storeSlug: intent.order.store.slug,
    amountMinor: intent.amountMinor,
    orderStatus: intent.order.status,
    provider: intent.provider,
    redirectUrl: intent.redirectUrl,
    expiresAt: intent.expiresAt,
  });
});

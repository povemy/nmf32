import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

// GET /api/checkout/payments/[ref] — payment status for the hosted pay page.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ ref: string }> }) => {
  const { ref } = await ctx.params;
  const intent = await db.paymentIntent.findUnique({
    where: { providerRef: ref },
    include: { order: { include: { store: { select: { name: true, slug: true } } } } },
  });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Payment not found");

  return ok({
    status: intent.status,
    orderNumber: intent.order.orderNumber,
    amountMinor: intent.amountMinor,
    storeName: intent.order.store.name,
    storeSlug: intent.order.store.slug,
    orderStatus: intent.order.status,
    provider: intent.provider,
    redirectUrl: intent.redirectUrl,
    expiresAt: intent.expiresAt,
  });
});

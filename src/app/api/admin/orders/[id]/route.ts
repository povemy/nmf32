import { NextRequest } from "next/server";
import { handle, ok, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { AdminOrderDetailData, AdminDisputeRow, AdminRefundRow } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/admin/orders/[id] — full order dossier
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAdmin();
  const { id } = await ctx.params;

  const order = await db.order.findUnique({
    where: { id },
    include: {
      store: { include: { seller: { select: { id: true, email: true, displayName: true, fullName: true } } } },
      items: true,
      history: { orderBy: { createdAt: "asc" } },
      paymentIntents: { orderBy: { createdAt: "desc" } },
      refunds: { orderBy: { createdAt: "desc" } },
      disputes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

  // Store.sellerId is nullable in the schema — no seller → no wallet (was a
  // TypeError 500 before; findUnique already returns Wallet|null downstream).
  const sellerId = order.store.seller?.id;
  const wallet = sellerId ? await db.wallet.findUnique({ where: { sellerId: sellerId } }) : null;

  // Prisma rows carry Date objects; the contract rows are ISO strings — map
  // explicitly (JSON.stringify of a Date === toISOString, identical wire bytes).
  const orderRow: AdminOrderDetailData["order"] = {
    ...order,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    fulfilledAt: order.fulfilledAt ? order.fulfilledAt.toISOString() : null,
    shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
    deliveredAt: order.deliveredAt ? order.deliveredAt.toISOString() : null,
    receivedAt: order.receivedAt ? order.receivedAt.toISOString() : null,
    completedAt: order.completedAt ? order.completedAt.toISOString() : null,
    cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    store: {
      ...order.store,
      createdAt: order.store.createdAt.toISOString(),
      updatedAt: order.store.updatedAt.toISOString(),
    },
  };
  const historyRows: AdminOrderDetailData["history"] = order.history.map((h) => ({
    ...h,
    createdAt: h.createdAt.toISOString(),
  }));
  const intentRows: AdminOrderDetailData["paymentIntents"] = order.paymentIntents.map((pi) => ({
    ...pi,
    expiresAt: pi.expiresAt.toISOString(),
    createdAt: pi.createdAt.toISOString(),
    updatedAt: pi.updatedAt.toISOString(),
  }));
  const refundRows: AdminRefundRow[] = order.refunds.map((r) => ({
    ...r,
    processedAt: r.processedAt ? r.processedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
  const disputeRows: AdminDisputeRow[] = order.disputes.map((d) => ({
    ...d,
    resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }));

  const payload: AdminOrderDetailData = {
    order: orderRow,
    items: order.items,
    history: historyRows,
    paymentIntents: intentRows,
    refunds: refundRows,
    dispute: disputeRows[0] ?? null,
    disputes: disputeRows,
    seller: order.store.seller,
    store: { id: order.store.id, name: order.store.name, slug: order.store.slug },
    wallet: wallet
      ? { ...wallet, createdAt: wallet.createdAt.toISOString(), updatedAt: wallet.updatedAt.toISOString() }
      : null,
  };
  return ok(payload);
});

import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify, dispatchStoreWebhooks, transitionOrder } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postRefund } from "@/lib/ledger";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/refunds/[id]/process — posts ledger T5 + updates order/items/stock (RBAC refunds.manage)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("refunds.manage");
  const { id } = await ctx.params;

  const refund = await db.refund.findUnique({
    where: { id },
    include: {
      order: {
        include: {
          items: { orderBy: { id: "asc" } },
          store: { include: { seller: { include: { wallet: true } } } },
          refunds: true,
        },
      },
    },
  });
  if (!refund) throw new ApiError(404, "NOT_FOUND", "Refund not found");
  if (refund.status === "processed") throw new ApiError(409, "ALREADY_PROCESSED", "Refund already processed");
  if (refund.status === "rejected") throw new ApiError(409, "CONFLICT", "Rejected refund cannot be processed");

  const order = refund.order;
  const wallet = order.store.seller.wallet;
  if (!wallet) throw new ApiError(400, "NO_WALLET", "Seller has no wallet");

  // first item with remaining (un-refunded) amount
  const item = order.items.find((it) => it.lineSubtotalMinor - it.refundedMinor > 0) ?? order.items[0];
  if (!item) throw new ApiError(400, "NO_ITEMS", "Order has no items");

  const commissionReversalMinor = Math.round((refund.amountMinor * item.commissionPercent) / 100);

  // T5 — ledger refund (balanced): DR seller payable + DR commission revenue | CR gateway
  const txn = await postRefund({
    orderId: order.id,
    orderNumber: order.orderNumber,
    walletId: wallet.id,
    provider: order.paymentProvider ?? "fpx_toyyibpay",
    amountMinor: refund.amountMinor,
    commissionReversalMinor,
  });

  // total refunded so far (processed refunds incl. this one)
  const priorProcessed = order.refunds
    .filter((r) => r.id !== refund.id && r.status === "processed")
    .reduce((s, r) => s + r.amountMinor, 0);
  const totalRefunded = priorProcessed + refund.amountMinor;
  const fullyRefunded = totalRefunded >= order.totalMinor;

  // advance order status (writes history row)
  await transitionOrder({
    orderId: order.id,
    toStatus: fullyRefunded ? "refunded" : "partially_refunded",
    actor: `admin:${admin.email}`,
    note: `Refund ${refund.amountMinor / 100} processed (reason: ${refund.reason ?? "n/a"})`,
  });

  // item refund bookkeeping + optional restock
  const remaining = item.lineSubtotalMinor - item.refundedMinor;
  const applied = Math.min(refund.amountMinor, Math.max(0, remaining));
  await db.orderItem.update({ where: { id: item.id }, data: { refundedMinor: item.refundedMinor + applied } });
  if (refund.restock && item.variantId) {
    await db.productVariant.update({ where: { id: item.variantId }, data: { stock: { increment: item.qty } } });
    await db.inventoryLog.create({
      data: { variantId: item.variantId, delta: item.qty, reason: "refund_restock", refId: refund.id },
    });
  }

  const processed = await db.refund.update({
    where: { id },
    data: { status: "processed", processedAt: new Date(), commissionReversalMinor },
  });

  // gateway intent reflects refund
  await db.paymentIntent.updateMany({
    where: { orderId: order.id, status: "succeeded" },
    data: { status: "refunded" },
  });

  // notifications: customer + seller
  await notify({
    event: "refund.approved",
    channel: "email",
    recipient: order.customerEmail,
    subject: `Refund processed for order ${order.orderNumber}`,
  });
  await notify({
    event: "refund.approved",
    channel: "email",
    recipient: order.store.seller.email,
    subject: `Refund processed for order ${order.orderNumber}`,
  });

  // store webhooks
  await dispatchStoreWebhooks({
    storeId: order.storeId,
    event: "order.refunded",
    payload: {
      orderNumber: order.orderNumber,
      refundId: refund.id,
      amountMinor: refund.amountMinor,
      commissionReversalMinor,
      status: fullyRefunded ? "refunded" : "partially_refunded",
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "refund.process",
    entityType: "refund",
    entityId: id,
    before: { status: refund.status, orderStatus: order.status, amountMinor: refund.amountMinor },
    after: {
      status: "processed",
      orderStatus: fullyRefunded ? "refunded" : "partially_refunded",
      totalRefundedMinor: totalRefunded,
      commissionReversalMinor,
      restocked: refund.restock,
      txnId: txn.id,
    },
  });

  return ok({ refund: processed, txnId: txn.id, orderStatus: fullyRefunded ? "refunded" : "partially_refunded", totalRefundedMinor: totalRefunded });
});

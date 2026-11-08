import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import type { MeAfterSalesDispute, ReturnRequestBody, ReturnRequestData, ReturnRequestsData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/me/orders/[orderNumber]/return-request — buyer opens an
// after-sales request. Body: {reason: string, type?: "refund"|"return"}.
// Stored as a Dispute row (Dispute model is the platform-wide after-sales
// sink; the Dispute schema has no dedicated `type` column, so the type is
// carried in the reason text). Buyer-visible status is served by the order
// detail endpoint as `dispute`.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ orderNumber: string }> }) => {
  const me = await requireShopper();
  const { orderNumber } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as ReturnRequestBody;

  const reason = String(body.reason ?? "").trim();
  const type = body.type == null || String(body.type).trim() === "" ? "refund" : String(body.type).trim().toLowerCase();
  if (reason.length < 10) {
    throw new ApiError(400, "VALIDATION", "Please describe the issue (at least 10 characters)");
  }
  if (!["refund", "return"].includes(type)) {
    throw new ApiError(400, "VALIDATION", "type must be 'refund' or 'return'");
  }

  const order = await db.order.findFirst({
    where: { orderNumber: orderNumber.trim().toUpperCase(), shopperId: me.id },
    select: { id: true, orderNumber: true, status: true, disputedFlag: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "No order with that number on your account");

  const openDispute = await db.dispute.findFirst({
    where: { orderId: order.id, status: "open" },
    select: { id: true },
  });
  if (openDispute || order.disputedFlag) {
    throw new ApiError(409, "DISPUTE_EXISTS", "There is already an open after-sales request for this order");
  }
  if (!["paid", "processing", "shipped", "delivered", "received", "completed"].includes(order.status)) {
    throw new ApiError(409, "INVALID_STATUS", `After-sales requests are not available for orders in status '${order.status}'`);
  }

  const dispute = await db.dispute.create({
    data: {
      orderId: order.id,
      reason: `${type === "return" ? "Return" : "Refund"} request — ${reason}`,
      status: "open",
      openedBy: "shopper",
    },
  });
  await db.order.update({ where: { id: order.id }, data: { disputedFlag: true } });

  await logActivity({
    actorType: "shopper",
    actorId: me.id,
    actorLabel: me.email,
    action: "order.return_requested",
    entityType: "order",
    entityId: order.id,
    meta: { orderNumber: order.orderNumber, type, disputeId: dispute.id },
  });

  const payload: ReturnRequestData = {
    id: dispute.id,
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    // The includes("refund","return") guard above pins the runtime value;
    // TS cannot narrow String()-derived locals, so assert the union here.
    type: type as ReturnRequestData["type"],
    reason,
    status: dispute.status,
    createdAt: dispute.createdAt.toISOString(),
  };
  return ok(payload);
});

// GET — quick buyer-side visibility of the current request on the order.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ orderNumber: string }> }) => {
  const me = await requireShopper();
  const { orderNumber } = await ctx.params;

  const order = await db.order.findFirst({
    where: { orderNumber: orderNumber.trim().toUpperCase(), shopperId: me.id },
    select: { id: true, orderNumber: true, status: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "No order with that number on your account");

  const disputes = await db.dispute.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, reason: true, status: true, resolution: true, createdAt: true, resolvedAt: true },
  });

  const payload: ReturnRequestsData = {
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    disputes: disputes.map((d): MeAfterSalesDispute => ({
      id: d.id,
      reason: d.reason,
      status: d.status,
      resolution: d.resolution,
      createdAt: d.createdAt.toISOString(),
      resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    })),
  };
  return ok(payload);
});

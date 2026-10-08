import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, str } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/disputes/[id] {status, resolution?} (RBAC disputes.manage)
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("disputes.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);

  const dispute = await db.dispute.findUnique({ where: { id }, include: { order: true } });
  if (!dispute) throw new ApiError(404, "NOT_FOUND", "Dispute not found");

  const status = reqStr(body, "status", "status");
  if (!["open", "under_review", "resolved", "rejected"].includes(status)) {
    throw new ApiError(400, "VALIDATION", "status must be open | under_review | resolved | rejected");
  }
  const resolution = str(body, "resolution") ?? null;
  if ((status === "resolved" || status === "rejected") && !resolution && !dispute.resolution) {
    throw new ApiError(400, "VALIDATION", "resolution is required when resolving/rejecting a dispute");
  }

  const updated = await db.dispute.update({
    where: { id },
    data: {
      status,
      resolution: resolution ?? dispute.resolution,
      resolvedAt: status === "resolved" || status === "rejected" ? new Date() : null,
    },
  });

  // resolving clears the order dispute flag
  if (status === "resolved" && dispute.order.disputedFlag) {
    await db.order.update({ where: { id: dispute.orderId }, data: { disputedFlag: false } });
  }

  if (status === "resolved") {
    await notify({
      event: "dispute.resolved",
      channel: "email",
      recipient: dispute.order.customerEmail,
      subject: `Dispute resolved for order ${dispute.order.orderNumber}`,
    });
  }

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "dispute.update",
    entityType: "dispute",
    entityId: id,
    before: { status: dispute.status, resolution: dispute.resolution, orderNumber: dispute.order.orderNumber },
    after: { status, resolution: resolution ?? dispute.resolution },
  });

  return ok(updated);
});

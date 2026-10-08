import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/refunds/[id]/approve (RBAC refunds.manage)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("refunds.manage");
  const { id } = await ctx.params;

  const refund = await db.refund.findUnique({ where: { id }, include: { order: { include: { store: { include: { seller: true } } } } } });
  if (!refund) throw new ApiError(404, "NOT_FOUND", "Refund not found");
  if (refund.status !== "requested") throw new ApiError(409, "CONFLICT", `Refund is ${refund.status}, only requested refunds can be approved`);

  const updated = await db.refund.update({ where: { id }, data: { status: "approved" } });

  await notify({
    event: "refund.approved",
    channel: "email",
    recipient: refund.order.customerEmail,
    subject: `Refund approved for order ${refund.order.orderNumber}`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "refund.approve",
    entityType: "refund",
    entityId: id,
    before: { status: refund.status, amountMinor: refund.amountMinor, orderNumber: refund.order.orderNumber },
    after: { status: "approved" },
  });

  return ok(updated);
});

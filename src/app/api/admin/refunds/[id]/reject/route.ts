import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/refunds/[id]/reject {reason?} (RBAC refunds.manage)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("refunds.manage");
  const { id } = await ctx.params;
  const body = await readBody(req).catch(() => ({}) as Record<string, never>);
  const reason = typeof body.reason === "string" ? body.reason : "Refund request declined";

  const refund = await db.refund.findUnique({ where: { id }, include: { order: { include: { store: { include: { seller: true } } } } } });
  if (!refund) throw new ApiError(404, "NOT_FOUND", "Refund not found");
  if (refund.status === "processed") throw new ApiError(409, "CONFLICT", "Processed refund cannot be rejected");

  const updated = await db.refund.update({ where: { id }, data: { status: "rejected" } });

  await notify({
    event: "refund.rejected",
    channel: "email",
    recipient: refund.order.store.seller.email,
    subject: `Refund rejected for order ${refund.order.orderNumber}`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "refund.reject",
    entityType: "refund",
    entityId: id,
    before: { status: refund.status, amountMinor: refund.amountMinor },
    after: { status: "rejected", reason },
  });

  return ok(updated);
});

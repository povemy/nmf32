import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, stripSeller } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/terminate {reason?} (RBAC sellers.suspend)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.suspend");
  const { id } = await ctx.params;
  const body = await readBody(req).catch(() => ({}) as Record<string, never>);
  const reason = typeof body.reason === "string" ? body.reason : "Contract termination";

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status === "terminated") throw new ApiError(409, "CONFLICT", "Seller already terminated");

  const updated = await db.seller.update({ where: { id }, data: { status: "terminated" } });
  if (seller.store) await db.store.update({ where: { id: seller.store.id }, data: { status: "draft" } });

  await notify({
    event: "seller.terminated",
    channel: "email",
    recipient: seller.email,
    subject: "Your seller account has been terminated",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.terminate",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, storeStatus: seller.store?.status ?? null },
    after: { status: "terminated", storeStatus: seller.store ? "draft" : null, reason },
  });

  return ok(stripSeller(updated));
});

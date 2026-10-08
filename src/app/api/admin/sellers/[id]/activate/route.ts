import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripSeller } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/activate (RBAC sellers.suspend)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.suspend");
  const { id } = await ctx.params;

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status === "terminated" || seller.status === "rejected") {
    throw new ApiError(409, "CONFLICT", `Cannot activate a ${seller.status} seller`);
  }

  const updated = await db.seller.update({ where: { id }, data: { status: "active" } });
  if (seller.store) await db.store.update({ where: { id: seller.store.id }, data: { status: "live" } });

  await notify({
    event: "seller.activated",
    channel: "email",
    recipient: seller.email,
    subject: "Your store is back online",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.activate",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, storeStatus: seller.store?.status ?? null },
    after: { status: "active", storeStatus: seller.store ? "live" : null },
  });

  return ok(stripSeller(updated));
});

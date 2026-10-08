import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify, logActivity } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripSeller } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/approve — activate seller + store (RBAC sellers.approve)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.approve");
  const { id } = await ctx.params;

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status === "terminated") throw new ApiError(409, "CONFLICT", "Terminated seller cannot be approved");

  const updated = await db.seller.update({
    where: { id },
    data: { status: "active", kycStatus: "approved", approvedAt: new Date(), rejectReason: null },
  });
  if (seller.store) {
    await db.store.update({ where: { id: seller.store.id }, data: { status: "live" } });
  }

  await notify({
    event: "kyc.approved",
    channel: "email",
    recipient: seller.email,
    subject: "You're approved — your store is live!",
  });
  await logActivity({
    actorType: "system",
    action: "seller.approved",
    entityType: "seller",
    entityId: id,
    meta: { sellerEmail: seller.email, storeName: seller.store?.name ?? null },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.approve",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, kycStatus: seller.kycStatus, storeStatus: seller.store?.status ?? null },
    after: { status: "active", kycStatus: "approved", storeStatus: seller.store ? "live" : null },
  });

  return ok(stripSeller(updated));
});

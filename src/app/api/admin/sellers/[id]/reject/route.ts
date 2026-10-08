import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, stripSeller } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/reject {reason}
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.approve");
  const { id } = await ctx.params;
  const body = await readBody(req);
  const reason = reqStr(body, "reason", "reason");

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status === "active") throw new ApiError(409, "CONFLICT", "Active seller cannot be rejected — suspend or terminate instead");

  const updated = await db.seller.update({
    where: { id },
    data: { status: "rejected", kycStatus: "rejected", rejectReason: reason },
  });
  if (seller.store) await db.store.update({ where: { id: seller.store.id }, data: { status: "draft" } });

  await notify({
    event: "kyc.rejected",
    channel: "email",
    recipient: seller.email,
    subject: "KYC verification rejected",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.reject",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, kycStatus: seller.kycStatus },
    after: { status: "rejected", kycStatus: "rejected", reason },
  });

  return ok(stripSeller(updated));
});

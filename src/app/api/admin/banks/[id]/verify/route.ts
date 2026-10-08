import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/banks/[id]/verify (RBAC sellers.approve)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.approve");
  const { id } = await ctx.params;

  const bank = await db.bankAccount.findUnique({ where: { id }, include: { seller: true } });
  if (!bank) throw new ApiError(404, "NOT_FOUND", "Bank account not found");

  const updated = await db.bankAccount.update({ where: { id }, data: { verified: true, verifiedAt: new Date() } });

  await notify({
    event: "bank.verified",
    channel: "email",
    recipient: bank.seller.email,
    subject: "Bank account verified",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "bank.verify",
    entityType: "bank_account",
    entityId: id,
    before: { verified: bank.verified, bankName: bank.bankName, sellerId: bank.sellerId },
    after: { verified: true },
  });

  return ok(updated);
});

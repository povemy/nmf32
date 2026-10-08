import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/banks/[id]/reject (RBAC sellers.approve)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.approve");
  const { id } = await ctx.params;

  const bank = await db.bankAccount.findUnique({ where: { id } });
  if (!bank) throw new ApiError(404, "NOT_FOUND", "Bank account not found");

  const updated = await db.bankAccount.update({ where: { id }, data: { verified: false, verifiedAt: null } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "bank.reject",
    entityType: "bank_account",
    entityId: id,
    before: { verified: bank.verified, bankName: bank.bankName, sellerId: bank.sellerId },
    after: { verified: false },
  });

  return ok(updated);
});

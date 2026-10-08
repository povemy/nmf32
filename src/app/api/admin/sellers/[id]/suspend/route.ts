import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, stripSeller } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/suspend {reason?} (RBAC sellers.suspend)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.suspend");
  const { id } = await ctx.params;
  const body = await readBody(req).catch(() => ({}) as Record<string, never>);
  const reason = typeof body.reason === "string" ? body.reason : "Policy review";

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status !== "active") throw new ApiError(409, "CONFLICT", `Only active sellers can be suspended (current: ${seller.status})`);

  const updated = await db.seller.update({ where: { id }, data: { status: "suspended" } });
  if (seller.store) await db.store.update({ where: { id: seller.store.id }, data: { status: "draft" } });

  await notify({
    event: "seller.suspended",
    channel: "email",
    recipient: seller.email,
    subject: "Your store has been suspended",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.suspend",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, storeStatus: seller.store?.status ?? null },
    after: { status: "suspended", storeStatus: seller.store ? "draft" : null, reason },
  });

  return ok(stripSeller(updated));
});

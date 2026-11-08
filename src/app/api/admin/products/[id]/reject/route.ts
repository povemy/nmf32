import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody } from "@/app/api/admin/_helpers";
import type { AdminProductRejectBody, AdminProductRow } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/products/[id]/reject {reason?} (RBAC products.moderate)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("products.moderate");
  const { id } = await ctx.params;
  const body = await readBody(req).catch(() => ({}) as AdminProductRejectBody);
  const reason = typeof body.reason === "string" ? body.reason : "Does not meet listing guidelines";

  const product = await db.product.findUnique({ where: { id }, include: { store: { include: { seller: true } } } });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found");

  const updated = await db.product.update({ where: { id }, data: { status: "rejected", rejectReason: reason } });

  if (product.store.seller?.email) {
    await notify({
      event: "product.rejected",
      channel: "email",
      recipient: product.store.seller.email,
      subject: `Product rejected: ${product.title}`,
    });
  }

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "product.reject",
    entityType: "product",
    entityId: id,
    before: { status: product.status, title: product.title },
    after: { status: "rejected", reason },
  });

  const payload: AdminProductRow = {
    ...updated,
    publishedAt: updated.publishedAt ? updated.publishedAt.toISOString() : null,
    lastSyncedAt: updated.lastSyncedAt ? updated.lastSyncedAt.toISOString() : null,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
  return ok(payload);
});

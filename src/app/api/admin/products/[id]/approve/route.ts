import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/products/[id]/approve (RBAC products.moderate)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("products.moderate");
  const { id } = await ctx.params;

  const product = await db.product.findUnique({ where: { id }, include: { store: { include: { seller: true } } } });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found");

  const updated = await db.product.update({
    where: { id },
    data: { status: "active", rejectReason: null, publishedAt: product.publishedAt ?? new Date() },
  });

  await notify({
    event: "product.approved",
    channel: "email",
    recipient: product.store.seller.email,
    subject: `Product approved: ${product.title}`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "product.approve",
    entityType: "product",
    entityId: id,
    before: { status: product.status, title: product.title },
    after: { status: "active" },
  });

  return ok(updated);
});

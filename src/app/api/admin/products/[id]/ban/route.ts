import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/products/[id]/ban {reason?} (RBAC products.moderate)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("products.moderate");
  const { id } = await ctx.params;
  const body = await readBody(req).catch(() => ({}) as Record<string, never>);
  const reason = typeof body.reason === "string" ? body.reason : "Policy violation";

  const product = await db.product.findUnique({ where: { id }, include: { store: { include: { seller: true } } } });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found");

  const updated = await db.product.update({ where: { id }, data: { status: "banned", rejectReason: reason, isFeatured: false } });
  // banned products must not stay in marketplace slots
  await db.featuredSlot.deleteMany({ where: { productId: id } });

  await notify({
    event: "product.banned",
    channel: "email",
    recipient: product.store.seller.email,
    subject: `Product banned: ${product.title}`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "product.ban",
    entityType: "product",
    entityId: id,
    before: { status: product.status, title: product.title },
    after: { status: "banned", reason },
  });

  return ok(updated);
});

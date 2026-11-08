import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { AdminFeaturedDeleteData } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/admin/featured/[id]
export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;

  const slot = await db.featuredSlot.findUnique({ where: { id }, include: { product: true } });
  if (!slot) throw new ApiError(404, "NOT_FOUND", "Featured slot not found");

  await db.featuredSlot.delete({ where: { id } });
  const remaining = await db.featuredSlot.count({ where: { productId: slot.productId } });
  if (remaining === 0) {
    await db.product.update({ where: { id: slot.productId }, data: { isFeatured: false } });
  }

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "featured.delete",
    entityType: "featured_slot",
    entityId: id,
    before: { productId: slot.productId, title: slot.product.title, slot: slot.slot },
    after: null,
  });

  const payload: AdminFeaturedDeleteData = { deleted: true };
  return ok(payload);
});

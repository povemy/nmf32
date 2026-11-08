import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, str, optNum } from "@/app/api/admin/_helpers";
import type { AdminCategoryDetail, AdminCategoryDeleteData, CategoryUpdateBody } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/categories/[id] {name?, commissionPercent?, sortOrder?}
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const body = (await readBody(req)) as CategoryUpdateBody & Record<string, unknown>;

  const category = await db.category.findUnique({ where: { id } });
  if (!category) throw new ApiError(404, "NOT_FOUND", "Category not found");

  const data: { name?: string; commissionPercent?: number | null; sortOrder?: number } = {};
  const name = str(body, "name");
  if (name != null) data.name = name;
  if ("commissionPercent" in body) {
    const v = optNum(body, "commissionPercent");
    if (v != null && (v < 0 || v > 100)) throw new ApiError(400, "VALIDATION", "commissionPercent must be 0..100");
    data.commissionPercent = v ?? null;
  }
  const sortOrder = optNum(body, "sortOrder");
  if (sortOrder != null) data.sortOrder = Math.round(sortOrder);
  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const updated = await db.category.update({ where: { id }, data });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "category.update",
    entityType: "category",
    entityId: id,
    before: { name: category.name, commissionPercent: category.commissionPercent, sortOrder: category.sortOrder },
    after: data,
  });

  const payload: AdminCategoryDetail = {
    id: updated.id,
    name: updated.name,
    slug: updated.slug,
    parentId: updated.parentId,
    commissionPercent: updated.commissionPercent,
    imageUrl: updated.imageUrl,
    sortOrder: updated.sortOrder,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
  return ok(payload);
});

// DELETE /api/admin/categories/[id] — detach products (categoryId=null), re-parent children, then delete
export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;

  const category = await db.category.findUnique({ where: { id } });
  if (!category) throw new ApiError(404, "NOT_FOUND", "Category not found");

  await db.product.updateMany({ where: { categoryId: id }, data: { categoryId: null } });
  await db.category.updateMany({ where: { parentId: id }, data: { parentId: null } });
  await db.category.delete({ where: { id } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "category.delete",
    entityType: "category",
    entityId: id,
    before: { name: category.name, slug: category.slug },
    after: null,
  });

  const payload: AdminCategoryDeleteData = { deleted: true };
  return ok(payload);
});

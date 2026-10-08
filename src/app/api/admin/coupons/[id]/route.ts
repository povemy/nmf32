import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, str, optNum, optDate, optBool } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/coupons/[id]
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const body = await readBody(req);

  const coupon = await db.coupon.findUnique({ where: { id } });
  if (!coupon) throw new ApiError(404, "NOT_FOUND", "Coupon not found");

  const data: Record<string, unknown> = {};
  const description = str(body, "description");
  if (description != null) data.description = description;
  const percent = optNum(body, "percent");
  if (percent != null) {
    if (percent < 0 || percent > 100) throw new ApiError(400, "VALIDATION", "percent must be 0..100");
    data.percent = percent;
  }
  const amountMinor = optNum(body, "amountMinor");
  if (amountMinor != null) {
    if (amountMinor < 0) throw new ApiError(400, "VALIDATION", "amountMinor must be >= 0");
    data.amountMinor = Math.round(amountMinor);
  }
  const minSpendMinor = optNum(body, "minSpendMinor");
  if (minSpendMinor != null) data.minSpendMinor = Math.round(minSpendMinor);
  const maxRedemptions = optNum(body, "maxRedemptions");
  if (maxRedemptions != null) data.maxRedemptions = Math.round(maxRedemptions);
  const perCustomerLimit = optNum(body, "perCustomerLimit");
  if (perCustomerLimit != null) data.perCustomerLimit = Math.round(perCustomerLimit);
  if ("startsAt" in body) data.startsAt = optDate(body, "startsAt") ?? null;
  if ("endsAt" in body) data.endsAt = optDate(body, "endsAt") ?? null;
  const isActive = optBool(body, "isActive");
  if (isActive != null) data.isActive = isActive;
  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const updated = await db.coupon.update({ where: { id }, data });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "coupon.update",
    entityType: "coupon",
    entityId: id,
    before: { code: coupon.code, isActive: coupon.isActive, percent: coupon.percent, amountMinor: coupon.amountMinor },
    after: data,
  });

  return ok(updated);
});

// DELETE /api/admin/coupons/[id]
export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;

  const coupon = await db.coupon.findUnique({ where: { id } });
  if (!coupon) throw new ApiError(404, "NOT_FOUND", "Coupon not found");

  await db.coupon.delete({ where: { id } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "coupon.delete",
    entityType: "coupon",
    entityId: id,
    before: { code: coupon.code, scope: coupon.scope },
    after: null,
  });

  return ok({ deleted: true });
});

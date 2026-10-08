import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, optNum, optDate, str, optBool } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/commission/overrides/[id] (RBAC commission.manage)
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("commission.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);

  const ov = await db.commissionOverride.findUnique({ where: { id } });
  if (!ov) throw new ApiError(404, "NOT_FOUND", "Override not found");

  const data: Record<string, unknown> = {};
  const percent = optNum(body, "percent");
  if (percent != null) {
    if (percent < 0 || percent > 100) throw new ApiError(400, "VALIDATION", "percent must be 0..100");
    data.percent = percent;
  }
  const fixedFeeMinor = optNum(body, "fixedFeeMinor");
  if (fixedFeeMinor != null) {
    if (fixedFeeMinor < 0) throw new ApiError(400, "VALIDATION", "fixedFeeMinor must be >= 0");
    data.fixedFeeMinor = Math.round(fixedFeeMinor);
  }
  const holdDays = optNum(body, "holdDays");
  if (holdDays != null) {
    if (holdDays < 0 || holdDays > 60) throw new ApiError(400, "VALIDATION", "holdDays must be 0..60");
    data.holdDays = Math.round(holdDays);
  }
  if ("validFrom" in body) data.validFrom = optDate(body, "validFrom") ?? null;
  if ("validTo" in body) data.validTo = optDate(body, "validTo") ?? null;
  const isActive = optBool(body, "isActive");
  if (isActive != null) data.isActive = isActive;
  const name = str(body, "name");
  if (name) data.name = name;
  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const updated = await db.commissionOverride.update({ where: { id }, data });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.override.update",
    entityType: "commission_override",
    entityId: id,
    before: { percent: ov.percent, fixedFeeMinor: ov.fixedFeeMinor, holdDays: ov.holdDays, isActive: ov.isActive },
    after: data,
  });

  return ok(updated);
});

// DELETE /api/admin/commission/overrides/[id] (RBAC commission.manage)
export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("commission.manage");
  const { id } = await ctx.params;

  const ov = await db.commissionOverride.findUnique({ where: { id } });
  if (!ov) throw new ApiError(404, "NOT_FOUND", "Override not found");

  await db.commissionOverride.delete({ where: { id } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.override.delete",
    entityType: "commission_override",
    entityId: id,
    before: { scope: ov.scope, percent: ov.percent, fixedFeeMinor: ov.fixedFeeMinor, holdDays: ov.holdDays },
    after: null,
  });

  return ok({ deleted: true });
});

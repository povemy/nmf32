import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, optNum, optDate, optBool } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/commission/holidays/[id] (RBAC commission.manage)
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("commission.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);

  const h = await db.feeHoliday.findUnique({ where: { id } });
  if (!h) throw new ApiError(404, "NOT_FOUND", "Fee holiday not found");

  const data: Record<string, unknown> = {};
  const percent = optNum(body, "percent");
  if (percent != null) {
    if (percent < 0 || percent > 100) throw new ApiError(400, "VALIDATION", "percent must be 0..100");
    data.percent = percent;
  }
  if ("startsAt" in body) {
    const v = optDate(body, "startsAt");
    if (!v) throw new ApiError(400, "VALIDATION", "startsAt invalid");
    data.startsAt = v;
  }
  if ("endsAt" in body) {
    const v = optDate(body, "endsAt");
    if (!v) throw new ApiError(400, "VALIDATION", "endsAt invalid");
    data.endsAt = v;
  }
  const isActive = optBool(body, "isActive");
  if (isActive != null) data.isActive = isActive;
  if (typeof body.name === "string" && body.name.trim() !== "") data.name = body.name.trim();
  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const updated = await db.feeHoliday.update({ where: { id }, data });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.holiday.update",
    entityType: "fee_holiday",
    entityId: id,
    before: { name: h.name, percent: h.percent, isActive: h.isActive, startsAt: h.startsAt, endsAt: h.endsAt },
    after: data,
  });

  return ok(updated);
});

// DELETE /api/admin/commission/holidays/[id] (RBAC commission.manage)
export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("commission.manage");
  const { id } = await ctx.params;

  const h = await db.feeHoliday.findUnique({ where: { id } });
  if (!h) throw new ApiError(404, "NOT_FOUND", "Fee holiday not found");

  await db.feeHoliday.delete({ where: { id } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.holiday.delete",
    entityType: "fee_holiday",
    entityId: id,
    before: { name: h.name, percent: h.percent, scope: h.scope },
    after: null,
  });

  return ok({ deleted: true });
});

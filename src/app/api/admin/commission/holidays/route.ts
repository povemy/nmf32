import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, optNum, optDate, optBool } from "@/app/api/admin/_helpers";

// GET /api/admin/commission/holidays
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.feeHoliday.findMany({ orderBy: { startsAt: "desc" } });
  const data = rows.map((h) => ({ ...h, scopeIdsList: h.scopeIds ? (JSON.parse(h.scopeIds) as string[]) : [] }));
  return ok(data);
});

// POST /api/admin/commission/holidays (RBAC commission.manage)
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("commission.manage");
  const body = await readBody(req);

  const name = reqStr(body, "name", "name");
  const scope = typeof body.scope === "string" && ["all", "sellers", "categories"].includes(body.scope) ? body.scope : "all";
  let scopeIds: string | null = null;
  if (scope === "all") {
    scopeIds = null;
  } else {
    const ids = Array.isArray(body.scopeIds) ? body.scopeIds.filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0) throw new ApiError(400, "VALIDATION", `scopeIds required for scope=${scope}`);
    scopeIds = JSON.stringify(ids);
  }
  const percent = optNum(body, "percent") ?? 0;
  if (percent < 0 || percent > 100) throw new ApiError(400, "VALIDATION", "percent must be 0..100");
  const startsAt = optDate(body, "startsAt");
  const endsAt = optDate(body, "endsAt");
  if (!startsAt || !endsAt) throw new ApiError(400, "VALIDATION", "startsAt and endsAt are required");
  if (startsAt > endsAt) throw new ApiError(400, "VALIDATION", "startsAt must be before endsAt");
  const isActive = optBool(body, "isActive") ?? true;

  const created = await db.feeHoliday.create({
    data: { name, scope, scopeIds, percent, startsAt, endsAt, isActive },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.holiday.create",
    entityType: "fee_holiday",
    entityId: created.id,
    after: { name, scope, percent, startsAt, endsAt, isActive },
  });

  return ok(created);
});

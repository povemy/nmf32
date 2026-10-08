import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/activity-logs?actorType=&action=&page=&size= (RBAC logs.view)
export const GET = handle(async (req: NextRequest) => {
  await requireCap("logs.view");
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const actorType = url.searchParams.get("actorType");
  const action = url.searchParams.get("action");

  const where: Prisma.ActivityLogWhereInput = {
    ...(actorType && actorType !== "all" ? { actorType } : {}),
    ...(action ? { action: { contains: action } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.activityLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    db.activityLog.count({ where }),
  ]);

  const data = rows.map((r) => ({
    ...r,
    meta: parseSafe(r.metaJson),
    metaJson: undefined,
  }));
  return okPaged(data, { page, size, total });
});

function parseSafe(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import type { AdminAuditLogRow } from "@/lib/types/api-contract";

// GET /api/admin/audit-logs?adminEmail=&action=&entityType=&page=&size= (RBAC logs.view)
export const GET = handle(async (req: NextRequest) => {
  await requireCap("logs.view");
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const adminEmail = url.searchParams.get("adminEmail");
  const action = url.searchParams.get("action");
  const entityType = url.searchParams.get("entityType");

  const where: Prisma.AdminAuditLogWhereInput = {
    ...(adminEmail ? { adminEmail: { contains: adminEmail } } : {}),
    ...(action ? { action: { contains: action } } : {}),
    ...(entityType ? { entityType } : {}),
  };

  const [rows, total] = await Promise.all([
    db.adminAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    db.adminAuditLog.count({ where }),
  ]);

  const data: AdminAuditLogRow[] = rows.map((r) => ({
    id: r.id,
    adminId: r.adminId,
    adminEmail: r.adminEmail,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    before: parseSafe(r.beforeJson),
    after: parseSafe(r.afterJson),
    createdAt: r.createdAt.toISOString(),
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

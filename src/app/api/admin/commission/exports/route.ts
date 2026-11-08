import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { aggregateCommission, snapshotToCsv } from "@/lib/commission-export";
import { readBody } from "@/app/api/admin/_helpers";
import type { ExportsData, ExportCreateBody, ExportCreateData } from "@/lib/types/api-contract";

// GET /api/admin/commission/exports — export history (latest 50).
export const GET = handle(async () => {
  await requireAdmin();
  const rows = await db.commissionExport.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, periodFrom: true, periodTo: true, totalMinor: true, orderCount: true, lineCount: true, format: true, createdByEmail: true, createdAt: true },
  });
  const payload: ExportsData[] = rows.map((r) => ({
    ...r,
    periodFrom: r.periodFrom.toISOString(),
    periodTo: r.periodTo.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
  return ok(payload);
});

// POST /api/admin/commission/exports {days: 30|90|365} — snapshot the current
// commission aggregates into history and return the CSV (RBAC commission.manage).
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("commission.manage");
  const body = (await readBody(req)) as ExportCreateBody;
  const days = Math.min(730, Math.max(7, Number(body.days ?? 90) || 90));
  const periodTo = new Date();
  const periodFrom = new Date(periodTo.getTime() - days * 86_400_000);

  const snapshot = await aggregateCommission(periodFrom, periodTo, admin.email);
  if (snapshot.summary.commissionMinor === 0 && snapshot.stores.length === 0) {
    throw new ApiError(409, "EMPTY_PERIOD", "No commission activity in the selected period — nothing to export");
  }
  const csv = snapshotToCsv(snapshot);
  const lineCount = snapshot.stores.length + snapshot.weekly.length;

  const row = await db.commissionExport.create({
    data: {
      periodFrom,
      periodTo,
      totalMinor: snapshot.summary.commissionMinor,
      orderCount: snapshot.summary.orderCount,
      lineCount,
      format: "csv",
      snapshotJson: JSON.stringify(snapshot),
      createdByEmail: admin.email,
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.export.create",
    entityType: "commission_export",
    entityId: row.id,
    before: null,
    after: { days, totalMinor: row.totalMinor, orderCount: row.orderCount, lineCount },
  });

  const payload: ExportCreateData = {
    export: {
      ...row,
      periodFrom: row.periodFrom.toISOString(),
      periodTo: row.periodTo.toISOString(),
      createdAt: row.createdAt.toISOString(),
    },
    csv,
    snapshot,
  };
  return ok(payload, { status: 201 });
});

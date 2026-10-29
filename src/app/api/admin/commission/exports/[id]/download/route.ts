import { NextRequest, NextResponse } from "next/server";
import { handle, ApiError } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { snapshotToCsv, type CommissionSnapshot } from "@/lib/commission-export";

// GET /api/admin/commission/exports/[id]/download — regenerate the CSV from
// the stored snapshot. The historical file is byte-stable: aggregates are
// frozen in snapshotJson, never recomputed from live data.
// F-26 (Phase 3): full commission CSV download — now `commission.manage`
// (superadmin | finance), matching the POST that creates the export.
// Previously bare requireAdmin (moderator could download every export).
export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  await requireCap("commission.manage");
  const { id } = await ctx.params;
  const row = await db.commissionExport.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Export not found");

  const snapshot = JSON.parse(row.snapshotJson) as CommissionSnapshot;
  const csv = snapshotToCsv(snapshot);
  const stamp = row.periodFrom.toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="NOMOFEE-commission-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});

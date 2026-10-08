import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/notifications — latest 100 notification logs
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.notificationLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return ok(rows);
});

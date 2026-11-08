import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { AdminNotificationRow } from "@/lib/types/api-contract";

// GET /api/admin/notifications — latest 100 notification logs
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.notificationLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  const data: AdminNotificationRow[] = rows.map((r) => ({
    id: r.id,
    event: r.event,
    channel: r.channel,
    recipient: r.recipient,
    subject: r.subject,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    dedupKey: r.dedupKey,
  }));
  return ok(data);
});

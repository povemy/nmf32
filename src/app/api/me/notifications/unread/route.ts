import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import type { UnreadCountData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/me/notifications/unread — cheap badge count for the header bell
// (count where readAt is null).
export const GET = handle(async () => {
  const me = await requireShopper();
  const unread = await db.notification.count({ where: { shopperUserId: me.id, readAt: null } });
  const payload: UnreadCountData = { unread };
  return ok(payload);
});

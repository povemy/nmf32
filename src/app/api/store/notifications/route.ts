import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import type { SellerNotificationsData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/notifications — seller in-app notification bell feed (FIN-3-c).
//
// Serves the NotificationLog rows that the finance flows already write for the
// seller's email with channel="inapp" (order.paid from FIN-2-b; payout
// requested/approved/paid/failed/rejected from FIN-2-a/FIN-3-b). This is a
// SEPARATE subsystem from the shopper bell — /api/me/notifications reads the
// `Notification` model and is intentionally untouched.
//
// Bounded list, bell-scoped: latest 30 rows, no pagination. NotificationLog
// has no read/seen tracking (deliberately NOT added — read-state would be
// fake without a real mark-read flow), so the only honest server-side signal
// is recency: `recentCount` = rows within the last 24h, consumed by the bell
// as the "new" dot heuristic.
export const GET = handle(async () => {
  const { me } = await requireActiveSellerStore();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [rows, recentCount] = await Promise.all([
    db.notificationLog.findMany({
      where: { recipient: me.email, channel: "inapp" },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    db.notificationLog.count({
      where: { recipient: me.email, channel: "inapp", createdAt: { gte: since } },
    }),
  ]);

  const payload: SellerNotificationsData = {
    notifications: rows.map((r) => ({
      id: r.id,
      // subject is nullable in the schema — fall back to the event name so the
      // bell never renders a blank row.
      subject: r.subject ?? r.event,
      createdAt: r.createdAt.toISOString(),
      event: r.event,
    })),
    recentCount,
  };
  return ok(payload);
});

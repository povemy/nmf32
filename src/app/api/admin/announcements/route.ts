import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, str, optDate, optBool } from "@/app/api/admin/_helpers";
import type { AdminAnnouncementRow, AnnouncementPostBody } from "@/lib/types/api-contract";

/** Announcement DB row → contract AdminAnnouncementRow (Dates → ISO strings). */
function serializeAnnouncement(
  a: {
    id: string;
    title: string;
    body: string | null;
    audience: string;
    startsAt: Date | null;
    endsAt: Date | null;
    isActive: boolean;
    createdAt: Date;
  }
): AdminAnnouncementRow {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    audience: a.audience,
    startsAt: a.startsAt ? a.startsAt.toISOString() : null,
    endsAt: a.endsAt ? a.endsAt.toISOString() : null,
    isActive: a.isActive,
    createdAt: a.createdAt.toISOString(),
  };
}

// GET /api/admin/announcements
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.announcement.findMany({ orderBy: { createdAt: "desc" } });
  const data: AdminAnnouncementRow[] = rows.map(serializeAnnouncement);
  return ok(data);
});

// POST /api/admin/announcements
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin();
  const body = (await readBody(req)) as AnnouncementPostBody & Record<string, unknown>;
  const title = reqStr(body, "title", "title");
  const audience = str(body, "audience") ?? "all";
  if (!["all", "sellers", "admins"].includes(audience)) throw new ApiError(400, "VALIDATION", "audience must be all | sellers | admins");

  const created = await db.announcement.create({
    data: {
      title,
      body: str(body, "body") ?? null,
      audience,
      startsAt: optDate(body, "startsAt") ?? null,
      endsAt: optDate(body, "endsAt") ?? null,
      isActive: optBool(body, "isActive") ?? true,
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "announcement.create",
    entityType: "announcement",
    entityId: created.id,
    after: { title, audience },
  });

  const payload: AdminAnnouncementRow = serializeAnnouncement(created);
  return ok(payload);
});

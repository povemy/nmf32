import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, str, optDate, optBool } from "@/app/api/admin/_helpers";

// GET /api/admin/announcements
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.announcement.findMany({ orderBy: { createdAt: "desc" } });
  return ok(rows);
});

// POST /api/admin/announcements
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
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

  return ok(created);
});

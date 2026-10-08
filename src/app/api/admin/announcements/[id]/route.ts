import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, str, optDate, optBool } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/announcements/[id]
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const body = await readBody(req);

  const ann = await db.announcement.findUnique({ where: { id } });
  if (!ann) throw new ApiError(404, "NOT_FOUND", "Announcement not found");

  const data: Record<string, unknown> = {};
  const title = str(body, "title");
  if (title != null) data.title = title;
  const text = str(body, "body");
  if (text != null) data.body = text;
  const audience = str(body, "audience");
  if (audience != null) {
    if (!["all", "sellers", "admins"].includes(audience)) throw new ApiError(400, "VALIDATION", "audience must be all | sellers | admins");
    data.audience = audience;
  }
  if ("startsAt" in body) data.startsAt = optDate(body, "startsAt") ?? null;
  if ("endsAt" in body) data.endsAt = optDate(body, "endsAt") ?? null;
  const isActive = optBool(body, "isActive");
  if (isActive != null) data.isActive = isActive;
  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const updated = await db.announcement.update({ where: { id }, data });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "announcement.update",
    entityType: "announcement",
    entityId: id,
    before: { title: ann.title, isActive: ann.isActive },
    after: data,
  });

  return ok(updated);
});

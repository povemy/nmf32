import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody } from "@/app/api/admin/_helpers";

// GET /api/admin/settings — key/valueJson list
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.setting.findMany({ orderBy: { key: "asc" } });
  return ok(rows);
});

// PUT /api/admin/settings {settings: [{key, valueJson}]} (RBAC settings.manage)
export const PUT = handle(async (req: NextRequest) => {
  const admin = await requireCap("settings.manage");
  const body = await readBody(req);
  const settings = Array.isArray(body.settings) ? body.settings : null;
  if (!settings || settings.length === 0) throw new ApiError(400, "VALIDATION", "settings array is required");

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const s of settings) {
    if (!s || typeof s !== "object") continue;
    const key = typeof (s as Record<string, unknown>).key === "string" ? ((s as Record<string, unknown>).key as string) : null;
    if (!key) continue;
    const existing = await db.setting.findUnique({ where: { key } });
    before[key] = existing ? existing.valueJson : null;
    let valueJson: string;
    const raw = (s as Record<string, unknown>).valueJson;
    if (typeof raw === "string") {
      // accept pre-serialized JSON or raw scalar; normalize scalars into JSON
      const trimmed = raw.trim();
      if (trimmed === "" ) valueJson = '""';
      else if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"") || /^(true|false|null|-?\d+(\.\d+)?)$/.test(trimmed)) valueJson = trimmed;
      else valueJson = JSON.stringify(trimmed);
    } else {
      valueJson = JSON.stringify(raw ?? null);
    }
    const upserted = await db.setting.upsert({
      where: { key },
      create: { key, valueJson },
      update: { valueJson },
    });
    after[key] = upserted.valueJson;
  }

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "settings.update",
    entityType: "setting",
    entityId: null,
    before,
    after,
  });

  const rows = await db.setting.findMany({ orderBy: { key: "asc" } });
  return ok(rows);
});

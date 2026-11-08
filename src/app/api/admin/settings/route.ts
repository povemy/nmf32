import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody } from "@/app/api/admin/_helpers";
import { SETTINGS_REGISTRY, settingMetaFor, defaultJsonValue, validateSettingValue } from "@/lib/settings-registry";
import type { AdminSettingsRow, SettingsPutBody, AdminSettingsPutRow } from "@/lib/types/api-contract";

// GET /api/admin/settings — DB rows merged with the settings registry so the
// UI can render friendly controls (toggles/selects/numbers) instead of raw
// JSON. Known-but-absent keys are surfaced with their default value; keys the
// registry does not know fall through to the Advanced (raw JSON) group.
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.setting.findMany({ orderBy: { key: "asc" } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const visible = SETTINGS_REGISTRY.filter((m) => !m.hidden);
  const visibleKeys = new Set(visible.map((m) => m.key));

  const known: AdminSettingsRow[] = visible.map((m) => {
    const row = byKey.get(m.key);
    return {
      key: m.key,
      valueJson: row?.valueJson ?? defaultJsonValue(m.field),
      description: row?.description ?? m.description,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      meta: m,
    };
  });
  const extras: AdminSettingsRow[] = rows
    .filter((r) => !visibleKeys.has(r.key))
    .map((r) => ({
      key: r.key,
      valueJson: r.valueJson,
      description: r.description,
      updatedAt: r.updatedAt.toISOString(),
      meta: settingMetaFor(r.key),
    }));

  return ok([...known, ...extras]);
});

// PUT /api/admin/settings {settings: [{key, valueJson}]} (RBAC settings.manage)
// Values are validated against the registry so friendly controls cannot write
// garbage (the historic `"claimed"` contamination is impossible to recreate).
export const PUT = handle(async (req: NextRequest) => {
  const admin = await requireCap("settings.manage");
  const body = (await readBody(req)) as SettingsPutBody & Record<string, unknown>;
  const settings = Array.isArray(body.settings) ? body.settings : null;
  if (!settings || settings.length === 0) throw new ApiError(400, "VALIDATION", "settings array is required");

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const s of settings) {
    if (!s || typeof s !== "object") continue;
    const key = typeof (s as Record<string, unknown>).key === "string" ? ((s as Record<string, unknown>).key as string) : null;
    if (!key) continue;
    const meta = settingMetaFor(key);
    if (meta.field.kind === "readonly") throw new ApiError(400, "READ_ONLY", `'${key}' is written by the system and cannot be edited.`);

    const existing = await db.setting.findUnique({ where: { key } });
    before[key] = existing ? existing.valueJson : null;

    let valueJson: string;
    const raw = (s as Record<string, unknown>).valueJson;
    const draft = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
    if (meta.field.kind === "json") {
      // Advanced/unknown keys: keep the legacy scalar normalization.
      const trimmed = draft.trim();
      if (trimmed === "") valueJson = '""';
      else if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"") || /^(true|false|null|-?\d+(\.\d+)?)$/.test(trimmed)) valueJson = trimmed;
      else valueJson = JSON.stringify(trimmed);
    } else {
      const checked = validateSettingValue(key, draft);
      if (!checked.ok) throw new ApiError(400, "VALIDATION", `'${key}': ${checked.error}`);
      valueJson = checked.valueJson;
    }

    const upserted = await db.setting.upsert({
      where: { key },
      create: { key, valueJson, description: meta.description || null },
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
  const data: AdminSettingsPutRow[] = rows.map((r) => ({
    key: r.key,
    valueJson: r.valueJson,
    description: r.description,
    updatedAt: r.updatedAt.toISOString(),
  }));
  return ok(data);
});

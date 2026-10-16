import { NextRequest } from "next/server";
import { handle, ok, okPaged, ApiError, getPagination, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, optDate, optBool } from "@/app/api/admin/_helpers";
import {
  CAMPAIGN_PRESETS,
  DEFAULT_CAMPAIGN_THEME,
  campaignStatusOf,
  daysUntil,
  findCampaignPreset,
  invalidateCampaignCache,
  parseCampaignTheme,
  presetDateRange,
  serializeCampaignTheme,
  validateCampaignTheme,
  CampaignThemeT,
} from "@/lib/campaigns";

type CampaignRow = {
  id: string;
  name: string;
  presetId: string | null;
  themeJson: string;
  isPublished: boolean;
  startAt: Date;
  endAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function present(c: CampaignRow) {
  return {
    ...c,
    theme: parseCampaignTheme(c.themeJson),
    status: campaignStatusOf(c),
    daysUntilStart: daysUntil(c.startAt),
    daysLeft: daysUntil(c.endAt),
  };
}

/** Map the derived status token onto a Prisma where-fragment. */
function statusWhere(status: string, now: Date) {
  switch (status) {
    case "draft":
      return { isPublished: false };
    case "scheduled":
      return { isPublished: true, startAt: { gt: now } };
    case "live":
      return { isPublished: true, startAt: { lte: now }, endAt: { gte: now } };
    case "ended":
      return { isPublished: true, endAt: { lt: now } };
    default:
      return {};
  }
}

// GET /api/admin/campaigns — paged list (RBAC campaigns.manage).
// Query: page, size, status=draft|scheduled|live|ended, q=<name contains>.
export const GET = handle(async (req: NextRequest) => {
  await requireCap("campaigns.manage");
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const status = url.searchParams.get("status") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim();

  const where = {
    ...statusWhere(status, new Date()),
    ...(q ? { name: { contains: q } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.campaign.findMany({ where, orderBy: { startAt: "desc" }, skip, take }),
    db.campaign.count({ where }),
  ]);

  return okPaged(rows.map(present), { page, size, total });
});

// POST /api/admin/campaigns — create (RBAC campaigns.manage).
// Body: { name, presetId?, startAt?, endAt?, theme?, isPublished? }.
// With a presetId and no dates, the window is auto-filled from the preset
// (nearest upcoming occurrence). Theme JSON is validated server-side.
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("campaigns.manage");
  const body = await readBody(req);

  const name = reqStr(body, "name", "name");
  if (name.length > 120) throw new ApiError(400, "VALIDATION", "name must be ≤ 120 characters");

  const preset = findCampaignPreset(typeof body.presetId === "string" ? body.presetId : undefined);
  if (body.presetId != null && body.presetId !== "" && !preset) {
    throw new ApiError(400, "VALIDATION", `Unknown presetId '${String(body.presetId)}'. Valid: ${CAMPAIGN_PRESETS.map((p) => p.id).join(", ")}`);
  }

  const now = new Date();
  let startAt = optDate(body, "startAt");
  let endAt = optDate(body, "endAt");
  if (preset && (!startAt || !endAt)) {
    const range = presetDateRange(preset, now);
    if (range) {
      startAt = startAt ?? range.start;
      endAt = endAt ?? range.end;
    }
  }
  if (!startAt || !endAt) throw new ApiError(400, "VALIDATION", "startAt and endAt are required");
  if (startAt >= endAt) throw new ApiError(400, "VALIDATION", "startAt must be before endAt");

  let theme: CampaignThemeT;
  if (body.theme != null && typeof body.theme === "object") {
    const verdict = validateCampaignTheme(body.theme);
    if (!verdict.ok) throw new ApiError(400, "VALIDATION", "Invalid campaign theme", verdict.errors);
    theme = verdict.theme;
  } else {
    theme = preset ? preset.theme : DEFAULT_CAMPAIGN_THEME;
  }

  const isPublished = optBool(body, "isPublished") ?? false;

  const created = await db.campaign.create({
    data: {
      name,
      presetId: preset?.id ?? null,
      themeJson: serializeCampaignTheme(theme),
      isPublished,
      startAt,
      endAt,
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "campaign.create",
    entityType: "campaign",
    entityId: created.id,
    after: { name: created.name, presetId: created.presetId, isPublished: created.isPublished, startAt, endAt },
  });

  invalidateCampaignCache();
  return ok(present(created));
});

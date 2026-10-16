import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, optDate, optBool } from "@/app/api/admin/_helpers";
import {
  campaignStatusOf,
  daysUntil,
  findCampaignPreset,
  invalidateCampaignCache,
  parseCampaignTheme,
  serializeCampaignTheme,
  validateCampaignTheme,
} from "@/lib/campaigns";

type Ctx = { params: Promise<{ id: string }> };

type CampaignUpdateData = {
  isPublished?: boolean;
  name?: string;
  presetId?: string | null;
  startAt?: Date;
  endAt?: Date;
  themeJson?: string;
};

// PATCH /api/admin/campaigns/[id] — publish/unpublish + edits
// (RBAC campaigns.manage).
// Body: { publish?: bool, isPublished?: bool, name?, presetId?, startAt?,
//         endAt?, theme? }. Theme JSON is validated server-side; the window
//        stays valid (start < end) across combined edits.
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("campaigns.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);

  const campaign = await db.campaign.findUnique({ where: { id } });
  if (!campaign) throw new ApiError(404, "NOT_FOUND", "Campaign not found");

  const data: CampaignUpdateData = {};

  // Publish / unpublish (accept a "publish" toggle and/or "isPublished").
  const publish = optBool(body, "publish");
  const isPublished = optBool(body, "isPublished");
  if (publish != null) data.isPublished = publish;
  if (isPublished != null) data.isPublished = isPublished;

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name === "") throw new ApiError(400, "VALIDATION", "name cannot be empty");
    if (name.length > 120) throw new ApiError(400, "VALIDATION", "name must be ≤ 120 characters");
    data.name = name;
  }

  if ("presetId" in body) {
    if (body.presetId == null || body.presetId === "") {
      data.presetId = null;
    } else {
      const preset = findCampaignPreset(typeof body.presetId === "string" ? body.presetId : undefined);
      if (!preset) throw new ApiError(400, "VALIDATION", `Unknown presetId '${String(body.presetId)}'`);
      data.presetId = preset.id;
    }
  }

  // Dates: validate the EFFECTIVE window (provided values overlay the row).
  const effStart = "startAt" in body ? optDate(body, "startAt") : undefined;
  const effEnd = "endAt" in body ? optDate(body, "endAt") : undefined;
  if ("startAt" in body) {
    if (!effStart) throw new ApiError(400, "VALIDATION", "startAt is not a valid date");
    data.startAt = effStart;
  }
  if ("endAt" in body) {
    if (!effEnd) throw new ApiError(400, "VALIDATION", "endAt is not a valid date");
    data.endAt = effEnd;
  }
  const finalStart = data.startAt ?? campaign.startAt;
  const finalEnd = data.endAt ?? campaign.endAt;
  if (finalStart >= finalEnd) throw new ApiError(400, "VALIDATION", "startAt must be before endAt");

  // Theme: full replacement payload, validated per-field (bad fields → 400).
  if ("theme" in body) {
    if (body.theme == null || typeof body.theme !== "object" || Array.isArray(body.theme)) {
      throw new ApiError(400, "VALIDATION", "theme must be an object (send {} for defaults)");
    }
    const verdict = validateCampaignTheme(body.theme);
    if (!verdict.ok) throw new ApiError(400, "VALIDATION", "Invalid campaign theme", verdict.errors);
    data.themeJson = serializeCampaignTheme(verdict.theme);
  }

  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const updated = await db.campaign.update({ where: { id }, data });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "campaign.update",
    entityType: "campaign",
    entityId: id,
    before: { name: campaign.name, presetId: campaign.presetId, isPublished: campaign.isPublished, startAt: campaign.startAt, endAt: campaign.endAt },
    after: data,
  });

  invalidateCampaignCache();

  return ok({
    ...updated,
    theme: parseCampaignTheme(updated.themeJson),
    status: campaignStatusOf(updated),
    daysUntilStart: daysUntil(updated.startAt),
    daysLeft: daysUntil(updated.endAt),
  });
});

// DELETE /api/admin/campaigns/[id] (RBAC campaigns.manage).
export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("campaigns.manage");
  const { id } = await ctx.params;

  const campaign = await db.campaign.findUnique({ where: { id } });
  if (!campaign) throw new ApiError(404, "NOT_FOUND", "Campaign not found");

  await db.campaign.delete({ where: { id } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "campaign.delete",
    entityType: "campaign",
    entityId: id,
    before: { name: campaign.name, presetId: campaign.presetId, isPublished: campaign.isPublished },
    after: null,
  });

  invalidateCampaignCache();
  return ok({ deleted: true });
});

import { NextRequest } from "next/server";
import { handle, ok, okPaged, ApiError, getPagination, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, optDate, optBool } from "@/app/api/admin/_helpers";
import { parseCampaignMerchFields } from "@/app/api/admin/_campaign-merch";
import type { AdminCampaignItem, CampaignCreateBody } from "@/lib/types/api-contract";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import {
  CAMPAIGN_PRESETS,
  DEFAULT_CAMPAIGN_THEME,
  campaignStatusOf,
  daysUntil,
  findCampaignPreset,
  findPlacement,
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
  description: string | null;
  presetId: string | null;
  themeJson: string;
  isPublished: boolean;
  placement: string;
  priority: number;
  displayOrder: number;
  ctaLabel: string | null;
  ctaHref: string | null;
  bannerDesktopUrl: string | null;
  bannerMobileUrl: string | null;
  thumbnailUrl: string | null;
  productQuery: string | null;
  archivedAt: Date | null;
  startAt: Date;
  endAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function present(c: CampaignRow): AdminCampaignItem {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    presetId: c.presetId,
    themeJson: c.themeJson,
    isPublished: c.isPublished,
    placement: c.placement,
    priority: c.priority,
    displayOrder: c.displayOrder,
    ctaLabel: c.ctaLabel,
    ctaHref: c.ctaHref,
    bannerDesktopUrl: c.bannerDesktopUrl,
    bannerMobileUrl: c.bannerMobileUrl,
    thumbnailUrl: c.thumbnailUrl,
    productQuery: c.productQuery,
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
    startAt: c.startAt.toISOString(),
    endAt: c.endAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    theme: parseCampaignTheme(c.themeJson),
    status: campaignStatusOf(c),
    daysUntilStart: daysUntil(c.startAt),
    daysLeft: daysUntil(c.endAt),
  };
}
// Work order 14: the derived status token maps onto a Prisma where-fragment.
// "archived" is a real filter, and the DEFAULT listing (no/other status)
// EXCLUDES archived campaigns — exactly like the public homepage.
function statusWhere(status: string, now: Date) {
  switch (status) {
    case "draft":
      return { isPublished: false, archivedAt: null };
    case "scheduled":
      return { isPublished: true, archivedAt: null, startAt: { gt: now } };
    case "live":
      return { isPublished: true, archivedAt: null, startAt: { lte: now }, endAt: { gte: now } };
    case "ended":
      return { isPublished: true, archivedAt: null, endAt: { lt: now } };
    case "archived":
      return { archivedAt: { not: null } };
    default:
      return { archivedAt: null };
  }
}

// ---------------------------------------------------------------------------
// Cache invalidation shared by every campaign mutation: globalThis memo +
// the pub:campaigns tag (market-home aggregate) — the TTL is only the safety
// net. Public staleness window is therefore seconds, not minutes.
// ---------------------------------------------------------------------------

function bustCampaignCaches(): void {
  invalidateCampaignCache();
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.campaigns, PUBLIC_CACHE_TAGS.market);
}

// GET /api/admin/campaigns — paged list (RBAC campaigns.manage).
// Query: page, size, status=draft|scheduled|live|ended|archived, placement, q.
export const GET = handle(async (req: NextRequest) => {
  await requireCap("campaigns.manage");
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const status = url.searchParams.get("status") ?? "";
  const placement = url.searchParams.get("placement") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim();

  const where = {
    ...statusWhere(status, new Date()),
    ...(placement && findPlacement(placement) ? { placement } : {}),
    ...(q ? { name: { contains: q } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.campaign.findMany({ where, orderBy: [{ priority: "desc" }, { displayOrder: "asc" }, { startAt: "desc" }], skip, take }),
    db.campaign.count({ where }),
  ]);

  return okPaged(rows.map(present), { page, size, total });
});

// POST /api/admin/campaigns — create (RBAC campaigns.manage).
// Body: { name, presetId?, startAt?, endAt?, theme?, isPublished?,
//         description?, placement?, priority?, displayOrder?, ctaLabel?,
//         ctaHref?, bannerDesktopUrl?, bannerMobileUrl?, thumbnailUrl?,
//         productQuery? }.
// With a presetId and no dates, the window is auto-filled from the preset
// (nearest upcoming occurrence). Theme JSON is validated server-side.
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("campaigns.manage");
  const body = (await readBody(req)) as CampaignCreateBody & Record<string, unknown>;

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
  const merch = parseCampaignMerchFields(body);

  const created = await db.campaign.create({
    data: {
      name,
      presetId: preset?.id ?? null,
      themeJson: serializeCampaignTheme(theme),
      isPublished,
      startAt,
      endAt,
      ...merch,
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "campaign.create",
    entityType: "campaign",
    entityId: created.id,
    after: { name: created.name, presetId: created.presetId, isPublished: created.isPublished, placement: created.placement, priority: created.priority, displayOrder: created.displayOrder, startAt, endAt },
  });

  bustCampaignCaches();
  return ok(present(created));
});

import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody } from "@/app/api/admin/_helpers";
import type { HomeLayoutData, HomeLayoutPutBody, HomeLayoutPutData } from "@/lib/types/api-contract";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import {
  DEFAULT_SECTION_ORDER,
  HOME_SECTIONS,
  HOME_SECTION_ORDER_KEY,
  normalizeSectionOrder,
  sectionOrderFromSetting,
  type HomeSectionId,
} from "@/lib/home-layout";

// Work order 14 — admin-controlled homepage section order, stored as the
// Setting "home.section_order" (JSON array). The shopper homepage renders in
// THIS order; omitting a section hides it (hero is mandatory and always first
// — enforced by normalizeSectionOrder, the same normalizer the public
// market-home read path uses, so admin validation and public rendering can
// never drift).

async function loadOrder(): Promise<HomeSectionId[]> {
  const row = await db.setting.findUnique({ where: { key: HOME_SECTION_ORDER_KEY } });
  return sectionOrderFromSetting(row?.valueJson);
}

// GET /api/admin/home-layout — current order + section catalogue (RBAC
// campaigns.manage, same capability as the campaign system it configures).
export const GET = handle(async () => {
  await requireCap("campaigns.manage");
  const order = await loadOrder();
  const payload: HomeLayoutData = {
    order,
    defaults: DEFAULT_SECTION_ORDER,
    sections: HOME_SECTIONS,
  };
  return ok(payload);
});

// PUT /api/admin/home-layout { order: string[] } (RBAC campaigns.manage).
// The stored value is ALWAYS the normalized form — invalid ids are dropped,
// hero is forced first, inline slots are capped. Audited; cache busted so the
// public homepage reflects the change within the documented window.
export const PUT = handle(async (req: NextRequest) => {
  const admin = await requireCap("campaigns.manage");
  const body = (await readBody(req)) as HomeLayoutPutBody & Record<string, unknown>;
  if (!Array.isArray(body.order)) throw new ApiError(400, "VALIDATION", "order must be an array of section ids");

  const before = await loadOrder();
  const normalized = normalizeSectionOrder(body.order);
  if (normalized.length === 0) throw new ApiError(400, "VALIDATION", "order cannot be empty");

  await db.setting.upsert({
    where: { key: HOME_SECTION_ORDER_KEY },
    create: { key: HOME_SECTION_ORDER_KEY, valueJson: JSON.stringify(normalized) },
    update: { valueJson: JSON.stringify(normalized) },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "home_layout.update",
    entityType: "setting",
    entityId: HOME_SECTION_ORDER_KEY,
    before: { order: before },
    after: { order: normalized },
  });

  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.campaigns, PUBLIC_CACHE_TAGS.market);

  const payload: HomeLayoutPutData = { order: normalized };
  return ok(payload);
});

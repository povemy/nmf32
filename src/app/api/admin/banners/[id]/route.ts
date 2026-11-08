import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, str, optNum, optBool } from "@/app/api/admin/_helpers";
import type { AdminBannerRow, AdminBannerDeleteData, BannerUpdateBody } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/banners/[id]
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const body = (await readBody(req)) as BannerUpdateBody & Record<string, unknown>;

  const banner = await db.marketplaceBanner.findUnique({ where: { id } });
  if (!banner) throw new ApiError(404, "NOT_FOUND", "Banner not found");

  const data: Record<string, unknown> = {};
  const title = str(body, "title");
  if (title != null) data.title = title;
  const imageUrl = str(body, "imageUrl");
  if (imageUrl != null) data.imageUrl = imageUrl;
  const linkUrl = str(body, "linkUrl");
  if (linkUrl != null) data.linkUrl = linkUrl;
  const sortOrder = optNum(body, "sortOrder");
  if (sortOrder != null) data.sortOrder = Math.round(sortOrder);
  const isActive = optBool(body, "isActive");
  if (isActive != null) data.isActive = isActive;
  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const updated = await db.marketplaceBanner.update({ where: { id }, data });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "banner.update",
    entityType: "marketplace_banner",
    entityId: id,
    before: { title: banner.title, isActive: banner.isActive, sortOrder: banner.sortOrder },
    after: data,
  });

  const payload: AdminBannerRow = {
    id: updated.id,
    title: updated.title,
    imageUrl: updated.imageUrl,
    linkUrl: updated.linkUrl,
    sortOrder: updated.sortOrder,
    isActive: updated.isActive,
    createdAt: updated.createdAt.toISOString(),
  };
  return ok(payload);
});

// DELETE /api/admin/banners/[id]
export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;

  const banner = await db.marketplaceBanner.findUnique({ where: { id } });
  if (!banner) throw new ApiError(404, "NOT_FOUND", "Banner not found");

  await db.marketplaceBanner.delete({ where: { id } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "banner.delete",
    entityType: "marketplace_banner",
    entityId: id,
    before: { title: banner.title },
    after: null,
  });

  const payload: AdminBannerDeleteData = { deleted: true };
  return ok(payload);
});

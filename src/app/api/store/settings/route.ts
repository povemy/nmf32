import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { toJson } from "@/lib/json";

export const dynamic = "force-dynamic";

// PATCH /api/store/settings — whitelist of editable store fields.
export const PATCH = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new ApiError(400, "VALIDATION", "Store name cannot be empty");
    data.name = name;
  }
  if (body.tagline !== undefined) data.tagline = body.tagline == null ? null : String(body.tagline);
  if (body.description !== undefined) data.description = body.description == null ? null : String(body.description);
  if (body.supportEmail !== undefined) data.supportEmail = body.supportEmail == null ? null : String(body.supportEmail);
  if (body.supportPhone !== undefined) data.supportPhone = body.supportPhone == null ? null : String(body.supportPhone);
  if (body.whatsapp !== undefined) data.whatsapp = body.whatsapp == null ? null : String(body.whatsapp);
  if (body.marketplaceOptIn !== undefined) data.marketplaceOptIn = !!body.marketplaceOptIn;
  if (body.logoUrl !== undefined) data.logoUrl = body.logoUrl == null ? null : String(body.logoUrl);
  if (body.bannerUrl !== undefined) data.bannerUrl = body.bannerUrl == null ? null : String(body.bannerUrl);
  if (body.social !== undefined) {
    data.socialJson = typeof body.social === "string" ? body.social : toJson(body.social ?? {});
  }

  if (Object.keys(data).length === 0) {
    throw new ApiError(400, "VALIDATION", "No editable fields provided");
  }

  const updated = await db.store.update({ where: { id: store.id }, data });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.settings.updated",
    entityType: "store",
    entityId: store.id,
    meta: { fields: Object.keys(data) },
  });

  return ok({ id: updated.id, name: updated.name, tagline: updated.tagline, updated: Object.keys(data) });
});

import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { toJson, parseJson } from "@/lib/json";
import { sanitizeExternalUrl } from "@/lib/url-guard";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

export const dynamic = "force-dynamic";

/** D2 — sanitize the social map (object OR raw JSON string form). Every
 *  network → URL entry must be an http(s) URL. REJECT (400 VALIDATION, naming
 *  the key) rather than silently nulling: the seller is actively editing these
 *  in Settings, and a silent drop would look like a save bug. */
function sanitizeSocialMap(raw: unknown): Record<string, string> {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    const parsed = parseJson<Record<string, unknown> | null>(raw, null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "VALIDATION", "social must be a JSON object of network → URL");
    }
    obj = parsed;
  } else if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    obj = {};
  }
  const clean: Record<string, string> = {};
  for (const [network, value] of Object.entries(obj)) {
    const key = String(network).trim().slice(0, 40);
    if (value == null || value === "") continue; // optional entries drop out
    const safe = sanitizeExternalUrl(String(value), { maxLength: 500 });
    if (!safe) throw new ApiError(400, "VALIDATION", `social.${network} must be a valid http(s) URL`);
    if (key) clean[key] = safe;
  }
  return clean;
}

// PATCH /api/store/settings — whitelist of editable store fields.
export const PATCH = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  let sellerData: Record<string, unknown> = {};
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
  // marketplaceOptIn lives on the Seller record (controls Market portal visibility), not the Store.
  if (body.marketplaceOptIn !== undefined) sellerData.marketplaceOptIn = !!body.marketplaceOptIn;
  // D2 — logoUrl/bannerUrl are seller-controlled URLs rendered on the shopper
  // storefront, so they pass the same guard as socials. Relative paths
  // ("/api/img/…") are legitimate here → allowRelative. Optional fields:
  // explicit null stays null; a non-empty value that fails the guard is
  // REJECTED (400 VALIDATION) so the seller fixes it instead of a silent loss.
  if (body.logoUrl !== undefined) {
    if (body.logoUrl == null || body.logoUrl === "") {
      data.logoUrl = body.logoUrl == null ? null : "";
    } else {
      const safe = sanitizeExternalUrl(String(body.logoUrl), { allowRelative: true });
      if (!safe) throw new ApiError(400, "VALIDATION", "logoUrl must be a valid http(s) or site-relative URL");
      data.logoUrl = safe;
    }
  }
  if (body.bannerUrl !== undefined) {
    if (body.bannerUrl == null || body.bannerUrl === "") {
      data.bannerUrl = body.bannerUrl == null ? null : "";
    } else {
      const safe = sanitizeExternalUrl(String(body.bannerUrl), { allowRelative: true });
      if (!safe) throw new ApiError(400, "VALIDATION", "bannerUrl must be a valid http(s) or site-relative URL");
      data.bannerUrl = safe;
    }
  }
  if (body.social !== undefined) {
    data.socialJson = toJson(sanitizeSocialMap(body.social));
  }

  if (Object.keys(data).length === 0 && Object.keys(sellerData).length === 0) {
    throw new ApiError(400, "VALIDATION", "No editable fields provided");
  }

  let updatedSellerOptIn: boolean | undefined;
  if (Object.keys(sellerData).length > 0) {
    // PHASE 2.3 select hygiene (C2.7): update() would RETURN all Seller
    // scalars (incl. the un-migrated emailVerifiedAt — P2022 pre-migration
    // 20261107000000); only marketplaceOptIn is used.
    const updatedSeller = await db.seller.update({
      where: { id: me.id },
      data: sellerData,
      select: { marketplaceOptIn: true },
    });
    updatedSellerOptIn = updatedSeller.marketplaceOptIn;
  }
  const updated = Object.keys(data).length > 0
    ? await db.store.update({ where: { id: store.id }, data })
    : store;

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.settings.updated",
    entityType: "store",
    entityId: store.id,
    meta: { fields: [...Object.keys(data), ...Object.keys(sellerData)] },
  });

  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.stores, PUBLIC_CACHE_TAGS.market);
  return ok({
    id: updated.id,
    name: updated.name,
    tagline: updated.tagline,
    updated: [...Object.keys(data), ...Object.keys(sellerData)],
    ...(updatedSellerOptIn !== undefined ? { marketplaceOptIn: updatedSellerOptIn } : {}),
  });
});

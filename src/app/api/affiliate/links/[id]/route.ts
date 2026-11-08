import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireAffiliate, getAffiliateSettings } from "@/lib/affiliate";
import type { UpdateLinkBody, UpdateLinkData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

const CHANNELS = ["tiktok", "threads", "facebook", "telegram", "whatsapp", "blog", "website", "other"] as const;

// PATCH /api/affiliate/links/[id] — archive / reactivate / relabel / channel.
// Ownership-scoped (spec §16: affiliate cannot edit another affiliate's links).
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const aff = await requireAffiliate();
  const { id } = await ctx.params;
  const link = await db.affiliateLink.findFirst({ where: { id, affiliateId: aff.id } });
  if (!link) throw new ApiError(404, "NOT_FOUND", "Link not found");
  const body = (await req.json().catch(() => ({}))) as UpdateLinkBody;
  const data: Record<string, unknown> = {};
  if (body.status != null) {
    const status = String(body.status);
    if (!["active", "archived"].includes(status)) throw new ApiError(400, "VALIDATION", "status must be active | archived");
    // POST-IMPLEMENTATION AUDIT (P2): while the deferred-feature gates are
    // off, an archived collection/showcase link cannot be REACTIVATED (that
    // would create a new live promotional surface). Archiving stays allowed.
    if (status === "active" && link.status === "archived" && (link.type === "collection" || link.type === "showcase")) {
      const settings = await getAffiliateSettings();
      if ((link.type === "collection" && !settings.collectionsEnabled) || (link.type === "showcase" && !settings.showcaseEnabled)) {
        throw new ApiError(403, link.type === "collection" ? "COLLECTIONS_DISABLED" : "SHOWCASE_DISABLED", `${link.type === "collection" ? "Collections" : "Showcases"} are currently disabled`);
      }
    }
    data.status = status;
    data.archivedAt = status === "archived" ? new Date() : null;
  }
  if (body.channel != null && CHANNELS.includes(String(body.channel) as (typeof CHANNELS)[number])) {
    data.channel = String(body.channel);
  }
  if (body.label != null) data.label = String(body.label).slice(0, 80);
  const updated = await db.affiliateLink.update({ where: { id: link.id }, data });
  const payload: UpdateLinkData = { link: { id: updated.id, status: updated.status, channel: updated.channel, label: updated.label } };
  return ok(payload);
});

import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireAffiliate } from "@/lib/affiliate";

export const dynamic = "force-dynamic";

const CHANNELS = ["tiktok", "threads", "facebook", "telegram", "whatsapp", "blog", "website", "other"] as const;

// PATCH /api/affiliate/links/[id] — archive / reactivate / relabel / channel.
// Ownership-scoped (spec §16: affiliate cannot edit another affiliate's links).
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const aff = await requireAffiliate();
  const { id } = await ctx.params;
  const link = await db.affiliateLink.findFirst({ where: { id, affiliateId: aff.id } });
  if (!link) throw new ApiError(404, "NOT_FOUND", "Link not found");
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  if (body.status != null) {
    const status = String(body.status);
    if (!["active", "archived"].includes(status)) throw new ApiError(400, "VALIDATION", "status must be active | archived");
    data.status = status;
    data.archivedAt = status === "archived" ? new Date() : null;
  }
  if (body.channel != null && CHANNELS.includes(String(body.channel) as (typeof CHANNELS)[number])) {
    data.channel = String(body.channel);
  }
  if (body.label != null) data.label = String(body.label).slice(0, 80);
  const updated = await db.affiliateLink.update({ where: { id: link.id }, data });
  return ok({ link: { id: updated.id, status: updated.status, channel: updated.channel, label: updated.label } });
});

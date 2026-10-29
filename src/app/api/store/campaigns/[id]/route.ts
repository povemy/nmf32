import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// PATCH /api/store/campaigns/[id] — rename and/or archive/reactivate.
// The slug and code are IMMUTABLE: links already in the wild must keep
// resolving to the same campaign. Archive keeps the campaign reporting in
// insights (historical attribution) but removes it from the link generator.
// Ownership: the row is fetched with BOTH id AND the session store's id —
// another seller's campaign id is a plain 404 (never a leak).
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  rateLimit(req, "campaigns", 20, 60_000);
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (body == null || typeof body !== "object" || Array.isArray(body)) body = {};
  } catch {
    throw new ApiError(400, "VALIDATION", "JSON body required");
  }

  const campaign = await db.sellerCampaign.findFirst({ where: { id, storeId: store.id } });
  if (!campaign) throw new ApiError(404, "NOT_FOUND", "Campaign not found");

  const updates: { name?: string; status?: string; defaultSource?: string | null; defaultMedium?: string | null } = {};
  if (body.name != null) {
    const name = typeof body.name === "string"
      // eslint-disable-next-line no-control-regex
      ? body.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim()
      : "";
    if (name === "") throw new ApiError(400, "VALIDATION", "name cannot be empty");
    updates.name = name;
  }
  if (body.status != null) {
    if (body.status !== "active" && body.status !== "archived") {
      throw new ApiError(400, "VALIDATION", "status must be active|archived");
    }
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) {
    throw new ApiError(400, "VALIDATION", "Nothing to update — provide name and/or status");
  }

  const updated = await db.sellerCampaign.update({
    where: { id: campaign.id },
    data: updates,
    select: { id: true, name: true, slug: true, code: true, status: true, defaultSource: true, defaultMedium: true, createdAt: true },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "campaigns.update",
    entityType: "store",
    entityId: store.id,
    meta: { campaignId: campaign.id, updates },
  });

  return ok({ ...updated, createdAt: updated.createdAt.toISOString() });
});

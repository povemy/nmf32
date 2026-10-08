import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseJson, toJson } from "@/lib/json";

export const dynamic = "force-dynamic";

async function ownEndpoint(storeId: string, id: string) {
  const endpoint = await db.webhookEndpoint.findFirst({ where: { id, storeId } });
  if (!endpoint) throw new ApiError(404, "NOT_FOUND", "Webhook endpoint not found");
  return endpoint;
}

// PATCH /api/store/webhooks/[id] {url?, events?, isActive?}
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const endpoint = await ownEndpoint(store.id, id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (body.url !== undefined) {
    const url = String(body.url).trim();
    if (!/^https?:\/\/.+/.test(url)) throw new ApiError(400, "VALIDATION", "url must be a valid http(s) URL");
    data.url = url;
  }
  if (Array.isArray(body.events)) {
    const events = body.events.map((e) => String(e)).filter(Boolean);
    if (events.length === 0) throw new ApiError(400, "VALIDATION", "events cannot be empty");
    data.eventsJson = JSON.stringify(events);
  }
  if (body.isActive !== undefined) data.isActive = !!body.isActive;

  const updated = await db.webhookEndpoint.update({ where: { id: endpoint.id }, data });
  return ok({
    id: updated.id,
    url: updated.url,
    secret: updated.secret,
    events: parseJson<string[]>(updated.eventsJson, []),
    isActive: updated.isActive,
  });
});

// DELETE /api/store/webhooks/[id]
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const endpoint = await ownEndpoint(store.id, id);
  await db.webhookEndpoint.delete({ where: { id: endpoint.id } });
  return ok({ id: endpoint.id, deleted: true });
});

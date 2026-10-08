import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { randomToken } from "@/lib/password";
import { parseJson } from "@/lib/json";

export const dynamic = "force-dynamic";

const DEFAULT_EVENTS = ["order.paid", "order.shipped", "order.refunded"];

// GET /api/store/webhooks — endpoints with their last 10 deliveries.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const endpoints = await db.webhookEndpoint.findMany({
    where: { storeId: store.id },
    include: { deliveries: { orderBy: { createdAt: "desc" }, take: 10 } },
    orderBy: { createdAt: "desc" },
  });
  return ok(
    endpoints.map((ep) => ({
      id: ep.id,
      url: ep.url,
      secret: ep.secret,
      events: parseJson<string[]>(ep.eventsJson, []),
      isActive: ep.isActive,
      createdAt: ep.createdAt,
      deliveries: ep.deliveries,
    }))
  );
});

// POST /api/store/webhooks {url, events: [...]}
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const url = String(body.url ?? "").trim();
  if (!/^https?:\/\/.+/.test(url)) {
    throw new ApiError(400, "VALIDATION", "url must be a valid http(s) URL");
  }
  const events = Array.isArray(body.events) && body.events.length > 0
    ? body.events.map((e) => String(e))
    : DEFAULT_EVENTS;

  const endpoint = await db.webhookEndpoint.create({
    data: {
      storeId: store.id,
      url,
      secret: `whsec_${randomToken(12)}`,
      eventsJson: JSON.stringify(events),
      isActive: true,
    },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "webhook.created",
    entityType: "webhook_endpoint",
    entityId: endpoint.id,
    meta: { url, events },
  });

  return ok(
    {
      id: endpoint.id,
      url: endpoint.url,
      secret: endpoint.secret,
      events: parseJson<string[]>(endpoint.eventsJson, []),
      isActive: endpoint.isActive,
      deliveries: [],
    },
    { status: 201 }
  );
});

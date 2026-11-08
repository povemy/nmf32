import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { randomToken } from "@/lib/password";
import { rateLimit } from "@/lib/rate-limit";
import type { SellerWebhookRotateData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

/** Extract just the host of a webhook URL for audit meta — the full URL is
 *  fine to log, but we keep rotation logs minimal and NEVER log secrets. */
function urlHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "";
  }
}

// POST /api/store/webhooks/[id]/rotate — replace the signing secret.
// Ownership follows the sibling [id] routes (requireActiveSellerStore +
// where {id, storeId}); the update itself is a conditional updateMany so a
// concurrent delete can never rotate another store's endpoint. The new
// plaintext secret is returned EXACTLY ONCE, here — list responses only ever
// show the masked form (D1).
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  rateLimit(req, "webhook-rotate", 10); // 10/min/IP — secret churn is rare
  const { id } = await ctx.params;

  const endpoint = await db.webhookEndpoint.findFirst({ where: { id, storeId: store.id } });
  if (!endpoint) throw new ApiError(404, "NOT_FOUND", "Webhook endpoint not found");

  const newSecret = `whsec_${randomToken(12)}`; // same generator as create
  const res = await db.webhookEndpoint.updateMany({
    where: { id, storeId: store.id },
    data: { secret: newSecret },
  });
  if (res.count === 0) throw new ApiError(404, "NOT_FOUND", "Webhook endpoint not found");

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.webhook.rotated",
    entityType: "webhook_endpoint",
    entityId: endpoint.id,
    // meta carries the endpoint id + URL host ONLY — never the secret.
    meta: { endpointId: endpoint.id, urlHost: urlHost(endpoint.url) },
  });

  const payload: SellerWebhookRotateData = { id: endpoint.id, secret: newSecret };
  return ok(payload);
});

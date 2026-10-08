import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/webhook-deliveries/[id]/replay — simulate a successful retry
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;

  const delivery = await db.webhookDelivery.findUnique({ where: { id }, include: { endpoint: { include: { store: true } } } });
  if (!delivery) throw new ApiError(404, "NOT_FOUND", "Webhook delivery not found");

  const updated = await db.webhookDelivery.update({
    where: { id },
    data: { attempts: delivery.attempts + 1, status: "success", responseCode: 200, lastAttemptAt: new Date() },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "webhook_delivery.replay",
    entityType: "webhook_delivery",
    entityId: id,
    before: { status: delivery.status, attempts: delivery.attempts, event: delivery.event, endpointUrl: delivery.endpoint.url },
    after: { status: "success", attempts: delivery.attempts + 1, responseCode: 200 },
  });

  return ok(updated);
});

import { db } from "@/lib/db";
import { handle, ok, ApiError, notify, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/store/domains/[id]/verify — sandbox simulation: DNS check passes instantly.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const record = await db.storeDomain.findFirst({ where: { id, storeId: store.id } });
  if (!record) throw new ApiError(404, "NOT_FOUND", "Domain not found");

  const updated = await db.storeDomain.update({
    where: { id: record.id },
    data: {
      status: "active",
      sslStatus: "issued",
      lastCheckedAt: new Date(),
      errorReason: null,
    },
  });

  await notify({
    event: "domain.verified",
    channel: "email",
    recipient: me.email,
    subject: `Domain ${record.domain} verified — SSL issued`,
  });
  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "domain.verified",
    entityType: "store_domain",
    entityId: record.id,
    meta: { domain: record.domain },
  });

  return ok(updated);
});

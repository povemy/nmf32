import { db } from "@/lib/db";
import { handle, ok, ApiError, notify, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import type { SellerDomainVerifiedData } from "@/lib/types/api-contract";

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

  // lastCheckedAt is non-null on this payload: the update above just wrote it.
  const payload: SellerDomainVerifiedData = {
    id: updated.id,
    storeId: updated.storeId,
    domain: updated.domain,
    mode: updated.mode,
    status: updated.status,
    sslStatus: updated.sslStatus,
    isPrimary: updated.isPrimary,
    lastCheckedAt: updated.lastCheckedAt!.toISOString(),
    errorReason: updated.errorReason,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };

  return ok(payload);
});

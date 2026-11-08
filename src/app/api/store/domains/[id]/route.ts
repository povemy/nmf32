import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import type { SellerDomainDeleteData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// DELETE /api/store/domains/[id]
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const record = await db.storeDomain.findFirst({ where: { id, storeId: store.id } });
  if (!record) throw new ApiError(404, "NOT_FOUND", "Domain not found");
  await db.storeDomain.delete({ where: { id: record.id } });
  const payload: SellerDomainDeleteData = { id: record.id, deleted: true };
  return ok(payload);
});

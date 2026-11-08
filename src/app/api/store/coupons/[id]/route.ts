import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import type { SellerCouponPatchBody, SellerCouponRow, SellerCouponDeleteData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

async function ownCoupon(storeId: string, id: string) {
  const coupon = await db.coupon.findFirst({ where: { id, storeId } });
  if (!coupon) throw new ApiError(404, "NOT_FOUND", "Coupon not found");
  return coupon;
}

// PATCH /api/store/coupons/[id]
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const coupon = await ownCoupon(store.id, id);
  const body = (await req.json().catch(() => ({}))) as SellerCouponPatchBody;

  const data: Record<string, unknown> = {};
  if (body.description !== undefined) data.description = body.description == null ? null : String(body.description);
  if (body.percent !== undefined && coupon.type === "percent") {
    const percent = Number(body.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new ApiError(400, "VALIDATION", "percent must be 1..100");
    data.percent = percent;
  }
  if (body.amountMinor !== undefined && coupon.type === "fixed") {
    data.amountMinor = Math.max(0, Math.round(Number(body.amountMinor)));
  }
  if (body.minSpendMinor !== undefined) data.minSpendMinor = Math.max(0, Math.round(Number(body.minSpendMinor)));
  if (body.maxRedemptions !== undefined) data.maxRedemptions = body.maxRedemptions == null ? null : Math.max(1, Math.round(Number(body.maxRedemptions)));
  if (body.startsAt !== undefined) data.startsAt = body.startsAt == null || body.startsAt === "" ? null : new Date(String(body.startsAt));
  if (body.endsAt !== undefined) data.endsAt = body.endsAt == null || body.endsAt === "" ? null : new Date(String(body.endsAt));
  if (body.isActive !== undefined) data.isActive = !!body.isActive;

  const updated = await db.coupon.update({ where: { id: coupon.id }, data });
  const payload: SellerCouponRow = {
    id: updated.id,
    scope: updated.scope,
    storeId: updated.storeId,
    code: updated.code,
    description: updated.description,
    type: updated.type,
    percent: updated.percent,
    amountMinor: updated.amountMinor,
    minSpendMinor: updated.minSpendMinor,
    maxRedemptions: updated.maxRedemptions,
    perCustomerLimit: updated.perCustomerLimit,
    startsAt: updated.startsAt ? updated.startsAt.toISOString() : null,
    endsAt: updated.endsAt ? updated.endsAt.toISOString() : null,
    isActive: updated.isActive,
    timesUsed: updated.timesUsed,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
  return ok(payload);
});

// DELETE /api/store/coupons/[id]
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const coupon = await ownCoupon(store.id, id);
  await db.coupon.delete({ where: { id: coupon.id } });
  const payload: SellerCouponDeleteData = { id: coupon.id, deleted: true };
  return ok(payload);
});

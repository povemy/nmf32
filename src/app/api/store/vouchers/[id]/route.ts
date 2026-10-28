import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseSellerVoucherInput } from "@/lib/vouchers";

export const dynamic = "force-dynamic";

// PATCH /api/store/vouchers/[id] — toggle isActive, or edit terms.
// EDIT RULE (retention v1): once even ONE shopper holds the voucher, its terms
// are frozen — only the isActive toggle is accepted (pausing stops new
// checkouts from applying it without burning existing holders' claims).
async function ownVoucher(storeId: string, id: string) {
  // scope guard: sellers can only touch their own seller-scope vouchers —
  // never platform pool rows.
  const voucher = await db.voucher.findFirst({ where: { id, storeId, scope: "seller" } });
  if (!voucher) throw new ApiError(404, "NOT_FOUND", "Voucher not found");
  return voucher;
}

async function heldCount(voucherId: string): Promise<number> {
  return db.userVoucher.count({ where: { voucherId } });
}

export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const voucher = await ownVoucher(store.id, id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const wantsTermEdit = ["title", "kind", "discountMinor", "percentOff", "maxDiscountMinor", "minSpendMinor", "expiryAt", "quota"].some(
    (k) => body[k] !== undefined
  );
  const holders = await heldCount(voucher.id);
  if (wantsTermEdit && holders > 0) {
    throw new ApiError(409, "VOUCHER_HAS_HOLDERS", `${holders} shopper${holders === 1 ? "" : "s"} already claimed this voucher — its terms can no longer be edited (pause it instead)`);
  }

  const data: Record<string, unknown> = {};
  if (body.isActive !== undefined) data.isActive = !!body.isActive;

  if (wantsTermEdit) {
    // Merge overrides onto current values, then run the same validation as create.
    const merged: Record<string, unknown> = {
      title: body.title ?? voucher.title,
      kind: body.kind ?? voucher.kind,
      discountMinor: body.discountMinor ?? (voucher.discountMinor > 0 ? voucher.discountMinor : undefined),
      percentOff: body.percentOff ?? voucher.percentOff,
      maxDiscountMinor: body.maxDiscountMinor ?? voucher.maxDiscountMinor,
      minSpendMinor: body.minSpendMinor ?? voucher.minSpendMinor,
      expiryAt: body.expiryAt ?? voucher.expiryAt.toISOString(),
      quota: body.quota ?? voucher.quota,
    };
    // An existing flat-amount voucher with no explicit discountMinor in the body
    // must keep its flat amount: encode it explicitly for the validator.
    if (body.discountMinor === undefined && voucher.percentOff == null) {
      merged.discountMinor = voucher.discountMinor;
      merged.percentOff = null;
    }
    const payload = parseSellerVoucherInput(merged);
    data.title = payload.title;
    data.kind = payload.kind;
    data.discountMinor = payload.discountMinor;
    data.percentOff = payload.percentOff;
    data.maxDiscountMinor = payload.maxDiscountMinor;
    data.minSpendMinor = payload.minSpendMinor;
    data.expiryAt = payload.expiryAt;
    data.quota = payload.quota;
    data.regionLimit = payload.regionLimit;
  }

  const updated = await db.voucher.update({ where: { id: voucher.id }, data });
  const redeemedCount = await db.userVoucher.count({ where: { voucherId: voucher.id, status: "USED" } });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: data.isActive === false ? "voucher.paused" : "voucher.updated",
    entityType: "voucher",
    entityId: voucher.id,
    meta: { code: voucher.code, editedFields: Object.keys(data) },
  }).catch(() => undefined);

  return ok({ ...updated, heldCount: holders, redeemedCount });
});

// DELETE /api/store/vouchers/[id] — SOFT delete: flip isActive=false so the
// voucher disappears from the claim centre while historical claims/orders
// keep their audit trail (voucher rows are referenced by UserVoucher/Order).
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const voucher = await ownVoucher(store.id, id);

  const updated = await db.voucher.update({ where: { id: voucher.id }, data: { isActive: false } });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "voucher.deleted",
    entityType: "voucher",
    entityId: voucher.id,
    meta: { code: voucher.code, soft: true },
  }).catch(() => undefined);

  return ok({ ...updated, deleted: true });
});

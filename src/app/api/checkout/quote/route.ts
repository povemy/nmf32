import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { computePricing, computeGroupPricing } from "../pricing";
import { computeOrderCommissions } from "@/lib/commission";
import { buildVoucherOutcomes, applyVoucherOutcomesToGroups, type VoucherEntryInput } from "@/lib/vouchers";

export const dynamic = "force-dynamic";

// POST /api/checkout/quote
//  • {storeSlug, items, ...}          → LEGACY single-store quote (kept for compatibility)
//  • {items, couponCode?, ...}        → multi-seller quote: one section per store,
//    per-store shipping + coupon rules, ONE aggregated total (the buyer pays once).
//  • + vouchers?: [{storeId, userVoucherId}] → Task 10-b claimable vouchers,
//    validated per seller group (verdict engine in @/lib/vouchers). A valid
//    discount voucher adds to the group discount (capped at the subtotal); a
//    freeshipping voucher zeroes that group's parcel cost. Nothing is marked
//    used here — redemption happens atomically at /api/checkout/create.
export const POST = handle(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const voucherEntries = Array.isArray(body.vouchers)
    ? (body.vouchers as VoucherEntryInput[]).filter((e) => e && typeof e === "object")
    : [];
  // Vouchers live in the shopper's wallet — resolve the optional session, but
  // guest quotes (no vouchers) keep working exactly as before.
  const sess = voucherEntries.length > 0 ? await getSession() : null;
  const shopperId = sess?.userType === "shopper" ? sess.userId : null;

  // ------------------------------------------------------------------ legacy single-store
  const storeSlug = String(body.storeSlug ?? "");
  if (storeSlug) {
    const store = await db.store.findUnique({ where: { slug: storeSlug } });
    if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

    const pricing = await computePricing({
      storeId: store.id,
      items: (body.items ?? []) as { variantId: string; qty: number }[],
      couponCode: body.couponCode != null ? String(body.couponCode) : null,
      shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
      state: body.state != null ? String(body.state) : null,
    });

    // Optional voucher on the single store group (legacy checkout).
    const outcomes = await buildVoucherOutcomes({
      entries: voucherEntries.length > 0 ? voucherEntries : body.userVoucherId ? [{ storeId: store.id, userVoucherId: String(body.userVoucherId) }] : [],
      shopperId,
      groups: [{ storeId: store.id, subtotalMinor: pricing.subtotalMinor }],
      addressState: body.state != null ? String(body.state) : null,
    });
    const applied = applyVoucherOutcomesToGroups(
      [{ storeId: store.id, subtotalMinor: pricing.subtotalMinor, discountMinor: pricing.discountMinor, shippingMinor: pricing.shippingMinor, totalMinor: pricing.totalMinor }],
      outcomes
    );
    const g = applied.groups[0];
    const voucherOutcome = outcomes[0] ?? null;

    const seller = store.sellerId
      ? await db.seller.findUnique({ where: { id: store.sellerId }, select: { id: true } })
      : null;
    let commissionPreviewMinor = 0;
    if (seller) {
      const comm = await computeOrderCommissions({
        sellerId: seller.id,
        items: pricing.lines.map((l) => ({
          productId: l.productId,
          categoryId: l.categoryId,
          title: l.title,
          variantLabel: l.variantLabel,
          unitPriceMinor: l.unitPriceMinor,
          qty: l.qty,
        })),
        orderDiscountMinor: g.discountMinor,
        shippingMinorTotal: g.shippingMinor,
      });
      commissionPreviewMinor = comm.items.reduce((s, i) => s + i.percentPartMinor, 0);
    }

    return ok({
      subtotalMinor: pricing.subtotalMinor,
      discountMinor: g.discountMinor,
      shippingMinor: g.shippingMinor,
      totalMinor: g.totalMinor,
      shippingRateId: pricing.shippingRateId,
      coupon: pricing.coupon.valid
        ? { code: pricing.coupon.code, valid: true, discountMinor: pricing.coupon.discountMinor, freeShip: pricing.coupon.freeShip }
        : { code: pricing.coupon.code, valid: false, reason: pricing.coupon.reason ?? "Invalid coupon" },
      voucher: voucherOutcome,
      items: pricing.lines.map((l) => ({
        title: l.title,
        variantLabel: l.variantLabel,
        qty: l.qty,
        unitPriceMinor: l.unitPriceMinor,
        lineTotalMinor: l.lineTotalMinor,
        stock: l.stock,
        moq: l.moq,
      })),
      shippingOptions: pricing.shippingOptions,
      commissionPreviewMinor,
    });
  }

  // ------------------------------------------------------------------ multi-seller quote
  const pricing = await computeGroupPricing({
    items: (body.items ?? []) as { variantId: string; qty: number }[],
    couponCode: body.couponCode != null ? String(body.couponCode) : null,
    shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
    state: body.state != null ? String(body.state) : null,
  });

  // Per-group voucher verdicts → adjusted group + aggregate totals.
  const outcomes = await buildVoucherOutcomes({
    entries: voucherEntries,
    shopperId,
    groups: pricing.groups.map((g) => ({ storeId: g.storeId, subtotalMinor: g.subtotalMinor })),
    addressState: body.state != null ? String(body.state) : null,
  });
  const applied = applyVoucherOutcomesToGroups(pricing.groups, outcomes);
  const outcomeByStore = new Map(outcomes.map((o) => [o.storeId, o]));

  return ok({
    subtotalMinor: applied.totals.subtotalMinor,
    discountMinor: applied.totals.discountMinor,
    shippingMinor: applied.totals.shippingMinor,
    totalMinor: applied.totals.totalMinor,
    shippingRateId: pricing.shippingRateId,
    coupon: pricing.coupon.valid
      ? { code: pricing.coupon.code, valid: true, discountMinor: pricing.coupon.discountMinor, freeShip: pricing.coupon.freeShip }
      : { code: pricing.coupon.code, valid: false, reason: pricing.coupon.reason ?? "Invalid coupon" },
    items: pricing.items.map((l) => ({
      title: l.title,
      variantLabel: l.variantLabel,
      qty: l.qty,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: l.lineTotalMinor,
      stock: l.stock,
      moq: l.moq,
      storeId: l.storeId,
      storeSlug: l.storeSlug,
      storeName: l.storeName,
    })),
    groups: applied.groups.map((g) => ({
      storeId: g.storeId,
      storeSlug: g.storeSlug,
      storeName: g.storeName,
      subtotalMinor: g.subtotalMinor,
      discountMinor: g.discountMinor,
      shippingMinor: g.shippingMinor,
      totalMinor: g.totalMinor,
      itemCount: g.lines.length,
      couponApplied: g.coupon.valid,
      voucher: outcomeByStore.get(g.storeId) ?? null,
    })),
    shippingOptions: pricing.shippingOptions,
  });
});

import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { formatMinor } from "@/lib/money";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// SELLER-FUNDED FREE-SHIPPING PROGRAMME — price-adjust helper (retention v1)
// ---------------------------------------------------------------------------
// Sellers who issue freeshipping vouchers fund them by marking up their variant
// prices by a flat amount (the average parcel fee). This endpoint applies or
// reverts that markup over every ACTIVE variant of the store's ACTIVE products
// in one shot, recording the applied amount on the store row so revert knows
// exactly how much to unwind.
//
// Invariants:
//   • apply    — only from a clean state (fsPriceAdjustMinor === 0); amount is
//                RM 1.00..RM 50.00 (100..5000 minor) to keep the programme sane.
//   • revert   — only when an adjustment is live; variants are decremented by
//                the recorded amount, but ONLY those whose current price can
//                absorb it (priceMinor >= adjust) so no price ever goes
//                negative. Variants created/ repriced BELOW the markup while it
//                was live are left untouched (documented v1 caveat).
// Both paths run in one transaction; activity logging is best-effort.
// ---------------------------------------------------------------------------

const MIN_ADJUST_MINOR = 100; // RM 1.00
const MAX_ADJUST_MINOR = 5000; // RM 50.00

export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const action = String(body.action ?? "");
  if (action !== "apply" && action !== "revert") {
    throw new ApiError(400, "VALIDATION", "action must be \"apply\" or \"revert\"");
  }

  if (action === "apply") {
    if (store.fsPriceAdjustMinor !== 0) {
      throw new ApiError(409, "ALREADY_APPLIED", `A ${formatMinor(store.fsPriceAdjustMinor)} price adjustment is already live on this store — revert it first`);
    }
    const amountMinor = Math.round(Number(body.amountMinor));
    if (!Number.isFinite(amountMinor) || amountMinor < MIN_ADJUST_MINOR || amountMinor > MAX_ADJUST_MINOR) {
      throw new ApiError(400, "VALIDATION", `amountMinor must be between ${MIN_ADJUST_MINOR} and ${MAX_ADJUST_MINOR} (RM 1.00 – RM 50.00)`);
    }

    const updatedCount = await db.$transaction(async (tx) => {
      const variants = await tx.productVariant.findMany({
        where: { isActive: true, product: { storeId: store.id, status: "active" } },
        select: { id: true },
      });
      const res = await tx.productVariant.updateMany({
        where: { id: { in: variants.map((v) => v.id) } },
        data: { priceMinor: { increment: amountMinor } },
      });
      await tx.store.update({ where: { id: store.id }, data: { fsPriceAdjustMinor: amountMinor } });
      return res.count;
    });

    await logActivity({
      actorType: "seller",
      actorId: me.id,
      actorLabel: me.email,
      action: "store.fs_price_adjust.applied",
      entityType: "store",
      entityId: store.id,
      meta: { amountMinor, updatedCount, storeSlug: store.slug },
    }).catch(() => undefined);

    return ok({ action, amountMinor, updatedCount, fsPriceAdjustMinor: amountMinor });
  }

  // ------------------------------------------------------------------ revert
  if (store.fsPriceAdjustMinor <= 0) {
    throw new ApiError(409, "NOTHING_TO_REVERT", "No free-shipping price adjustment is live on this store");
  }
  const adjust = store.fsPriceAdjustMinor;

  const updatedCount = await db.$transaction(async (tx) => {
    // Decrement only variants whose current price can absorb the full markup —
    // guarantees no negative prices (cheaper/newer variants are skipped).
    const res = await tx.productVariant.updateMany({
      where: { isActive: true, product: { storeId: store.id, status: "active" }, priceMinor: { gte: adjust } },
      data: { priceMinor: { decrement: adjust } },
    });
    await tx.store.update({ where: { id: store.id }, data: { fsPriceAdjustMinor: 0 } });
    return res.count;
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.fs_price_adjust.reverted",
    entityType: "store",
    entityId: store.id,
    meta: { amountMinor: adjust, updatedCount, storeSlug: store.slug },
  }).catch(() => undefined);

  return ok({ action, amountMinor: adjust, updatedCount, fsPriceAdjustMinor: 0 });
});

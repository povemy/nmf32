// ============================================================================
// Guest → account merge ("claim on login") — ORDERS ONLY now.
// Guest checkout and guest carts no longer exist (add-to-cart requires sign-in),
// so nothing new is ever created against a device. The one remaining legacy
// path: orders placed as guest BEFORE that change with an email that matches a
// shopper account are claimed into the account at login/registration so they
// appear in the buyer dashboard. Address claiming was removed — the address
// book is strictly account-scoped (shopperId), which is what closed the
// guest-address-leaking-into-logged-in-checkout bug. Idempotent by design.
// ============================================================================
import { db } from "./db";

export async function claimGuestStateForShopper(
  shopperId: string,
  email: string
): Promise<{ addressesClaimed: number; ordersClaimed: number }> {
  // Claim guest orders placed with the account email (checked out before sign-in).
  const orders = await db.order.updateMany({
    where: { customerEmail: email.toLowerCase(), shopperId: null },
    data: { shopperId },
  });

  // Normalize defaults — at most ONE default address per account.
  const defaults = await db.address.findMany({
    where: { shopperId, isDefault: true },
    orderBy: { updatedAt: "desc" },
  });
  if (defaults.length > 1) {
    await db.address.updateMany({
      where: { id: { in: defaults.slice(1).map((a) => a.id) } },
      data: { isDefault: false },
    });
  } else if (defaults.length === 0) {
    const newest = await db.address.findFirst({
      where: { shopperId },
      orderBy: { updatedAt: "desc" },
    });
    if (newest) await db.address.update({ where: { id: newest.id }, data: { isDefault: true } });
  }

  return { addressesClaimed: 0, ordersClaimed: orders.count };
}

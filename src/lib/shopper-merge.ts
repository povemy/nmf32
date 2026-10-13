// ============================================================================
// Guest → account merge ("claim on login").
// When a shopper signs in or registers on a device, state created as a GUEST on
// that device is claimed into the account:
//   • Address rows   (ownerToken = this device, shopperId = null) → shopperId = user
//   • Orders         (customerEmail = account email, shopperId = null) → shopperId = user
// After the claim, queries scope by shopperId — so addresses/orders follow the
// ACCOUNT instead of the browser. Signing into a different account on the same
// device can never read the previous account's book (its rows are already
// claimed; only shopperId=null rows are ever claimable). Idempotent by design.
// ============================================================================
import { db } from "./db";

export async function claimGuestStateForShopper(
  shopperId: string,
  email: string,
  deviceOwnerToken: string | null
): Promise<{ addressesClaimed: number; ordersClaimed: number }> {
  let addressesClaimed = 0;

  // 1) Claim guest addresses minted on THIS device (shopperId=null = unowned).
  if (deviceOwnerToken) {
    const res = await db.address.updateMany({
      where: { ownerToken: deviceOwnerToken, shopperId: null },
      data: { shopperId },
    });
    addressesClaimed = res.count;
  }

  // 2) Normalize defaults — at most ONE default address per account.
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

  // 3) Claim guest orders placed with the account email (checked out before sign-in).
  const orders = await db.order.updateMany({
    where: { customerEmail: email.toLowerCase(), shopperId: null },
    data: { shopperId },
  });

  return { addressesClaimed, ordersClaimed: orders.count };
}

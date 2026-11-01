// ============================================================================
// Guest → account merge ("claim on login") — ORDERS ONLY now.
// Guest checkout and guest carts no longer exist (add-to-cart requires sign-in),
// so nothing new is ever created against a device. The one remaining legacy
// path: orders placed as guest BEFORE that change with an email that matches a
// shopper account are claimed into the account at login/registration so they
// appear in the buyer dashboard. Address claiming was removed — the address
// book is strictly account-scoped (shopperId), which is what closed the
// guest-address-leaking-into-logged-in-checkout bug. Idempotent by design.
//
// FINAL CLOSURE §2 — EMAIL-OWNERSHIP GATE. Shopper registration performs NO
// email verification, so an "email match" alone is knowledge-of-email, NOT
// proof of ownership: registering an account with someone else's address must
// never claim that person's guest orders (they carry full PII once claimed).
// The order-claiming half below now requires the DURABLE email-ownership
// proof recorded by POST /api/auth/shopper/email-verification/verify (a
// verified EmailOtpChallenge row, purpose "shopper-email"). Until the
// shopper completes that code round-trip through their own mailbox, claiming
// is skipped — at registration, at login, everywhere (the gate lives HERE so
// no future caller can bypass it). The address-default normalization below
// touches only the account's OWN rows and is unaffected.
// ============================================================================
import { db } from "./db";
import { getShopperEmailVerified } from "./guest-otp";

export type ClaimGuestStateResult = {
  addressesClaimed: number;
  ordersClaimed: number;
  /** "email-unverified" when the ownership gate skipped order claiming. */
  skipped?: "email-unverified";
};

export async function claimGuestStateForShopper(
  shopperId: string,
  email: string
): Promise<ClaimGuestStateResult> {
  // FINAL CLOSURE §2: claim guest orders ONLY after the account has proved
  // ownership of its own email address. Fail-closed when the verification
  // storage is not migrated yet (P2021 → unverified, see getShopperEmailVerified).
  const emailVerified = await getShopperEmailVerified(shopperId);

  let ordersClaimed = 0;
  let skipped: "email-unverified" | undefined = emailVerified ? undefined : "email-unverified";

  if (emailVerified) {
    // Claim guest orders placed with the account email (checked out before
    // sign-in). Still idempotent: shopperId IS NULL filters out anything
    // already claimed, so repeated calls after verification claim nothing new.
    const orders = await db.order.updateMany({
      where: { customerEmail: email.toLowerCase(), shopperId: null },
      data: { shopperId },
    });
    ordersClaimed = orders.count;
    skipped = undefined;
  }

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

  return { addressesClaimed: 0, ordersClaimed, ...(skipped ? { skipped } : {}) };
}

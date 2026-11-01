// ============================================================================
// Guest → account merge ("claim on login") — PHASE 2.2 GUEST CHECKOUT
// RESTORATION: orders (email-ownership-gated) AND the device guest cart.
// Guest checkout is back: unauthenticated buyers build a token-keyed cart
// ("sm_cart" cookie); at login/registration that cart is folded INTO the
// account cart so items follow the buyer. Address claiming stays removed — the
// address book is strictly account-scoped (shopperId); guests check out with an
// inline address only. All merges are idempotent by design.
//
// FINAL CLOSURE §2 — EMAIL-OWNERSHIP GATE (unchanged). Shopper registration
// performs NO email verification, so an "email match" alone is knowledge-of-
// email, NOT proof of ownership: registering an account with someone else's
// address must never claim that person's guest orders (they carry full PII
// once claimed). The order-claiming half below still requires the DURABLE
// email-ownership proof recorded by POST /api/auth/shopper/email-verification/
// verify (a verified EmailOtpChallenge row, purpose "shopper-email"). Until
// the shopper completes that code round-trip through their own mailbox,
// order claiming is skipped — at registration, at login, everywhere (the gate
// lives HERE so no future caller can bypass it). The CART merge needs no such
// gate: it only moves the device's own cart rows into the account the caller
// just authenticated as (possession of the credentials IS the proof). The
// address-default normalization below touches only the account's OWN rows and
// is unaffected.
// ============================================================================
import { db } from "./db";
import { getShopperEmailVerified } from "./guest-otp";
import { getCartToken, clearCartToken } from "@/app/api/cart/cart";

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

export type MergeGuestCartResult = { itemsMerged: number };

/** PHASE 2.2 GUEST CHECKOUT RESTORATION — fold the device's guest cart into
 *  the shopper's account cart at login/registration.
 *
 *  • No guest cart cookie / empty guest cart / cookie names an ACCOUNT-bound
 *    row (defensive — must never be deleted) → no-op.
 *  • Account has no cart yet → the guest cart row is RE-POINTED (shopperId is
 *    set), keeping item ids and the buyer's checkout selection.
 *  • Account has a cart → guest lines are upserted into it (same variant →
 *    quantities added, capped at 99 and at live stock; new variant → line
 *    created), then the guest row is deleted (cascades its items).
 *  • The device cart token is retired either way, so a later logout can never
 *    resurrect the (now account-owned) cart through the guest path.
 *
 *  Best-effort by design: any failure logs a warning and merges nothing — a
 *  cart merge must NEVER fail login/registration. Idempotent: after a merge
 *  there is no guest row left for a second call to find. */
export async function mergeGuestCartForShopper(shopperId: string): Promise<MergeGuestCartResult> {
  try {
    const token = await getCartToken();
    if (!token) return { itemsMerged: 0 };

    const guestCart = await db.cart.findUnique({ where: { token }, include: { items: true } });
    if (!guestCart || guestCart.shopperId != null || guestCart.items.length === 0) {
      return { itemsMerged: 0 };
    }

    // No account cart yet → re-point the guest cart (cheapest, keeps selection).
    const accountCart = await db.cart.findUnique({ where: { shopperId }, include: { items: true } });
    if (!accountCart) {
      await db.cart.update({ where: { id: guestCart.id }, data: { shopperId } });
      await clearCartToken();
      return { itemsMerged: guestCart.items.length };
    }

    // Upsert quantities per variant — cap at 99 and at live stock (the same
    // friendly caps the add-to-cart route applies; out-of-stock lines survive
    // at qty 1 so the buyer SEES them and the cart UI/checkout re-validates).
    const variantIds = [...new Set(guestCart.items.map((i) => i.variantId))];
    const variants = await db.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, stock: true },
    });
    const stockById = new Map(variants.map((v) => [v.id, v.stock]));
    const accountByVariant = new Map(accountCart.items.map((i) => [i.variantId, i]));

    let itemsMerged = 0;
    for (const guestItem of guestCart.items) {
      const cap = (combined: number) => {
        const stock = stockById.get(guestItem.variantId);
        return stock == null ? Math.min(99, combined) : Math.min(99, combined, Math.max(1, stock));
      };
      const accountItem = accountByVariant.get(guestItem.variantId);
      if (accountItem) {
        const capped = cap(accountItem.qty + guestItem.qty);
        if (capped !== accountItem.qty) {
          await db.cartItem.update({ where: { id: accountItem.id }, data: { qty: capped } });
        }
      } else {
        await db.cartItem.create({
          data: { cartId: accountCart.id, variantId: guestItem.variantId, qty: cap(guestItem.qty) },
        });
      }
      itemsMerged += 1;
    }

    // The guest cart row is spent — delete it (cascade removes its items) and
    // retire the device token so it can never address an account cart.
    await db.cart.delete({ where: { id: guestCart.id } });
    await clearCartToken();
    return { itemsMerged };
  } catch (err) {
    console.warn(
      `[shopper-merge] guest cart merge failed for shopper=${shopperId}: ${err instanceof Error ? err.message : String(err)} — login continues with the account cart as-is`
    );
    return { itemsMerged: 0 };
  }
}

// End of shopper-merge.ts — Phase 2.2 guest checkout restoration (HMR nudge).

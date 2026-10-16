import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { NOMO_FINANCE_ENABLED } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

const CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// GET /api/me/wallet — buyer financial overview: NomoPay balance, coin
// balance, NomoPay Later credit, voucher counts and the daily check-in state.
//
// DORMANT SCAFFOLD — NOMO FINANCE (see src/lib/feature-flags.ts): while
// NOMO_FINANCE_ENABLED is false this endpoint intentionally does NOT touch
// ShopperWallet (no lazy creation, no stored-value exposure) and reports a
// `disabled` envelope. Voucher counts are still served — vouchers are
// marketing assets, not stored value. The full wallet scaffold below stays
// exactly as built; flip the flag to re-activate it without further changes.
export const GET = handle(async () => {
  const me = await requireShopper();

  const [availableVouchers, usedVouchers] = await Promise.all([
    db.userVoucher.count({ where: { userId: me.id, status: "AVAILABLE" } }),
    db.userVoucher.count({ where: { userId: me.id, status: "USED" } }),
  ]);

  if (!NOMO_FINANCE_ENABLED) {
    return ok({
      disabled: true,
      message: "NomoPay & Nomo Coins are coming soon.",
      wallet: null,
      checkIn: null,
      vouchers: { available: availableVouchers, used: usedVouchers },
    });
  }

  // Wallet is created lazily on first read so every account has one.
  const wallet = await db.shopperWallet.upsert({
    where: { userId: me.id },
    create: { userId: me.id },
    update: {},
  });

  const now = new Date();
  const lastCheckInAt = wallet.lastCheckInAt;
  const canClaim = !lastCheckInAt || now.getTime() - lastCheckInAt.getTime() >= CLAIM_COOLDOWN_MS;
  const nextClaimAt = lastCheckInAt ? new Date(lastCheckInAt.getTime() + CLAIM_COOLDOWN_MS) : null;

  return ok({
    wallet: {
      balanceMinor: wallet.balanceMinor,
      coinBalance: wallet.coinBalance,
      payLaterLimitMinor: wallet.payLaterLimitMinor,
      payLaterUsedMinor: wallet.payLaterUsedMinor,
      payLaterAvailableMinor: Math.max(0, wallet.payLaterLimitMinor - wallet.payLaterUsedMinor),
      checkInStreak: wallet.checkInStreak,
    },
    vouchers: { available: availableVouchers, used: usedVouchers },
    checkIn: { canClaim, lastCheckInAt, nextClaimAt },
  });
});

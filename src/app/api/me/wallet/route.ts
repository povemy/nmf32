import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// GET /api/me/wallet — buyer financial overview: SHOPMESH Pay balance, coin
// balance, SPayLater credit, voucher counts and the daily check-in state.
export const GET = handle(async () => {
  const me = await requireShopper();

  // Wallet is created lazily on first read so every account has one.
  const wallet = await db.shopperWallet.upsert({
    where: { userId: me.id },
    create: { userId: me.id },
    update: {},
  });

  const now = new Date();
  const [availableVouchers, usedVouchers] = await Promise.all([
    db.userVoucher.count({ where: { userId: me.id, status: "AVAILABLE" } }),
    db.userVoucher.count({ where: { userId: me.id, status: "USED" } }),
  ]);

  const lastCheckInAt = wallet.lastCheckInAt;
  const canClaim = !lastCheckInAt || now.getTime() - lastCheckInAt.getTime() >= CLAIM_COOLDOWN_MS;
  const nextClaimAt = lastCheckInAt ? new Date(lastCheckInAt.getTime() + CLAIM_COOLDOWN_MS) : null;

  return ok({
    wallet: {
      balanceMinor: wallet.balanceMinor,
      coinBalance: wallet.coinBalance,
      spayLaterLimitMinor: wallet.spayLaterLimitMinor,
      spayLaterUsedMinor: wallet.spayLaterUsedMinor,
      spayLaterAvailableMinor: Math.max(0, wallet.spayLaterLimitMinor - wallet.spayLaterUsedMinor),
      checkInStreak: wallet.checkInStreak,
    },
    vouchers: { available: availableVouchers, used: usedVouchers },
    checkIn: { canClaim, lastCheckInAt, nextClaimAt },
  });
});

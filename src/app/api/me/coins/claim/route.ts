import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { MESH_FINANCE_ENABLED } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

const CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BASE_COINS = 10;
/** Streak bonus: +2 coins per consecutive day, capped at +14 (day 8+). */
function coinsForStreak(streak: number): number {
  return BASE_COINS + Math.min(14, Math.max(0, streak) * 2);
}

// POST /api/me/coins/claim — daily coin check-in with server-side state
// validation (24h cooldown enforced on the stored lastCheckInAt, never on the
// client). Credits the wallet and advances the streak.
//
// DORMANT SCAFFOLD — MESH FINANCE (see src/lib/feature-flags.ts): the whole
// check-in flow stays fully implemented but is gated off — nothing is
// awarded and no streak state changes while MESH_FINANCE_ENABLED is false.
export const POST = handle(async () => {
  const me = await requireShopper();

  if (!MESH_FINANCE_ENABLED) {
    throw new ApiError(403, "FEATURE_DORMANT", "Mesh Coins will be available soon — daily check-in is paused for now.");
  }

  const wallet = await db.shopperWallet.upsert({
    where: { userId: me.id },
    create: { userId: me.id },
    update: {},
  });

  const now = new Date();
  if (wallet.lastCheckInAt && now.getTime() - wallet.lastCheckInAt.getTime() < CLAIM_COOLDOWN_MS) {
    const nextAt = new Date(wallet.lastCheckInAt.getTime() + CLAIM_COOLDOWN_MS);
    throw new ApiError(429, "ALREADY_CLAIMED", `Already checked in today — come back after ${nextAt.toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" })}`, { nextClaimAt: nextAt });
  }

  // Consecutive-day streak resets when the last check-in was >48h ago.
  const gap = wallet.lastCheckInAt ? now.getTime() - wallet.lastCheckInAt.getTime() : Infinity;
  const streak = gap <= 2 * CLAIM_COOLDOWN_MS ? wallet.checkInStreak + 1 : 1;
  const awarded = coinsForStreak(streak);

  const updated = await db.shopperWallet.update({
    where: { userId: me.id },
    data: {
      coinBalance: { increment: awarded },
      lastCheckInAt: now,
      checkInStreak: streak,
    },
  });

  return ok({
    awarded,
    coinBalance: updated.coinBalance,
    checkInStreak: streak,
    nextClaimAt: new Date(now.getTime() + CLAIM_COOLDOWN_MS),
  });
});

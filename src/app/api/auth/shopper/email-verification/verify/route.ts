import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { requireShopper } from "@/lib/auth";
import { assertEmailOtpStorage, verifyEmailOtp, getShopperEmailVerified } from "@/lib/guest-otp";
import { claimGuestStateForShopper } from "@/lib/shopper-merge";
import type { ShopperEvVerifyBody, ShopperEvVerifyData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/auth/shopper/email-verification/verify { code } — FINAL CLOSURE §2.
//
// Completes email ownership verification for the signed-in shopper and —
// exactly once — claims the legacy guest orders placed with that email.
//
// Exactly-once mechanics:
//   1. verifyEmailOtp() CAS-sets verifiedAt (WHERE verifiedAt IS NULL) — only
//      ONE concurrent verify can win; replays of the same code answer 401.
//   2. The winner (and only the winner) runs claimGuestStateForShopper(),
//      whose own gate now requires the verified proof. A second verify
//      attempt reads alreadyVerified and claims nothing.
//
// Attack closed by this route + the gate: register an account with a
// victim's email (registration performs NO email verification) → the account
// can NOT claim the victim's guest orders at registration, at login, or
// anywhere else until this code round-trip through the victim's mailbox
// succeeds — at which point the person controlling the mailbox IS the
// legitimate owner of that email.
//
// Throttles: 10/min/IP + 20/hour per account (plus the challenge's own
// 5-attempt bound).
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  rateLimit(req, "email-verification-verify", 10);
  rateLimitKey(me.id, "email-verification-verify", 20, 3_600_000);

  const body = (await req.json().catch(() => ({}))) as ShopperEvVerifyBody;
  const code = (body.code ?? "").trim();
  if (!code || code.length > 12) {
    throw new ApiError(401, "INVALID", "That code is not valid");
  }

  // Already verified (caller's own state — safe to reveal): idempotent
  // success WITHOUT a second claim.
  if (await getShopperEmailVerified(me.id)) {
    const payload: ShopperEvVerifyData = { verified: true, alreadyVerified: true, ordersClaimed: 0 };
    return ok(payload);
  }

  // Uniform fail-closed pre-flight (pre-migration deployment).
  await assertEmailOtpStorage();

  const result = await verifyEmailOtp({ purpose: "shopper-email", subjectId: me.id, code });
  if (!result.ok) {
    // One uniform 401 for every failure mode (wrong/expired/locked/race).
    throw new ApiError(401, "INVALID", "That code is not valid");
  }

  // Winner of the CAS: claim exactly once. The gate inside
  // claimGuestStateForShopper re-checks the verified proof (defense in depth
  // for any future caller).
  const claimed = await claimGuestStateForShopper(me.id, me.email);

  await logActivity({
    actorType: "shopper",
    actorId: me.id,
    actorLabel: me.email,
    action: "shopper.email_verification.verified",
    meta: { ordersClaimed: claimed.ordersClaimed },
  }).catch(() => undefined);

  const payload: ShopperEvVerifyData = { verified: true, alreadyVerified: false, ordersClaimed: claimed.ordersClaimed };
  return ok(payload);
});

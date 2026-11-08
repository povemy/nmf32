import { db } from "@/lib/db";
import { verifyPasswordAsync, DUMMY_PASSWORD_HASH } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { claimGuestStateForShopper, mergeGuestCartForShopper } from "@/lib/shopper-merge";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import type { ShopperLoginBody, ShopperLoginData } from "@/lib/types/api-contract";

// POST /api/auth/shopper/login { email, password } — buyer account sign-in.
// Legacy guest orders placed with the account email (guest checkout existed
// before it was removed) are claimed INTO the account — FINAL CLOSURE §2:
// only once the account has PROVED ownership of its email address
// (verified EmailOtpChallenge row; the gate lives inside
// claimGuestStateForShopper, so no call site can bypass it). PHASE 2.2 GUEST
// CHECKOUT RESTORATION: the device's guest cart ("sm_cart" cookie) is merged
// into the account cart here — best-effort, never fails login. `emailVerified`
// in the response lets the client point the shopper at the verification flow
// (Me → Profile) when claiming is gated.
export const POST = handle(async (req: Request) => {
  // F-12 remediation: bounded brute-force throttle — shared "auth-login"
  // bucket (10/min/IP) with the admin/seller login route; uniform 429.
  rateLimit(req, "auth-login", 10);
  const body = (await req.json().catch(() => ({}))) as ShopperLoginBody;
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) return fail(400, "VALIDATION", "Email and password are required");
  // Phase 1 (SEC-01): identity-keyed throttle — 20/hour per EMAIL on top of
  // the shared per-IP bucket (distributed brute-force still exhausts).
  rateLimitKey(email, "auth-login-email", 20, 3_600_000);

  const shopper = await db.shopperUser.findUnique({ where: { email } });
  // Phase 1 (SEC-01/SEC-04): async scrypt + DUMMY verification for the
  // not-found branch — same work, same timing, no enumeration oracle.
  const pwOk = await verifyPasswordAsync(password, shopper?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!shopper || !pwOk) {
    return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }
  if (shopper.status !== "active") {
    return fail(403, "ACCOUNT_SUSPENDED", "This account is not available right now");
  }
  await db.shopperUser.update({ where: { id: shopper.id }, data: { lastLoginAt: new Date() } });
  const token = await createSession("shopper", shopper.id);
  const claimed = await claimGuestStateForShopper(shopper.id, shopper.email);
  const emailVerified = claimed.skipped !== "email-unverified";
  // PHASE 2.2 guest checkout restoration — fold the guest cart into the
  // account cart (best-effort; never fails login).
  const guestCartMerged = await mergeGuestCartForShopper(shopper.id);
  await logActivity({ actorType: "shopper", actorId: shopper.id, actorLabel: shopper.email, action: "shopper.login", meta: { guestCartMerged: guestCartMerged.itemsMerged } });
  const payload: ShopperLoginData = {
    userType: "shopper",
    shopper: { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone },
    token,
    claimed,
    emailVerified,
    guestCartMerged: guestCartMerged.itemsMerged,
  };
  return ok(payload);
});

import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { claimGuestStateForShopper } from "@/lib/shopper-merge";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/auth/shopper/login { email, password } — buyer account sign-in.
// Legacy guest orders placed with the account email (guest checkout existed
// before it was removed) are claimed INTO the account. Carts and the address
// book are strictly account-scoped — there is nothing device-owned any more.
export const POST = handle(async (req: Request) => {
  // F-12 remediation: bounded brute-force throttle — shared "auth-login"
  // bucket (10/min/IP) with the admin/seller login route; uniform 429.
  rateLimit(req, "auth-login", 10);
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) return fail(400, "VALIDATION", "Email and password are required");

  const shopper = await db.shopperUser.findUnique({ where: { email } });
  if (!shopper || !verifyPassword(password, shopper.passwordHash)) {
    return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }
  if (shopper.status !== "active") {
    return fail(403, "ACCOUNT_SUSPENDED", "This account is not available right now");
  }
  await db.shopperUser.update({ where: { id: shopper.id }, data: { lastLoginAt: new Date() } });
  const token = await createSession("shopper", shopper.id);
  const claimed = await claimGuestStateForShopper(shopper.id, shopper.email);
  await logActivity({ actorType: "shopper", actorId: shopper.id, actorLabel: shopper.email, action: "shopper.login" });
  return ok({
    userType: "shopper",
    shopper: { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone },
    token,
    claimed,
  });
});

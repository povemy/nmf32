import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, logActivity } from "@/lib/api";

// POST /api/auth/shopper/login { email, password } — buyer account sign-in.
export const POST = handle(async (req: Request) => {
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
  await logActivity({ actorType: "shopper", actorId: shopper.id, actorLabel: shopper.email, action: "shopper.login" });
  return ok({
    userType: "shopper",
    shopper: { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone },
    token,
  });
});

import { db } from "@/lib/db";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { getSession, rotateSession } from "@/lib/auth";
import { hashPasswordAsync, verifyPasswordAsync } from "@/lib/password";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/me/password { currentPassword, newPassword } — Task 22-b (R2).
//
// Self-service credential change for the signed-in principal (admin | seller |
// shopper). No password-change endpoint existed anywhere before this route
// (verified by grep: passwordHash was write-only at registration). On success
// the session is ROTATED (rotateSession): the presented token is deleted and a
// fresh one is issued for the same principal, so a stolen token cannot survive
// a credential change. The response returns the new token exactly the way the
// login endpoints do ({ userType, <role>: {...}, token }) so a client that
// stores it (sm_session_token localStorage bridge) can update it the same way.
// To sign out EVERY device instead, revokeUserSessions() in lib/auth.ts is the
// building block (no such surface exists in this build).
export const POST = handle(async (req: Request) => {
  rateLimit(req, "auth", 20); // credential endpoint → same throttle class as login

  const sess = await getSession();
  if (!sess) return fail(401, "UNAUTHORIZED", "Sign in required");

  const body = (await req.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
  const currentPassword = body.currentPassword ?? "";
  const newPassword = body.newPassword ?? "";
  if (!currentPassword || !newPassword) {
    return fail(400, "VALIDATION", "Current and new password are required");
  }
  if (newPassword.length < 8) {
    return fail(400, "VALIDATION", "Password must be at least 8 characters");
  }

  // Phase 1 (SEC-04): async scrypt — hashing/verification never blocks the
  // event loop on this credential endpoint.
  const passwordHash = await hashPasswordAsync(newPassword);

  if (sess.userType === "admin") {
    const admin = await db.adminUser.findUnique({ where: { id: sess.userId } });
    if (!admin || !admin.isActive) return fail(401, "UNAUTHORIZED", "Admin not found");
    if (!await verifyPasswordAsync(currentPassword, admin.passwordHash)) {
      return fail(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
    }
    await db.adminUser.update({ where: { id: admin.id }, data: { passwordHash } });
    const token = await rotateSession();
    if (!token) return fail(401, "UNAUTHORIZED", "Session expired — sign in again");
    await logActivity({ actorType: "admin", actorId: admin.id, actorLabel: admin.email, action: "admin.password_changed" });
    return ok({ userType: "admin", admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }, token });
  }

  if (sess.userType === "seller") {
    const seller = await db.seller.findUnique({ where: { id: sess.userId } });
    if (!seller) return fail(401, "UNAUTHORIZED", "Seller not found");
    if (seller.status === "terminated") return fail(403, "ACCOUNT_TERMINATED", "This account has been terminated");
    if (!await verifyPasswordAsync(currentPassword, seller.passwordHash)) {
      return fail(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
    }
    await db.seller.update({ where: { id: seller.id }, data: { passwordHash } });
    const token = await rotateSession();
    if (!token) return fail(401, "UNAUTHORIZED", "Session expired — sign in again");
    await logActivity({ actorType: "seller", actorId: seller.id, actorLabel: seller.email, action: "seller.password_changed" });
    return ok({
      userType: "seller",
      seller: {
        id: seller.id, email: seller.email, fullName: seller.fullName,
        displayName: seller.displayName, status: seller.status,
      },
      token,
    });
  }

  const shopper = await db.shopperUser.findUnique({ where: { id: sess.userId } });
  if (!shopper || shopper.status !== "active") return fail(401, "UNAUTHORIZED", "Shopper account unavailable");
  if (!await verifyPasswordAsync(currentPassword, shopper.passwordHash)) {
    return fail(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
  }
  await db.shopperUser.update({ where: { id: shopper.id }, data: { passwordHash } });
  const token = await rotateSession();
  if (!token) return fail(401, "UNAUTHORIZED", "Session expired — sign in again");
  await logActivity({ actorType: "shopper", actorId: shopper.id, actorLabel: shopper.email, action: "shopper.password_changed" });
  return ok({
    userType: "shopper",
    shopper: { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone },
    token,
  });
});

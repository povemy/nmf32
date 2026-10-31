import { db } from "@/lib/db";
import { verifyMfaChallenge } from "@/lib/mfa";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, ApiError, logActivity } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/auth/mfa/verify { challenge, code } — Phase 1 (C4) login completion.
// ---------------------------------------------------------------------------
// Second factor for administrators with a CONFIRMED TOTP enrollment. Both admin
// login paths (unified-login and the legacy /api/auth/login) refuse to mint a
// session when MFA is confirmed; they return { mfaRequired, challenge } instead
// and the client submits the authenticator code (or a one-time recovery code)
// here. ONLY this route mints the session for a challenge — and it can only
// succeed against a challenge that (a) was created server-side after the
// PASSWORD verified and (b) belongs to an enrollment that is still confirmed.
//
// Brute-force posture: the challenge map enforces progressive lockout (3 fails
// → 60 s lock, 8 total → permanent until expiry) and challenges expire after
// 5 minutes; this route adds the shared per-IP login throttle on top. Failure
// responses are uniform ("Invalid code") — the challenge token is
// unguessable (256-bit) so no enumeration surface exists.
export const POST = handle(async (req: Request) => {
  rateLimit(req, "auth-login", 10);

  const body = (await req.json().catch(() => ({}))) as { challenge?: string; code?: string };
  const challenge = (body.challenge ?? "").trim();
  const code = (body.code ?? "").trim();
  if (!challenge || !code) {
    return fail(400, "VALIDATION", "challenge and code are required");
  }
  if (!/^[a-f0-9]{16,128}$/i.test(challenge) || code.length > 16) {
    return fail(400, "VALIDATION", "Invalid request");
  }

  const result = await verifyMfaChallenge(challenge, code);
  if (!result.ok) {
    if (result.reason === "EXPIRED") {
      return fail(401, "MFA_EXPIRED", "This sign-in attempt expired — start again");
    }
    if (result.reason === "LOCKED") {
      throw new ApiError(429, "MFA_LOCKED", `Too many incorrect codes — retry in ${result.retryAfterSeconds ?? 60}s`, {
        retryAfterSeconds: result.retryAfterSeconds ?? 60,
      });
    }
    return fail(401, "MFA_INVALID", "Invalid code", {
      attemptsRemaining: result.attemptsRemaining ?? null,
    });
  }

  // Mint the admin session exactly like the password-only path would have.
  const admin = await db.adminUser.findUnique({ where: { id: result.adminId } });
  if (!admin || !admin.isActive) {
    // Enrollment/admin changed mid-challenge — no session, uniform message.
    return fail(401, "UNAUTHORIZED", "Invalid admin credentials");
  }
  await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  const token = await createSession("admin", admin.id);
  await logActivity({
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    action: "admin.login",
    meta: { via: "mfa", recovery: result.usedRecoveryCode },
  });
  return ok({ userType: "admin", admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }, token });
});

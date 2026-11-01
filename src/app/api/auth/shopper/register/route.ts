import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getEmailChannel } from "@/lib/email-provider";
import { getShopperEmailVerified, issueEmailOtp, assertEmailOtpStorage } from "@/lib/guest-otp";

// POST /api/auth/shopper/register { fullName, email, password, phone? } — buyer signup.
//
// FINAL CLOSURE §2 — REGISTRATION NO LONGER CLAIMS GUEST ORDERS. Registration
// performs no email verification, so a fresh account with someone else's
// email address must not absorb that person's legacy guest orders (full PII)
// just by existing. Instead, registration best-effort SENDS an email
// verification code (when a provider is configured); the shopper completes
// verification via /api/auth/shopper/email-verification/verify, which claims
// the guest orders EXACTLY ONCE.
//
// Response contract: `claimed` stays in the shape callers already know
// ({ addressesClaimed, ordersClaimed }) but is always zero here, plus
// `emailVerified: false` and `emailVerificationSent` (best-effort — a
// missing provider or delivery problem NEVER fails registration).
export const POST = handle(async (req: Request) => {
  // F-12 remediation: account-creation throttle — shared "auth-register"
  // bucket (5/min/IP) with the seller register route.
  rateLimit(req, "auth-register", 5);
  const body = (await req.json().catch(() => ({}))) as {
    email?: string; password?: string; fullName?: string; phone?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const fullName = (body.fullName ?? "").trim();
  const phone = (body.phone ?? "").trim() || null;

  if (!email.includes("@")) return fail(400, "VALIDATION", "A valid email is required");
  if (password.length < 8) return fail(400, "VALIDATION", "Password must be at least 8 characters");
  if (!fullName) return fail(400, "VALIDATION", "Full name is required");

  const exists = await db.shopperUser.findUnique({ where: { email } });
  if (exists) return fail(409, "EMAIL_TAKEN", "An account with this email already exists");

  // A shopper email must not collide with seller/admin accounts (separate portals).
  const sellerClash = await db.seller.findUnique({ where: { email } });
  const adminClash = sellerClash ? null : await db.adminUser.findUnique({ where: { email } });
  if (sellerClash || adminClash) return fail(409, "EMAIL_TAKEN", "This email is already registered on NOMOFEE");

  const shopper = await db.shopperUser.create({
    data: { email, passwordHash: hashPassword(password), fullName, phone, lastLoginAt: new Date() },
  });

  const token = await createSession("shopper", shopper.id);

  // Best-effort verification kickoff — never blocks registration.
  let emailVerificationSent = false;
  try {
    const channel = getEmailChannel();
    if (channel) {
      await assertEmailOtpStorage();
      const result = await issueEmailOtp({
        purpose: "shopper-email",
        subjectId: shopper.id,
        deliver: (code) =>
          channel.send({
            to: shopper.email,
            subject: "Verify your NOMOFEE email address",
            textBody:
              `Welcome to NOMOFEE! Your email verification code is ${code}.\n\n` +
              `It expires in 10 minutes. Verifying your email lets orders placed as a guest with this address appear in your account.\n` +
              `If you did not create this account, you can ignore this email.`,
            meta: { purpose: "shopper-email", subjectId: shopper.id },
          }),
      });
      emailVerificationSent = result.issued;
    }
  } catch {
    // Provider/storage fail-closed states are expected pre-configuration —
    // registration itself must never depend on email delivery.
    emailVerificationSent = false;
  }

  // Defense in depth: a brand-new account can never be verified yet, but the
  // documented claim result is derived from the ACTUAL gate state.
  const emailVerified = await getShopperEmailVerified(shopper.id).catch(() => false);

  await logActivity({
    actorType: "shopper",
    actorId: shopper.id,
    actorLabel: shopper.email,
    action: "shopper.register",
    meta: { emailVerificationSent },
  });
  return ok({
    userType: "shopper",
    shopper: { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone },
    token,
    claimed: { addressesClaimed: 0, ordersClaimed: 0 },
    emailVerified,
    emailVerificationSent,
  });
});

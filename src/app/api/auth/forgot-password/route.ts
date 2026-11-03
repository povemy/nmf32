import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { db } from "@/lib/db";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { requireEmailChannel, type TransactionalEmailChannel } from "@/lib/email-provider";
import { assertEmailOtpStorage, issueEmailOtp, PASSWORD_RESET_OTP_TTL_MS } from "@/lib/guest-otp";
import { normalizeRecoveryEmail, burnAccountNotFoundDelay } from "@/lib/password-recovery";

export const dynamic = "force-dynamic";

// POST /api/auth/forgot-password { email } — WORK ORDER 1: shopper password
// recovery, step A.
//
// Mirrors /api/checkout/guest-verify/request (the proven guest-checkout OTP
// request route) with the account-existence discipline login already follows:
//
//   • UNIFORM RESPONSE — the same 200, the same message, the same response
//     shape whether the address belongs to an active shopper account or not.
//     No status differences, no message differences. The not-found branch
//     burns comparable scrypt + jitter work (burnAccountNotFoundDelay) so the
//     two paths' latency bands overlap — no OBVIOUS timing oracle.
//   • issuance only when appropriate — a challenge row + delivery happen ONLY
//     for a REGISTERED, ACTIVE account; unknown/inactive addresses get the
//     pad, never a row (a locked-challenge suppression also returns the
//     uniform 200 — a 429 here would reveal that the address HAS a challenge,
//     i.e. that an account exists; the sibling guest-verify route may 429
//     safely because every email there gets challenges, accounts or not).
//   • fail-closed pre-flights BEFORE any account lookup are uniform for every
//     caller (no provider → 503; OTP storage missing → 503).
//   • throttles: 5/min per IP + 3/hour per normalized email (identity-keyed —
//     brute-force spread across many IPs still exhausts against the mailbox),
//     PLUS the challenge's own carry-over attempt counter (guest-otp.ts).
const MESSAGE =
  "If that address belongs to a NOMOFEE account, a recovery code has been sent to it. " +
  "The code expires in 15 minutes. If it does not arrive, wait a few minutes — earlier codes expire automatically.";

export const POST = handle(async (req: Request) => {
  rateLimit(req, "auth-forgot-password", 5);
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const email = normalizeRecoveryEmail(body.email);
  if (!email) {
    throw new ApiError(400, "VALIDATION", "A valid email address is required");
  }
  rateLimitKey(email, "auth-forgot-password-email", 3, 3_600_000);

  // Fail-closed pre-flights BEFORE any account lookup (uniform for every
  // caller — these 503s cannot act as an account-existence oracle).
  const channel: TransactionalEmailChannel = requireEmailChannel();
  await assertEmailOtpStorage();

  const shopper = await db.shopperUser.findUnique({
    where: { email },
    select: { id: true, status: true },
  });

  let issued = false;
  // Full IssueEmailOtpResult union: "already-verified" cannot occur for the
  // single-shot password-reset purpose (consumed rows are deleted, not
  // verified-persisted), but the local type must match the contract.
  let suppressed: "locked" | "already-verified" | "delivery-failed" | null = null;
  if (shopper && shopper.status === "active") {
    // Registered + active → issue (or re-issue) the single live challenge.
    // Re-issuance replaces the code/hash and extends the expiry (latest email
    // wins); attempt counters carry over while a row is live, so re-requesting
    // codes can never reset brute-force accounting.
    const result = await issueEmailOtp({
      purpose: "password-reset",
      subjectId: email,
      ttlMs: PASSWORD_RESET_OTP_TTL_MS,
      deliver: (code) =>
        channel.send({
          to: email,
          subject: "Your NOMOFEE password recovery code",
          textBody:
            `Your password recovery code for NOMOFEE is ${code}.\n\n` +
            `It expires in 15 minutes and can be used once. With it you can set a new password for your account.\n\n` +
            `If you did not request a password reset, you can ignore this email — your password stays unchanged.\n` +
            `NOMOFEE will never ask you to reply with this code.`,
          meta: { purpose: "password-reset", subjectId: email },
        }),
    });
    issued = result.issued;
    suppressed = result.suppressed ?? null;
  } else {
    // Unknown or ineligible address — burn comparable work, never write a row,
    // then answer with the byte-identical response.
    await burnAccountNotFoundDelay();
  }

  // Audit WITHOUT the code — the normalized email is the durable correlation
  // key (same convention as the login audit rows). Suppression reasons are
  // internal: locked / delivery-failed still return the uniform 200.
  await logActivity({
    actorType: "shopper",
    actorLabel: email,
    action: "shopper.password_reset.request",
    entityType: "email",
    entityId: shopper?.id ?? null,
    meta: { issued, suppressed },
  }).catch(() => undefined);

  return ok({ sent: true, message: MESSAGE });
});

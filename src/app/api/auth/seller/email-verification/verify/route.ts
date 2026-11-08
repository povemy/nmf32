import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { requireSeller } from "@/lib/auth";
import { assertEmailOtpStorage, verifyEmailOtp } from "@/lib/guest-otp";
import { isPrismaMissingTableError } from "@/lib/mfa";
import {
  getSellerEmailVerifiedAt,
  assertSellerEmailVerificationWritable,
} from "@/lib/seller-email-verification";
import type { SellerEvVerifyBody, SellerEvVerifyData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/auth/seller/email-verification/verify { code } — PHASE 2.3 (C2.7).
//
// Completes email-ownership verification for the signed-in seller — the
// seller-side twin of /api/auth/shopper/email-verification/verify.
//
// Exactly-once mechanics:
//   1. verifyEmailOtp() CAS-sets verifiedAt on the purpose-"seller-email"
//      challenge row (WHERE verifiedAt IS NULL) — only ONE concurrent verify
//      can win; replays of the same code answer the uniform 401.
//   2. The winner's side effect (onWin) sets Seller.emailVerifiedAt in the
//      SAME db.$transaction as that consume, itself CAS-guarded
//      (WHERE emailVerifiedAt IS NULL). The challenge row and the seller
//      column therefore commit together or not at all — a crash between the
//      two is impossible, so the states can never diverge.
//
// Honesty rule: Seller.emailVerifiedAt is written by THIS ROUTE ONLY. No
// other code path (registration, admin actions, KYC auto-rules) may set it —
// a null column must always be displayed as "not verified".
//
// Fail-closed pre-flight (uniform 503, before any account lookup work):
//   • assertEmailOtpStorage — EmailOtpChallenge table un-migrated (P2021);
//   • assertSellerEmailVerificationWritable — loaded client predates the
//     Phase 2.3 schema (would fail query validation mid-transaction).
// A P2022 raised by the in-transaction seller update (client migrated, DB
// not) rolls the WHOLE transaction back — the challenge stays unconsumed and
// the route maps it to the same 503, so nothing gets stuck pre-migration.
//
// Throttles: 10/min/IP + 20/hour per account (plus the challenge's own
// 5-attempt bound).
export const POST = handle(async (req: Request) => {
  const me = await requireSeller();
  rateLimit(req, "email-verification-verify", 10);
  rateLimitKey(me.id, "email-verification-verify", 20, 3_600_000);

  const body = (await req.json().catch(() => ({}))) as SellerEvVerifyBody;
  const code = (body.code ?? "").trim();
  if (!code || code.length > 12) {
    throw new ApiError(401, "INVALID", "That code is not valid");
  }

  // Already verified (caller's own state — safe to reveal): idempotent
  // success. Tolerant read: pre-migration reads as unverified.
  const alreadyAt = await getSellerEmailVerifiedAt(me.id);
  if (alreadyAt != null) {
    const payload: SellerEvVerifyData = { verified: true, alreadyVerified: true, emailVerifiedAt: alreadyAt.toISOString() };
    return ok(payload);
  }

  // Uniform fail-closed pre-flight (pre-migration deployment).
  await assertEmailOtpStorage();
  assertSellerEmailVerificationWritable();

  let verifiedAt: Date;
  try {
    const result = await verifyEmailOtp({
      purpose: "seller-email",
      subjectId: me.id,
      code,
      // Winner-only, INSIDE the consume transaction — see route header. The
      // CAS on emailVerifiedAt IS NULL is defense in depth: even a future
      // second caller that somehow reached the hook would no-op.
      onWin: async (tx) => {
        await tx.seller.updateMany({
          where: { id: me.id, emailVerifiedAt: null },
          data: { emailVerifiedAt: new Date() },
        });
      },
    });
    if (!result.ok) {
      // One uniform 401 for every failure mode (wrong/expired/locked/race).
      throw new ApiError(401, "INVALID", "That code is not valid");
    }
    verifiedAt = result.verifiedAt ?? new Date();
  } catch (e) {
    // Migration 20261107000000 not applied (Seller.emailVerifiedAt column
    // missing): the transaction rolled back — the challenge is unconsumed,
    // nothing is stuck. Surface the same uniform 503 as the pre-flights.
    if (isPrismaMissingTableError(e)) {
      throw new ApiError(
        503,
        "SELLER_EMAIL_VERIFICATION_UNAVAILABLE",
        "Seller email verification storage is not initialized on this deployment (fail closed)"
      );
    }
    throw e;
  }

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "seller.email_verification.verified",
    meta: { emailVerifiedAt: verifiedAt.toISOString() },
  }).catch(() => undefined);

  const payload: SellerEvVerifyData = { verified: true, alreadyVerified: false, emailVerifiedAt: verifiedAt.toISOString() };
  return ok(payload);
});

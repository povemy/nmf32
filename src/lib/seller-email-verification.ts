// ============================================================================
// PHASE 2.3 (C2.7) — seller email-verification support.
//
// The durable proof of a seller's email ownership is the purpose-
// "seller-email" EmailOtpChallenge row (see src/lib/guest-otp.ts); its
// verifiedAt is mirrored onto Seller.emailVerifiedAt by the verify route
// inside the SAME $transaction as the CAS consume, so the two can never
// diverge. This module is the SINGLE read/availability seam for that column,
// so every caller gets the same HONEST semantics:
//
//   • NULL / false is the ONLY default. Nothing here, and nothing downstream,
//     may ever report "verified" without the column actually being set —
//     that is the C2.7 KYC-honesty rule (no facade claims).
//   • Pre-migration tolerance (dev contract, same posture as
//     getShopperEmailVerified / AdminMfaEnrollment):
//       - the loaded Prisma client predates the schema change (server started
//         before `prisma generate`) → the field is not even selectable →
//         read as null;
//       - the client knows the field but migration 20261107000000 is not
//         applied (P2022) → read as null.
//     Both cases fail CLOSED: "unverified", never an error page, and never a
//     false "verified".
// ============================================================================
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { ApiError } from "./api";
import { isPrismaMissingTableError } from "./mfa";

let warnedStaleClient = false;

/** True when the LOADED Prisma client knows Seller.emailVerifiedAt (i.e. the
 *  process started after `prisma generate` picked up the Phase 2.3 schema).
 *  A stale client must fail closed — selecting the field on it is a client
 *  validation error, so callers check this FIRST. Mirrors emailOtpModel()'s
 *  stale-client guard in guest-otp.ts. */
export function sellerEmailVerifiedFieldAvailable(): boolean {
  const fields = Prisma.dmmf.datamodel.models.find((m) => m.name === "Seller")?.fields;
  const available = fields?.some((f) => f.name === "emailVerifiedAt") ?? false;
  if (!available && !warnedStaleClient) {
    warnedStaleClient = true;
    console.warn(
      "[seller-email-verification] the loaded Prisma client has no Seller.emailVerifiedAt — regenerate the client (bunx prisma generate) and restart; seller email verification reads as UNVERIFIED (fail closed) until then"
    );
  }
  return available;
}

/** When the seller's email was verified, or null = NOT verified. P2021/P2022
 *  (migration 20261107000000 not applied) and stale-client → null. Never
 *  throws for storage-shape reasons; real database faults still propagate. */
export async function getSellerEmailVerifiedAt(sellerId: string): Promise<Date | null> {
  if (!sellerEmailVerifiedFieldAvailable()) return null; // stale client → unverified
  try {
    const row = await db.seller.findUnique({
      where: { id: sellerId },
      select: { emailVerifiedAt: true },
    });
    return row?.emailVerifiedAt ?? null;
  } catch (e) {
    if (isPrismaMissingTableError(e)) {
      // Column not migrated yet → unverified (fail closed, honest).
      console.warn(
        "[seller-email-verification] Seller.emailVerifiedAt column missing — migration 20261107000000 not applied; seller email verification reads as UNVERIFIED (fail closed)"
      );
      return null;
    }
    throw e;
  }
}

/** Boolean convenience over getSellerEmailVerifiedAt (null → false). */
export async function getSellerEmailVerified(sellerId: string): Promise<boolean> {
  return (await getSellerEmailVerifiedAt(sellerId)) != null;
}

/** Fail-closed pre-flight for the WRITE path (the verify route): the loaded
 *  client must know the field, otherwise setting it would be a client
 *  validation error AFTER the OTP consume. 503 keeps the route's failure
 *  uniform with EMAIL_PROVIDER_NOT_CONFIGURED / EMAIL_OTP_UNAVAILABLE. */
export function assertSellerEmailVerificationWritable(): void {
  if (!sellerEmailVerifiedFieldAvailable()) {
    throw new ApiError(
      503,
      "SELLER_EMAIL_VERIFICATION_UNAVAILABLE",
      "Seller email verification storage is not initialized on this deployment (fail closed)"
    );
  }
}

// End of seller-email-verification.ts — Phase 2.3 / C2.7.

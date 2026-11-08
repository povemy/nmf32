import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { sealSecret } from "@/lib/secretbox";
import type { BankAccountPublic, BankAccountBody } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// ============================================================================
// /api/store/bank-accounts — seller PAYOUT DESTINATION records (PHASE 2.3,
// audit item C2.5). These rows back the MANUAL bank-transfer payout
// workflow (admin approves a payout request → operations transfer from the
// platform bank account → mark-paid): they are NOT PSP tokens. When the PSP
// decision lands (Curlec Route linked accounts is the recommended path per
// the Phase 2.3 PSP research), bank details should migrate to
// provider-managed onboarding — NOMOFEE would then STOP storing account
// numbers entirely (see docs/phase23/seller-verification.md).
//
// CRYPTO PATH (src/lib/secretbox.ts — AES-256-GCM secretbox):
//   • POST seals the FULL account number: accountNumberEnc = sealSecret(...).
//     Production fails closed (503 SECRETBOX_NOT_CONFIGURED) without
//     IMPORT_TOKEN_ENC_KEY; dev falls back to the documented derived key.
//   • accountNumberMasked = "••••" + last4 is the ONLY number form any read
//     surface returns — GET/POST responses expose masked fields ONLY
//     (never the ciphertext, never the full number).
//   • DECRYPTION (openSecret) is deliberately NOT wired to any route today:
//     no admin view displays full bank details, and the manual payout
//     workflow has the operator read the number from the PSP/bank side.
//     When the manual payout execution view needs it, openSecret belongs in
//     THAT admin-only route (payouts.manage cap), never in a GET list.
//   • KEY ROTATION: single version-tagged key — see the rotation contract in
//     secretbox.ts (decrypt+re-encrypt under a maintenance freeze).
//   • LEGACY ROWS created before this change store accountNumberEnc =
//     "enc:<last4>" (a masked tail, not a ciphertext). openSecret fails them
//     gracefully (tamper → null); they cannot be recovered — the seller must
//     re-enter the account number. NO data migration is performed.
// ============================================================================

/** Masked-display projection — the ONLY bank-account shape ever returned. */
const BANK_ACCOUNT_PUBLIC_SELECT = {
  id: true,
  holderName: true,
  bankName: true,
  accountNumberMasked: true,
  verified: true,
  createdAt: true,
} as const;

// GET /api/store/bank-accounts — masked payout destinations for this seller.
export const GET = handle(async () => {
  const { me } = await requireActiveSellerStore();
  const accounts = await db.bankAccount.findMany({
    where: { sellerId: me.id },
    orderBy: { createdAt: "desc" },
    // C2.5: masked fields only — accountNumberEnc (the ciphertext) and the
    // full number are NEVER part of a GET response.
    select: { ...BANK_ACCOUNT_PUBLIC_SELECT },
  });
  const payload: BankAccountPublic[] = accounts.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }));
  return ok(payload);
});

// POST /api/store/bank-accounts {holderName, bankName, accountNumber}
export const POST = handle(async (req: Request) => {
  const { me } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as BankAccountBody;

  const holderName = String(body.holderName ?? "").trim();
  const bankName = String(body.bankName ?? "").trim();
  const accountNumber = String(body.accountNumber ?? "").trim();
  if (!holderName || !bankName || !accountNumber) {
    throw new ApiError(400, "VALIDATION", "holderName, bankName and accountNumber are required");
  }
  if (holderName.length > 100 || bankName.length > 100) {
    throw new ApiError(400, "VALIDATION", "holderName and bankName must be at most 100 characters");
  }
  // Digits 5–31: covers MY bank account numbers; strips spaces/dashes the
  // entry UI allows. Anything else (letters, short stubs, oversized input)
  // is rejected before it ever touches the secretbox.
  const clean = accountNumber.replace(/[\s-]+/g, "");
  if (!/^[0-9]{5,31}$/.test(clean)) {
    throw new ApiError(400, "VALIDATION", "accountNumber must be 5–31 digits");
  }

  const last4 = clean.slice(-4);
  // C2.5: the REAL secretbox — the full number is sealed (never stored or
  // logged in clear) and the masked tail is the display form. Throws 503
  // SECRETBOX_NOT_CONFIGURED in production without IMPORT_TOKEN_ENC_KEY
  // (fail closed — no plaintext fallback, no stub).
  const account = await db.bankAccount.create({
    data: {
      sellerId: me.id,
      holderName,
      bankName,
      accountNumberMasked: `••••${last4}`,
      accountNumberEnc: sealSecret(clean),
      verified: false,
    },
    // Same masked-only projection as GET — the create response must not leak
    // the ciphertext either.
    select: { ...BANK_ACCOUNT_PUBLIC_SELECT },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "bank.account.added",
    entityType: "bank_account",
    entityId: account.id,
    meta: { bankName, masked: account.accountNumberMasked },
  });

  const payload: BankAccountPublic = { ...account, createdAt: account.createdAt.toISOString() };
  return ok(payload, { status: 201 });
});

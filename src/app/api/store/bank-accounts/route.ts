import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/store/bank-accounts
export const GET = handle(async () => {
  const { me } = await requireActiveSellerStore();
  const accounts = await db.bankAccount.findMany({
    where: { sellerId: me.id },
    orderBy: { createdAt: "desc" },
  });
  return ok(accounts);
});

// POST /api/store/bank-accounts {holderName, bankName, accountNumber}
export const POST = handle(async (req: Request) => {
  const { me } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const holderName = String(body.holderName ?? "").trim();
  const bankName = String(body.bankName ?? "").trim();
  const accountNumber = String(body.accountNumber ?? "").trim();
  if (!holderName || !bankName || !accountNumber) {
    throw new ApiError(400, "VALIDATION", "holderName, bankName and accountNumber are required");
  }
  if (!/^[0-9]{4,}$/.test(accountNumber.replace(/\s+/g, ""))) {
    throw new ApiError(400, "VALIDATION", "accountNumber must be at least 4 digits");
  }

  const clean = accountNumber.replace(/\s+/g, "");
  const last4 = clean.slice(-4);
  const account = await db.bankAccount.create({
    data: {
      sellerId: me.id,
      holderName,
      bankName,
      accountNumberMasked: `****${last4}`,
      accountNumberEnc: `enc:${last4}`,
      verified: false,
    },
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

  return ok(account, { status: 201 });
});

import { db } from "@/lib/db";
import { handle, ok, ApiError, notify } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { refreshWalletCache, parseStatement } from "@/lib/ledger";
import { parseMaybeJson } from "@/app/api/admin/_helpers";

export const dynamic = "force-dynamic";

// GET /api/store/payouts — payout history for the seller's wallet.
export const GET = handle(async () => {
  const { me } = await requireActiveSellerStore();
  const wallet = await db.wallet.findUnique({ where: { sellerId: me.id } });
  const payouts = wallet
    ? await db.payout.findMany({
        where: { walletId: wallet.id },
        include: { batch: { select: { id: true, runType: true, status: true } } },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    : [];
  return ok(payouts.map((p) => ({ ...p, statement: parseStatement(p.statementJson) })));
});

// POST /api/store/payouts { amountMinor } — seller-initiated payout request.
// Creates a Payout row with status "requested" + method "seller_request".
// NO ledger movement yet: T3 (money leaves the available balance) posts when
// an admin APPROVES the request, T4/T4f when the transfer confirms/fails —
// the exact same pipeline a platform payout batch uses.
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();

  const body = (await req.json().catch(() => ({}))) as { amountMinor?: unknown; amount?: unknown };
  const amountMinor = Number(
    body.amountMinor ?? (typeof body.amount === "string" || typeof body.amount === "number" ? Math.round(Number(body.amount) * 100) : NaN)
  );
  if (!Number.isFinite(amountMinor) || amountMinor <= 0 || !Number.isInteger(amountMinor)) {
    throw new ApiError(400, "BAD_AMOUNT", "Enter a valid payout amount");
  }

  const wallet = await db.wallet.findUnique({ where: { sellerId: me.id } });
  if (!wallet) throw new ApiError(404, "NOT_FOUND", "Wallet not found");

  // One open request at a time — keeps the admin queue and the wallet math simple.
  const openRequest = await db.payout.findFirst({ where: { walletId: wallet.id, status: "requested" } });
  if (openRequest) {
    throw new ApiError(409, "REQUEST_PENDING", `You already have payout request ${openRequest.referenceNo} awaiting approval`);
  }

  // Ledger truth (not the cache) decides what can be requested.
  const truth = await refreshWalletCache(wallet.id);

  const minSetting = await db.setting.findUnique({ where: { key: "payout.min_minor" } });
  const minMinor = parseMaybeJson<number>(minSetting?.valueJson, 1000);

  if (amountMinor < minMinor) {
    throw new ApiError(400, "BELOW_MINIMUM", `Minimum payout is ${(minMinor / 100).toFixed(2)} MYR`);
  }
  if (amountMinor > truth.availableMinor) {
    throw new ApiError(400, "INSUFFICIENT_BALANCE", `Available balance is ${(truth.availableMinor / 100).toFixed(2)} MYR`);
  }

  // Payouts need somewhere to land — any bank account on file (verified preferred).
  const bank = await db.bankAccount.findFirst({
    where: { sellerId: me.id },
    orderBy: [{ verified: "desc" }, { createdAt: "desc" }],
  });
  if (!bank) {
    throw new ApiError(400, "NO_BANK_ACCOUNT", "Add a bank account in Wallet & Payouts before requesting a payout");
  }

  const counter = await db.counter.upsert({
    where: { key: "payout_number" },
    create: { key: "payout_number", value: 100002 },
    update: { value: { increment: 1 } },
  });
  const referenceNo = `PO-${counter.value}`;

  const payout = await db.payout.create({
    data: {
      sellerId: me.id,
      walletId: wallet.id,
      referenceNo,
      amountMinor,
      status: "requested",
      method: "seller_request",
      bankAccountId: bank.id,
    },
  });

  await notify({
    event: "payout.requested",
    channel: "email",
    recipient: "ops@nomofee.io",
    subject: `Seller payout request ${referenceNo} — ${(amountMinor / 100).toFixed(2)} MYR`,
  });
  await notify({
    event: "payout.requested",
    channel: "email",
    recipient: me.email,
    subject: `Payout request ${referenceNo} received`,
  });

  return ok({
    payout,
    message: `Request ${referenceNo} submitted — funds stay in your available balance until NOMOFEE approves and transfers.`,
    storeName: store.name,
  });
});

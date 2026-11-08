import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handle, ok, ApiError, notify } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { walletTruth, refreshWalletCache, parseStatement } from "@/lib/ledger";
import { parseMaybeJson } from "@/app/api/admin/_helpers";
import type { SellerPayoutWithStatement, SellerPayoutRequestBody, SellerPayoutRequestData, SellerPayoutRow } from "@/lib/types/api-contract";

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
  const rows: SellerPayoutWithStatement[] = payouts.map((p) => ({
    ...p,
    paidAt: p.paidAt ? p.paidAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    statement: parseStatement(p.statementJson),
  }));
  return ok(rows);
});

// POST /api/store/payouts { amountMinor } — seller-initiated payout request.
// Creates a Payout row with status "requested" + method "seller_request".
// NO ledger movement yet: T3 (money leaves the available balance) posts when
// an admin APPROVES the request, T4/T4f when the transfer confirms/fails —
// the exact same pipeline a platform payout batch uses.
//
// FIN-2a RACE-SAFE "ONE OPEN REQUEST": the old findFirst-then-create had a
// TOCTOU window — two concurrent submits both saw no open request and both
// created one. Now the open-request check, the balance re-check, the counter
// upsert and the create all run inside ONE Serializable interactive
// transaction (Postgres serializes the snapshot → the loser retries on P2034,
// bounded at 3 attempts). Prisma cannot express a partial unique index, so
// this bounded Serializable tx IS the enforcement mechanism.
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();

  const body = (await req.json().catch(() => ({}))) as SellerPayoutRequestBody;
  const amountMinor = Number(
    body.amountMinor ?? (typeof body.amount === "string" || typeof body.amount === "number" ? Math.round(Number(body.amount) * 100) : NaN)
  );
  if (!Number.isFinite(amountMinor) || amountMinor <= 0 || !Number.isInteger(amountMinor)) {
    throw new ApiError(400, "BAD_AMOUNT", "Enter a valid payout amount");
  }

  const wallet = await db.wallet.findUnique({ where: { sellerId: me.id } });
  if (!wallet) throw new ApiError(404, "NOT_FOUND", "Wallet not found");

  // Amount-vs-setting and bank-account checks don't race — keep them outside
  // the Serializable tx so the critical section stays as short as possible.
  const minSetting = await db.setting.findUnique({ where: { key: "payout.min_minor" } });
  const minMinor = parseMaybeJson<number>(minSetting?.valueJson, 1000);

  if (amountMinor < minMinor) {
    throw new ApiError(400, "BELOW_MINIMUM", `Minimum payout is ${(minMinor / 100).toFixed(2)} MYR`);
  }

  // Payouts need somewhere to land — any bank account on file (verified preferred).
  const bank = await db.bankAccount.findFirst({
    where: { sellerId: me.id },
    orderBy: [{ verified: "desc" }, { createdAt: "desc" }],
  });
  if (!bank) {
    throw new ApiError(400, "NO_BANK_ACCOUNT", "Add a bank account in Wallet & Payouts before requesting a payout");
  }

  // Serializable create with bounded retry (P2034 = serialization conflict).
  const MAX_ATTEMPTS = 3;
  let payout: Awaited<ReturnType<typeof createPayoutRequestTx>> | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      payout = await createPayoutRequestTx({ walletId: wallet.id, sellerId: me.id, bankId: bank.id, amountMinor });
      break;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") {
        if (attempt < MAX_ATTEMPTS) continue; // concurrent writer — retry bounded
        throw new ApiError(409, "CONFLICT", "Payout request could not be created due to concurrent activity — try again");
      }
      throw e;
    }
  }
  if (!payout) {
    throw new ApiError(409, "CONFLICT", "Payout request could not be created due to concurrent activity — try again");
  }

  // F1 — post-commit wallet-cache refresh (best-effort, display-only value;
  // a failure leaves benign staleness that the next wallet event/read heals).
  try {
    await refreshWalletCache(wallet.id);
  } catch (e) {
    console.error(`[wallet-cache] post-commit refresh failed for ${wallet.id} (benign, self-heals):`, e instanceof Error ? e.message : e);
  }

  await notify({
    event: "payout.requested",
    channel: "email",
    recipient: "ops@nomofee.io",
    subject: `Seller payout request ${payout.referenceNo} — ${(amountMinor / 100).toFixed(2)} MYR`,
    // FIN-2b notify dedupKey: stable per-payout key so retries can't multiply
    // this email. Recipient-scoped — a shared key would dedup ACROSS
    // recipients via the (channel, dedupKey) unique and silence the seller copy.
    dedupKey: `payout.requested:${payout.id}:ops`,
  });
  await notify({
    event: "payout.requested",
    channel: "email",
    recipient: me.email,
    subject: `Payout request ${payout.referenceNo} received`,
    dedupKey: `payout.requested:${payout.id}:seller`,
  });

  const payoutRow: SellerPayoutRow = {
    ...payout,
    paidAt: payout.paidAt ? payout.paidAt.toISOString() : null,
    createdAt: payout.createdAt.toISOString(),
    updatedAt: payout.updatedAt.toISOString(),
  };
  const payload: SellerPayoutRequestData = {
    payout: payoutRow,
    message: `Request ${payout.referenceNo} submitted — funds stay in your available balance until NOMOFEE approves and transfers.`,
    storeName: store.name,
  };
  return ok(payload);
});

/** The Serializable critical section: open-request check → balance truth →
 *  counter → create. Everything the race could corrupt lives in here. */
async function createPayoutRequestTx(input: { walletId: string; sellerId: string; bankId: string; amountMinor: number }) {
  return db.$transaction(
    async (tx) => {
      // One open request at a time — keeps the admin queue and the wallet math
      // simple. Serializable isolation makes this check-then-create atomic.
      const openRequest = await tx.payout.findFirst({ where: { walletId: input.walletId, status: "requested" } });
      if (openRequest) {
        throw new ApiError(409, "REQUEST_PENDING", `You already have payout request ${openRequest.referenceNo} awaiting approval`);
      }

      // Ledger truth (not the cache) decides what can be requested — read
      // transactionally for a consistent Serializable snapshot. The CACHE
      // WRITE is deferred to post-commit (F1): keeping the wallet-row UPDATE
      // out of this Serializable critical section removes it from the
      // conflict domain (measured hot-row epicenter in payment storms),
      // while authorization stays exact — it uses the freshly computed truth,
      // never the cache.
      const truth = await walletTruth(input.walletId, tx);
      if (input.amountMinor > truth.availableMinor) {
        throw new ApiError(400, "INSUFFICIENT_BALANCE", `Available balance is ${(truth.availableMinor / 100).toFixed(2)} MYR`);
      }

      const counter = await tx.counter.upsert({
        where: { key: "payout_number" },
        create: { key: "payout_number", value: 100002 },
        update: { value: { increment: 1 } },
      });
      const referenceNo = `PO-${counter.value}`;

      return tx.payout.create({
        data: {
          sellerId: input.sellerId,
          walletId: input.walletId,
          referenceNo,
          amountMinor: input.amountMinor,
          status: "requested",
          method: "seller_request",
          bankAccountId: input.bankId,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );
}

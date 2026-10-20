import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postPayoutConfirmed } from "@/lib/ledger";
import { assertTransition } from "@/lib/payout-state";
import { rateLimit } from "@/lib/ratelimit";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/mark-paid {referenceNo} — T4 (RBAC payouts.manage)
//
// FIN-2a ATOMIC CLAIM PATTERN: the conditional updateMany (processing → paid)
// inside the tx is the concurrency guard — a second concurrent mark-paid (or a
// racing PSP webhook doing the same transition) matches 0 rows and gets a 409
// instead of double-posting T4. The FIN-1 dedupKey on T4
// (`payout_confirmed:payout:{id}`) backstops ledger-level exactly-once.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const rl = rateLimit(req, { limit: 20, windowMs: 60000 });
  if (!rl.ok) throw new ApiError(429, "RATE_LIMITED", "Too many requests, retry later");

  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);
  const referenceNo = reqStr(body, "referenceNo", "referenceNo (bank transfer reference)");

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  // Readable fast-fail (stale read) — the updateMany claim below is the real guard.
  assertTransition(payout.status, "paid");

  const seller = await db.seller.findUnique({ where: { id: payout.sellerId } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  const txn = await db.$transaction(async (tx) => {
    // CLAIM — atomic race guard before any ledger movement.
    const claim = await tx.payout.updateMany({
      where: { id, status: "processing" },
      data: { status: "paid" },
    });
    if (claim.count === 0) {
      throw new ApiError(409, "CONFLICT", "Payout is not in processing state (or already claimed)");
    }
    // T4 — DR PAYOUT_CLEARING | CR BANK_MAIN (clearing settles to bank).
    const t = await postPayoutConfirmed({
      walletId: payout.walletId,
      payoutId: payout.id,
      referenceNo: payout.referenceNo,
      amountMinor: payout.amountMinor,
      tx,
    });
    // Remaining fields — same tx so paidAt/providerRef commit with the claim + T4.
    await tx.payout.update({
      where: { id },
      data: { paidAt: new Date(), providerRef: referenceNo },
    });
    return t;
  });

  // FIN-3b (3b.1) — dedupKey pattern (see approve route): stable
  // `{event}.{channel}:{payoutId}` keys so webhook/ops replays converge on the
  // first delivered copy. Inapp subject mirrors the email wording.
  await notify({
    event: "payout.paid",
    channel: "email",
    recipient: seller.email,
    subject: `Payout ${payout.referenceNo} on the way`,
    dedupKey: `payout.paid.email:${payout.id}`,
  });
  await notify({
    event: "payout.paid",
    channel: "inapp",
    recipient: seller.email,
    subject: `Payout ${payout.referenceNo} on the way`,
    dedupKey: `payout.paid.inapp:${payout.id}`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.mark_paid",
    entityType: "payout",
    entityId: id,
    before: { status: payout.status, referenceNo: payout.referenceNo, amountMinor: payout.amountMinor },
    after: { status: "paid", providerRef: referenceNo, txnId: txn.id },
  });

  const updated = await db.payout.findUnique({ where: { id } });
  if (!updated) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  return ok(updated);
});

import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postPayoutFailed } from "@/lib/ledger";
import { assertTransition } from "@/lib/payout-state";
import { rateLimit } from "@/lib/ratelimit";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/fail {reason} — T4f reversal (RBAC payouts.manage)
//
// FIN-2a ATOMIC CLAIM PATTERN: the conditional updateMany (processing → failed)
// inside the tx is the concurrency guard — a racing fail/mark-paid/webhook
// matches 0 rows and gets a 409 instead of double-posting T4f. The FIN-1
// dedupKey on T4f (`payout_failed:payout:{id}`) backstops ledger-level
// exactly-once.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const rl = rateLimit(req, { limit: 20, windowMs: 60000 });
  if (!rl.ok) throw new ApiError(429, "RATE_LIMITED", "Too many requests, retry later");

  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);
  const reason = reqStr(body, "reason", "reason");

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  // Readable fast-fail (stale read) — the updateMany claim below is the real guard.
  assertTransition(payout.status, "failed");

  const seller = await db.seller.findUnique({ where: { id: payout.sellerId } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  const txn = await db.$transaction(async (tx) => {
    // CLAIM — atomic race guard before any ledger movement.
    const claim = await tx.payout.updateMany({
      where: { id, status: "processing" },
      data: { status: "failed" },
    });
    if (claim.count === 0) {
      throw new ApiError(409, "CONFLICT", "Payout is not in processing state (or already claimed)");
    }
    // T4f — reversal of T3: DR PAYOUT_CLEARING | CR SELLER:PAYABLE (money returns).
    const t = await postPayoutFailed({
      walletId: payout.walletId,
      payoutId: payout.id,
      referenceNo: payout.referenceNo,
      amountMinor: payout.amountMinor,
      reason,
      tx,
    });
    // Remaining fields — same tx so failReason commits with the claim + T4f.
    await tx.payout.update({
      where: { id },
      data: { failReason: reason },
    });
    return t;
  });

  await notify({
    event: "payout.failed",
    channel: "email",
    recipient: "ops@nomofee.io",
    subject: `Payout ${payout.referenceNo} failed`,
  });
  await notify({
    event: "payout.failed",
    channel: "email",
    recipient: seller.email,
    subject: `Payout ${payout.referenceNo} failed`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.fail",
    entityType: "payout",
    entityId: id,
    before: { status: payout.status, referenceNo: payout.referenceNo, amountMinor: payout.amountMinor },
    after: { status: "failed", reason, txnId: txn.id },
  });

  const updated = await db.payout.findUnique({ where: { id } });
  if (!updated) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  return ok(updated);
});

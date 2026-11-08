import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { refreshWalletCache } from "@/lib/ledger";
import { assertTransition } from "@/lib/payout-state";
import { rateLimit } from "@/lib/ratelimit";
import { readBody, reqStr, type Body } from "@/app/api/admin/_helpers";
import type { AdminPayoutRejectBody, AdminPayoutRow } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/reject {reason} — seller payout request → rejected.
// No ledger movement: a request never moved money (T3 posts at approve time),
// so rejection simply releases the request and the balance stays available.
//
// FIN-2a ATOMIC CLAIM PATTERN: the conditional updateMany (requested → rejected)
// is the concurrency guard — a losing concurrent reject/approve matches 0 rows
// and gets a 409 instead of double-transitioning the payout.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const rl = rateLimit(req, { limit: 20, windowMs: 60000 });
  if (!rl.ok) throw new ApiError(429, "RATE_LIMITED", "Too many requests, retry later");

  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;
  const body = (await readBody(req)) as Body & AdminPayoutRejectBody;
  const reason = reqStr(body, "reason", "reason");

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  // Readable fast-fail (stale read) — the updateMany claim below is the real guard.
  assertTransition(payout.status, "rejected");

  // PHASE 2.3 select hygiene (C2.7): only seller.email is used — explicit
  // select keeps the un-migrated Seller.emailVerifiedAt out of the query.
  const seller = await db.seller.findUnique({ where: { id: payout.sellerId }, select: { email: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  // Keep ledger truth fresh so the wallet page immediately shows the released balance.
  await refreshWalletCache(payout.walletId);

  await db.$transaction(async (tx) => {
    // CLAIM — atomic guard (no money moves here, but the transition itself must
    // stay exactly-once even under concurrent approve/reject).
    const claim = await tx.payout.updateMany({
      where: { id, status: "requested" },
      data: { status: "rejected" },
    });
    if (claim.count === 0) {
      throw new ApiError(409, "CONFLICT", "Payout is not in requested state (or already claimed)");
    }
    // Remaining fields — same tx so reason and status commit together.
    await tx.payout.update({ where: { id }, data: { failReason: reason } });
  });

  // FIN-3b (3b.1) — dedupKey pattern (see approve route): stable
  // `{event}.{channel}:{payoutId}` keys; rejection replays stay single-delivery.
  await notify({
    event: "payout.rejected",
    channel: "email",
    recipient: seller.email,
    subject: `Payout request ${payout.referenceNo} not approved`,
    dedupKey: `payout.rejected.email:${payout.id}`,
  });
  await notify({
    event: "payout.rejected",
    channel: "inapp",
    recipient: seller.email,
    subject: `Payout request ${payout.referenceNo} not approved`,
    dedupKey: `payout.rejected.inapp:${payout.id}`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.request.reject",
    entityType: "payout",
    entityId: id,
    before: { status: payout.status, amountMinor: payout.amountMinor },
    after: { status: "rejected", reason },
  });

  const updated = await db.payout.findUnique({ where: { id } });
  if (!updated) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  const payload: AdminPayoutRow = {
    ...updated,
    paidAt: updated.paidAt ? updated.paidAt.toISOString() : null,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
  return ok(payload);
});

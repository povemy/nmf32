import { NextRequest } from "next/server";
import { Prisma, type Payout } from "@prisma/client";
import { handle, ok, ApiError, auditAdmin, logActivity } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { refreshWalletCache, postPayoutInitiated, buildLedgerStatementFromLedger, walletTruth } from "@/lib/ledger";
import { rateLimit } from "@/lib/ratelimit";
import { parseMaybeJson, readBody, optBool, daysAgo } from "@/app/api/admin/_helpers";
import type {
  AdminPayoutBatchData,
  AdminPayoutBatchRunBody,
  AdminPayoutBatchRunDryRunData,
  AdminPayoutBatchRunExecutedData,
  AdminPayoutRow,
} from "@/lib/types/api-contract";

/** Payout row → contract AdminPayoutRow (Date fields → ISO strings; identical JSON). */
const payoutRow = (p: Payout): AdminPayoutRow => ({
  ...p,
  paidAt: p.paidAt ? p.paidAt.toISOString() : null,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

// GET /api/admin/payout-batches
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const batches = await db.payoutBatch.findMany({
    include: { payouts: { orderBy: { createdAt: "asc" } } },
    orderBy: { startedAt: "desc" },
  });

  // seller info resolved manually (no relation declared on Payout)
  const sellerIds = [...new Set(batches.flatMap((b) => b.payouts.map((p) => p.sellerId)))];
  const sellers = sellerIds.length
    ? await db.seller.findMany({
        where: { id: { in: sellerIds } },
        select: { id: true, email: true, displayName: true, store: { select: { name: true } } },
      })
    : [];
  const sMap = new Map(sellers.map((s) => [s.id, s]));

  const data: AdminPayoutBatchData[] = batches.map((b) => ({
    ...b,
    startedAt: b.startedAt.toISOString(),
    finishedAt: b.finishedAt ? b.finishedAt.toISOString() : null,
    payouts: b.payouts.map((p) => {
      const s = sMap.get(p.sellerId);
      return {
        ...payoutRow(p),
        sellerName: s?.store?.name ?? s?.displayName ?? null,
        sellerEmail: s?.email ?? null,
      };
    }),
  }));
  return ok(data);
});

// POST /api/admin/payout-batches {dryRun?: boolean} — run a payout batch (RBAC payouts.manage)
//
// FIN-2a ATOMIC CLAIM PATTERN, per payout: each payout row is created in the
// pre-claim state ("requested") and claimed to "processing" with a conditional
// updateMany INSIDE its own Serializable $transaction that also re-verifies the
// wallet balance and posts T3. Payouts that lose the claim or no longer have
// sufficient balance are skipped + logged (activity row) — never half-processed.
// Per-payout transactions (NOT one giant tx): one bad wallet can't abort the
// whole batch, and the batch summary is recomputed AFTER the claims so
// totalMinor/payoutCount only ever count payouts whose money actually moved.
export const POST = handle(async (req: NextRequest) => {
  const rl = rateLimit(req, { limit: 20, windowMs: 60000 });
  if (!rl.ok) throw new ApiError(429, "RATE_LIMITED", "Too many requests, retry later");

  const admin = await requireCap("payouts.manage");
  const body = (await readBody(req).catch(() => ({}) as Record<string, never>)) as AdminPayoutBatchRunBody;
  const dryRun = optBool(body as Record<string, unknown>, "dryRun") ?? false;

  // settings
  const [minSetting, modeSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: "payout.min_minor" } }),
    db.setting.findUnique({ where: { key: "payout.mode" } }),
  ]);
  const minMinor = parseMaybeJson<number>(minSetting?.valueJson, 1000);
  const mode = parseMaybeJson<string>(modeSetting?.valueJson, "manual_csv");

  // refresh all wallet caches from ledger truth
  const wallets = await db.wallet.findMany({
    include: {
      seller: { select: { id: true, email: true, displayName: true, store: { select: { id: true, name: true } }, bankAccounts: true } },
    },
  });
  const refreshed: Array<(typeof wallets)[number] & { truth: Awaited<ReturnType<typeof refreshWalletCache>> }> = [];
  for (const w of wallets) {
    const truth = await refreshWalletCache(w.id);
    refreshed.push({ ...w, truth });
  }

  // Seller payout requests: money already promised via status "requested" rows
  // (no T3 posted yet, so still ledger-"available"). A batch sweep must NOT
  // double-pay those wallets — skip them until the request is approved or rejected.
  const openRequestWalletIds = new Set(
    (await db.payout.findMany({
      where: { status: "requested", method: "seller_request" },
      select: { walletId: true },
    })).map((r) => r.walletId)
  );
  const skipped: AdminPayoutBatchRunDryRunData["skipped"] = refreshed
    .filter((w) => openRequestWalletIds.has(w.id))
    .map((w) => {
      const bank = w.seller.bankAccounts.find((b) => b.verified) ?? w.seller.bankAccounts[0] ?? null;
      return {
        walletId: w.id,
        sellerName: w.seller.displayName,
        storeName: w.seller.store?.name ?? null,
        availableMinor: w.truth.availableMinor,
        reason: "Payout request pending — approve/reject it in Seller requests first",
        bank: bank ? { id: bank.id, bankName: bank.bankName, holderName: bank.holderName, accountNumberMasked: bank.accountNumberMasked, verified: bank.verified } : null,
      };
    });

  const eligible = refreshed.filter((w) => w.truth.availableMinor >= minMinor && !openRequestWalletIds.has(w.id));

  const preview: AdminPayoutBatchRunDryRunData["eligible"] = eligible.map((w) => {
    const bank = w.seller.bankAccounts.find((b) => b.verified) ?? w.seller.bankAccounts[0] ?? null;
    return {
      walletId: w.id,
      sellerId: w.seller.id,
      sellerName: w.seller.displayName,
      storeName: w.seller.store?.name ?? null,
      availableMinor: w.truth.availableMinor,
      bank: bank ? { id: bank.id, bankName: bank.bankName, holderName: bank.holderName, accountNumberMasked: bank.accountNumberMasked, verified: bank.verified } : null,
    };
  });

  if (dryRun) {
    const payload: AdminPayoutBatchRunDryRunData = {
      dryRun: true,
      minMinor,
      mode,
      eligibleCount: preview.length,
      eligibleTotalMinor: preview.reduce((s, e) => s + e.availableMinor, 0),
      eligible: preview,
      skipped,
    };
    return ok(payload);
  }

  if (preview.length === 0) {
    throw new ApiError(
      409,
      "NO_ELIGIBLE_WALLETS",
      skipped.length > 0
        ? `No eligible wallet meets the minimum of ${minMinor} minor units — ${skipped.length} wallet${skipped.length === 1 ? "" : "s"} skipped because a seller payout request is pending`
        : `No wallet meets the minimum payout of ${minMinor} minor units`
    );
  }

  // create batch (summary recomputed after the per-payout claims)
  const batch = await db.payoutBatch.create({
    data: { runType: "manual", status: "running", currency: "MYR", totalMinor: 0, payoutCount: 0 },
  });

  const createdPayouts: Payout[] = [];
  for (const w of eligible) {
    const bank = w.seller.bankAccounts.find((b) => b.verified) ?? w.seller.bankAccounts[0] ?? null;

    // Statement period: since the seller's previous PAID payout (fallback:
    // wallet creation). Every number is aggregated from ledger lines in that
    // window — INTEGRITY RULE: statements never contain decorated numbers.
    // Built OUTSIDE the per-payout tx (ledger aggregate reads, derived snapshot).
    const prevPaid = await db.payout.findFirst({
      where: { walletId: w.id, status: "paid" },
      orderBy: { paidAt: "desc" },
      select: { paidAt: true },
    });
    const walletRow = await db.wallet.findUnique({ where: { id: w.id }, select: { createdAt: true } });
    const periodFrom = prevPaid?.paidAt ?? walletRow?.createdAt ?? daysAgo(30);
    const periodTo = new Date();
    // Defensive clamp — a period that starts after it ends yields empty (and
    // misleading) statements.
    const periodFromSafe = periodFrom > periodTo ? daysAgo(30) : periodFrom;
    const orderCount = await db.order.count({
      where: { storeId: w.seller.store?.id, paidAt: { not: null, gte: periodFromSafe, lte: periodTo } },
    });
    const statementJson = await buildLedgerStatementFromLedger({
      walletId: w.id,
      sellerName: w.seller.store?.name ?? w.seller.displayName,
      payoutAmountMinor: w.truth.availableMinor,
      orderCount,
      periodFrom: periodFromSafe,
      periodTo,
    });

    // Per-payout Serializable transaction with bounded retry (P2034).
    let created: Payout | null = null;
    let skipReason: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        created = await db.$transaction(
          async (tx) => {
            const counter = await tx.counter.upsert({
              where: { key: "payout_number" },
              create: { key: "payout_number", value: 100002 },
              update: { value: { increment: 1 } },
            });
            const referenceNo = `PO-${counter.value}`;

            // Born in the pre-claim state — claimed to processing below.
            const row = await tx.payout.create({
              data: {
                batchId: batch.id,
                sellerId: w.seller.id,
                walletId: w.id,
                referenceNo,
                amountMinor: w.truth.availableMinor,
                status: "requested",
                method: mode,
                bankAccountId: bank?.id ?? null,
                statementJson,
              },
            });

            // CLAIM — conditional update is the atomic race guard (same pattern
            // as the approve route). If anything concurrently transitioned this
            // row, the claim matches 0 rows and the payout is skipped.
            const claim = await tx.payout.updateMany({
              where: { id: row.id, status: "requested" },
              data: { status: "processing" },
            });
            if (claim.count === 0) {
              throw new ApiError(409, "CONFLICT", "Payout claim lost — another process transitioned it");
            }

            // Balance re-verify INSIDE the tx (Serializable snapshot): a
            // concurrent batch/refund may have moved the balance since preview.
            // F1: truth READ transactional; cache WRITE deferred to post-commit.
            const truth = await walletTruth(w.id, tx);
            if (truth.availableMinor < row.amountMinor) {
              throw new ApiError(
                409,
                "INSUFFICIENT_BALANCE",
                `Available balance (${(truth.availableMinor / 100).toFixed(2)} MYR) no longer covers the payout (${(row.amountMinor / 100).toFixed(2)} MYR) — wallet skipped`
              );
            }

            await postPayoutInitiated({
              walletId: w.id,
              payoutId: row.id,
              referenceNo,
              amountMinor: row.amountMinor,
              tx,
              refreshCache: false, // post-commit below (F1)
            });
            return row;
          },
          { isolationLevel: "Serializable" }
        );
        break;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") {
          if (attempt < 3) continue; // concurrent writer — bounded retry
          skipReason = "Serialization conflict after 3 attempts — wallet skipped";
          break;
        }
        skipReason = e instanceof ApiError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }

    if (!created) {
      // SKIP + LOG — the wallet keeps its balance; nothing half-processed.
      await logActivity({
        actorType: "system",
        action: "payout.batch.skip",
        entityType: "wallet",
        entityId: w.id,
        meta: { walletId: w.id, sellerId: w.seller.id, batchId: batch.id, reason: skipReason },
      });
      continue;
    }
    // F1 — post-commit wallet-cache refresh (best-effort, display-only value).
    try {
      await refreshWalletCache(w.id);
    } catch (e) {
      console.error(`[wallet-cache] post-commit refresh failed for ${w.id} (benign, self-heals):`, e instanceof Error ? e.message : e);
    }
    createdPayouts.push(created);
  }

  // Summary math recomputed AFTER the claims — only claimed payouts count.
  const totalMinor = createdPayouts.reduce((s, p) => s + p.amountMinor, 0);
  const finished = await db.payoutBatch.update({
    where: { id: batch.id },
    data: { status: "completed", totalMinor, payoutCount: createdPayouts.length, finishedAt: new Date() },
    include: { payouts: true },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.batch.run",
    entityType: "payout_batch",
    entityId: batch.id,
    before: null,
    after: {
      batchId: batch.id,
      payoutCount: createdPayouts.length,
      totalMinor,
      minMinor,
      mode,
      wallets: createdPayouts.map((p) => ({ referenceNo: p.referenceNo, amountMinor: p.amountMinor, sellerId: p.sellerId })),
    },
  });

  const payload: AdminPayoutBatchRunExecutedData = {
    batch: {
      ...finished,
      startedAt: finished.startedAt.toISOString(),
      finishedAt: finished.finishedAt ? finished.finishedAt.toISOString() : null,
      payouts: finished.payouts.map(payoutRow),
    },
    payouts: createdPayouts.map(payoutRow),
  };
  return ok(payload);
});

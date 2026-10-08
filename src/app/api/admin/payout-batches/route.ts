import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { refreshWalletCache, postPayoutInitiated, buildPayoutStatement } from "@/lib/ledger";
import { parseMaybeJson, readBody, optBool, daysAgo } from "@/app/api/admin/_helpers";

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

  const data = batches.map((b) => ({
    ...b,
    payouts: b.payouts.map((p) => {
      const s = sMap.get(p.sellerId);
      return { ...p, sellerName: s?.store?.name ?? s?.displayName ?? null, sellerEmail: s?.email ?? null };
    }),
  }));
  return ok(data);
});

// POST /api/admin/payout-batches {dryRun?: boolean} — run a payout batch (RBAC payouts.manage)
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("payouts.manage");
  const body = await readBody(req).catch(() => ({}) as Record<string, never>);
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
  const refreshed = [];
  for (const w of wallets) {
    const truth = await refreshWalletCache(w.id);
    refreshed.push({ ...w, truth });
  }

  const eligible = refreshed.filter((w) => w.truth.availableMinor >= minMinor);

  const preview = eligible.map((w) => {
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
    return ok({ dryRun: true, minMinor, mode, eligibleCount: preview.length, eligibleTotalMinor: preview.reduce((s, e) => s + e.availableMinor, 0), eligible: preview });
  }

  if (preview.length === 0) {
    throw new ApiError(409, "NO_ELIGIBLE_WALLETS", `No wallet meets the minimum payout of ${minMinor} minor units`);
  }

  // create batch + payouts (processing) + T3 per wallet
  const batch = await db.payoutBatch.create({
    data: { runType: "manual", status: "running", currency: "MYR", totalMinor: 0, payoutCount: 0 },
  });

  const createdPayouts = [];
  for (const w of eligible) {
    const bank = w.seller.bankAccounts.find((b) => b.verified) ?? w.seller.bankAccounts[0] ?? null;
    const counter = await db.counter.upsert({
      where: { key: "payout_number" },
      create: { key: "payout_number", value: 100002 },
      update: { value: { increment: 1 } },
    });
    const referenceNo = `PO-${counter.value}`;

    const orderCount = await db.order.count({ where: { storeId: w.seller.store?.id, paidAt: { not: null } } });
    const statementJson = buildPayoutStatement({
      sellerName: w.seller.store?.name ?? w.seller.displayName,
      periodFrom: daysAgo(30),
      periodTo: new Date(),
      salesMinor: w.truth.lifetimeEarnedMinor + w.truth.lifetimeCommissionMinor,
      commissionMinor: w.truth.lifetimeCommissionMinor,
      refundsMinor: 0,
      adjustmentsMinor: 0,
      negativeCarryMinor: 0,
      orderCount,
    });

    const payout = await db.payout.create({
      data: {
        batchId: batch.id,
        sellerId: w.seller.id,
        walletId: w.id,
        referenceNo,
        amountMinor: w.truth.availableMinor,
        status: "processing",
        method: mode,
        bankAccountId: bank?.id ?? null,
        statementJson,
      },
    });

    await postPayoutInitiated({ walletId: w.id, payoutId: payout.id, referenceNo, amountMinor: payout.amountMinor });
    createdPayouts.push(payout);
  }

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

  return ok({ batch: finished, payouts: createdPayouts });
});

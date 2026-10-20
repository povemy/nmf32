import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { refreshWalletCache } from "@/lib/ledger";
import { parseMaybeJson } from "@/app/api/admin/_helpers";

export const dynamic = "force-dynamic";

// GET /api/admin/payouts/due — who is owed money RIGHT NOW.
// This is the source of truth behind the dashboard "Payouts due" card: wallets
// are re-derived from the LEDGER (refreshWalletCache) exactly like a real
// batch run does, so this panel always matches what "Run payout batch" would
// sweep. The dashboard card and this page can never disagree again.
export const GET = handle(async (_req: NextRequest) => {
  await requireAdmin();

  const [minSetting, modeSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: "payout.min_minor" } }),
    db.setting.findUnique({ where: { key: "payout.mode" } }),
  ]);
  const minMinor = parseMaybeJson<number>(minSetting?.valueJson, 1000);
  const mode = parseMaybeJson<string>(modeSetting?.valueJson, "manual_csv");

  // refresh every wallet cache from ledger truth (same as POST payout-batches)
  const wallets = await db.wallet.findMany({
    include: {
      seller: {
        select: {
          id: true,
          email: true,
          displayName: true,
          store: { select: { id: true, name: true } },
          bankAccounts: { select: { id: true, bankName: true, holderName: true, accountNumberMasked: true, verified: true } },
        },
      },
    },
  });
  const refreshed: {
    w: (typeof wallets)[number];
    truth: Awaited<ReturnType<typeof refreshWalletCache>>;
  }[] = [];
  for (const w of wallets) {
    const truth = await refreshWalletCache(w.id);
    refreshed.push({ w, truth });
  }

  // last paid payout per wallet for the "last paid" column
  const lastPaid = await db.payout.findMany({
    where: { status: "paid" },
    orderBy: { paidAt: "desc" },
    select: { walletId: true, amountMinor: true, paidAt: true },
  });
  const lastPaidByWallet = new Map<string, { amountMinor: number; paidAt: Date }>();
  for (const p of lastPaid) {
    if (p.paidAt && !lastPaidByWallet.has(p.walletId)) lastPaidByWallet.set(p.walletId, { amountMinor: p.amountMinor, paidAt: p.paidAt });
  }

  // seller-initiated payout requests: still part of "available" (no T3 posted
  // yet) but already promised to the seller — surfaced per wallet so the
  // admin sees how much of the due total is committed.
  const requestedRows = await db.payout.findMany({
    where: { status: "requested", method: "seller_request" },
    select: { walletId: true, amountMinor: true, referenceNo: true },
  });
  const requestedByWallet = new Map<string, { amountMinor: number; referenceNo: string }>();
  for (const r of requestedRows) {
    const prev = requestedByWallet.get(r.walletId);
    requestedByWallet.set(r.walletId, {
      amountMinor: (prev?.amountMinor ?? 0) + r.amountMinor,
      referenceNo: prev ? `${prev.referenceNo}, ${r.referenceNo}` : r.referenceNo,
    });
  }

  const bankOf = (accounts: { id: string; bankName: string; holderName: string; accountNumberMasked: string; verified: boolean }[]) =>
    accounts.find((b) => b.verified) ?? accounts[0] ?? null;

  const due = refreshed
    .filter(({ truth }) => truth.availableMinor >= minMinor)
    .map(({ w, truth }) => {
      const bank = bankOf(w.seller.bankAccounts);
      const last = lastPaidByWallet.get(w.id) ?? null;
      const req = requestedByWallet.get(w.id) ?? null;
      return {
        walletId: w.id,
        sellerId: w.seller.id,
        sellerName: w.seller.displayName,
        storeName: w.seller.store?.name ?? null,
        availableMinor: truth.availableMinor,
        requestedMinor: req?.amountMinor ?? 0,
        requestedRef: req?.referenceNo ?? null,
        bank: bank
          ? { id: bank.id, bankName: bank.bankName, holderName: bank.holderName, accountNumberMasked: bank.accountNumberMasked, verified: bank.verified }
          : null,
        lastPayout: last ? { amountMinor: last.amountMinor, paidAt: last.paidAt.toISOString() } : null,
      };
    })
    .sort((a, b) => b.availableMinor - a.availableMinor);

  const pendingTotalMinor = refreshed.reduce((s, { truth }) => s + truth.pendingMinor, 0);
  const belowMin = refreshed.filter(({ truth }) => truth.availableMinor > 0 && truth.availableMinor < minMinor);
  const requestedTotalMinor = [...requestedByWallet.values()].reduce((s, r) => s + r.amountMinor, 0);

  return ok({
    minMinor,
    mode,
    asOf: new Date().toISOString(),
    dueTotalMinor: due.reduce((s, d) => s + d.availableMinor, 0),
    dueCount: due.length,
    due,
    requestedTotalMinor,
    pendingTotalMinor,
    belowMinCount: belowMin.length,
    belowMinTotalMinor: belowMin.reduce((s, { truth }) => s + truth.availableMinor, 0),
  });
});

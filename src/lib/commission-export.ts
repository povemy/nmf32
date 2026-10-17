// ============================================================================
// COMMISSION REPORTS / EXPORTS (FIN-08, Task 17-③) — aggregation + CSV.
// Everything is aggregated from LEDGER TRUTH (PLATFORM:REVENUE_COMMISSION
// lines + the matching seller payable credits), integer minor units only.
// ============================================================================
import { db } from "./db";
import { ACCOUNTS } from "./ledger";

export type ExportStoreRow = { walletId: string; storeName: string; orderCount: number; commissionMinor: number };
export type CommissionSnapshot = {
  periodFrom: string;
  periodTo: string;
  generatedAt: string;
  createdByEmail: string;
  summary: {
    commissionMinor: number;
    salesMinor: number;
    effectiveRatePct: number;
    orderCount: number;
    refundsReversalMinor: number;
  };
  weekly: { weekStart: string; commissionMinor: number; orderCount: number }[];
  stores: ExportStoreRow[];
};

type CommissionLine = {
  id: string;
  walletId: string | null;
  direction: string;
  amountMinor: number;
  txnId: string;
  txn: { txnType: string; occurredAt: Date };
};

async function fetchCommissionLines(periodFrom: Date, periodTo: Date): Promise<CommissionLine[]> {
  return db.ledgerLine.findMany({
    where: {
      accountCode: ACCOUNTS.revenueCommission(),
      txn: { occurredAt: { gte: periodFrom, lte: periodTo } },
    },
    select: { id: true, walletId: true, direction: true, amountMinor: true, txnId: true, txn: { select: { txnType: true, occurredAt: true } } },
    orderBy: { txnId: "asc" },
  });
}

/** Monday 00:00 (local) bucket start for a date. */
function mondayOf(d: Date): Date {
  const day = d.getDay(); // 0 Sun … 6 Sat
  const back = (day + 6) % 7; // days since Monday
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 0, 0, 0, 0);
  return m;
}

/** Aggregate commission for [periodFrom, periodTo] from ledger truth. */
export async function aggregateCommission(periodFrom: Date, periodTo: Date, createdByEmail: string): Promise<CommissionSnapshot> {
  const lines = await fetchCommissionLines(periodFrom, periodTo);
  const commissionAccount = ACCOUNTS.revenueCommission();

  let commissionMinor = 0;
  let refundsReversalMinor = 0;
  const orderTxnIds = new Set<string>();
  const byWallet = new Map<string, { commissionMinor: number; txnIds: Set<string> }>();
  const byWeek = new Map<string, { commissionMinor: number; txnIds: Set<string> }>();

  for (const l of lines) {
    if (l.direction === "credit") {
      if (l.txn.txnType !== "order_paid") continue; // only commission earned on paid orders
      commissionMinor += l.amountMinor;
      orderTxnIds.add(l.txnId);
      const w = l.walletId ?? "unknown";
      const wr = byWallet.get(w) ?? { commissionMinor: 0, txnIds: new Set<string>() };
      wr.commissionMinor += l.amountMinor;
      wr.txnIds.add(l.txnId);
      byWallet.set(w, wr);
      const wk = mondayOf(l.txn.occurredAt).toISOString().slice(0, 10);
      const kr = byWeek.get(wk) ?? { commissionMinor: 0, txnIds: new Set<string>() };
      kr.commissionMinor += l.amountMinor;
      kr.txnIds.add(l.txnId);
      byWeek.set(wk, kr);
    } else if (l.txn.txnType === "refund") {
      refundsReversalMinor += l.amountMinor;
    }
  }
  void commissionAccount;

  // Seller-net credits for the SAME order txns → gross sales + effective rate.
  const payableCredits = orderTxnIds.size
    ? await db.ledgerLine.findMany({
        where: { txnId: { in: [...orderTxnIds] }, accountCode: { startsWith: "SELLER:" }, direction: "credit" },
        select: { amountMinor: true },
      })
    : [];
  const sellerNetMinor = payableCredits.reduce((s, l) => s + l.amountMinor, 0);
  const salesMinor = sellerNetMinor + commissionMinor;
  const effectiveRatePct = salesMinor > 0 ? Math.round((commissionMinor / salesMinor) * 1000) / 10 : 0;

  // Store names for the top wallets.
  const walletIds = [...byWallet.keys()];
  const wallets = walletIds.length
    ? await db.wallet.findMany({
        where: { id: { in: walletIds } },
        select: { id: true, seller: { select: { store: { select: { name: true } }, displayName: true } } },
      })
    : [];
  const nameOf = new Map<string, string>(wallets.map((w) => [w.id, w.seller.store?.name ?? w.seller.displayName ?? "Unknown seller"]));

  const stores: ExportStoreRow[] = walletIds
    .map((id) => ({
      walletId: id,
      storeName: nameOf.get(id) ?? "Unknown seller",
      commissionMinor: byWallet.get(id)!.commissionMinor,
      orderCount: byWallet.get(id)!.txnIds.size,
    }))
    .sort((a, b) => b.commissionMinor - a.commissionMinor);

  const weekly = [...byWeek.entries()]
    .map(([weekStart, v]) => ({ weekStart, commissionMinor: v.commissionMinor, orderCount: v.txnIds.size }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  return {
    periodFrom: periodFrom.toISOString(),
    periodTo: periodTo.toISOString(),
    generatedAt: new Date().toISOString(),
    createdByEmail,
    summary: {
      commissionMinor,
      salesMinor,
      effectiveRatePct,
      orderCount: orderTxnIds.size,
      refundsReversalMinor,
    },
    weekly,
    stores,
  };
}

const csvEscape = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Deterministic CSV from a snapshot (used for both immediate download and
 *  later re-download, so the historical file never mutates). */
export function snapshotToCsv(s: CommissionSnapshot): string {
  const out: string[] = [];
  out.push("# NOMOFEE commission export (ledger-truth aggregate)");
  out.push(`# period,${s.periodFrom},${s.periodTo}`);
  out.push(`# generated,${s.generatedAt}`);
  out.push(`# total_commission_myr,${(s.summary.commissionMinor / 100).toFixed(2)}`);
  out.push(`# gross_sales_myr,${(s.summary.salesMinor / 100).toFixed(2)}`);
  out.push(`# effective_rate_pct,${s.summary.effectiveRatePct}`);
  out.push(`# paid_orders,${s.summary.orderCount}`);
  out.push(`# refund_commission_reversals_myr,${(s.summary.refundsReversalMinor / 100).toFixed(2)}`);
  out.push("");
  out.push("store,orders,commission_myr");
  for (const st of s.stores) out.push(`${csvEscape(st.storeName)},${st.orderCount},${(st.commissionMinor / 100).toFixed(2)}`);
  out.push("");
  out.push("week_start,orders,commission_myr");
  for (const w of s.weekly) out.push(`${w.weekStart},${w.orderCount},${(w.commissionMinor / 100).toFixed(2)}`);
  return out.join("\n") + "\n";
}

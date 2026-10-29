import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { aggregateCommission } from "@/lib/commission-export";
import { ACCOUNTS } from "@/lib/ledger";
import { PSP_SPLIT_CANDIDATES, PSP_SPLIT_SETTING_KEYS } from "@/lib/psp";
import { parseMaybeJson } from "@/app/api/admin/_helpers";

// GET /api/admin/commission/analytics?days=90 — ledger-truth commission
// analytics + recent exports + dormant PSP split-settlement scaffold state.
// F-26 (Phase 3): per-store commission money read — now `commission.manage`
// (superadmin | finance), matching the exports POST that creates the same
// data. Previously bare requireAdmin (moderator readable).
export const GET = handle(async (req: NextRequest) => {
  await requireCap("commission.manage");
  const url = new URL(req.url);
  const days = Math.min(730, Math.max(7, Number(url.searchParams.get("days") ?? 90) || 90));
  const periodTo = new Date();
  const periodFrom = new Date(periodTo.getTime() - days * 86_400_000);

  const snapshot = await aggregateCommission(periodFrom, periodTo, "analytics");

  // All-time commission (credits on paid orders − refund reversals).
  const allLines = await db.ledgerLine.findMany({
    where: { accountCode: ACCOUNTS.revenueCommission() },
    select: { direction: true, amountMinor: true, txn: { select: { txnType: true } } },
  });
  let allTimeCommissionMinor = 0;
  for (const l of allLines) {
    if (l.direction === "credit" && l.txn.txnType === "order_paid") allTimeCommissionMinor += l.amountMinor;
    else if (l.direction === "debit" && l.txn.txnType === "refund") allTimeCommissionMinor -= l.amountMinor;
  }

  // Recent exports history.
  const exports = await db.commissionExport.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { id: true, periodFrom: true, periodTo: true, totalMinor: true, orderCount: true, lineCount: true, format: true, createdByEmail: true, createdAt: true },
  });

  // Dormant PSP split-settlement scaffold state.
  const [autoSettleRow, providerRow, lastSettlement] = await Promise.all([
    db.setting.findUnique({ where: { key: PSP_SPLIT_SETTING_KEYS.autoSettle } }),
    db.setting.findUnique({ where: { key: PSP_SPLIT_SETTING_KEYS.provider } }),
    db.ledgerTransaction.findFirst({
      where: { txnType: "gateway_settlement" },
      orderBy: { occurredAt: "desc" },
      include: { lines: { select: { amountMinor: true, direction: true } } },
    }),
  ]);

  return ok({
    days,
    summary: {
      ...snapshot.summary,
      allTimeCommissionMinor,
    },
    weekly: snapshot.weekly,
    stores: snapshot.stores,
    exports,
    psp: {
      webhookPath: "/api/webhooks/payments/{provider}",
      candidates: PSP_SPLIT_CANDIDATES,
      autoSettle: parseMaybeJson<boolean>(autoSettleRow?.valueJson, false) ?? false,
      provider: parseMaybeJson<string>(providerRow?.valueJson, "mock") ?? "mock",
      lastSettlement: lastSettlement
        ? {
            description: lastSettlement.description,
            occurredAt: lastSettlement.occurredAt,
            amountMinor: lastSettlement.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0),
          }
        : null,
      note: "Dormant scaffold — with a licensed PSP the gateway webhook mirrors each split settlement into the ledger and wallet caches refresh automatically on release. Auto-settle stays OFF until a provider adapter is implemented.",
    },
  });
});

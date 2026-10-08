import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/ledger/accounts — accounts with summed debit/credit balances
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();

  const [accounts, grouped] = await Promise.all([
    db.ledgerAccount.findMany({ orderBy: { code: "asc" } }),
    db.ledgerLine.groupBy({
      by: ["accountCode"],
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
  ]);

  // split by direction for signed balances
  const lines = await db.ledgerLine.findMany({ select: { accountCode: true, direction: true, amountMinor: true } });
  const sums = new Map<string, { debit: number; credit: number }>();
  for (const l of lines) {
    const cur = sums.get(l.accountCode) ?? { debit: 0, credit: 0 };
    if (l.direction === "debit") cur.debit += l.amountMinor;
    else cur.credit += l.amountMinor;
    sums.set(l.accountCode, cur);
  }

  const meta = new Map(grouped.map((g) => [g.accountCode, { count: g._count._all }]));

  const data = accounts.map((a) => {
    const s = sums.get(a.code) ?? { debit: 0, credit: 0 };
    // asset accounts: debit-positive; liability/revenue: credit-positive
    const balanceMinor = a.type === "asset" ? s.debit - s.credit : s.credit - s.debit;
    return {
      code: a.code,
      name: a.name,
      type: a.type,
      walletId: a.walletId,
      debitMinor: s.debit,
      creditMinor: s.credit,
      balanceMinor,
      lineCount: meta.get(a.code)?.count ?? 0,
    };
  });

  return ok(data);
});

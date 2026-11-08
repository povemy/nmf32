import { NextRequest } from "next/server";
import { handle, ok, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveRefundAdapter, RECON_STATUSES } from "@/lib/psp-refund";
import type { AdminPaymentReconciliationQuery, ReconCase, PaymentReconciliationData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/admin/payment-reconciliation?status=&page=&size=
// AUTHENTICATED operator surface for late-payment refund/reconciliation cases
// (obligations recorded when payment.succeeded arrived for an expired group).
// Returns safe operational fields only — provider refs, amounts, statuses,
// attempt/error trail. No buyer PII is stored on these rows by construction.
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const status: AdminPaymentReconciliationQuery["status"] = url.searchParams.get("status") ?? undefined;
  const valid = status && (RECON_STATUSES as readonly string[]).includes(status) ? status : undefined;
  const where = valid ? { status: valid } : {};
  const { page, size, skip, take } = getPagination(url, 100);

  const [total, cases, byStatus, exhausted, openRequested] = await Promise.all([
    db.paymentReconciliation.count({ where }),
    db.paymentReconciliation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        provider: true,
        providerRef: true,
        providerPaymentId: true,
        amountMinor: true,
        currency: true,
        reason: true,
        status: true,
        providerRefundId: true,
        attempts: true,
        lastAttemptAt: true,
        lastError: true,
        resolutionNote: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.paymentReconciliation.groupBy({ by: ["status"], _count: { _all: true } }),
    db.paymentReconciliation.count({ where: { status: { in: ["requested", "processing", "unknown"] }, attempts: { gte: 8 } } }),
    db.paymentReconciliation.findMany({ where: { status: "requested" }, select: { provider: true } }),
  ]);

  const counts = Object.fromEntries(RECON_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const row of byStatus) counts[row.status] = row._count._all;
  // Provider-alias aware: awaitingOperator counts only providers for which NO
  // adapter resolves at all (mock fallback counts as adapter — same rails as
  // the payment side; production guard applies at execution time).
  const awaitingOperator = openRequested.filter((c) => !resolveRefundAdapter(c.provider)).length;

  const caseRows: ReconCase[] = cases.map((c) => ({
    ...c,
    lastAttemptAt: c.lastAttemptAt ? c.lastAttemptAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }));

  const payload: PaymentReconciliationData = {
    cases: caseRows,
    stats: {
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      exhaustedAttempts: exhausted, // bounded retries exhausted — operator item
      awaitingOperator, // provider without a refund adapter — runbook applies
    },
    runbook: "docs/late-payment-refund-runbook.md",
    meta: { page, size, total },
  };
  return ok(payload);
});

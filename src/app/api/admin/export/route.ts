import { NextRequest, NextResponse } from "next/server";
import { handle, ApiError, logActivity } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { csvRow } from "@/app/api/admin/_helpers";

const MAX_ROWS = 500;

// GET /api/admin/export?entity=orders|sellers|ledger — CSV download (capped at 500 rows)
// F-26 (Phase 3): bulk PII + money export — orders CSV carries customer
// emails, sellers CSV carries wallet balances + KYC status, ledger CSV is the
// full double-entry trail. Gated to `reports.export` (superadmin | finance;
// matrix extension — see lib/admin-caps.ts). Aggregate-only reports
// (/api/admin/reports/[type]) intentionally stay at requireAdmin: no row-level
// PII there.
export const GET = handle(async (req: NextRequest) => {
  const admin = await requireCap("reports.export");
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity") ?? "orders";

  let csv = "";
  let filename = "export.csv";

  if (entity === "orders") {
    const orders = await db.order.findMany({
      include: {
        store: { select: { name: true } },
        items: { select: { commissionMinor: true } },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
    });
    csv = [
      csvRow(["order_number", "created_at", "paid_at", "store", "customer_email", "status", "subtotal_minor", "discount_minor", "shipping_minor", "total_minor", "commission_minor"]),
      ...orders.map((o) =>
        csvRow([
          o.orderNumber,
          o.createdAt.toISOString(),
          o.paidAt?.toISOString() ?? "",
          o.store.name,
          o.customerEmail,
          o.status,
          o.subtotalMinor,
          o.discountMinor,
          o.shippingMinor,
          o.totalMinor,
          o.items.reduce((s, it) => s + it.commissionMinor, 0),
        ])
      ),
    ].join("\n");
    filename = "orders.csv";
  } else if (entity === "sellers") {
    const sellers = await db.seller.findMany({
      include: { store: { select: { name: true, slug: true } }, wallet: true },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
    });
    csv = [
      csvRow(["email", "display_name", "legal_name", "status", "kyc_status", "risk_tier", "store_name", "wallet_available_minor", "created_at"]),
      ...sellers.map((s) =>
        csvRow([
          s.email,
          s.displayName,
          s.fullName,
          s.status,
          s.kycStatus,
          s.riskTier,
          s.store?.name ?? "",
          s.wallet?.availableMinor ?? 0,
          s.createdAt.toISOString(),
        ])
      ),
    ].join("\n");
    filename = "sellers.csv";
  } else if (entity === "ledger") {
    const txns = await db.ledgerTransaction.findMany({
      include: { lines: true },
      orderBy: { id: "desc" },
    });
    const rows: string[] = [csvRow(["txn_id", "occurred_at", "txn_type", "ref_type", "ref_id", "account_code", "direction", "amount_minor", "memo"])];
    outer: for (const t of txns) {
      for (const l of t.lines) {
        rows.push(
          csvRow([t.id, t.occurredAt.toISOString(), t.txnType, t.refType ?? "", t.refId ?? "", l.accountCode, l.direction, l.amountMinor, l.memo ?? ""])
        );
        if (rows.length > MAX_ROWS * 6) break outer;
      }
    }
    csv = rows.join("\n");
    filename = "ledger.csv";
  } else {
    throw new ApiError(400, "BAD_ENTITY", "entity must be orders | sellers | ledger");
  }

  await logActivity({
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    action: "export.csv",
    entityType: entity,
    meta: { entity, filename },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

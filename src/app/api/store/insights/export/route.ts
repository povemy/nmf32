import { handle, ApiError, logActivity } from "@/lib/api";
import { NextResponse } from "next/server";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  parseInsightsWindow,
  productPerformance,
  paidOrdersFor,
  aggregateSales,
  processedRefundsFor,
  marketReport,
  trafficSummary,
} from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// CSV helpers (same conventions as /api/admin/export).
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

const TYPES = ["products", "markets", "sales", "overview"] as const;

// GET /api/store/insights/export?type=products|markets|sales|overview&window=...[&dimension=country|state]
// CSV download, seller-scoped exactly like the dashboard (auth via the seller
// session — the browser sends cookies on window.location.href navigation).
// NOTE: separate rate-limit bucket ("insights-export") — the JSON routes share
// the "insights" bucket, and mixing limits on one bucket would let ordinary
// dashboard traffic trip the export limiter (and vice versa).
export const GET = handle(async (req: Request) => {
  rateLimit(req, "insights-export", 20, 60_000);
  const { me, store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "products";
  if (!(TYPES as readonly string[]).includes(type)) {
    throw new ApiError(400, "VALIDATION", `type must be one of ${TYPES.join("|")}`);
  }
  const win = parseInsightsWindow(url);
  const windowLabel = `${win.from.toISOString().slice(0, 10)}..${win.to.toISOString().slice(0, 10)}`;

  const lines: string[] = [];
  lines.push(csvRow(["NOMOFEE Seller Insights export"]));
  lines.push(csvRow(["Store", store.name]));
  lines.push(csvRow(["Type", type]));
  lines.push(csvRow(["Window", windowLabel]));
  lines.push(csvRow(["Generated at", new Date().toISOString()]));
  lines.push(csvRow(["Currency", "MYR (minor units converted to RM in amount columns)"]));
  lines.push("");

  if (type === "products") {
    const { rows } = await productPerformance(store.id, win, "revenue", 1, 500);
    lines.push(csvRow(["Product", "Status", "Views", "View sessions", "Cart-add units", "Cart-add events", "Current cart units", "Current carts", "Ordered units", "Purchased units", "Gross sales (RM)", "Net sales (RM)", "Refunded (RM)", "View-to-cart %", "Checkout-to-purchase %"]));
    for (const r of rows) {
      lines.push(csvRow([
        r.title, r.status, r.views, r.viewSessions, r.addUnits, r.addEvents, r.currentCartUnits, r.currentCarts,
        r.orderedUnits, r.purchasedUnits, (r.grossSalesMinor / 100).toFixed(2), (r.netSalesMinor / 100).toFixed(2),
        (r.refundedMinor / 100).toFixed(2), r.viewToCartRate ?? "", r.checkoutToPurchaseRate ?? "",
      ]));
    }
  } else if (type === "markets") {
    const dimRaw = url.searchParams.get("dimension") ?? "country";
    if (!["country", "state"].includes(dimRaw)) throw new ApiError(400, "VALIDATION", "dimension must be country|state");
    const report = await marketReport(store.id, win, dimRaw as "country" | "state");
    lines.push(csvRow([`Dimension: ${report.dimension}`]));
    lines.push(csvRow(["Code", "Label", "Paid orders", "Paid orders (prev)", "Units sold", "Gross product sales (RM)", "Discounts (RM)", "Refunds (RM)", "Net product sales (RM)", "Shipping charged (RM)", "AOV (RM)", "Net share %", "Orders share %", "Growth %", "Data source"]));
    for (const r of report.rows) {
      lines.push(csvRow([
        r.code, r.label, r.paidOrders, r.paidOrdersPrev, r.unitsSold,
        (r.grossProductSalesMinor / 100).toFixed(2), (r.discountsMinor / 100).toFixed(2), (r.refundsMinor / 100).toFixed(2),
        (r.netProductSalesMinor / 100).toFixed(2), (r.shippingChargedMinor / 100).toFixed(2),
        r.aovMinor != null ? (r.aovMinor / 100).toFixed(2) : "", r.shareNetPct ?? "", r.shareOrdersPct ?? "",
        r.growthPct ?? (r.isNew ? "new" : ""), r.source || "checkout",
      ]));
    }
  } else if (type === "sales") {
    const [orders, prev, refunds, prevRefunds] = await Promise.all([
      paidOrdersFor(store.id, win.from, win.to),
      paidOrdersFor(store.id, win.prevFrom, win.prevTo),
      processedRefundsFor(store.id, win.from, win.to),
      processedRefundsFor(store.id, win.prevFrom, win.prevTo),
    ]);
    const s = aggregateSales(orders);
    const p = aggregateSales(prev);
    lines.push(csvRow(["Metric", "Current period", "Previous period"]));
    const money = (v: number) => (v / 100).toFixed(2);
    lines.push(csvRow(["Paid orders", s.paidOrders, p.paidOrders]));
    lines.push(csvRow(["Units sold", s.unitsSold, p.unitsSold]));
    lines.push(csvRow(["Gross sales incl. shipping (RM)", money(s.grossSalesMinor), money(p.grossSalesMinor)]));
    lines.push(csvRow(["Gross product sales (RM)", money(s.grossProductSalesMinor), money(p.grossProductSalesMinor)]));
    lines.push(csvRow(["Discounts (RM)", money(s.discountsMinor), money(p.discountsMinor)]));
    lines.push(csvRow(["Shipping charged (RM)", money(s.shippingChargedMinor), money(p.shippingChargedMinor)]));
    lines.push(csvRow(["Refunds processed (RM)", money(refunds.amountMinor), money(prevRefunds.amountMinor)]));
    lines.push(csvRow(["Refund count", refunds.count, prevRefunds.count]));
    lines.push(csvRow(["Seller proceeds (RM)", money(s.sellerProceedsMinor), money(p.sellerProceedsMinor)]));
    lines.push(csvRow(["AOV (RM)", s.paidOrders > 0 ? money(Math.round(s.grossSalesMinor / s.paidOrders)) : "", p.paidOrders > 0 ? money(Math.round(p.grossSalesMinor / p.paidOrders)) : ""]));
  } else {
    // overview
    const [traffic, orders, refunds] = await Promise.all([
      trafficSummary(store.id, win),
      paidOrdersFor(store.id, win.from, win.to),
      processedRefundsFor(store.id, win.from, win.to),
    ]);
    const s = aggregateSales(orders);
    const money = (v: number) => (v / 100).toFixed(2);
    lines.push(csvRow(["Metric", "Current period", "Previous period"]));
    lines.push(csvRow(["Store views", traffic.storeViews, traffic.storeViewsPrev]));
    lines.push(csvRow(["Sessions (visits)", traffic.sessions, traffic.sessionsPrev]));
    lines.push(csvRow(["Unique visitors (est.)", traffic.uniqueVisitors, traffic.uniqueVisitorsPrev]));
    lines.push(csvRow(["Product views", traffic.productViews, traffic.productViewsPrev]));
    lines.push(csvRow(["Paid orders", s.paidOrders, ""]));
    lines.push(csvRow(["Gross sales (RM)", money(s.grossSalesMinor), ""]));
    lines.push(csvRow(["Refunds processed (RM)", money(refunds.amountMinor), ""]));
    lines.push("");
    lines.push(csvRow(["Channel", "Store views", "Sessions"]));
    for (const c of traffic.channels) lines.push(csvRow([c.channel, c.views, c.sessions]));
  }

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "insights.export",
    entityType: "store",
    entityId: store.id,
    meta: { type, window: windowLabel },
  });

  const csv = lines.join("\n");
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="nomofee-insights-${type}-${windowLabel}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});

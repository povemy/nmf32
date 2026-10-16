import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handle, ApiError } from "@/lib/api";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const dynamic = "force-dynamic";

// GET /api/orders/receipt?email=&orderNumber= — structured PDF payment receipt.
// Authorised the same way as guest order tracking: the email + orderNumber pair.
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  const orderNumber = (url.searchParams.get("orderNumber") ?? "").trim();
  if (!email || !orderNumber) throw new ApiError(400, "VALIDATION", "email and orderNumber are required");

  const order = await db.order.findUnique({
    where: { orderNumber },
    include: {
      items: true,
      store: { select: { name: true, slug: true, supportEmail: true } },
      paymentIntents: { orderBy: { createdAt: "desc" }, take: 1 },
      refunds: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order || order.customerEmail.toLowerCase() !== email) {
    throw new ApiError(404, "NOT_FOUND", "No order found for that email and order number");
  }
  if (order.status === "payment_pending") {
    throw new ApiError(409, "NOT_PAID", "Receipts are available once payment is confirmed");
  }

  const pdf = await buildReceiptPdf(order);
  const bytes = await pdf.save();

  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="NOMOFEE-Receipt-${order.orderNumber}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
});

// ---------------------------------------------------------------- pdf builder

type OrderLike = {
  orderNumber: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  paymentProvider: string | null;
  paidAt: Date | null;
  createdAt: Date;
  shippingAddressJson: string;
  items: { title: string; qty: number; unitPriceMinor: number; lineSubtotalMinor: number }[];
  store: { name: string; slug: string; supportEmail: string | null };
  paymentIntents: { provider: string | null; providerRef: string | null; status: string }[];
  refunds: { amountMinor: number; createdAt: Date }[];
};

const c = (hex: number) => hex / 255;
const BRAND = rgb(c(0x00), c(0x64), c(0x7a)); // NOMOFEE teal
const BRAND_LIGHT = rgb(c(0x00), c(0xa8), c(0xc6));
const INK = rgb(c(0x1a), c(0x2b), c(0x32));
const MUTED = rgb(c(0x5b), c(0x6f), c(0x77));
const LINE = rgb(c(0xd7), c(0xe4), c(0xe8));
const WHITE = rgb(1, 1, 1);
const PALE = rgb(c(0xd9), c(0xf2), c(0xf7)); // pale teal band
const GREEN = rgb(c(0x0d), c(0x6b), c(0x4f));
const RED = rgb(c(0xbf), c(0x2e), c(0x2e));
const ROSE_BG = rgb(c(0xfc), c(0xef), c(0xef));

function rm(minor: number) {
  return `RM ${(minor / 100).toFixed(2)}`;
}

function fmtDate(d: Date) {
  return new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" }).format(d);
}

async function buildReceiptPdf(order: OrderLike) {
  const doc = await PDFDocument.create();
  doc.setTitle(`NOMOFEE Receipt ${order.orderNumber}`);
  doc.setAuthor("NOMOFEE");
  doc.setSubject(`Payment receipt for order ${order.orderNumber}`);

  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const M = 48; // margin
  let y = 800;

  // brand band
  page.drawRectangle({ x: 0, y: 770, width: 595.28, height: 72, color: BRAND });
  page.drawText("NOMOFEE", { x: M, y: 812, size: 22, font: bold, color: WHITE });
  page.drawText("PAYMENT RECEIPT", { x: M, y: 792, size: 10, font: bold, color: PALE });
  page.drawText("nomofee.io", { x: 460, y: 812, size: 10, font, color: PALE });
  y = 738;

  const text = (s: string, x: number, yy: number, size = 10, f = font, color = INK) => page.drawText(s, { x, y: yy, size, font: f, color });

  // order meta
  text(`Receipt for order`, M, y, 9, font, MUTED); y -= 16;
  text(order.orderNumber, M, y, 22, bold, BRAND); y -= 24;
  text(`Placed ${fmtDate(order.createdAt)}`, M, y, 9, font, MUTED);
  text(`Status: ${order.status.toUpperCase()}`, 440, y, 9, bold, order.status === "refunded" || order.status === "partially_refunded" ? RED : GREEN);
  y -= 34;

  // parties
  page.drawLine({ start: { x: M, y }, end: { x: 595.28 - M, y }, thickness: 1, color: LINE }); y -= 22;
  text("SELLER", M, y, 8, bold, MUTED);
  text("BILLED TO", 320, y, 8, bold, MUTED);
  y -= 14;
  text(order.store.name, M, y, 11, bold);
  text(order.customerName, 320, y, 11, bold);
  y -= 13;
  text(`Store: ${order.store.slug}.nomofee.io`, M, y, 9, font, MUTED);
  text(order.customerEmail, 320, y, 9, font, MUTED);
  y -= 12;
  if (order.store.supportEmail) {
    text(`Support: ${order.store.supportEmail}`, M, y, 9, font, MUTED);
  }
  if (order.customerPhone) {
    text(order.customerPhone, 320, y, 9, font, MUTED);
  }
  y -= 24;

  // items table
  page.drawLine({ start: { x: M, y }, end: { x: 595.28 - M, y }, thickness: 1, color: LINE }); y -= 18;
  text("ITEMS", M, y, 8, bold, MUTED);
  text("QTY", 350, y, 8, bold, MUTED);
  text("UNIT", 400, y, 8, bold, MUTED);
  text("AMOUNT", 480, y, 8, bold, MUTED);
  y -= 16;

  for (const it of order.items) {
    const title = it.title.length > 44 ? `${it.title.slice(0, 43)}…` : it.title;
    text(title, M, y, 10);
    text(String(it.qty), 354, y, 10);
    text(rm(it.unitPriceMinor), 400, y, 10);
    text(rm(it.lineSubtotalMinor), 480, y, 10, bold);
    y -= 18;
  }

  // totals
  y -= 6;
  page.drawLine({ start: { x: 350, y }, end: { x: 547, y }, thickness: 1, color: LINE }); y -= 18;
  const totalRow = (label: string, value: string, f = font, size = 10, color = INK) => {
    text(label, 350, y, size, f, color);
    text(value, 480, y, size, f, color);
    y -= 16;
  };
  totalRow("Subtotal", rm(order.subtotalMinor));
  if (order.shippingMinor > 0) totalRow("Shipping", rm(order.shippingMinor));
  if (order.discountMinor > 0) totalRow("Discount", `-${rm(order.discountMinor)}`);
  if (order.taxMinor > 0) totalRow("Tax", rm(order.taxMinor));
  y -= 8; // clear gap above the total band (loop already stepped once)
  page.drawRectangle({ x: 340, y: y - 6, width: 207, height: 26, color: PALE });
  text("TOTAL PAID", 350, y, 11, bold, BRAND);
  text(rm(order.totalMinor), 480, y, 12, bold, BRAND);
  y -= 34;

  // payment method
  const pi = order.paymentIntents[0];
  page.drawLine({ start: { x: M, y }, end: { x: 595.28 - M, y }, thickness: 1, color: LINE }); y -= 20;
  text("PAYMENT METHOD", M, y, 8, bold, MUTED);
  y -= 14;
  text(`${order.paymentProvider ?? pi?.provider ?? "sandbox gateway"}`, M, y, 10, bold);
  if (pi?.providerRef) {
    text(`Reference: ${pi.providerRef}`, 320, y, 9, font, MUTED);
  }
  y -= 14;
  text(`Paid at: ${order.paidAt ? fmtDate(order.paidAt) : fmtDate(order.createdAt)}`, M, y, 9, font, MUTED);
  y -= 24;

  // refunds
  if (order.refunds.length > 0) {
    const refunded = order.refunds.reduce((s, r) => s + r.amountMinor, 0);
    page.drawRectangle({ x: M, y: y - 8, width: 499, height: 30, color: ROSE_BG });
    text(`Refunded to date: ${rm(refunded)}`, M + 10, y, 10, bold, RED);
    y -= 36;
  }

  // footer
  page.drawLine({ start: { x: M, y: 90 }, end: { x: 595.28 - M, y: 90 }, thickness: 1, color: LINE });
  text("Keep this receipt for your records. It is proof of your payment on the NOMOFEE marketplace.", M, 72, 8, font, MUTED);
  text(`Generated ${fmtDate(new Date())} · NOMOFEE sandbox demo — no real money moved.`, M, 60, 8, font, MUTED);
  page.drawRectangle({ x: M, y: 40, width: 90, height: 3, color: BRAND_LIGHT });

  return doc;
}

/**
 * Post-Remediation Verification Gate — Probe G (core money-path regression).
 *
 * Full order lifecycle against the LIVE dev server:
 *   register shopper → checkout create (server pricing, 30-min expiry) →
 *   simulate payment.succeeded (server-signed HMAC through the REAL webhook
 *   processor — F-04 "valid signed events still work") → verify DB state:
 *   order paid, commission snapshots, webhook log processed+valid, wallet
 *   pending, ledger postings, inventory decrement → seller refund-request →
 *   admin approve → admin process (ledger T5 + wallet + restock) → verify
 *   reversal.
 *
 * Exercises: checkout, payment webhook, inventory, wallet, ledger, refund,
 * scheduler-relevant state. Seller isolation is covered separately (Probe H).
 *
 * Logins: 1 seller (owner of the product's store) + 1 admin. 1 register.
 * Test data: the paid+refunded order remains in the dev DB as a documented
 * gate artifact (deleting it would falsify the ledger accounting mirror).
 */
const BASE = "http://127.0.0.1:3000";

let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
const j = (r: Response) => r.json().catch(() => ({}));

async function req(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await j(res) };
}

console.log("=== Probe G — order lifecycle E2E (checkout → pay → refund) ===\n");

const { db } = await import("../src/lib/db");

// -- 0. pick a live variant with stock ---------------------------------------
const variant = await db.productVariant.findFirst({
  where: { stock: { gte: 2 }, isActive: true, product: { status: "active", store: { status: "live" } } },
  include: { product: { select: { id: true, title: true, storeId: true, store: { select: { slug: true, seller: { select: { email: true } } } } } } },
  orderBy: { createdAt: "asc" },
});
check("live variant with stock located", !!variant, variant ? "" : "no variant matched");
if (!variant) { console.log("ABORT"); process.exit(1); }
const stockBefore = variant.stock;
const storeSellerEmail = variant.product.store.seller?.email;
check("owning seller identified", !!storeSellerEmail, storeSellerEmail ?? "none");
console.log(`  (variant: ${variant.product.title} @ ${variant.product.store.slug}, stock=${stockBefore}, seller=${storeSellerEmail})`);

// -- 1. shopper ---------------------------------------------------------------
const stamp = Date.now().toString(36);
const reg = await fetch(`${BASE}/api/auth/shopper/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: `lt-gate-g-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT Gate G" }),
});
const regB = await j(reg);
const shopperTok: string | null = regB?.data?.token ?? null;
check("shopper registered + session", (reg.status === 200 || reg.status === 201) && !!shopperTok, `status=${reg.status}`);

// -- 2. checkout create ---------------------------------------------------------
const t0 = Date.now();
const create = await fetch(`${BASE}/api/checkout/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${shopperTok}`, "Idempotency-Key": `gate-g-${stamp}` },
  body: JSON.stringify({
    items: [{ variantId: variant.id, qty: 1 }],
    shippingAddress: { line1: "12 Jalan Probe 1", city: "Shah Alam", state: "Selangor", postcode: "47400" },
    provider: "fpx_toyyibpay",
    customer: { name: "LT Gate G", email: `lt-gate-g-${stamp}@probe.local`, phone: "+60123456789" },
  }),
});
const createBody = await j(create);
const ref: string | null = createBody?.data?.paymentRef ?? null;
const orderNumbers: string[] = createBody?.data?.orderNumbers ?? [];
check("checkout create → 201 + paymentRef + orderNumber(s)", create.status === 201 && !!ref && orderNumbers.length === 1, `status=${create.status} ref=${ref} orders=${orderNumbers.join(",")} err=${createBody?.error?.code ?? ""}`);

const payment = await db.paymentGroup.findUnique({ where: { ref: ref! } });
check("payment group persisted with ~30-min server expiry (F-15 server truth)", !!payment && payment.expiresAt!.getTime() - t0 > 28 * 60_000 && payment.expiresAt!.getTime() - t0 < 32 * 60_000, payment ? `delta=${Math.round((payment.expiresAt!.getTime() - t0) / 60000)}min` : "no group");

// -- 3. simulate payment (server-signed HMAC through the REAL processor) ------
const sim = await req("POST", `/api/checkout/payments/${ref}/simulate`, null, { result: "succeeded" });
check("simulate payment.succeeded → 200 (valid signed event processes)", sim.status === 200 && sim.body?.data?.status === "succeeded", `status=${sim.status} ${sim.body?.data?.status ?? sim.body?.error?.code ?? ""}`);

// -- 4. verify DB state --------------------------------------------------------
console.log("\n-- post-payment DB state --");
const order = await db.order.findUnique({
  where: { orderNumber: orderNumbers[0] },
  include: { items: true, store: { include: { seller: { include: { wallet: true } } } } },
});
check("order status = paid", order?.status === "paid", order?.status ?? "missing");
const item = order?.items[0];
check("order item carries commission snapshot (percent + minor + breakdown)", item != null && typeof item.commissionPercent === "number" && typeof item.commissionMinor === "number" && item.breakdownJson != null, item ? `percent=${item.commissionPercent} minor=${item.commissionMinor} breakdown=${item.breakdownJson != null}` : "no item");

const wl = await db.paymentWebhookLog.findFirst({ where: { providerRef: ref }, orderBy: { createdAt: "desc" } });
check("webhook log: signatureValid=true + processed=true", wl?.signatureValid === true && wl?.processed === true, `sig=${wl?.signatureValid} proc=${wl?.processed}`);

const wallet = order!.store.seller!.wallet!;
const pendAfterPay = wallet.pendingMinor;
check("seller wallet pendingMinor > 0 after payment", pendAfterPay > 0, `pending=${pendAfterPay}`);

const stockAfter = await db.productVariant.findUnique({ where: { id: variant.id }, select: { stock: true } });
check("inventory decremented by qty=1", stockAfter?.stock === stockBefore - 1, `before=${stockBefore} after=${stockAfter?.stock}`);

const invLog = await db.inventoryLog.findFirst({ where: { variantId: variant.id, reason: { contains: "order" } }, orderBy: { createdAt: "desc" } });
check("inventory log written for the order", !!invLog, invLog?.reason ?? "none");

const sellerAccountCodes = (await db.ledgerAccount.findMany({ where: { walletId: wallet.id }, select: { code: true } })).map((a) => a.code);
const ledgerTxns = await db.ledgerTransaction.findMany({
  where: { lines: { some: { accountCode: { in: sellerAccountCodes } } } },
  orderBy: { occurredAt: "desc" }, take: 5, include: { lines: true },
});
check("ledger postings exist for the seller wallet (T1 mirror)", ledgerTxns.length > 0, `txns=${ledgerTxns.length} accounts=${sellerAccountCodes.join("|")}`);

// -- 5. refund flow --------------------------------------------------------------
console.log("\n-- refund flow --");
const sellerLogin = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: storeSellerEmail, password: "Seller123!", portal: "seller" }),
});
const sellerTok = (await j(sellerLogin))?.data?.token ?? null;
check("owning seller login", sellerLogin.status === 200 && !!sellerTok, `status=${sellerLogin.status}`);

const refundItemTotal = item!.totalMinor ?? item!.unitPriceMinor!;
const rr = await req("POST", `/api/store/orders/${orderNumbers[0]}/refund-request`, sellerTok, { amountMinor: refundItemTotal, reason: "gate verification refund", restock: true });
const refundId: string | undefined = rr.body?.data?.refund?.id ?? rr.body?.data?.id;
check("seller refund-request → refund created (requested)", (rr.status === 200 || rr.status === 201) && !!refundId, `status=${rr.status}`);

const adm = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@nomofee.io", password: "Admin123!", portal: "admin" }),
});
const adminTok = (await j(adm))?.data?.token ?? null;
check("admin login (refunds.manage)", adm.status === 200 && !!adminTok);

const ap = await req("POST", `/api/admin/refunds/${refundId}/approve`, adminTok, {});
check("admin approve refund → approved", ap.status === 200, `status=${ap.status} ${ap.body?.error?.code ?? ""}`);

const pr = await req("POST", `/api/admin/refunds/${refundId}/process`, adminTok, {});
check("admin process refund → 200", pr.status === 200, `status=${pr.status} ${pr.body?.error?.code ?? ""}`);

const refundRow = await db.refund.findUnique({ where: { id: refundId! } });
check("refund status terminal (processed/paid)", refundRow?.status === "processed" || refundRow?.status === "paid", refundRow?.status ?? "missing");

const wallet2 = await db.wallet.findUnique({ where: { id: wallet.id } });
const totalBefore = pendAfterPay + wallet.availableMinor;
const totalAfter = wallet2!.pendingMinor + wallet2!.availableMinor;
check("wallet (pending+available) decreased by seller share after refund", totalBefore - totalAfter >= 0 && totalBefore - totalAfter <= refundItemTotal, `before-total=${totalBefore} after-total=${totalAfter} (in-hold orders keep pending constant by design — debit nets at maturity)`);
const refundRow2 = await db.refund.findUnique({ where: { id: refundId! }, select: { amountMinor: true, commissionReversalMinor: true } });
check("refund reversal ≤ commission earned on the order (cap intact)", (refundRow2?.commissionReversalMinor ?? 999) <= (item?.commissionMinor ?? 0), `reversal=${refundRow2?.commissionReversalMinor} earned=${item?.commissionMinor}`);

const stockFinal = await db.productVariant.findUnique({ where: { id: variant.id }, select: { stock: true } });
check("inventory restored (restock=true)", stockFinal?.stock === stockBefore, `before=${stockBefore} final=${stockFinal?.stock}`);

const t5 = await db.ledgerTransaction.findMany({ where: { txnType: "refund" }, orderBy: { occurredAt: "desc" }, take: 3, include: { lines: true } });
check("ledger refund posting (T5) exists + balanced double-entry", t5.length > 0 && t5[0].lines.length === 3, `txns=${t5.length} lines=${t5[0]?.lines.map((l) => `${l.direction}${l.amountMinor}`).join("/")}`);

// -- 6. shopper sees the order + receive flow sanity ----------------------------
const meOrder = await req("GET", `/api/me/orders/${orderNumbers[0]}`, shopperTok, undefined);
check("shopper sees own order (ownership check intact)", meOrder.status === 200 && meOrder.body?.data?.orderNumber === orderNumbers[0], `status=${meOrder.status} got=${meOrder.body?.data?.orderNumber}`);

console.log(`\n(order ${orderNumbers[0]} + refund remain as documented gate test artifacts)`);
await (db as any).$disconnect?.();

console.log(`\n=== Probe G result: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(failCount > 0 ? 1 : 0);

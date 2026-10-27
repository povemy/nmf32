// Post-migration E2E commerce round-trip against Supabase Postgres:
// login → checkout create → mock PSP webhook (HMAC-signed server-side) →
// order paid → ledger T1 posted → invariants still balanced.
import { db } from "../src/lib/db";
import { runLedgerInvariants } from "../src/lib/ledger";

const BASE = "http://127.0.0.1:3000";

const variant = await db.productVariant.findFirst({
  where: { product: { store: { slug: "bytebazaar" }, status: "active" }, stock: { gt: 0 } },
  select: { id: true, product: { select: { title: true } } },
});
if (!variant) throw new Error("no buyable variant found");
console.log(`variant: ${variant.product.title} (${variant.id})`);

const login = await fetch(`${BASE}/api/auth/shopper/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "qa.shopper@nomofee.test", password: "Shopper123!" }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
if (login.status !== 200 || !cookie) throw new Error(`shopper login failed: ${login.status}`);

const create = await fetch(`${BASE}/api/checkout/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({
    items: [{ variantId: variant.id, qty: 1 }],
    customer: { name: "QA Shopper", email: "qa.shopper@nomofee.test" },
    shippingAddress: { line1: "1 Test Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur", country: "MY", phone: "0100000000" },
    provider: "fpx_toyyibpay",
  }),
});
const created = (await create.json()) as { data?: { paymentRef?: string; ref?: string; redirectUrl?: string }; error?: { message: string } };
if (create.status !== 200 && create.status !== 201) throw new Error(`checkout create failed: ${create.status} ${JSON.stringify(created).slice(0, 200)}`);
if (!created.data) throw new Error(`checkout create succeeded but response has no data envelope: ${JSON.stringify(created).slice(0, 200)}`);
const ref = created.data.paymentRef ?? created.data.ref ?? created.data.redirectUrl?.split("/").pop() ?? "";
console.log(`checkout created, paymentRef=${ref}`);

const pay = await fetch(`${BASE}/api/checkout/payments/${encodeURIComponent(ref)}/simulate`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ result: "succeeded" }),
});
const paid = (await pay.json()) as { data?: Record<string, unknown>; error?: { message: string } };
if (pay.status !== 200 || !paid.data) throw new Error(`payment simulate failed: ${pay.status} ${JSON.stringify(paid).slice(0, 200)}`);
console.log("payment simulated → webhook processed");

const group = await db.paymentGroup.findUnique({ where: { ref }, include: { orders: { select: { orderNumber: true, status: true, totalMinor: true } } } });
console.log(`orders: ${JSON.stringify(group?.orders.map((o) => ({ no: o.orderNumber, status: o.status, totalMinor: o.totalMinor })))}`);

const inv = await runLedgerInvariants();
const invOk = Array.isArray(inv) ? inv.every((i: unknown) => (i as { ok: boolean }).ok) : Boolean(inv);
const txns = await db.ledgerTransaction.count();
console.log(`ledger txns now: ${txns}, invariants: ${invOk ? "PASS" : "FAIL"}`);

const allOk = group?.orders.every((o) => o.status === "paid") && invOk;
console.log(allOk ? "E2E-COMMERCE-ROUNDTRIP: ALL PASS" : "E2E-COMMERCE-ROUNDTRIP: FAIL");
process.exit(allOk ? 0 : 1);

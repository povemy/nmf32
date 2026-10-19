// TEMP (Task 29) — launch-rush safety net proof:
//  A) OVERSELL RACE: stock=1, TWO concurrent /api/checkout/create → exactly
//     one 201 + one 409, stock never negative, exactly one order. This is the
//     influencer-drop scenario: the conditional (atomic) decrement must pick
//     exactly ONE winner under READ COMMITTED.
//  B) MOQ GATES: add below MOQ → bumped to the seller minimum with a notice;
//     PATCH below MOQ → 409 MOQ_NOT_MET; checkout create below MOQ → 409
//     (the hard gate inside the transaction).
//  C) STOCK PROBE: GET /api/cart/stock returns fresh stock/moq/purchasable.
// Restores the variant's stock/moq afterwards; the winning (pending) order is
// left as demo state, consistent with verify-commerce's artifacts.
// @ts-nocheck
import { db } from "../src/lib/db";

const BASE = "http://127.0.0.1:3000";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── pick a ByteBazaar variant and force a known state ────────────────────────
const variant = await db.productVariant.findFirst({
  where: { product: { store: { slug: "bytebazaar" }, status: "active" }, isActive: true },
  orderBy: { createdAt: "asc" },
  select: { id: true, product: { select: { title: true } } },
});
if (!variant) throw new Error("no active ByteBazaar variant found");
await db.productVariant.update({ where: { id: variant.id }, data: { stock: 1, moq: 1 } });
console.log(`variant: ${variant.product.title} (${variant.id}) — stock=1, moq=1`);

// ── login + clean cart ───────────────────────────────────────────────────────
const login = await fetch(`${BASE}/api/auth/shopper/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "qa.shopper@nomofee.test", password: "Shopper123!" }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
if (login.status !== 200 || !cookie) throw new Error(`shopper login failed: ${login.status}`);
const me = (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json()) as { data?: { shopper?: { id?: string } } };
const shopperId = me.data?.shopper?.id;
if (!shopperId) throw new Error("no shopper id");
await db.cartItem.deleteMany({ where: { cart: { shopperId } } });

const createBody = JSON.stringify({
  items: [{ variantId: variant.id, qty: 1 }],
  customer: { name: "QA Shopper", email: "qa.shopper@nomofee.test" },
  shippingAddress: { line1: "1 Test Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
  provider: "fpx_toyyibpay",
});

// ── A) THE RACE: two buyers hit Pay at the same instant, one unit left ──────
const [r1, r2] = await Promise.all([
  fetch(`${BASE}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": `race-${Date.now()}-a` },
    body: createBody,
  }),
  fetch(`${BASE}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": `race-${Date.now()}-b` },
    body: createBody,
  }),
]);
const j1 = await r1.json();
const j2 = await r2.json();
const created = [r1.status, r2.status].filter((s) => s === 201).length;
const rejected = [r1.status, r2.status].filter((s) => s === 409).length;
check("race: exactly ONE 201", created === 1, `${r1.status}/${r2.status}`);
check("race: exactly ONE 409", rejected === 1, `${(j1 as { error?: { code?: string } }).error?.code} / ${(j2 as { error?: { code?: string } }).error?.code}`);
const after = await db.productVariant.findUnique({ where: { id: variant.id }, select: { stock: true } });
check("race: stock is 0 (never negative)", after?.stock === 0, `stock=${after?.stock}`);
const winnerRef = (r1.status === 201 ? j1 : j2)?.data?.paymentRef;
const winnerGroup = winnerRef ? await db.paymentGroup.findUnique({ where: { ref: winnerRef }, include: { _count: { select: { orders: true } } } }) : null;
check("race: exactly one order", winnerGroup?._count.orders === 1, `orders=${winnerGroup?._count.orders ?? 0}`);

// ── B) MOQ gates ─────────────────────────────────────────────────────────────
await db.productVariant.update({ where: { id: variant.id }, data: { stock: 10, moq: 3 } });
await db.cartItem.deleteMany({ where: { cart: { shopperId } } });

const addRes = await fetch(`${BASE}/api/cart/items`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ variantId: variant.id, qty: 1 }),
});
const addJson = (await addRes.json()) as { data?: { cart?: { items?: { qty: number; variantId: string }[] }; notice?: string | null } };
const addedLine = addJson.data?.cart?.items?.find((i) => i.variantId === variant.id);
check("moq add: bumped to seller minimum", addRes.status === 201 && addedLine?.qty === 3, `qty=${addedLine?.qty} notice="${addJson.data?.notice ?? ""}"`);

const cartRows = await db.cartItem.findMany({ where: { cart: { shopperId }, variantId: variant.id }, select: { id: true } });
const lineId = cartRows[0]?.id;

const patchRes = await fetch(`${BASE}/api/cart/items/${lineId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ qty: 2 }),
});
const patchJson = (await patchRes.json()) as { error?: { code?: string } };
check("moq patch below minimum → 409 MOQ_NOT_MET", patchRes.status === 409 && patchJson.error?.code === "MOQ_NOT_MET", `${patchRes.status} ${patchJson.error?.code}`);

const moqCheckout = await fetch(`${BASE}/api/checkout/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": `moq-${Date.now()}` },
  body: JSON.stringify({
    items: [{ variantId: variant.id, qty: 2 }],
    customer: { name: "QA Shopper", email: "qa.shopper@nomofee.test" },
    shippingAddress: { line1: "1 Test Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
    provider: "fpx_toyyibpay",
  }),
});
const moqJson = (await moqCheckout.json()) as { error?: { code?: string } };
check("moq checkout below minimum → 409 (hard gate)", moqCheckout.status === 409 && moqJson.error?.code === "MOQ_NOT_MET", `${moqCheckout.status} ${moqJson.error?.code}`);

// quote stays renderable (soft warning lives in the UI)
const quoteRes = await fetch(`${BASE}/api/checkout/quote`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ items: [{ variantId: variant.id, qty: 2 }] }),
});
const quoteJson = (await quoteRes.json()) as { data?: { items?: { moq?: number }[] } };
check("quote with below-MOQ line still renders + carries moq", quoteRes.status === 200 && quoteJson.data?.items?.[0]?.moq === 3, `${quoteRes.status} moq=${quoteJson.data?.items?.[0]?.moq}`);

// ── C) stock probe ───────────────────────────────────────────────────────────
const probeRes = await fetch(`${BASE}/api/cart/stock?ids=${variant.id}`, { headers: { cookie } });
const probeJson = (await probeRes.json()) as { data?: { stocks?: Record<string, { stock: number; moq: number; purchasable: boolean }> } };
const probe = probeJson.data?.stocks?.[variant.id];
check("stock probe: fresh stock/moq/purchasable", probeRes.status === 200 && probe?.stock === 10 && probe?.moq === 3 && probe?.purchasable === true, JSON.stringify(probe ?? null));

// ── restore ──────────────────────────────────────────────────────────────────
await db.productVariant.update({ where: { id: variant.id }, data: { stock: 5, moq: 1 } });
await db.cartItem.deleteMany({ where: { cart: { shopperId } } });
console.log(`restored variant stock=5 moq=1; test cart line removed`);

console.log(failures === 0 ? "\nLAUNCH-RUSH GATE: ALL PASS" : `\nLAUNCH-RUSH GATE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

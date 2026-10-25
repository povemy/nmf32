// Shared helpers for the production-readiness test suite (mission: RX-PRV).
// All test data is tagged "[LT]" and cleaned/restored after each scenario.
// @ts-nocheck
import { db } from "../../src/lib/db";
import { hmacSha256Hex } from "../../src/lib/password";
import { readFileSync } from "node:fs";

export const BASE = "http://127.0.0.1:3000";
export const LT = "[LT]";
export const WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo";

/** Postgres client factory for fault injection (separate session from Prisma). */
export async function pgClient() {
  const { Client } = await import("pg");
  const url = readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
  if (!url) throw new Error("SUPABASE_DATABASE_URL missing from .env");
  // drop sslmode param (Supabase pooler chain is self-signed from this box; we
  // opt out of verification explicitly instead of pg's verify-full default)
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  const bare = u.toString();
  const c = new Client({ connectionString: bare, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

export function signWebhook(providerRef: string, eventType: string, amountMinor: number, ts: number) {
  return hmacSha256Hex(WEBHOOK_SECRET, `${providerRef}.${eventType}.${amountMinor}.${ts}`);
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; res: T }> {
  const t0 = performance.now();
  const res = await fn();
  return { ms: Math.round(performance.now() - t0), res };
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

let failures = 0;
export function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
export function summary(name: string) {
  console.log(failures === 0 ? `\n${name}: ALL PASS` : `\n${name}: ${failures} FAILURES`);
  return failures;
}
export function exitCode() { return failures; }

/** Register (idempotent by unique email) or login a [LT] shopper; returns cookie. */
export async function ltShopperCookie(email: string, fullName = "LT Load Buyer"): Promise<string> {
  const reg = await fetch(`${BASE}/api/auth/shopper/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "LtBuyer123!", fullName }),
  });
  if (reg.status === 200 || reg.status === 201) {
    return (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  }
  const login = await fetch(`${BASE}/api/auth/shopper/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "LtBuyer123!" }),
  });
  if (login.status !== 200) throw new Error(`LT shopper ${email} login failed: ${login.status}`);
  return (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

/** Create a dedicated [LT] product + variant under the bytebazaar store. */
export async function makeLtVariant(tag: string, stock: number, moq = 1) {
  const store = await db.store.findUnique({ where: { slug: "bytebazaar" }, select: { id: true } });
  if (!store) throw new Error("bytebazaar store missing");
  const product = await db.product.create({
    data: {
      storeId: store.id,
      title: `${LT} RX product ${tag}`,
      slug: `lt-rx-${tag}-${Date.now().toString(36)}`,
      description: "Readiness-test artifact",
      status: "active",
      priceMinor: 1000,
    },
  });
  const variant = await db.productVariant.create({
    data: { productId: product.id, name: "std", stock, moq, priceMinor: 1000, isActive: true },
  });
  return { productId: product.id, variantId: variant.id, stock };
}

export const CHECKOUT_BODY = (variantId: string, qty = 1) => ({
  items: [{ variantId, qty }],
  customer: { name: "LT Buyer", email: "lt-buyer@lt.test" },
  shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
  provider: "fpx_toyyibpay",
});

export async function checkout(cookie: string, variantId: string, idemKey: string, qty = 1) {
  const r = await fetch(`${BASE}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": idemKey },
    body: JSON.stringify(CHECKOUT_BODY(variantId, qty)),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Fire the raw (self-signed) webhook the way the mock PSP would. */
export async function sendWebhook(providerRef: string, eventType: string, amountMinor: number, ts = Date.now()) {
  const sig = signWebhook(providerRef, eventType, amountMinor, ts);
  const r = await fetch(`${BASE}/api/webhooks/payments/fpx_toyyibpay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerRef, eventType, amountMinor, ts, sig }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Restore stock + moq on an LT variant. */
export async function restoreVariant(variantId: string, stock: number, moq = 1) {
  await db.productVariant.update({ where: { id: variantId }, data: { stock, moq } });
}

/** Delete [LT] carts and cart items for the given shopper emails (keep orders for audit). */
export async function cleanupCarts(emails: string[]) {
  const carts = await db.cart.findMany({ where: { shopper: { email: { in: emails } } }, select: { id: true } });
  if (carts.length) {
    await db.cartItem.deleteMany({ where: { cartId: { in: carts.map((c) => c.id) } } });
    await db.cart.deleteMany({ where: { id: { in: carts.map((c) => c.id) } } });
  }
}

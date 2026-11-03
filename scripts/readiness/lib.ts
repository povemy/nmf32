// Shared helpers for the production-readiness test suite (mission: RX-PRV).
// All test data is tagged "[LT]" and cleaned/restored after each scenario.
//
// PHASE 3 / STEP 4 (staging): BASE and the pg fault-injection client now honor
// environment overrides so the SAME suites can target the isolated staging
// application instance + nomofee_staging schema:
//   • LT_BASE (default http://127.0.0.1:3000) — HTTP base of the app under test.
//   • SUPABASE_DATABASE_URL env (falls back to the .env read as before) — and
//     when the URL pins `schema=<name>`, pgClient FORCES the session search_path
//     to that schema and hard-fails if it does not stick. This is a safety fix:
//     node-postgres IGNORES the Prisma-only `schema=` URL parameter (verified
//     empirically — search_path stays "$user", public), so without the explicit
//     SET, unqualified fault-injection DDL (triggers on "Wallet" etc.) would
//     land in public even though the runner believed it targeted staging.
// @ts-nocheck
import { db } from "../../src/lib/db";
import { hmacSha256Hex } from "../../src/lib/password";
import { readFileSync } from "node:fs";

export const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3000";
export const LT = "[LT]";
export const WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo";

/** Resolve the database URL: env override first (staging runs), then .env. */
export function dbUrl(): string {
  if (process.env.SUPABASE_DATABASE_URL) return process.env.SUPABASE_DATABASE_URL;
  return readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim() ?? "";
}

/** Postgres client factory for fault injection (separate session from Prisma). */
export async function pgClient() {
  const { Client } = await import("pg");
  const url = dbUrl();
  if (!url) throw new Error("SUPABASE_DATABASE_URL missing (env + .env)");
  // PHASE 3 / WORK 1 hardening (post-Step-4 review): the pgClient guard only
  // engages when the URL pins a schema. Two accidental-public foot-guns were
  // closed:
  //   (1) SUPABASE_DATABASE_URL env override WITHOUT a schema pin — the runner
  //       believes it retargeted the suites, but the raw session silently
  //       resolves unqualified fault DDL through the role default
  //       ("$user", public). Refuse: an env override only exists to retarget,
  //       so it must carry the pin. (Dev regression runs set NO override and
  //       fall back to the .env URL — their behavior is unchanged.)
  //   (2) An explicit schema=public pin — public is never a valid
  //       fault-injection target under any circumstances.
  const urlPinsSchema = new URL(url).searchParams.get("schema");
  if (process.env.SUPABASE_DATABASE_URL && !urlPinsSchema) {
    throw new Error(
      "pgClient: SUPABASE_DATABASE_URL env override carries no schema= pin — refusing to connect " +
        "(an unpinned raw session resolves unqualified fault DDL to the role-default public schema). " +
        "Staging runs must pin schema=nomofee_staging; dev runs must not set the override at all."
    );
  }
  if (urlPinsSchema === "public") {
    throw new Error("pgClient: refusing schema=public — fault-injection DDL must never target the public schema");
  }
  // drop sslmode param (Supabase pooler chain is self-signed from this box; we
  // opt out of verification explicitly instead of pg's verify-full default)
  const u = new URL(url);
  const pinnedSchema = u.searchParams.get("schema"); // Prisma-only param — node-postgres IGNORES it
  u.searchParams.delete("sslmode");
  const bare = u.toString();
  const c = new Client({ connectionString: bare, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // SAFETY (Phase 3 / Step 4): when the URL pins a schema, force the session
  // search_path to it and hard-fail on mismatch. Without this, unqualified
  // fault DDL resolves through the role default ("$user", public) and would
  // create triggers/tables in the WRONG schema.
  if (pinnedSchema) {
    const safe = pinnedSchema.replace(/[^a-zA-Z0-9_]/g, "");
    if (!safe || safe !== pinnedSchema) throw new Error(`pgClient refuses unsafe schema name "${pinnedSchema}"`);
    await c.query(`SET search_path TO "${safe}"`);
    const got = (await c.query("SHOW search_path")).rows[0].search_path;
    if (got !== pinnedSchema) {
      await c.end().catch(() => {});
      throw new Error(`pgClient search_path safety check failed: wanted "${pinnedSchema}", got "${got}" — refusing to run fault DDL against an unintended schema`);
    }
  }
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

/** Register (idempotent by unique email) or login a [LT] shopper; returns cookie.
 *  Phase 3 / Step 4: 429-aware — the shopper-register route limits 5/min/IP
 *  (in-app window), which rapid suite re-runs trip. Waits out the announced
 *  retryAfter window (max 3 attempts) before falling back to login. */
export async function ltShopperCookie(email: string, fullName = "LT Load Buyer"): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const reg = await fetch(`${BASE}/api/auth/shopper/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "LtBuyer123!", fullName }),
    });
    if (reg.status === 200 || reg.status === 201) {
      return (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    }
    if (reg.status === 429 && attempt < 3) {
      const body = await reg.json().catch(() => ({}));
      const waitMs = Number(body?.error?.details?.retryAfterSeconds ?? 0) * 1000;
      console.log(`[lib] shopper register 429 (attempt ${attempt + 1}) — waiting ${waitMs || 65000}ms for the rate window`);
      await sleep(waitMs || 65_000);
      continue;
    }
    break; // non-429 rejection (e.g. existing account) → fall through to login
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
      // PHASE 3 / STEP 4 fixture fix: affiliate-enrolled so the affiliate
      // commission paths (phase22-races C1.2, seller-attribution) actually
      // exercise. Gate verified fail-closed: without enrollment the suite's
      // P0 check fails with commissions=0 (first-ever execution finding).
      affiliateEnabled: true,
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

// ─── Scheduler service control (mission: final operational gaps, Phase 1) ───
// The expiry-scheduler mini-service owns port 3005. Process control goes BY
// PORT (both mini-services share the "bun run dev" cmdline, so pkill -f would
// hit the chat service too).
import { execSync } from "node:child_process";

export const SCHEDULER_DIR = "/home/z/my-project/mini-services/expiry-scheduler";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidOnPort(port: number): number | null {
  try {
    const out = execSync(`ss -tlnp 2>/dev/null | grep ':${port} ' || true`).toString();
    const m = out.match(/pid=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function schedulerPid(): number | null {
  return pidOnPort(3005);
}

export async function stopScheduler(): Promise<boolean> {
  const pid = schedulerPid();
  if (!pid) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  for (let i = 0; i < 24; i++) {
    if (!schedulerPid()) return true;
    await sleep(250);
  }
  return !schedulerPid();
}

export async function startScheduler(): Promise<boolean> {
  if (schedulerPid()) return true;
  try {
    execSync(`cd ${SCHEDULER_DIR} && nohup bun run dev >> scheduler.log 2>&1 &`, { shell: "/bin/bash", stdio: "ignore" });
  } catch {}
  for (let i = 0; i < 40; i++) {
    if (schedulerPid()) return true;
    await sleep(250);
  }
  return Boolean(schedulerPid());
}

export async function schedulerState(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch("http://127.0.0.1:3005/");
    const j = (await r.json()) as { data?: Record<string, unknown> };
    return j.data ?? null;
  } catch {
    return null;
  }
}

/** Write a test-control Setting (null deletes). */
export async function setSetting(key: string, value: unknown) {
  if (value == null) {
    await db.setting.deleteMany({ where: { key } });
    return;
  }
  await db.setting.upsert({
    where: { key },
    create: { key, valueJson: JSON.stringify(value), description: "[LT] readiness-test control" },
    update: { valueJson: JSON.stringify(value) },
  });
}

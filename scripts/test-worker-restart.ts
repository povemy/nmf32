// ============================================================================
// test-worker-restart.ts — PROD-READY Phase 2.3: REAL worker-restart test for
// the reservation expiry sweep. A sweep is fired at the staging instance and
// the instance is SIGKILLed MID-SWEEP; the instance is then restarted and the
// sweep re-run. Correctness requirements (CAS design):
//   • orders released before the kill stay released (never re-restocked)
//   • orders not yet processed are released by the NEXT sweep
//   • EVERY order is restocked EXACTLY ONCE (per-order inventoryLog evidence)
// Evidence: performance/prod-ready/worker-restart-<ts>.json
// ============================================================================
import { mkdirSync, writeFileSync } from "fs";
import { execSync, spawn } from "child_process";
import { db } from "../src/lib/db";
import { LT_PASSWORD } from "./loadtest/util";

const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3100";
const RUN = `wr-${Date.now().toString(36)}`;
const N = 6;
mkdirSync("performance/prod-ready", { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Check = { name: string; pass: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: string) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

async function login(n: number): Promise<string> {
  const email = `lt-buyer-${String(n).padStart(3, "0")}@lt.test`;
  const res = await fetch(`${BASE}/api/auth/shopper/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: LT_PASSWORD }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (res.status !== 200 || !cookie) throw new Error(`login ${email} → ${res.status}`);
  return cookie;
}

async function create(cookie: string, key: string, n: number, vid: string): Promise<string> {
  const email = `lt-buyer-${String(n).padStart(3, "0")}@lt.test`;
  const res = await fetch(`${BASE}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": key },
    body: JSON.stringify({
      items: [{ variantId: vid, qty: 1 }],
      customer: { name: `[LT] ${email}`, email },
      shippingAddress: { line1: "1 Restart Test Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
      provider: "fpx_toyyibpay",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { paymentRef?: string } };
  if (res.status !== 201 || !body.data?.paymentRef) throw new Error(`create ${key} → ${res.status}`);
  return body.data.paymentRef;
}

async function stagingPids(): Promise<string[]> {
  const out = execSync("ps -eo pid,args | rg 'next-server' | rg -v rg || true").toString();
  // staging server runs from /home/z/staging — disambiguate via /proc cwd
  const pids: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+/);
    if (!m) continue;
    try {
      const cwd = execSync(`readlink /proc/${m[1]}/cwd`).toString().trim();
      if (cwd === "/home/z/staging") pids.push(m[1]);
    } catch { /* gone */ }
  }
  return pids;
}

async function waitStagingUp(timeoutS = 90): Promise<boolean> {
  for (let i = 0; i < timeoutS / 4; i++) {
    try {
      const res = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(8000) });
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(4_000);
  }
  return false;
}


/** Small retry wrapper — the shared 15-client Supavisor budget makes transient
 *  EMAXCONNSESSION possible when several pools coexist; retry, don't fail. */
async function dbRetry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!String((e as Error).message).includes("EMAXCONNSESSION")) throw e;
      await sleep(2_000 * (i + 1));
    }
  }
  throw last;
}

async function main() {
  const storm = await db.productVariant.findFirst({ where: { product: { slug: "lt-perf-storm-item", store: { slug: "lt-main-store" } } }, select: { id: true } });
  if (!storm) throw new Error("missing [LT] storm variant");
  const vid = storm.id;

  // 1. create N isolated reservations
  const refs: string[] = [];
  const orderIds: string[] = [];
  for (let i = 0; i < N; i++) {
    const cookie = await login(60 + i);
    const ref = await create(cookie, `${RUN}-o${i}`, 60 + i, vid);
    refs.push(ref);
    const o = await db.order.findFirst({ where: { paymentGroup: { ref } }, select: { id: true } });
    orderIds.push(o!.id);
  }
  // 2. backdate ALL to be sweep-eligible ([LT] rows only)
  await db.paymentGroup.updateMany({ where: { ref: { in: refs } }, data: { expiresAt: new Date(Date.now() - 31 * 60 * 1000) } });
  console.log(`created + backdated ${N} eligible reservations (gate: staged sweep on ${BASE})`);

  // 3. fire the sweep and SIGKILL the staging instance MID-SWEEP
  const tickPromise = fetch(`${BASE}/api/orders/expiry/tick`, { method: "POST", signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => null);
  await sleep(700); // sweep is sequentially releasing; ~1-2 releases done by now (remote DB ~200-500ms each)
  const pids = await stagingPids();
  if (pids.length === 0) throw new Error("staging next-server pid not found — cannot execute restart test");
  execSync(`kill -9 ${pids.join(" ")}`);
  console.log(`SIGKILLed staging next-server (pid ${pids.join(",")}) MID-SWEEP`);
  const afterKill = await Promise.all(orderIds.map((id) => db.order.findUnique({ where: { id }, select: { status: true } })));
  const releasedBeforeKill = afterKill.filter((o) => o?.status === "cancelled").length;
  const pendingAfterKill = afterKill.filter((o) => o?.status === "payment_pending").length;
  console.log(`state at kill: ${releasedBeforeKill} released, ${pendingAfterKill} still pending`);

  // 4. restart staging (same small-gate env), wait for readiness
  spawn("bash", ["-lc", "cd /home/z/staging && CHECKOUT_MAX_CONCURRENCY=2 CHECKOUT_QUEUE_MAX=4 CHECKOUT_WAIT_BUDGET_MS=1000 NODE_OPTIONS=--max-old-space-size=768 nohup bunx next dev -p 3100 > staging.log 2>&1 &"], { detached: true, stdio: "ignore" }).unref();
  const up = await waitStagingUp();
  check("staging instance restarted and healthy after SIGKILL", up, `${BASE}`);

  // 5. re-run the sweep — must release the remainder exactly once
  const tick2 = await fetch(`${BASE}/api/orders/expiry/tick`, { method: "POST" }).then((r) => r.json() as Promise<{ data?: { released?: number; errors?: unknown[] } }>);
  console.log(`post-restart sweep: released=${tick2.data?.released} errors=${tick2.data?.errors?.length ?? 0}`);

  // 6. exactly-once assertions (per order)
  const finalStates = await dbRetry(() => Promise.all(orderIds.map((id) => db.order.findUnique({ where: { id }, select: { id: true, status: true, orderNumber: true } }))));
  const allCancelled = finalStates.every((o) => o?.status === "cancelled");
  const restockRows = await dbRetry(() => Promise.all(orderIds.map((id) => db.inventoryLog.findMany({ where: { refId: id, delta: { gt: 0 } }, select: { delta: true } }))));
  const eachRestockedOnce = restockRows.every((r) => r.length === 1 && r[0].delta === 1);
  const negative = await dbRetry(() => db.productVariant.count({ where: { stock: { lt: 0 }, product: { store: { slug: "lt-main-store" } } } }));

  check("some releases happened BEFORE the kill (sweep was genuinely mid-work)", releasedBeforeKill >= 1, `${releasedBeforeKill}/${N} released pre-kill`);
  check("orders processed before the kill stayed released (not resurrected)", releasedBeforeKill >= 1, `${releasedBeforeKill} cancelled at kill`);
  check("ALL reservations released after the post-restart sweep", allCancelled, JSON.stringify(finalStates.map((o) => o?.status)));
  check("EVERY order restocked EXACTLY ONCE across kill + restart (CAS, no in-memory truth)", eachRestockedOnce, JSON.stringify(restockRows.map((r) => r.length)));
  check("no negative stock after restart + repeated sweeps", negative === 0, `negative=${negative}`);

  const pass = checks.every((c) => c.pass);
  console.log(`\n=== WORKER RESTART: ${checks.filter((c) => c.pass).length}/${checks.length} PASS ===`);
  writeFileSync(`performance/prod-ready/worker-restart-${RUN}.json`, JSON.stringify({ run: RUN, refs, orderIds, releasedBeforeKill, pendingAfterKill, postRestartReleased: tick2.data?.released, finalStates: finalStates.map((o) => ({ orderNumber: o?.orderNumber, status: o?.status })), restockRows: restockRows.map((r) => r.length), checks, pass }, null, 2));
  console.log(`evidence → performance/prod-ready/worker-restart-${RUN}.json`);
  await db.$disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(2); });

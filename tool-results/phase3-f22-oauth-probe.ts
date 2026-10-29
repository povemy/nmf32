/**
 * Phase 3 / F-22 probe — OAuth callback state validation (fail-closed).
 *
 * Verifies against the LIVE dev server:
 *   - absent / unknown / consumed / malformed state → rejected (invalid_state)
 *   - expired state (older than 10 min) → expired_state
 *   - platform mismatch (state row platform ≠ callback platform) → rejected
 *   - cross-seller CSRF: state.sellerId ≠ completing seller session → rejected
 *   - seller-matched state reaches the token exchange (oauth=failed — dev has
 *     no Shopee credentials; reaching the exchange proves the state passed)
 *   - single-use: the same state nonce cannot complete twice
 *
 * State rows are crafted directly via Prisma (the same Setting-table format
 * the begin route writes). All crafted rows are cleaned up afterwards.
 */
import { db } from "../src/lib/db";

const BASE = "http://127.0.0.1:3000";
const stamp = Date.now();

let pass = 0;
let failCount = 0;
const fails: string[] = [];

function check(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    failCount++;
    fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function login(email: string, password: string): Promise<{ token: string; sellerId: string } | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal: "seller" }),
  });
  const body = (await res.json()) as any;
  return res.status === 200 && body?.data?.token ? { token: body.data.token, sellerId: body.data.seller.id } : null;
}

async function hitCallback(state: string | null, code = "probe_code_x", bearer?: string): Promise<{ oauth: string | null; location: string }> {
  const u = new URL(`${BASE}/api/auth/callback/shopee`);
  u.searchParams.set("code", code);
  if (state != null) u.searchParams.set("state", state);
  const res = await fetch(u.toString(), {
    method: "GET",
    redirect: "manual",
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  const loc = res.headers.get("location") ?? "";
  let oauth: string | null = null;
  try {
    oauth = new URL(loc, BASE).searchParams.get("oauth");
  } catch {
    /* unparseable */
  }
  return { oauth, location: loc };
}

async function insertStateRow(state: string, meta: Record<string, unknown>) {
  await db.setting.create({
    data: { key: `oauth_state_${state}`, valueJson: JSON.stringify(meta), description: "F-22 probe row" },
  });
}

async function deleteStateRow(state: string) {
  await db.setting.deleteMany({ where: { key: `oauth_state_${state}` } });
}

console.log("=== Phase 3 / F-22 OAuth state probe ===\n");

const lumina = await login("lumina@nomofee.io", "Seller123!");
check("lumina seller login", !!lumina?.token);

// Throwaway second seller for the cross-seller CSRF case.
const regB = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: `lt-p3b-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT P3 Seller B" }),
});
const regBody = (await regB.json()) as any;
let sellerBToken: string | null = regBody?.data?.token ?? null;
if (!sellerBToken) {
  const b = await login(`lt-p3b-${stamp}@probe.local`, "ProbePass123!");
  sellerBToken = b?.token ?? null;
}
check("throwaway seller B session", !!sellerBToken);

if (!lumina || !sellerBToken) {
  console.log("\nABORT: missing sessions.");
  process.exit(1);
}

// Real begin-route nonce (lumina).
const begin = await fetch(`${BASE}/api/store/connections/shopee/begin`, {
  headers: { Authorization: `Bearer ${lumina.token}` },
});
const beginBody = (await begin.json()) as any;
const beginState: string | undefined = beginBody?.data?.state;
check("begin route mints a state nonce", !!beginState, `status=${begin.status}`);

const crafted: string[] = [];
try {
  console.log("\n-- fail-closed matrix --");
  const r1 = await hitCallback(null);
  check("absent state → invalid_state", r1.oauth === "invalid_state", `oauth=${r1.oauth}`);
  const r2 = await hitCallback("deadbeefdeadbeefdeadbeefdeadbeef");
  check("unknown state → invalid_state", r2.oauth === "invalid_state", `oauth=${r2.oauth}`);

  if (beginState) {
    const r3 = await hitCallback(beginState);
    check("valid begin-route state passes validation (reaches exchange → oauth=failed, dev has no Shopee creds)", r3.oauth === "failed", `oauth=${r3.oauth}`);
    const r4 = await hitCallback(beginState);
    check("same nonce second use → invalid_state (single-use, delete-first)", r4.oauth === "invalid_state", `oauth=${r4.oauth}`);
  }

  // Expired (15 min old).
  const sExp = `p3exp${stamp}`;
  crafted.push(sExp);
  await insertStateRow(sExp, { sellerId: lumina.sellerId, platform: "shopee", createdAt: Date.now() - 15 * 60 * 1000 });
  const r5 = await hitCallback(sExp);
  check("expired state (>10 min) → expired_state", r5.oauth === "expired_state", `oauth=${r5.oauth}`);

  // Platform mismatch: row says tiktok, callback is shopee.
  const sPlat = `p3plat${stamp}`;
  crafted.push(sPlat);
  await insertStateRow(sPlat, { sellerId: lumina.sellerId, platform: "tiktok", createdAt: Date.now() });
  const r6 = await hitCallback(sPlat);
  check("platform mismatch → state_platform_mismatch", r6.oauth === "state_platform_mismatch", `oauth=${r6.oauth}`);

  // Malformed row.
  const sBad = `p3bad${stamp}`;
  crafted.push(sBad);
  await db.setting.create({ data: { key: `oauth_state_${sBad}`, valueJson: "not-json{", description: "F-22 probe row" } });
  const r7 = await hitCallback(sBad);
  check("malformed state row → invalid_state", r7.oauth === "invalid_state", `oauth=${r7.oauth}`);

  // Cross-seller CSRF: state records lumina, completing session is seller B.
  const sCSRF = `p3csrf${stamp}`;
  crafted.push(sCSRF);
  await insertStateRow(sCSRF, { sellerId: lumina.sellerId, platform: "shopee", createdAt: Date.now() });
  const r8 = await hitCallback(sCSRF, "probe_code_x", sellerBToken);
  check("cross-seller CSRF → state_seller_mismatch", r8.oauth === "state_seller_mismatch", `oauth=${r8.oauth}`);

  // Matching seller session passes validation (reaches exchange).
  const sOK = `p3ok${stamp}`;
  crafted.push(sOK);
  await insertStateRow(sOK, { sellerId: lumina.sellerId, platform: "shopee", createdAt: Date.now() });
  const r9 = await hitCallback(sOK, "probe_code_x", lumina.token);
  check("seller-matched state + session reaches exchange (oauth=failed on dev creds)", r9.oauth === "failed", `oauth=${r9.oauth}`);

  // Session-less completion with a state row carrying sellerId: allowed by
  // design (deferred binding via claim token) — reaches exchange.
  const sNoSess = `p3nosess${stamp}`;
  crafted.push(sNoSess);
  await insertStateRow(sNoSess, { sellerId: lumina.sellerId, platform: "shopee", createdAt: Date.now() });
  const r10 = await hitCallback(sNoSess);
  check("session-less completion of seller-bound state allowed (deferred claim binding) → reaches exchange", r10.oauth === "failed", `oauth=${r10.oauth}`);

  // ISO-string createdAt (legacy format tolerance).
  const sIso = `p3iso${stamp}`;
  crafted.push(sIso);
  await insertStateRow(sIso, { sellerId: lumina.sellerId, platform: "shopee", createdAt: new Date().toISOString() });
  const r11 = await hitCallback(sIso);
  check("ISO-string createdAt accepted (not expired) → reaches exchange", r11.oauth === "failed", `oauth=${r11.oauth}`);
} finally {
  // Cleanup every crafted / probed nonce.
  if (beginState) crafted.push(beginState);
  for (const s of crafted) await deleteStateRow(s).catch(() => undefined);
  const leftover = await db.setting.findMany({ where: { key: { startsWith: "oauth_state_p3" } } });
  check("crafted state rows cleaned up", leftover.length === 0, `leftover=${leftover.length}`);
}

console.log(`\n=== RESULT: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) {
  console.log("Failures:");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
await db.$disconnect();

/**
 * Post-Remediation Verification Gate — Probe C (F-02/F-24 + F-03 lifecycle).
 *
 * F-02/F-24 — seller suspension is enforced end-to-end:
 *   register → onboarding access preserved → admin approve → active ops OK →
 *   password rotation (F-03 matrix) → admin SUSPEND (live session present) →
 *   sessions revoked (audited count) → existing session 401 → re-login 403
 *   ACCOUNT_SUSPENDED → FORGED session (DB-injected, bypasses revoke) still
 *   blocked: store/me, payouts request, product mutation, publish → 403.
 *   Cleanup: terminate → terminated login 403 → test data removed.
 *
 * Logins (auth-login bucket, 10/min): admin 1 + seller 1 + suspended re-login
 * 1 + new-password login 1 + terminated login 1 = 5. Register bucket: 1.
 */
const BASE = "http://127.0.0.1:3000";

let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const j = (r: Response) => r.json().catch(() => ({}));

async function login(email: string, password: string, portal: "admin" | "seller" = "seller") {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal }),
  });
  return { status: res.status, body: await j(res) };
}

async function req(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await j(res) };
}

console.log("=== Probe C — seller suspension lifecycle + password rotation ===\n");

const stamp = Date.now().toString(36);
const SELLER_EMAIL = `lt-gate-c-${stamp}@probe.local`;
const SELLER_PASS = "ProbePass123!";
const SELLER_PASS2 = "ProbePass456!";

// -- 1. register a fresh seller (auto-session, status onboarding) -----------
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: SELLER_EMAIL, password: SELLER_PASS, fullName: "LT Gate C", displayName: "LTGateC", storeName: "LT Gate C Store" }),
});
const regB = await j(reg);
const sellerId: string | undefined = regB?.data?.seller?.id;
let sellerTok: string | null = regB?.data?.token ?? null;
check("seller register → session minted (status onboarding)", (reg.status === 200 || reg.status === 201) && !!sellerTok && !!sellerId, `status=${reg.status}`);

// -- 2. onboarding seller keeps store access (approval loop intact) --------
{
  const r = await req("GET", "/api/store/me", sellerTok);
  check("onboarding seller store access preserved (GET /api/store/me 200)", r.status === 200, `got ${r.status} ${r.body?.error?.code ?? ""}`);
}

// -- 3. admin approves ------------------------------------------------------
const adm = await login("admin@nomofee.io", "Admin123!", "admin");
const adminTok: string | null = adm.body?.data?.token ?? null;
check("admin (superadmin) login", adm.status === 200 && !!adminTok);

const appr = await req("POST", `/api/admin/sellers/${sellerId}/approve`, adminTok, {});
check("admin approve → seller active + store live", appr.status === 200 && appr.body?.data?.status === "active", `got ${appr.status}`);

// -- 4. active seller ops work ----------------------------------------------
{
  const r = await req("GET", "/api/store/me", sellerTok);
  check("ACTIVE seller store ops work (GET /api/store/me 200)", r.status === 200, `got ${r.status} ${r.body?.error?.code ?? ""}`);
}

// -- 5. F-03 password rotation matrix ---------------------------------------
console.log("\n-- F-03: password rotation --");
{
  const wrong = await req("POST", "/api/me/password", sellerTok, { currentPassword: "WrongCurrent9!", newPassword: SELLER_PASS2 });
  check("wrong current password → 400 INVALID_CURRENT_PASSWORD", wrong.status === 400 && wrong.body?.error?.code === "INVALID_CURRENT_PASSWORD", `got ${wrong.status} ${wrong.body?.error?.code}`);

  const ch = await req("POST", "/api/me/password", sellerTok, { currentPassword: SELLER_PASS, newPassword: SELLER_PASS2 });
  const newTok: string | null = ch.body?.data?.token ?? null;
  check("correct change → 200 + fresh token", ch.status === 200 && !!newTok, `got ${ch.status}`);

  const oldUse = await req("GET", "/api/store/me", sellerTok);
  check("OLD token rejected after rotation (401)", oldUse.status === 401, `got ${oldUse.status}`);

  const newUse = await req("GET", "/api/store/me", newTok);
  check("NEW token works (200)", newUse.status === 200, `got ${newUse.status}`);

  const relogin = await login(SELLER_EMAIL, SELLER_PASS2);
  check("login with NEW password works", relogin.status === 200 && !!relogin.body?.data?.token, `got ${relogin.status}`);

  const oldlogin = await login(SELLER_EMAIL, SELLER_PASS);
  check("login with OLD password → 401", oldlogin.status === 401, `got ${oldlogin.status}`);

  sellerTok = newTok; // rotation happened — use the fresh token from here on
}

// -- 6. admin suspends (live session present) --------------------------------
console.log("\n-- F-02: suspension lifecycle --");
{
  const sus = await req("POST", `/api/admin/sellers/${sellerId}/suspend`, adminTok, { reason: "gate verification" });
  const revoked: number = sus.body?.data?.sessionsRevoked ?? -1;
  check("admin suspend → 200 with sessionsRevoked ≥ 1 (audit field present)", sus.status === 200 && revoked >= 1, `got ${sus.status} sessionsRevoked=${revoked}`);

  const dead = await req("GET", "/api/store/me", sellerTok);
  check("suspended seller's EXISTING session → 401 (revoked immediately)", dead.status === 401, `got ${dead.status}`);

  const relogin = await login(SELLER_EMAIL, SELLER_PASS2);
  check("suspended seller re-login → 403 ACCOUNT_SUSPENDED", relogin.status === 403 && relogin.body?.error?.code === "ACCOUNT_SUSPENDED", `got ${relogin.status} ${relogin.body?.error?.code}`);
}

// -- 7. forged session (DB-injected) — status gates must still hold ----------
console.log("\n-- F-02: forged-session injection (session exists, status suspended) --");
{
  const { db } = await import("../src/lib/db");
  const forged = `f${"a".repeat(63)}`; // 64-hex token shape
  await db.session.create({
    data: { token: forged, userType: "seller", userId: sellerId!, expiresAt: new Date(Date.now() + 60_000) },
  });

  const me = await req("GET", "/api/store/me", forged);
  check("forged live session, suspended → GET /api/store/me 403 ACCOUNT_SUSPENDED", me.status === 403 && me.body?.error?.code === "ACCOUNT_SUSPENDED", `got ${me.status} ${me.body?.error?.code}`);

  const pay = await req("POST", "/api/store/payouts", forged, { amountMinor: 10000 });
  check("forged live session, suspended → payout request 403 ACCOUNT_SUSPENDED", pay.status === 403 && pay.body?.error?.code === "ACCOUNT_SUSPENDED", `got ${pay.status} ${pay.body?.error?.code}`);

  const pub = await req("POST", "/api/store/publish", forged, {});
  check("forged live session, suspended → store republish 403 ACCOUNT_SUSPENDED", pub.status === 403 && pub.body?.error?.code === "ACCOUNT_SUSPENDED", `got ${pub.status} ${pub.body?.error?.code}`);

  const mut = await req("PATCH", "/api/store/products/clx_probe_bogus_product_id", forged, { title: "x" });
  check("forged live session, suspended → product mutation 403 ACCOUNT_SUSPENDED (guard before lookup)", mut.status === 403 && mut.body?.error?.code === "ACCOUNT_SUSPENDED", `got ${mut.status} ${mut.body?.error?.code}`);

  // -- 8. terminate, then the terminated gates --------------------------------
  const term = await req("POST", `/api/admin/sellers/${sellerId}/terminate`, adminTok, { reason: "gate verification cleanup" });
  check("admin terminate → 200 (from suspended)", term.status === 200, `got ${term.status}`);

  const tlogin = await login(SELLER_EMAIL, SELLER_PASS2);
  check("terminated seller login → 403 ACCOUNT_TERMINATED", tlogin.status === 403 && tlogin.body?.error?.code === "ACCOUNT_TERMINATED", `got ${tlogin.status} ${tlogin.body?.error?.code}`);

  // re-inject a forged session AFTER termination (terminate revokes sessions —
  // the earlier forged token was correctly revoked by the terminate call)
  const forged2 = `e${"b".repeat(63)}`;
  await db.session.create({
    data: { token: forged2, userType: "seller", userId: sellerId!, expiresAt: new Date(Date.now() + 60_000) },
  });
  const tme = await req("GET", "/api/store/me", forged2);
  check("forged live session, terminated → 403 ACCOUNT_TERMINATED", tme.status === 403 && tme.body?.error?.code === "ACCOUNT_TERMINATED", `got ${tme.status} ${tme.body?.error?.code}`);
  const tpub = await req("POST", "/api/store/publish", forged2, {});
  check("forged live session, terminated → republish 403 ACCOUNT_TERMINATED", tpub.status === 403 && tpub.body?.error?.code === "ACCOUNT_TERMINATED", `got ${tpub.status} ${tpub.body?.error?.code}`);

  // -- 9. cleanup: remove ALL injected/test rows ------------------------------
  try {
    await db.session.deleteMany({ where: { userId: sellerId! } });
    const store = await db.store.findUnique({ where: { sellerId: sellerId! } });
    if (store) {
      await db.cmsPage.deleteMany({ where: { storeId: store.id } });
      const w = await db.wallet.findUnique({ where: { sellerId: sellerId! } });
      if (w) {
        await db.ledgerAccount.deleteMany({ where: { walletId: w.id } });
        await db.wallet.delete({ where: { id: w.id } });
      }
      await db.store.delete({ where: { id: store.id } });
    }
    await db.seller.delete({ where: { id: sellerId! } });
    const residue = await db.seller.findUnique({ where: { id: sellerId! } });
    check("cleanup: test seller + store + wallet + sessions fully removed", residue === null);
  } catch (e: any) {
    check("cleanup: test seller fully removed", false, e?.message ?? String(e));
  }
  await (db as any).$disconnect?.();
}

console.log(`\n=== Probe C result: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(failCount > 0 ? 1 : 0);

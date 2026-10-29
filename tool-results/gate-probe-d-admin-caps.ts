/**
 * Post-Remediation Verification Gate — Probe D (admin capability matrix).
 *
 * F-09  moderator cannot mutate commission/hold/risk on PATCH sellers/[id];
 *       non-money field (marketplaceOptIn) still editable by any admin.
 * F-18  moderator cannot PUT featured-stores (settings.manage).
 * F-25  moderator cannot POST webhook-deliveries replay (settings.manage).
 * F-26  moderator excluded from KYC queue, banks, seller detail (PII),
 *       bulk CSV export, commission analytics + CSV download.
 *       Preserved legitimate surfaces: seller LIST, report aggregates,
 *       coupon LIST. Finance/ops keep their tiers.
 * Cross-principal 401s: seller token / shopper token / anonymous on admin routes.
 *
 * All writes are no-ops (same current value) or bogus ids — no data changes.
 * Logins: superadmin + moderator + finance + seller = 4 (auth-login bucket).
 */
const BASE = "http://127.0.0.1:3000";

let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
const j = (r: Response) => r.json().catch(() => ({}));

async function login(email: string, password: string, portal: "admin" | "seller") {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal }),
  });
  const body = await j(res);
  return { status: res.status, token: body?.data?.token ?? null };
}

async function req(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await j(res) };
}

console.log("=== Probe D — admin capability matrix ===\n");

const sa = await login("admin@nomofee.io", "Admin123!", "admin");
check("superadmin login", sa.status === 200 && !!sa.token);
const mo = await login("moderator@nomofee.io", "Mod12345!", "admin");
check("moderator login", mo.status === 200 && !!mo.token);
const fi = await login("finance@nomofee.io", "Finance123!", "admin");
check("finance login", fi.status === 200 && !!fi.token);
const se = await login("lumina@nomofee.io", "Seller123!", "seller");
check("seller login (cross-principal probe principal)", se.status === 200 && !!se.token);

// Shopper (separate auth-register bucket)
const reg = await fetch(`${BASE}/api/auth/shopper/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: `lt-gate-d-${Date.now().toString(36)}@probe.local`, password: "ProbePass123!", fullName: "LT Gate D" }),
});
const regB = await j(reg);
const shopperTok: string | null = regB?.data?.token ?? null;
check("shopper register (cross-principal probe principal)", (reg.status === 200 || reg.status === 201) && !!shopperTok);

const SA = sa.token!, MO = mo.token!, FI = fi.token!, SE = se.token!;
if (!SA || !MO || !FI || !SE || !shopperTok) { console.log("ABORT: missing sessions"); process.exit(1); }

// Locate a seeded ACTIVE seller + current values for no-op writes
const list = await req("GET", "/api/admin/sellers?size=50", SA);
const rows: any[] = list.body?.data ?? [];
const target = rows.find((r) => r.status === "active");
check("seeded active seller located", !!target?.id, `rows=${rows.length}`);
const SID = target?.id;

const detailSA = SID ? await req("GET", `/api/admin/sellers/${SID}`, SA) : null;
const curCommission = detailSA?.body?.data?.seller?.commissionOverridePercent ?? null;
const curOptIn = detailSA?.body?.data?.seller?.marketplaceOptIn ?? true;
check("superadmin reads seller detail (commission fields present)", detailSA?.status === 200 && "commissionOverridePercent" in (detailSA?.body?.data?.seller ?? {}), `status=${detailSA?.status}`);

// ---------------------------------------------------------------- moderator tier
console.log("\n-- moderator: capability DENIALS --");
{
  const r1 = await req("PATCH", `/api/admin/sellers/${SID}`, MO, { commissionOverridePercent: curCommission });
  check("F-09: moderator PATCH commissionOverridePercent → 403", r1.status === 403, `got ${r1.status} ${r1.body?.error?.code ?? ""}`);

  const r1b = await req("PATCH", `/api/admin/sellers/${SID}`, MO, { holdDaysOverride: detailSA?.body?.data?.seller?.holdDaysOverride ?? null });
  check("F-09: moderator PATCH holdDaysOverride → 403", r1b.status === 403, `got ${r1b.status}`);

  const r2 = await req("GET", `/api/admin/sellers/${SID}`, MO);
  check("F-26: moderator GET seller detail (KYC/banks/wallet PII) → 403", r2.status === 403, `got ${r2.status}`);

  const r3 = await req("GET", "/api/admin/kyc-queue", MO);
  check("F-26: moderator GET kyc-queue → 403", r3.status === 403, `got ${r3.status}`);

  const r4 = await req("GET", "/api/admin/banks", MO);
  check("F-26: moderator GET banks → 403", r4.status === 403, `got ${r4.status}`);

  const r5 = await req("GET", "/api/admin/export?entity=sellers", MO);
  check("F-26: moderator GET bulk CSV export → 403", r5.status === 403, `got ${r5.status}`);

  const r6 = await req("GET", "/api/admin/commission/analytics", MO);
  check("F-26: moderator GET commission analytics → 403", r6.status === 403, `got ${r6.status}`);

  const r7 = await req("GET", "/api/admin/commission/exports/bogusid/download", MO);
  check("F-26: moderator GET commission CSV download → 403 (cap before 404)", r7.status === 403, `got ${r7.status}`);

  const r8 = await req("POST", "/api/admin/webhook-deliveries/bogusid/replay", MO, {});
  check("F-25: moderator POST webhook-delivery replay → 403 (cap before 404)", r8.status === 403, `got ${r8.status}`);

  const r9 = await req("PUT", "/api/admin/featured-stores", MO, { storeIds: [] });
  check("F-18: moderator PUT featured-stores (Setting write) → 403", r9.status === 403, `got ${r9.status}`);

  const r10 = await req("POST", "/api/admin/coupons", MO, { code: `LTGATE${Date.now().toString(36).toUpperCase()}`, percent: 10 });
  check("coupons: moderator POST create coupon → 403", r10.status === 403, `got ${r10.status}`);
}

console.log("\n-- moderator: PRESERVED legitimate surfaces --");
{
  const r1 = await req("GET", "/api/admin/sellers?size=10", MO);
  check("moderator GET seller LIST → 200 (preserved)", r1.status === 200, `got ${r1.status}`);

  const r2 = await req("GET", "/api/admin/reports/sales", MO);
  check("moderator GET report aggregates → 200 (preserved)", r2.status === 200, `got ${r2.status}`);

  const r3 = await req("GET", "/api/admin/coupons", MO);
  check("moderator GET coupon LIST → 200 (preserved)", r3.status === 200, `got ${r3.status}`);

  const r4 = await req("PATCH", `/api/admin/sellers/${SID}`, MO, { marketplaceOptIn: curOptIn });
  check("F-09 split guard: moderator PATCH marketplaceOptIn (non-money) → 200 no-op", r4.status === 200, `got ${r4.status} ${r4.body?.error?.code ?? ""}`);
}

console.log("\n-- finance tier --");
{
  const r1 = await req("GET", "/api/admin/banks", FI);
  check("finance GET banks → 200 (payout-safety read)", r1.status === 200, `got ${r1.status}`);

  const r2 = await req("GET", `/api/admin/sellers/${SID}`, FI);
  check("finance GET seller detail → 200 (commission overrides live here)", r2.status === 200, `got ${r2.status}`);

  const r3 = await req("GET", "/api/admin/commission/analytics", FI);
  check("finance GET commission analytics → 200", r3.status === 200, `got ${r3.status}`);

  const r4 = await req("GET", "/api/admin/export?entity=sellers", FI);
  check("finance GET bulk CSV export → 200 (reports.export)", r4.status === 200, `got ${r4.status}`);

  const r5 = await req("GET", "/api/admin/kyc-queue", FI);
  check("finance GET kyc-queue → 403 (correctly EXCLUDED — sellers.approve only)", r5.status === 403, `got ${r5.status}`);
}

console.log("\n-- superadmin tier (capability passes) --");
{
  const r1 = await req("PATCH", `/api/admin/sellers/${SID}`, SA, { commissionOverridePercent: curCommission });
  check("superadmin PATCH commissionOverridePercent (no-op same value) → 200", r1.status === 200, `got ${r1.status} ${r1.body?.error?.code ?? ""}`);

  const r2 = await req("GET", "/api/admin/kyc-queue", SA);
  check("superadmin GET kyc-queue → 200", r2.status === 200, `got ${r2.status}`);

  const r3 = await req("POST", "/api/admin/webhook-deliveries/bogusid/replay", SA, {});
  check("superadmin POST replay (bogus id) → 404 NOT_FOUND (cap passed, route logic)", r3.status === 404, `got ${r3.status} ${r3.body?.error?.code ?? ""}`);
}

console.log("\n-- cross-principal 401s on admin routes --");
{
  const r1 = await req("GET", "/api/admin/sellers", SE);
  check("seller token on admin route → 401", r1.status === 401, `got ${r1.status}`);

  const r2 = await req("POST", "/api/admin/coupons", shopperTok, { code: "X", percent: 1 });
  check("shopper token on admin mutation → 401", r2.status === 401, `got ${r2.status}`);

  const r3 = await req("GET", "/api/admin/kyc-queue", null);
  check("anonymous on admin route → 401", r3.status === 401, `got ${r3.status}`);
}

console.log(`\n=== Probe D result: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(failCount > 0 ? 1 : 0);

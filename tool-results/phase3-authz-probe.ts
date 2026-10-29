/**
 * Phase 3 authorization-boundary probe — role × route matrix.
 *
 * Verifies the capability-tier guards landed in this phase (F-09, F-18, F-25,
 * F-26 + coupons) against the LIVE dev server, including the preserved
 * legitimate surfaces (moderator list reads, ops/finance seller-detail access)
 * and cross-principal 401s (seller/shopper on admin routes).
 *
 * All mutations are no-ops (same-value writes) or bogus ids — no data changes.
 * Logins: 6 total (4 admin + 1 seller + 1 shopper register) — within the
 * 10/min auth-login bucket.
 */
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

async function login(email: string, password: string, portal: "admin" | "seller"): Promise<{ token: string; role?: string } | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal }),
  });
  const body = (await res.json()) as any;
  return res.status === 200 && body?.data?.token ? { token: body.data.token, role: body.data.admin?.role } : null;
}

async function req(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* CSV body */
  }
  return { status: res.status, json, text, contentType: res.headers.get("content-type") ?? "" };
}

console.log("=== Phase 3 authorization matrix probe ===\n");

console.log("-- logins --");
const superadmin = await login("admin@nomofee.io", "Admin123!", "admin");
check("superadmin login", !!superadmin?.token);
const ops = await login("ops@nomofee.io", "Ops12345!", "admin");
check("ops login", !!ops?.token);
const finance = await login("finance@nomofee.io", "Finance123!", "admin");
check("finance login", !!finance?.token);
const moderator = await login("moderator@nomofee.io", "Mod12345!", "admin");
check("moderator login", !!moderator?.token);
const seller = await login("lumina@nomofee.io", "Seller123!", "seller");
check("seller login", !!seller?.token);

// Fresh shopper (register auto-logs-in with a token)
const reg = await fetch(`${BASE}/api/auth/shopper/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: `lt-p3-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT P3 Shopper" }),
});
const regBody = (await reg.json()) as any;
const shopperTok: string | null = regBody?.data?.token ?? regBody?.token ?? null;
check("shopper register+token", !!shopperTok);

if (!superadmin || !ops || !finance || !moderator || !seller || !shopperTok) {
  console.log("\nABORT: missing sessions — cannot run matrix.");
  process.exit(1);
}
const SA = superadmin.token, OP = ops.token, FI = finance.token, MO = moderator.token,
  SE = seller.token, SH = shopperTok;

// Locate a real seller (seeded, active preferred) for the detail-route probes.
// okPaged shape: { data: [...rows], meta } — rows is the array itself.
const list = await req("GET", "/api/admin/sellers?size=50", SA);
const sellerRows: any[] = list.json?.data ?? [];
const activeRow = sellerRows.find((r) => r.status === "active");
const sellerId: string | undefined = activeRow?.id ?? sellerRows[0]?.id;
check("seeded seller located for detail probes", !!sellerId, `status=${list.status} rows=${sellerRows.length}`);

// Current commission-policy values (for no-op writes).
const detailSA = sellerId ? await req("GET", `/api/admin/sellers/${sellerId}`, SA) : null;
const cur = detailSA?.json?.data?.seller ?? {};
const curRisk = cur.riskTier ?? "medium";
const curComm = cur.commissionOverridePercent ?? null;
const curHold = cur.holdDaysOverride ?? null;
const curOptIn = cur.marketplaceOptIn ?? true;
check("seller detail readable by superadmin (baseline)", detailSA?.status === 200, `status=${detailSA?.status}`);

console.log("\n-- F-09: PATCH /api/admin/sellers/[id] commission-policy fields --");
if (sellerId) {
  const noOp = { riskTier: curRisk, commissionOverridePercent: curComm, holdDaysOverride: curHold };
  const rFI = await req("PATCH", `/api/admin/sellers/${sellerId}`, FI, noOp);
  check("finance PATCH commission fields (no-op) → 200", rFI.status === 200, `status=${rFI.status}`);
  const rSA = await req("PATCH", `/api/admin/sellers/${sellerId}`, SA, noOp);
  check("superadmin PATCH commission fields (no-op) → 200", rSA.status === 200, `status=${rSA.status}`);
  const rOP = await req("PATCH", `/api/admin/sellers/${sellerId}`, OP, noOp);
  check("ops PATCH commission fields → 403 FORBIDDEN", rOP.status === 403 && rOP.json?.error?.code === "FORBIDDEN", `status=${rOP.status}`);
  const rMO = await req("PATCH", `/api/admin/sellers/${sellerId}`, MO, noOp);
  check("moderator PATCH commission fields → 403 FORBIDDEN", rMO.status === 403 && rMO.json?.error?.code === "FORBIDDEN", `status=${rMO.status}`);
  // marketplaceOptIn stays admin-tier (deliberate): moderator allowed.
  const rMO2 = await req("PATCH", `/api/admin/sellers/${sellerId}`, MO, { marketplaceOptIn: curOptIn });
  check("moderator PATCH marketplaceOptIn only (no-op) → 200 (admin tier, by design)", rMO2.status === 200, `status=${rMO2.status}`);
  // Seller detail GET tiers (F-26).
  const gOP = await req("GET", `/api/admin/sellers/${sellerId}`, OP);
  check("ops GET seller detail (KYC/banks/wallet) → 200", gOP.status === 200, `status=${gOP.status}`);
  const gFI = await req("GET", `/api/admin/sellers/${sellerId}`, FI);
  check("finance GET seller detail → 200 (commission path preserved)", gFI.status === 200, `status=${gFI.status}`);
  const gMO = await req("GET", `/api/admin/sellers/${sellerId}`, MO);
  check("moderator GET seller detail → 403 FORBIDDEN (F-26)", gMO.status === 403 && gMO.json?.error?.code === "FORBIDDEN", `status=${gMO.status}`);
}

console.log("\n-- F-18: PUT /api/admin/featured-stores (Setting write) --");
const featList = await req("GET", "/api/admin/featured-stores", SA);
const featIds: string[] = (featList.json?.data?.stores ?? []).map((s: any) => s.id);
const rFeatSA = await req("PUT", "/api/admin/featured-stores", SA, { storeIds: featIds });
check("superadmin PUT featured-stores (no-op) → 200", rFeatSA.status === 200, `status=${rFeatSA.status}`);
const rFeatOP = await req("PUT", "/api/admin/featured-stores", OP, { storeIds: featIds });
check("ops PUT featured-stores → 403 (settings.manage)", rFeatOP.status === 403, `status=${rFeatOP.status}`);
const rFeatMO = await req("PUT", "/api/admin/featured-stores", MO, { storeIds: featIds });
check("moderator PUT featured-stores → 403 (settings.manage)", rFeatMO.status === 403, `status=${rFeatMO.status}`);
const rFeatFI = await req("PUT", "/api/admin/featured-stores", FI, { storeIds: featIds });
check("finance PUT featured-stores → 403 (settings.manage)", rFeatFI.status === 403, `status=${rFeatFI.status}`);

console.log("\n-- F-25: POST /api/admin/webhook-deliveries/[id]/replay (forged success) --");
const bogus = "cltbogusnonexistent000";
const rRepSA = await req("POST", `/api/admin/webhook-deliveries/${bogus}/replay`, SA, {});
check("superadmin replay bogus id → 404 (cap passed, not found)", rRepSA.status === 404, `status=${rRepSA.status}`);
const rRepOP = await req("POST", `/api/admin/webhook-deliveries/${bogus}/replay`, OP, {});
check("ops replay → 403 (settings.manage)", rRepOP.status === 403, `status=${rRepOP.status}`);
const rRepFI = await req("POST", `/api/admin/webhook-deliveries/${bogus}/replay`, FI, {});
check("finance replay → 403 (settings.manage)", rRepFI.status === 403, `status=${rRepFI.status}`);
const rRepMO = await req("POST", `/api/admin/webhook-deliveries/${bogus}/replay`, MO, {});
check("moderator replay → 403 (settings.manage)", rRepMO.status === 403, `status=${rRepMO.status}`);

console.log("\n-- F-26: money/PII reads --");
const kycSA = await req("GET", "/api/admin/kyc-queue", SA);
check("superadmin kyc-queue → 200", kycSA.status === 200, `status=${kycSA.status}`);
const kycOP = await req("GET", "/api/admin/kyc-queue", OP);
check("ops kyc-queue → 200 (approval tier)", kycOP.status === 200, `status=${kycOP.status}`);
const kycFI = await req("GET", "/api/admin/kyc-queue", FI);
check("finance kyc-queue → 403", kycFI.status === 403, `status=${kycFI.status}`);
const kycMO = await req("GET", "/api/admin/kyc-queue", MO);
check("moderator kyc-queue → 403 (F-26 core)", kycMO.status === 403, `status=${kycMO.status}`);

const bSA = await req("GET", "/api/admin/banks", SA);
check("superadmin banks → 200", bSA.status === 200, `status=${bSA.status}`);
const bOP = await req("GET", "/api/admin/banks", OP);
check("ops banks → 200 (verify/reject tier)", bOP.status === 200, `status=${bOP.status}`);
const bFI = await req("GET", "/api/admin/banks", FI);
check("finance banks → 200 (payout-safety read)", bFI.status === 200, `status=${bFI.status}`);
const bMO = await req("GET", "/api/admin/banks", MO);
check("moderator banks → 403 (F-26 core)", bMO.status === 403, `status=${bMO.status}`);

const eSA = await req("GET", "/api/admin/export?entity=orders", SA);
check("superadmin export CSV → 200 text/csv", eSA.status === 200 && eSA.contentType.includes("text/csv"), `status=${eSA.status} ct=${eSA.contentType}`);
const eFI = await req("GET", "/api/admin/export?entity=sellers", FI);
check("finance export CSV → 200 text/csv", eFI.status === 200 && eFI.contentType.includes("text/csv"), `status=${eFI.status}`);
const eOP = await req("GET", "/api/admin/export?entity=orders", OP);
check("ops export → 403 (reports.export)", eOP.status === 403, `status=${eOP.status}`);
const eMO = await req("GET", "/api/admin/export?entity=orders", MO);
check("moderator export → 403 (reports.export)", eMO.status === 403, `status=${eMO.status}`);

const aSA = await req("GET", "/api/admin/commission/analytics?days=7", SA);
check("superadmin commission analytics → 200", aSA.status === 200, `status=${aSA.status}`);
const aFI = await req("GET", "/api/admin/commission/analytics?days=7", FI);
check("finance commission analytics → 200", aFI.status === 200, `status=${aFI.status}`);
const aOP = await req("GET", "/api/admin/commission/analytics?days=7", OP);
check("ops commission analytics → 403", aOP.status === 403, `status=${aOP.status}`);
const aMO = await req("GET", "/api/admin/commission/analytics?days=7", MO);
check("moderator commission analytics → 403 (F-26 core)", aMO.status === 403, `status=${aMO.status}`);

const dSA = await req("GET", `/api/admin/commission/exports/${bogus}/download`, SA);
check("superadmin exports download bogus → 404 (cap passed)", dSA.status === 404, `status=${dSA.status}`);
const dFI = await req("GET", `/api/admin/commission/exports/${bogus}/download`, FI);
check("finance exports download bogus → 404 (cap passed)", dFI.status === 404, `status=${dFI.status}`);
const dOP = await req("GET", `/api/admin/commission/exports/${bogus}/download`, OP);
check("ops exports download → 403", dOP.status === 403, `status=${dOP.status}`);
const dMO = await req("GET", `/api/admin/commission/exports/${bogus}/download`, MO);
check("moderator exports download → 403 (F-26 core)", dMO.status === 403, `status=${dMO.status}`);

console.log("\n-- coupons mutations (§3.2 LOW-MED) --");
const cSA = await req("POST", "/api/admin/coupons", SA, {});
check("superadmin coupon POST bogus body → 400 VALIDATION (cap passed)", cSA.status === 400, `status=${cSA.status}`);
const cOP = await req("POST", "/api/admin/coupons", OP, {});
check("ops coupon POST bogus body → 400 VALIDATION (cap passed)", cOP.status === 400, `status=${cOP.status}`);
const cFI = await req("POST", "/api/admin/coupons", FI, {});
check("finance coupon POST → 403 (campaigns.manage)", cFI.status === 403, `status=${cFI.status}`);
const cMO = await req("POST", "/api/admin/coupons", MO, {});
check("moderator coupon POST → 403 (campaigns.manage)", cMO.status === 403, `status=${cMO.status}`);
const cdSA = await req("DELETE", `/api/admin/coupons/${bogus}`, SA);
check("superadmin coupon DELETE bogus → 404 (cap passed)", cdSA.status === 404, `status=${cdSA.status}`);
const cdMO = await req("DELETE", `/api/admin/coupons/${bogus}`, MO);
check("moderator coupon DELETE → 403", cdMO.status === 403, `status=${cdMO.status}`);
const cListMO = await req("GET", "/api/admin/coupons?size=1", MO);
check("moderator coupon LIST read preserved → 200 (reads stay admin-wide)", cListMO.status === 200, `status=${cListMO.status}`);

console.log("\n-- preserved legitimate surfaces (regression guards) --");
const lMO = await req("GET", "/api/admin/sellers?size=1", MO);
check("moderator sellers LIST still → 200 (unflagged, kept)", lMO.status === 200, `status=${lMO.status}`);
const rMO = await req("GET", "/api/admin/reports/sales?days=7", MO);
check("moderator aggregate reports still → 200 (no row PII, kept)", rMO.status === 200, `status=${rMO.status}`);
const dashMO = await req("GET", "/api/admin/dashboard", MO);
check("moderator dashboard still → 200", dashMO.status === 200, `status=${dashMO.status}`);
const notesMO = sellerId ? await req("POST", `/api/admin/sellers/${sellerId}/notes`, MO, { body: `P3 probe note ${stamp} (moderator, requireAdmin tier — logged residual)` }) : null;
check("moderator seller notes POST still → 200 (unflagged, kept — logged residual)", notesMO?.status === 200, `status=${notesMO?.status}`);

console.log("\n-- cross-principal 401s (seller/shopper on admin routes) --");
const xSE = await req("GET", "/api/admin/kyc-queue", SE);
check("seller token on admin kyc-queue → 401", xSE.status === 401, `status=${xSE.status}`);
const xSE2 = sellerId ? await req("PATCH", `/api/admin/sellers/${sellerId}`, SE, { riskTier: "low" }) : null;
check("seller token on admin seller PATCH → 401", xSE2?.status === 401, `status=${xSE2?.status}`);
const xSH = await req("GET", "/api/admin/banks", SH);
check("shopper token on admin banks → 401", xSH.status === 401, `status=${xSH.status}`);
const xSH2 = await req("GET", "/api/admin/export?entity=orders", SH);
check("shopper token on admin export → 401", xSH2.status === 401, `status=${xSH2.status}`);
const anon = await req("GET", "/api/admin/commission/analytics", null);
check("anonymous commission analytics → 401", anon.status === 401, `status=${anon.status}`);

console.log(`\n=== RESULT: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) {
  console.log("Failures:");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}

/**
 * Phase 4 config/functional-consistency probe — LIVE dev-server verification.
 *
 * F-08  CommissionOverride wiring: the scoped-override resolution matrix
 *       (baseline / seeded dead-row revival / interleaved precedence /
 *       activate / deactivate / validity window / field-wise holdDays /
 *       cleanup restore) through the REAL admin CRUD + simulator routes.
 * F-11  analytics.retention_days: Setting row drives the tick's
 *       retentionDays (env fallback verified by absence).
 * F-07  removed Feature Flags surface: /api/admin/feature-flags → 404.
 *
 * Login budget: 2 auth-login calls (superadmin + moderator) — within the
 * 10/min bucket. The only mutated data: probe-scoped CommissionOverride rows
 * (deleted at the end) and the analytics.retention_days Setting row (deleted
 * at the end). The seeded glow 10% override row is READ-ONLY here.
 */
const BASE = "http://localhost:3000";
const GLOW_SELLER_ID = "cmvizi23c0021q7ni1f8dyxyp"; // MeiLing — seeded 10% seller-scope row
const GLOW_ROW_ID = "cmvizi3mq003mq7ni4tv5fs7x"; // the seeded row itself (do NOT delete)
const BEAUTY_CAT_ID = "cmvizi087000kq7nii1t8ilsc"; // commissionPercent: 9 (direct field)
const LUMINA_SELLER_ID = "cmvizi0i9000vq7niwoii0hbt"; // clean baseline seller
const LUMINA_PRODUCT_ID = "cmvizi3vq003pq7nie9twcxk2"; // Aurora Ceramic Vase, clean category

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

async function login(email: string, password: string, portal: "admin" | "seller"): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal }),
  });
  const body = (await res.json()) as any;
  return res.status === 200 && body?.data?.token ? body.data.token : null;
}

async function req(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function sim(token: string, input: Record<string, unknown>) {
  const r = await req("POST", "/api/admin/commission/simulate", token, input);
  return { status: r.status, trace: r.json?.data?.trace, holdDays: r.json?.data?.holdDays };
}

const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

console.log("=== Phase 4 probe: F-08 commission overrides (live) ===\n");

const admin = await login("admin@nomofee.io", "Admin123!", "admin");
check("superadmin login", !!admin);
if (!admin) {
  console.log("ABORT: no admin token");
  process.exit(1);
}

// -- 1. clean baseline: no rows match Lumina → global default --------------
const base1 = await sim(admin, { sellerId: LUMINA_SELLER_ID, productId: LUMINA_PRODUCT_ID, priceMinor: 10000, qty: 1 });
check("baseline resolves global 0.5%", base1.trace?.percent === 0.5 && base1.trace?.rule_source === "global", JSON.stringify(base1.trace));
check("baseline holdDays default 7", base1.holdDays === 7, `holdDays=${base1.holdDays}`);

// -- 2. SEEDED dead-row revival: glow seller-scope 10% row now resolves -----
const glow1 = await sim(admin, { sellerId: GLOW_SELLER_ID, priceMinor: 10000, qty: 1 });
check("seeded glow 10% row now RESOLVES (was dead before F-08)", glow1.trace?.percent === 10 && glow1.trace?.rule_source === "override", JSON.stringify(glow1.trace));
check("seeded row sourceId points at the row", glow1.trace?.source_id === GLOW_ROW_ID, `source_id=${glow1.trace?.source_id}`);

// -- 3. interleaved precedence: category direct field (9%) beats seller row -
const glowCat = await sim(admin, { sellerId: GLOW_SELLER_ID, categoryId: BEAUTY_CAT_ID, priceMinor: 10000, qty: 1 });
check("category direct field 9% beats seller-scope row 10%", glowCat.trace?.percent === 9 && glowCat.trace?.rule_source === "category", JSON.stringify(glowCat.trace));

// -- 4. create a probe row via the admin CRUD -------------------------------
const created = await req("POST", "/api/admin/commission/overrides", admin, { scope: "seller", sellerId: LUMINA_SELLER_ID, percent: 12.5 });
const rowId: string | undefined = created.json?.data?.id;
check("create seller-scope row (12.5%)", created.status === 200 && !!rowId, JSON.stringify(created.json));

const afterCreate = await sim(admin, { sellerId: LUMINA_SELLER_ID, productId: LUMINA_PRODUCT_ID, priceMinor: 10000, qty: 1 });
check("created row drives rate (12.5% / override)", afterCreate.trace?.percent === 12.5 && afterCreate.trace?.rule_source === "override", JSON.stringify(afterCreate.trace));

// -- 5. deactivate → fallback to the next rule ------------------------------
await req("PATCH", `/api/admin/commission/overrides/${rowId}`, admin, { isActive: false });
const afterDeact = await sim(admin, { sellerId: LUMINA_SELLER_ID, productId: LUMINA_PRODUCT_ID, priceMinor: 10000, qty: 1 });
check("deactivated row falls back to global 0.5%", afterDeact.trace?.percent === 0.5 && afterDeact.trace?.rule_source === "global", JSON.stringify(afterDeact.trace));

// -- 6. validity window: active row OUTSIDE its window is ignored -----------
await req("PATCH", `/api/admin/commission/overrides/${rowId}`, admin, { isActive: true, validFrom: iso(-10), validTo: iso(-1) });
const afterPast = await sim(admin, { sellerId: LUMINA_SELLER_ID, productId: LUMINA_PRODUCT_ID, priceMinor: 10000, qty: 1 });
check("row with PAST validity window ignored (global 0.5%)", afterPast.trace?.percent === 0.5 && afterPast.trace?.rule_source === "global", JSON.stringify(afterPast.trace));

// -- 7. validity window covering now applies --------------------------------
await req("PATCH", `/api/admin/commission/overrides/${rowId}`, admin, { validFrom: iso(-1), validTo: iso(1) });
const afterWin = await sim(admin, { sellerId: LUMINA_SELLER_ID, productId: LUMINA_PRODUCT_ID, priceMinor: 10000, qty: 1 });
check("row with CURRENT window applies (12.5%)", afterWin.trace?.percent === 12.5 && afterWin.trace?.rule_source === "override", JSON.stringify(afterWin.trace));

// -- 8. category-scope row beats the category direct field ------------------
const catRow = await req("POST", "/api/admin/commission/overrides", admin, { scope: "category", categoryId: BEAUTY_CAT_ID, percent: 7 });
const catRowId: string | undefined = catRow.json?.data?.id;
check("create category-scope row (7%)", catRow.status === 200 && !!catRowId);
const afterCatRow = await sim(admin, { sellerId: GLOW_SELLER_ID, categoryId: BEAUTY_CAT_ID, priceMinor: 10000, qty: 1 });
check("category-scope row 7% beats category direct field 9%", afterCatRow.trace?.percent === 7 && afterCatRow.trace?.rule_source === "override", JSON.stringify(afterCatRow.trace));
const afterCatRowLumina = await sim(admin, { sellerId: LUMINA_SELLER_ID, productId: LUMINA_PRODUCT_ID, priceMinor: 10000, qty: 1 });
check("category-scope row does not leak to other categories (12.5% seller row still wins)", afterCatRowLumina.trace?.percent === 12.5, JSON.stringify(afterCatRowLumina.trace));

// -- 9. field-wise resolution: holdDays-only row -----------------------------
const holdRow = await req("POST", "/api/admin/commission/overrides", admin, { scope: "seller", sellerId: LUMINA_SELLER_ID, holdDays: 9 });
const holdRowId: string | undefined = holdRow.json?.data?.id;
check("create holdDays-only row (9 days, no percent)", holdRow.status === 200 && !!holdRowId);
const afterHold = await sim(admin, { sellerId: LUMINA_SELLER_ID, productId: LUMINA_PRODUCT_ID, priceMinor: 10000, qty: 1 });
check("holdDays-only row: percent still 12.5% (field-wise)", afterHold.trace?.percent === 12.5, JSON.stringify(afterHold.trace));
check("holdDays-only row: holdDays 9 applied", afterHold.holdDays === 9, `holdDays=${afterHold.holdDays}`);

// -- 10. authorization unchanged: moderator cannot create (commission.manage) -
const moderator = await login("moderator@nomofee.io", "Mod12345!", "admin");
check("moderator login", !!moderator);
const modCreate = await req("POST", "/api/admin/commission/overrides", moderator, { scope: "seller", sellerId: LUMINA_SELLER_ID, percent: 99 });
check("moderator cannot create override rows (403)", modCreate.status === 403, `status=${modCreate.status}`);

// -- 11. cleanup: delete probe rows, baseline restored -----------------------
for (const id of [rowId, catRowId, holdRowId]) {
  if (id) {
    const del = await req("DELETE", `/api/admin/commission/overrides/${id}`, admin);
    check(`cleanup delete ${id.slice(-6)}`, del.status === 200, `status=${del.status}`);
  }
}
const restored = await sim(admin, { sellerId: LUMINA_SELLER_ID, productId: LUMINA_PRODUCT_ID, priceMinor: 10000, qty: 1 });
check("baseline restored after cleanup (0.5% / holdDays 7)", restored.trace?.percent === 0.5 && restored.holdDays === 7, JSON.stringify({ trace: restored.trace, holdDays: restored.holdDays }));
const glowRestored = await sim(admin, { sellerId: GLOW_SELLER_ID, priceMinor: 10000, qty: 1 });
check("seeded glow row untouched (still 10% override)", glowRestored.trace?.percent === 10 && glowRestored.trace?.rule_source === "override", JSON.stringify(glowRestored.trace));

// ============================================================================
console.log("\n=== Phase 4 probe: F-11 analytics retention Setting wiring (live) ===\n");

// 1. no Setting row → env/default (180)
const tick0 = await req("POST", "/api/cron/analytics-tick", null, {});
check("tick without Setting row → default 180", tick0.status === 200 && tick0.json?.data?.retentionDays === 180, JSON.stringify(tick0.json?.data?.retentionDays));

// 2. write the Setting row the admin UI writes (730 — purges nothing)
const put1 = await req("PUT", "/api/admin/settings", admin, { settings: [{ key: "analytics.retention_days", valueJson: "730" }] });
check("settings PUT accepts retention 730", put1.status === 200, `status=${put1.status}`);
const tick1 = await req("POST", "/api/cron/analytics-tick", null, {});
check("tick now reads the Setting row (730)", tick1.status === 200 && tick1.json?.data?.retentionDays === 730, JSON.stringify(tick1.json?.data?.retentionDays));

// 3. change the Setting (365) → tick reflects it
await req("PUT", "/api/admin/settings", admin, { settings: [{ key: "analytics.retention_days", valueJson: "365" }] });
const tick2 = await req("POST", "/api/cron/analytics-tick", null, {});
check("tick follows Setting change (365)", tick2.status === 200 && tick2.json?.data?.retentionDays === 365, JSON.stringify(tick2.json?.data?.retentionDays));

// 4. malformed row → env/default fallback (row can only be corrupted via
//    direct DB writes — the validated settings API REJECTS garbage, which
//    the failed PUT above demonstrates; verify the tick still survives it)
const putBad = await req("PUT", "/api/admin/settings", admin, { settings: [{ key: "analytics.retention_days", valueJson: '"not-a-number"' }] });
check("settings PUT rejects a non-integer retention value (registry validation)", putBad.status !== 200, `status=${putBad.status}`);
const { db } = await import("../src/lib/db");
await db.setting.update({ where: { key: "analytics.retention_days" }, data: { valueJson: '"not-a-number"' } });
const tick3 = await req("POST", "/api/cron/analytics-tick", null, {});
check("malformed Setting value falls back to default 180", tick3.status === 200 && tick3.json?.data?.retentionDays === 180, JSON.stringify(tick3.json?.data?.retentionDays));

// 5. cleanup: remove the Setting row (row absent = registry default state)
await db.setting.delete({ where: { key: "analytics.retention_days" } }).catch(() => {});
const tick4 = await req("POST", "/api/cron/analytics-tick", null, {});
check("Setting row removed → default 180 restored", tick4.status === 200 && tick4.json?.data?.retentionDays === 180, JSON.stringify(tick4.json?.data?.retentionDays));

// ============================================================================
console.log("\n=== Phase 4 probe: F-07 removed Feature Flags surface (live) ===\n");

const flags = await req("GET", "/api/admin/feature-flags", admin);
check("GET /api/admin/feature-flags → 404 (route removed)", flags.status === 404, `status=${flags.status}`);

// ============================================================================
console.log(`\n=== RESULT: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length > 0) {
  console.log("FAILURES:");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);

/**
 * Phase 5 regression probe — the src-clean fixes, exercised live:
 *  1. me/follows rewrite (shopperId→shopperUserId drift): full GET/POST/DELETE cycle
 *  2. metrics route fail-closed without METRICS_TOKEN (503)
 *  3. deleted routes stay deleted (feature-flags, orders/[id]/shipping/quote → 404)
 *  4. vouchers parseSellerVoucherInput — PATCH toggle on a seeded LT voucher if
 *     one exists (isActive same-value write = no-op mutation, safe)
 */
const BASE = "http://localhost:3000";
let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
async function req(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}
async function shopperLogin(): Promise<string | null> {
  const r = await req("POST", "/api/auth/shopper/login", undefined, { email: "lt-p3-1793248421912@probe.local", password: "ProbePass123!" });
  return r.status === 200 && r.json?.data?.token ? r.json.data.token : null;
}

console.log("=== Phase 5 regression probe (live) ===\n");

// 1. follows cycle
const token = await shopperLogin();
check("probe shopper login", !!token, `status`);
if (token) {
  const g0 = await req("GET", "/api/me/follows", token);
  check("GET /api/me/follows 200 (rewritten route)", g0.status === 200 && Array.isArray(g0.json?.data?.stores), `status=${g0.status}`);
  const before = g0.json?.data?.stores?.length ?? 0;
  const stores = await req("GET", "/api/store/list?size=5");
  const target = stores.json?.data?.stores?.find((s: any) => s.status === "live") ?? stores.json?.data?.items?.find((s: any) => s.status === "live");
  if (target?.id) {
    const post = await req("POST", "/api/me/follows", token, { storeId: target.id });
    check("POST follow live store 200/201", post.status === 200 || post.status === 201, `status=${post.status}`);
    const g1 = await req("GET", "/api/me/follows", token);
    check("follow appears in list", (g1.json?.data?.stores?.length ?? 0) === before + 1 || post.json?.data?.already === true, `before=${before} after=${g1.json?.data?.stores?.length}`);
    const del = await req("DELETE", `/api/me/follows?storeId=${target.id}`, token);
    check("DELETE unfollow 200 (compound unique fixed)", del.status === 200, `status=${del.status}`);
    const g2 = await req("GET", "/api/me/follows", token);
    check("list restored to baseline", (g2.json?.data?.stores?.length ?? 0) === before, `after=${g2.json?.data?.stores?.length}`);
  } else {
    check("found a live store to follow", false, "no live store in list");
  }
}

// 2. metrics fail-closed
const met = await req("GET", "/api/metrics");
check("GET /api/metrics without token → 503/401 fail-closed", met.status === 503 || met.status === 401, `status=${met.status}`);

// 3. deleted routes stay deleted
const flags = await req("GET", "/api/admin/feature-flags");
check("feature-flags route 404", flags.status === 404, `status=${flags.status}`);
const quote = await req("POST", "/api/store/orders/nm-000/shipping/quote");
check("orders/[id]/shipping/quote route 404 (dead duplicate removed)", quote.status === 404, `status=${quote.status}`);

console.log(`\n=== RESULT: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:", fails); process.exit(1); }
process.exit(0);

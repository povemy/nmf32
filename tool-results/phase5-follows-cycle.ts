const BASE = "http://localhost:3000";
let pass = 0, failCount = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
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
const login = await req("POST", "/api/auth/shopper/login", undefined, { email: "lt-p3-1793248421912@probe.local", password: "ProbePass123!" });
const token = login.json?.data?.token;
check("shopper login", !!token);
const STORE_ID = "cmvs8x7xy000jqmqytue9oxb7"; // [LT] SI Store b (live)
const g0 = await req("GET", "/api/me/follows", token);
const before = g0.json?.data?.stores?.length ?? 0;
check("GET follows 200", g0.status === 200, `status=${g0.status}`);
const post = await req("POST", "/api/me/follows", token, { storeId: STORE_ID });
check("POST follow 200/201", post.status === 200 || post.status === 201, `status=${post.status}`);
const g1 = await req("GET", "/api/me/follows", token);
const after = g1.json?.data?.stores?.length ?? 0;
check("follow visible in list (or already followed)", after === before + 1 || post.json?.data?.already === true, `before=${before} after=${after} already=${post.json?.data?.already}`);
const del = await req("DELETE", `/api/me/follows?storeId=${STORE_ID}`, token);
check("DELETE unfollow 200 (shopperUserId_storeId compound)", del.status === 200, `status=${del.status}`);
const g2 = await req("GET", "/api/me/follows", token);
check("list back to baseline", (g2.json?.data?.stores?.length ?? 0) === before, `final=${g2.json?.data?.stores?.length}`);
console.log(`RESULT: ${pass} PASS / ${failCount} FAIL`);
process.exit(failCount ? 1 : 0);

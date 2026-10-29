const BASE = "http://localhost:3000";
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
const login = await req("POST", "/api/auth/login", undefined, { email: "lumina@nomofee.io", password: "Seller123!", portal: "seller" });
const token = login.json?.data?.token;
console.log("seller login:", login.status === 200 ? "PASS" : "FAIL");
const LUMINA_VOUCHER = "cmvizj0l10001q7op1nrwgg7g"; // LUMINAFS — Lumina's own STORE-scope voucher
const patch = await req("PATCH", `/api/store/vouchers/${LUMINA_VOUCHER}`, token, { isActive: true }); // same-value no-op
console.log("own-voucher PATCH (was 404 dead):", patch.status === 200 ? "PASS" : `FAIL status=${patch.status}`);
const cross = await req("PATCH", "/api/store/vouchers/does-not-exist", token, { isActive: true });
console.log("unknown voucher still 404:", cross.status === 404 ? "PASS" : `FAIL status=${cross.status}`);

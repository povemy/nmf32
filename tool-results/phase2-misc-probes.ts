import { createHmac } from "crypto";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = "") => { console.log(`${c ? "PASS" : "FAIL"} — ${n}${e ? " (" + e + ")" : ""}`); c ? pass++ : fail++; };
const BASE = "http://localhost:3000";
const WH = `${BASE}/api/shipping/webhook/mock`;
const j = (r: Response) => r.json().catch(() => ({}));

// --- shipping webhook signature matrix (nonexistent AWB exercises the auth gates) ---
const sig = (awb: string, status: string, ts: number) => createHmac("sha256", "sm_shipping_webhook_demo").update(`${awb}.${status}.${ts}`).digest("hex");
const ts = Date.now();
let res = await fetch(WH, { method: "POST", headers: { "Content-Type": "application/json", "x-shipping-signature": sig("NM-PROBE-1", "DELIVERED", ts) }, body: JSON.stringify({ awb: "NM-PROBE-1", status: "DELIVERED", ts }) });
check("shipping webhook valid sig → passes auth (404 unknown AWB)", res.status === 404, (await j(res))?.error?.code ?? "");
res = await fetch(WH, { method: "POST", headers: { "Content-Type": "application/json", "x-shipping-signature": "0".repeat(64) }, body: JSON.stringify({ awb: "NM-PROBE-1", status: "DELIVERED", ts }) });
check("shipping webhook bad sig → 400 BAD_SIGNATURE", res.status === 400 && (await j(res))?.error?.code === "BAD_SIGNATURE");
const oldTs = Date.now() - 30 * 60_000;
res = await fetch(WH, { method: "POST", headers: { "Content-Type": "application/json", "x-shipping-signature": sig("NM-PROBE-1", "DELIVERED", oldTs) }, body: JSON.stringify({ awb: "NM-PROBE-1", status: "DELIVERED", ts: oldTs }) });
check("shipping webhook stale replay → 400 STALE_EVENT", res.status === 400 && (await j(res))?.error?.code === "STALE_EVENT");
res = await fetch(WH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ awb: "NM-PROBE-1", status: "DELIVERED", ts }) });
check("shipping webhook NO signature → 400 BAD_SIGNATURE", res.status === 400 && (await j(res))?.error?.code === "BAD_SIGNATURE");
res = await fetch(WH, { method: "POST", headers: { "Content-Type": "application/json", "x-shipping-signature": sig("NM-PROBE-1", "NOT_A_STATUS", ts) }, body: JSON.stringify({ awb: "NM-PROBE-1", status: "NOT_A_STATUS", ts }) });
check("shipping webhook invalid status → 400 VALIDATION", res.status === 400);

// --- login rate limit: 11 rapid attempts → 429 on the 11th ---
let got429 = false; let attempts = 0;
for (let i = 0; i < 12; i++) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `nobody-${i}@x.io`, password: "wrong" }) });
  attempts++;
  if (r.status === 429) { got429 = true; const b = await j(r); check("login 429 carries RATE_LIMITED code", b?.error?.code === "RATE_LIMITED", `at attempt ${attempts}`); break; }
}
check("login brute-force throttle fires (≤12 attempts)", got429, `attempts=${attempts}`);

// --- uniform 401 (no account existence leak) ---
const r1 = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "definitely-not-real@x.io", password: "wrong" }) });
const b1 = await j(r1);
const r2 = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "lumina@nomofee.io", password: "wrong" }) });
const b2 = await j(r2);
check("login 401 identical for unknown vs known email", r1.status === r2.status && b1?.error?.code === b2?.error?.code && b1?.error?.message === b2?.error?.message);
console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);

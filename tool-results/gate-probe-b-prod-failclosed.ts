/**
 * Post-Remediation Verification Gate — Probe B (production fail-closed, NO dev server).
 *
 * Runs the REAL route/module code in an isolated bun process with
 * NODE_ENV=production and secrets deliberately UNSET, to verify the
 * fail-closed branches that cannot be exercised on the dev server
 * (dev intentionally keeps documented public fallbacks):
 *
 *   F-04  webhookSecret(): production + PSP_WEBHOOK_SECRET unset → 503
 *         WEBHOOK_SECRET_UNSET (no fallback to the demo constant).
 *   F-05  shipping webhook route: production + SHIPPING_WEBHOOK_SECRET unset
 *         → 503 SHIPPING_SECRET_UNSET; set + wrong sig → 400 BAD_SIGNATURE;
 *         set + correct sig + unknown AWB → 404 NOT_FOUND (full parity).
 *   F-13  mockPspAllowed(): production + Setting row missing → false;
 *         simulate route in production → 404 (mock rails closed).
 *
 * The dev server process is NOT touched — this is a separate process whose
 * process.env we control before importing the modules.
 */

let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

import { createHmac } from "crypto";
const hmac = (secret: string, msg: string) => createHmac("sha256", secret).update(msg).digest("hex");

console.log("=== Probe B — production fail-closed (isolated modules) ===\n");

// -- 1. F-04: webhookSecret in production -----------------------------------
console.log("-- F-04: webhookSecret() under NODE_ENV=production --");
{
  process.env.NODE_ENV = "production";
  delete process.env.PSP_WEBHOOK_SECRET;

  const proc = await import("../src/app/api/webhooks/payments/process.ts");
  let threw = false, code = "", status = 0;
  try { proc.webhookSecret(); } catch (e: any) { threw = true; code = e?.code ?? ""; status = e?.status ?? 0; }
  check("production + PSP_WEBHOOK_SECRET unset → throws 503 WEBHOOK_SECRET_UNSET", threw && status === 503 && code === "WEBHOOK_SECRET_UNSET", `threw=${threw} status=${status} code=${code}`);

  process.env.PSP_WEBHOOK_SECRET = "prod_secret_probe_value";
  const s = proc.webhookSecret();
  check("production + secret set → returns env value (no fallback)", s === "prod_secret_probe_value", `got ${s}`);
  delete process.env.PSP_WEBHOOK_SECRET;
}

// -- 2. F-05: shipping webhook route under production ------------------------
console.log("\n-- F-05: shipping webhook route under NODE_ENV=production --");
{
  process.env.NODE_ENV = "production";
  delete process.env.SHIPPING_WEBHOOK_SECRET;

  const mod = await import("../src/app/api/shipping/webhook/[provider]/route.ts");
  const mk = (body: unknown, sig?: string) =>
    new Request("http://localhost/api/shipping/webhook/easyparcel", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(sig ? { "x-shipping-signature": sig } : {}) },
      body: JSON.stringify(body),
    });
  const ctx = { params: Promise.resolve({ provider: "easyparcel" }) };

  // (a) secret unset → fail closed. NOTE: a request with NO signature header
  // is rejected earlier (400 BAD_SIGNATURE at the !providedSig check) — still
  // rejected, but the fail-closed SECRET branch is exercised by presenting a
  // signature (the attacker-controlled case: expected-sig computation must
  // refuse to run without the secret).
  const r1 = await mod.POST(mk({ awb: "PROBEPROD", status: "DELIVERED", ts: Date.now() }, "a".repeat(64)), ctx);
  const j1 = await r1.json().catch(() => ({}));
  check("production + signature presented + SHIPPING_WEBHOOK_SECRET unset → 503 SHIPPING_SECRET_UNSET (fail closed)", r1.status === 503 && j1?.error?.code === "SHIPPING_SECRET_UNSET", `got ${r1.status} ${j1?.error?.code}`);

  const r1b = await mod.POST(mk({ awb: "PROBEPROD", status: "DELIVERED", ts: Date.now() }), ctx);
  const j1b = await r1b.json().catch(() => ({}));
  check("production + secret unset + NO signature → 400 BAD_SIGNATURE (rejected before secret resolution — still fail-closed)", r1b.status === 400 && j1b?.error?.code === "BAD_SIGNATURE", `got ${r1b.status} ${j1b?.error?.code}`);

  // (b) secret set + wrong signature → rejected
  process.env.SHIPPING_WEBHOOK_SECRET = "prod_ship_secret";
  const ts = Date.now();
  const r2 = await mod.POST(mk({ awb: "PROBEPROD", status: "DELIVERED", ts }, "0".repeat(64)), ctx);
  const j2 = await r2.json().catch(() => ({}));
  check("production + secret set + wrong signature → 400 BAD_SIGNATURE", r2.status === 400 && j2?.error?.code === "BAD_SIGNATURE", `got ${r2.status} ${j2?.error?.code}`);

  // (c) secret set + CORRECT signature + unknown AWB → passes auth, 404 lookup
  const goodSig = hmac("prod_ship_secret", `PROBEPROD.DELIVERED.${ts}`);
  const r3 = await mod.POST(mk({ awb: "PROBEPROD", status: "DELIVERED", ts }, goodSig), ctx);
  const j3 = await r3.json().catch(() => ({}));
  check("production + correct signature + unknown AWB → 404 NOT_FOUND (valid signed events still work)", r3.status === 404 && j3?.error?.code === "NOT_FOUND", `got ${r3.status} ${j3?.error?.code}`);
  delete process.env.SHIPPING_WEBHOOK_SECRET;
}

// -- 3. F-13: mockPspAllowed + simulate route under production ---------------
console.log("\n-- F-13: mockPspAllowed() + simulate route under NODE_ENV=production --");
{
  process.env.NODE_ENV = "production";

  const psp = await import("../src/lib/psp.ts");
  const allowed = await psp.mockPspAllowed();
  check("production + Setting psp.mock.enabled missing → false (fail closed)", allowed === false, `got ${allowed}`);

  const sim = await import("../src/app/api/checkout/payments/[ref]/simulate/route.ts");
  const req = new Request("http://localhost/api/checkout/payments/ref_probe_missing/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result: "succeeded" }),
  });
  const r = await sim.POST(req, { params: Promise.resolve({ ref: "ref_probe_missing" }) });
  const j = await r.json().catch(() => ({}));
  check("production + mock disabled → simulate endpoint 404 (mock rails closed)", r.status === 404 && j?.error?.code === "NOT_FOUND", `got ${r.status} ${j?.error?.code}`);
}

console.log(`\n=== Probe B result: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(failCount > 0 ? 1 : 0);

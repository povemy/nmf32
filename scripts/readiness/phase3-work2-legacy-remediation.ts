// ============================================================================
// PHASE 3 / WORK 2 — LEGACY STUCK-PAYOUT REMEDIATION (operator API path)
// ----------------------------------------------------------------------------
// Demonstrates the F-1 remediation path on the REAL legacy rows left by the
// Step 4 V-F8 probe (pre-fix code): processing payouts shrunk to 0 and the
// races-suite leftover requested payout. Uses ONLY the sanctioned admin API
// (MFA challenge dance included) — no manual DB writes.
//
//   • fail   on a processing@0 payout  → 200, T-A4f SKIPPED (zero-value)
//   • mark-paid on a processing@0 payout → 200, reference NOT required, T-A4 SKIPPED
//   • reject on the requested leftover  → 200, entries released, no ledger
//
// Verifies afterwards: 0 open payouts remain; the remediations posted NO new
// ledger transactions (zero-value skips); every entry released/bound sanely.
// Writes: docs/staging/evidence/phase3-work2-legacy-remediation.json
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
const rawUrl = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
if (new URL(rawUrl).searchParams.get("schema") !== "nomofee_staging") {
  console.error("[remediate] REFUSED — URL must pin schema=nomofee_staging");
  process.exit(78);
}
const { db } = await import("../../src/lib/db");
const { hashPasswordAsync } = await import("../../src/lib/password");
const { base32Decode, totpCode, totpCounterAt } = await import("../../src/lib/mfa");
const { ACCOUNTS } = await import("../../src/lib/ledger");
const { LT, BASE, check, summary, exitCode, sleep } = await import("./lib");

const stamp = Date.now().toString(36);
const evidence: Record<string, unknown> = { runId: stamp, actions: [] as unknown[] };

async function pFetch(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${BASE}${path}`, init);
    if (r.status === 429 && attempt < 3) {
      const body = await r.json().catch(() => ({}));
      await sleep(Number(body?.error?.details?.retryAfterSeconds ?? 0) * 1000 || 61_000);
      continue;
    }
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }
  throw new Error(`pFetch exhausted: ${path}`);
}

// MFA-enrolled finance admin (real dance)
const email = `lt-w2-rem-${stamp}@nomofee.test`;
const password = "LtW2Rem123!pass";
await db.adminUser.create({ data: { email, name: "LT W2 Remediation", role: "finance", isActive: true, passwordHash: await hashPasswordAsync(password) } });
const li0 = (await pFetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json;
const tok0 = li0?.data?.token;
const en = (await pFetch("/api/admin/mfa/enroll", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` }, body: JSON.stringify({ password }) })).json;
const secret = base32Decode(String(en?.data?.secretBase32 ?? ""));
const cf = await fetch(`${BASE}/api/admin/mfa/confirm`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` }, body: JSON.stringify({ password, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) }) });
if (cf.status !== 200) throw new Error(`MFA confirm ${cf.status}`);
await sleep(Math.max(0, 30_100 - (Date.now() % 30_000)));
const li1 = (await pFetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json;
const vf = (await pFetch("/api/auth/mfa/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: li1?.data?.challenge, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) }) })).json;
const adminH = { "Content-Type": "application/json", Authorization: `Bearer ${vf.data.token}` };

async function accountNet(code: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ net: number }[]>(`
    SELECT sum(CASE WHEN direction='credit' THEN "amountMinor" ELSE -"amountMinor" END)::int AS net
    FROM "LedgerLine" WHERE "accountCode" = '${code}'`);
  return rows[0]?.net ?? 0;
}
async function payoutTxnCount(payoutId: string): Promise<number> {
  return db.ledgerTransaction.count({ where: { refType: "affiliate_payout", refId: payoutId } });
}

const open = await db.affiliatePayout.findMany({ where: { status: { in: ["requested", "processing"] } }, orderBy: { createdAt: "asc" } });
console.log(`legacy open payouts found: ${open.length}`);
const clearingBefore = await accountNet(ACCOUNTS.payoutClearing());

const stuck = open.filter((p) => p.status === "processing" && p.amountMinor === 0);
const requested = open.filter((p) => p.status === "requested");

// 1) fail the first stuck@0
if (stuck.length >= 1) {
  const p = stuck[0];
  const txBefore = await payoutTxnCount(p.id);
  const r = await pFetch(`/api/admin/affiliate/payouts/${p.id}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "fail", reason: `${LT}W2 legacy F-1 remediation (fail at 0)` }) });
  const after = await db.affiliatePayout.findUniqueOrThrow({ where: { id: p.id } });
  const txAfter = await payoutTxnCount(p.id);
  check("REM-1: legacy processing@0 payout FAIL remediation → 200, terminal failed", r.status === 200 && after.status === "failed", `http=${r.status} status=${after.status}`);
  check("REM-1: NO new ledger posting (zero-value T-A4f skipped)", txAfter === txBefore, `txns ${txBefore}→${txAfter}`);
  (evidence.actions as unknown[]).push({ payout: p.id, action: "fail", http: r.status, status: after.status });
}

// 2) mark-paid the second stuck@0 (reference NOT required at amount 0)
if (stuck.length >= 2) {
  const p = stuck[1];
  const txBefore = await payoutTxnCount(p.id);
  const r = await pFetch(`/api/admin/affiliate/payouts/${p.id}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "mark-paid" }) });
  const after = await db.affiliatePayout.findUniqueOrThrow({ where: { id: p.id } });
  const txAfter = await payoutTxnCount(p.id);
  check("REM-2: legacy processing@0 payout MARK-PAID remediation → 200 without reference", r.status === 200 && after.status === "paid", `http=${r.status} status=${after.status}`);
  check("REM-2: NO new ledger posting (zero-value T-A4 skipped)", txAfter === txBefore, `txns ${txBefore}→${txAfter}`);
  (evidence.actions as unknown[]).push({ payout: p.id, action: "mark-paid", http: r.status, status: after.status });
}

// 3) reject the requested leftover (clean release, no ledger ever posted)
for (const p of requested) {
  const r = await pFetch(`/api/admin/affiliate/payouts/${p.id}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "reject", reason: `${LT}W2 legacy requested-payout cleanup` }) });
  const after = await db.affiliatePayout.findUniqueOrThrow({ where: { id: p.id } });
  check("REM-3: legacy requested payout REJECT → 200, entries released", r.status === 200 && after.status === "rejected", `http=${r.status} status=${after.status}`);
  const released = await db.affiliateCommissionEntry.count({ where: { payoutId: p.id, status: { in: ["available", "approved"] } } });
  check("REM-3: claimed entries released back to pool", released === 0, `still-claimed=${released}`);
  (evidence.actions as unknown[]).push({ payout: p.id, action: "reject", http: r.status, status: after.status });
}

const openAfter = await db.affiliatePayout.count({ where: { status: { in: ["requested", "processing"] } } });
check("REM-4: zero open payouts remain in staging", openAfter === 0, `open=${openAfter}`);
const clearingAfter = await accountNet(ACCOUNTS.payoutClearing());
check("REM-5: remediation posted NOTHING to PAYOUT_CLEARING (legacy value preserved as audit record)", clearingAfter === clearingBefore, `${clearingBefore}→${clearingAfter}`);

evidence.finalState = { openPayouts: openAfter, clearingBefore, clearingAfter };
evidence.failures = exitCode();
writeFileSync("docs/staging/evidence/phase3-work2-legacy-remediation.json", JSON.stringify(evidence, null, 2));
const code = summary("phase3-work2-legacy-remediation");
await db.$disconnect();
process.exit(code === 0 ? 0 : 1);

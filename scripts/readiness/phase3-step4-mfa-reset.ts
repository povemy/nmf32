// ============================================================================
// PHASE 3 / STEP 4 — ADMIN MFA RECOVERY ASSESSMENT (§6)
// ----------------------------------------------------------------------------
// Exercises the OFFLINE operator reset runbook (mfa-admin-reset.ts) against a
// dedicated [LT] enrolled finance admin, then verifies the documented recovery
// properties LIVE:
//   R1  One-time recovery codes: mfa-e2e S6 already proved burn-once semantics.
//   R2  Authorized administrator MFA reset: the runbook transactionally deletes
//       the enrollment + revokes every session + writes an audit row.
//   R3  Mandatory re-enrollment after reset: login works but privileged APIs
//       answer 403 MFA_ENROLLMENT_REQUIRED until a fresh enrollment confirms.
//   R4  Audit record of the reset: ActivityLog row admin.mfa.reset exists.
//   R5  Session revocation after reset: pre-reset session dead (anonymous).
// Writes: docs/staging/evidence/phase3-step4-mfa-reset.json
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
const rawUrl = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
if (new URL(rawUrl).searchParams.get("schema") !== "nomofee_staging") {
  console.error("[mfa-reset] REFUSED — URL must pin schema=nomofee_staging");
  process.exit(78);
}
const { db } = await import("../../src/lib/db");
const { hashPasswordAsync } = await import("../../src/lib/password");
const { base32Decode, totpCode, totpCounterAt } = await import("../../src/lib/mfa");
const { check } = await import("./lib");

const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3000";
const stamp = Date.now().toString(36);
const email = `lt-reset-fin-${stamp}@nomofee.test`;
const password = "LtResetFin123!p";
const evidence: Record<string, unknown> = { runId: stamp, target: "nomofee_staging" };

// 1. Create + enroll a finance admin (real API surface).
await db.adminUser.create({ data: { email, name: "LT Reset Finance", role: "finance", isActive: true, passwordHash: await hashPasswordAsync(password) } });
const li0 = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json();
const tok0 = li0?.data?.token as string;
const en = await (await fetch(`${BASE}/api/admin/mfa/enroll`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` }, body: JSON.stringify({ password }) })).json();
const secret = base32Decode(String(en?.data?.secretBase32 ?? ""));
const cf = await fetch(`${BASE}/api/admin/mfa/confirm`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` }, body: JSON.stringify({ password, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) }) });
check("R0.a fixture admin MFA-enrolled + confirmed", cf.status === 200, `confirm=${cf.status}`);
const enrolled = await db.adminMfaEnrollment.findUnique({ where: { adminId: (await db.adminUser.findUnique({ where: { email } }))!.id } });
check("R0.b enrollment row exists pre-reset", Boolean(enrolled), `adminId=${enrolled?.adminId?.slice(-6)}`);

// 2. A privileged call works pre-reset (enrolled, session minted via MFA dance
//    is not needed — the pre-confirm token was revoked by confirm, so do the
//    full challenge login for a live privileged session).
await new Promise((r) => setTimeout(r, Math.max(0, 30_100 - (Date.now() % 30_000))));
const li1 = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json();
const vf = await (await fetch(`${BASE}/api/auth/mfa/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: li1?.data?.challenge, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) }) })).json();
const liveTok = vf?.data?.token as string;
check("R0.c challenge-login mints a live privileged session", Boolean(liveTok), `token=${Boolean(liveTok)}`);
const walletsPre = await fetch(`${BASE}/api/admin/wallets`, { headers: { Authorization: `Bearer ${liveTok}` } });
check("R0.d privileged API works pre-reset", walletsPre.status === 200, `http=${walletsPre.status}`);

// 3. Run the OFFLINE operator reset runbook (the exact operator procedure).
const { spawnSync } = await import("node:child_process");
const reset = spawnSync("bun", ["scripts/readiness/mfa-admin-reset.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, MFA_ADMIN_RESET_CONFIRM: "yes-verified-out-of-band", MFA_ADMIN_EMAIL: email, OPERATOR_EMAIL: "lt-ops-operator@nomofee.test" },
  encoding: "utf8",
});
console.log("[mfa-reset] runbook output:\n" + String(reset.stdout ?? "").trim() + String(reset.stderr ?? "").trim());
check("R2.a operator reset runbook exits clean", reset.status === 0, `exit=${reset.status}`);

// 4. Post-reset verification.
const adminRow = await db.adminUser.findUniqueOrThrow({ where: { email } });
const enrollmentAfter = await db.adminMfaEnrollment.findUnique({ where: { adminId: adminRow.id } });
check("R2.b enrollment row deleted by the reset", !enrollmentAfter, `row=${Boolean(enrollmentAfter)}`);
const auditRow = await db.activityLog.findFirst({ where: { actorId: adminRow.id, action: "admin.mfa.reset" }, orderBy: { createdAt: "desc" } });
check("R4 audit row admin.mfa.reset written (operator recorded)", Boolean(auditRow) && (auditRow?.actorLabel ?? "").includes("lt-ops-operator"), `action=${auditRow?.action} operator=${auditRow?.actorLabel}`);
const sessionsAfter = await db.session.count({ where: { userType: "admin", userId: adminRow.id } });
check("R5.a every admin session revoked", sessionsAfter === 0, `sessions=${sessionsAfter}`);
const meAfterReset = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${liveTok}` } });
const meBody = await meAfterReset.json().catch(() => ({}));
// userType null (JSON null) OR undefined ⇒ anonymous ⇒ the revoked token no
// longer authenticates. (A `?? "none"` default would swallow the null case.)
check("R5.b pre-reset token no longer authenticates", meBody?.data?.userType == null, `userType=${JSON.stringify(meBody?.data?.userType)}`);

// 5. Mandatory re-enrollment: password login works, privileged API restricted.
const li2 = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json();
const tok2 = li2?.data?.token as string;
check("R3.a password-only login works after reset", Boolean(tok2), `token=${Boolean(tok2)}`);
const walletsPost = await fetch(`${BASE}/api/admin/wallets`, { headers: { Authorization: `Bearer ${tok2}` } });
const wpBody = await walletsPost.json().catch(() => ({}));
check("R3.b privileged API blocked until re-enrollment (403 MFA_ENROLLMENT_REQUIRED)", walletsPost.status === 403 && wpBody?.error?.code === "MFA_ENROLLMENT_REQUIRED", `http=${walletsPost.status} code=${wpBody?.error?.code}`);
const statusPost = await fetch(`${BASE}/api/admin/mfa/status`, { headers: { Authorization: `Bearer ${tok2}` } });
check("R3.c MFA bootstrap routes stay reachable while restricted", statusPost.status === 200, `http=${statusPost.status}`);

evidence.summary = {
  oneTimeRecoveryCodes: "burn-once semantics proven by mfa-e2e S6 (staging run 2026-11-02)",
  authorizedReset: "offline runbook only — no online self-service reset route exists (grep: no admin MFA reset API route)",
  mandatoryReenrollment: walletsPost.status === 403,
  auditRecord: Boolean(auditRow),
  sessionRevocation: sessionsAfter === 0,
};
writeFileSync("docs/staging/evidence/phase3-step4-mfa-reset.json", JSON.stringify(evidence, null, 2));

// cleanup
await db.session.deleteMany({ where: { userType: "admin", userId: adminRow.id } });
await db.activityLog.deleteMany({ where: { actorId: adminRow.id } });
await db.adminUser.delete({ where: { id: adminRow.id } });
console.log("\n[mfa-reset] assessment complete — evidence written.");
await db.$disconnect();

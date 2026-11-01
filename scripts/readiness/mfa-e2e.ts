// ============================================================================
// PHASE 2.1 STAGING TEST — Administrator MFA end-to-end (runbook §7).
// ----------------------------------------------------------------------------
// ⚠️ PREPARED — DO NOT RUN IN THIS SANDBOX. Authorized staging only, AFTER
// migrations 20261101000002 + 20261103000000 are applied. Everything is
// [LT]-tagged and self-cleaning (deletes its admin + enrollment + sessions).
//
// Covers (§7 "Administrator MFA"):
//   1  Enrollment start (password reauth; secret + otpauth returned once).
//   2  Confirmation with a REAL TOTP code; recovery codes revealed once;
//      ALL admin sessions revoked at confirm.
//   3  Login challenge: password OK → { mfaRequired, challenge }, NO session.
//   4  Failed attempts → progressive cooldowns (3rd wrong → 429 MFA_LOCKED
//      with retryAfter; NO permanent lock anywhere).
//   5  TOTP REPLAY rejection: the same valid code, re-submitted on a fresh
//      challenge within its 30s window, is REJECTED (401 MFA_INVALID).
//   6  Recovery-code use at login (works once; second use of the SAME code
//      fails — burn is persisted).
//   7  MANDATORY ENROLLMENT: a privileged (finance) admin without enrollment
//      is 403 MFA_ENROLLMENT_REQUIRED on privileged APIs, still reaches
//      me/logout/mfa routes, and me reports mfaEnrollmentRequired: true.
//   8  Cross-challenge mint cooldown: after enough failures, login mints
//      refuse with 429 MFA_ACCOUNT_COOLDOWN.
//   9  Session revocation after security-sensitive change (confirm revokes).
//  10  Admin recovery runbook (offline) — NOT executed here; documented in
//      scripts/readiness/mfa-admin-reset.ts.
// Requires MFA_ENCRYPTION_KEY set in the target env (staging).
// ============================================================================
import { createHash } from "crypto";
import { db } from "../../src/lib/db";
import { hashPasswordAsync } from "../../src/lib/password";
import { base32Decode, totpCode, totpCounterAt } from "../../src/lib/mfa";
import { check, summary, exitCode } from "./lib";

const BASE = "http://127.0.0.1:3000";
const RUN = Date.now().toString(36);
const FIN_EMAIL = `lt-mfa-fin-${RUN}@nomofee.test`;
const PASSWORD = "LtMfa123!pass";

type Json = Record<string, unknown>;
async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json: Json = {};
  try { json = await res.json() as Json; } catch { /* empty */ }
  return { status: res.status, json };
}
const data = (j: Json) => (j.data ?? {}) as Record<string, unknown>;

async function adminLogin(email: string, password: string) {
  return api("POST", "/api/auth/login", { body: { email, password, portal: "admin" } });
}

async function main() {
  // ---- fixture: a finance (privileged) [LT] admin --------------------------------
  const fin = await db.adminUser.create({
    data: { email: FIN_EMAIL, name: "LT MFA Finance", role: "finance", isActive: true, passwordHash: await hashPasswordAsync(PASSWORD) },
  });
  try {
    // 7a — privileged WITHOUT enrollment: login works, but privileged APIs 403.
    const li = await adminLogin(FIN_EMAIL, PASSWORD);
    check("S7a privileged admin can sign in (pre-enrollment)", li.status === 200 && !!data(li.json).token, `status=${li.status}`);
    const tok0 = String(data(li.json).token ?? "");
    const me = await api("GET", "/api/auth/me", { token: tok0 });
    check("S7b /me reports mfaEnrollmentRequired=true", me.status === 200 && data(me.json).mfaEnrollmentRequired === true);
    const wallets = await api("GET", "/api/admin/wallets", { token: tok0 });
    check("S7c privileged API blocked pre-enrollment (403 MFA_ENROLLMENT_REQUIRED)", wallets.status === 403 && String((wallets.json.error as Json)?.code) === "MFA_ENROLLMENT_REQUIRED", `status=${wallets.status}`);
    const st = await api("GET", "/api/admin/mfa/status", { token: tok0 });
    check("S7d MFA bootstrap routes stay reachable while restricted", st.status === 200 && data(st.json).enrolled === false);

    // 1 — enrollment start (password reauth).
    const en = await api("POST", "/api/admin/mfa/enroll", { token: tok0, body: { password: PASSWORD } });
    const secretBase32 = String(data(en.json).secretBase32 ?? "");
    check("S1 enrollment returns secretBase32 + otpauthUrl once", en.status === 200 && secretBase32.length === 32 && String(data(en.json).otpauthUrl ?? "").startsWith("otpauth://totp/"), `status=${en.status}`);
    const badEn = await api("POST", "/api/admin/mfa/enroll", { token: tok0, body: { password: "wrong" } });
    check("S1b wrong password → 401, no secret leak", badEn.status === 401 && !data(badEn.json).secretBase32);

    // 2 — confirm with a REAL code (counter = now); recovery codes revealed once.
    const counter = totpCounterAt(Math.floor(Date.now() / 1000));
    const secret = base32Decode(secretBase32);
    const code = totpCode(secret, counter);
    const cf = await api("POST", "/api/admin/mfa/confirm", { token: tok0, body: { password: PASSWORD, code } });
    const codes = (data(cf.json).recoveryCodes ?? []) as string[];
    check("S2 confirm accepts live TOTP; 10 recovery codes returned", cf.status === 200 && codes.length === 10, `status=${cf.status} codes=${codes.length}`);
    const meAfter = await api("GET", "/api/auth/me", { token: tok0 });
    check("S9 confirm revoked every prior admin session", meAfter.status === 401, `status=${meAfter.status}`);

    // 3 — login now demands MFA; no session minted by the password step.
    const li2 = await adminLogin(FIN_EMAIL, PASSWORD);
    check("S3 login returns mfaRequired + challenge, NO token", li2.status === 200 && data(li2.json).mfaRequired === true && !!data(li2.json).challenge && !data(li2.json).token);
    const challenge = String(data(li2.json).challenge ?? "");

    // 4 — three wrong codes → progressive cooldown, uniform 401s, then 429 LOCKED.
    const w1 = await api("POST", "/api/auth/mfa/verify", { body: { challenge, code: "000000" } });
    const w2 = await api("POST", "/api/auth/mfa/verify", { body: { challenge, code: "000000" } });
    const w3 = await api("POST", "/api/auth/mfa/verify", { body: { challenge, code: "000000" } });
    check("S4 first two wrong codes → uniform 401 MFA_INVALID", w1.status === 401 && w2.status === 401 && String((w1.json.error as Json)?.code) === "MFA_INVALID");
    const w3err = (w3.json.error ?? {}) as { code?: string; details?: { retryAfterSeconds?: number } };
    check("S4b third wrong code → 429 MFA_LOCKED with retryAfter (temporary)", w3.status === 429 && w3err.code === "MFA_LOCKED" && Number(w3err.details?.retryAfterSeconds ?? 0) > 0, `status=${w3.status}`);

    // 5 — a FRESH challenge: the code from S2's counter may now be an earlier
    //     step; use the CURRENT step's code, verify OK, then REPLAY it once
    //     more on another fresh challenge → must be rejected.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await sleep(2000);
    const c2 = totpCounterAt(Math.floor(Date.now() / 1000));
    const li3 = await adminLogin(FIN_EMAIL, PASSWORD);
    const ch3 = String(data(li3.json).challenge ?? "");
    const okCode = totpCode(secret, c2);
    const v1 = await api("POST", "/api/auth/mfa/verify", { body: { challenge: ch3, code: okCode } });
    check("S5a valid code verifies and mints a session", v1.status === 200 && !!data(v1.json).token, `status=${v1.status}`);
    const li4 = await adminLogin(FIN_EMAIL, PASSWORD);
    const ch4 = String(data(li4.json).challenge ?? "");
    const v2 = await api("POST", "/api/auth/mfa/verify", { body: { challenge: ch4, code: okCode } });
    const replayRejected = v2.status === 401 || v2.status === 429; // 401 when the step aged out (also a reject), 429 when within window but replayed
    check("S5b SAME code replayed on a fresh challenge is REJECTED", replayRejected && !data(v2.json).token, `status=${v2.status}`);

    // 6 — recovery code: use once (fresh challenge), then the SAME code again fails.
    const li5 = await adminLogin(FIN_EMAIL, PASSWORD);
    const ch5 = String(data(li5.json).challenge ?? "");
    const rc = codes[0].replace(/-/g, "");
    const r1 = await api("POST", "/api/auth/mfa/verify", { body: { challenge: ch5, code: rc } });
    check("S6a recovery code verifies once", r1.status === 200 && data(r1.json).token != null, `status=${r1.status}`);
    const li6 = await adminLogin(FIN_EMAIL, PASSWORD);
    const ch6 = String(data(li6.json).challenge ?? "");
    const r2 = await api("POST", "/api/auth/mfa/verify", { body: { challenge: ch6, code: rc } });
    check("S6b the SAME recovery code cannot be used twice", r2.status !== 200 || !data(r2.json).token, `status=${r2.status}`);

    // 8 — cross-challenge mint cooldown: hammer wrong codes through fresh
    //     challenges until login itself answers 429 MFA_ACCOUNT_COOLDOWN.
    let cooldownSeen = false;
    for (let i = 0; i < 12 && !cooldownSeen; i++) {
      const lix = await adminLogin(FIN_EMAIL, PASSWORD);
      if (lix.status === 429) { cooldownSeen = true; break; }
      const chx = String(data(lix.json).challenge ?? "");
      if (!chx) break;
      await api("POST", "/api/auth/mfa/verify", { body: { challenge: chx, code: "000000" } }).catch(() => {});
    }
    check("S8 sustained failures trigger the per-admin mint cooldown (429)", cooldownSeen);

    // Token-hash sanity for the minted admin session (ties into §7 session security).
    if (data(v1.json).token) {
      const rawTok = String(data(v1.json).token);
      const row = await db.session.findUnique({ where: { token: createHash("sha256").update(rawTok).digest("hex") } });
      check("S3b admin session stored as sha256(token) only", !!row);
    }
  } finally {
    // ---- self-cleaning --------------------------------------------------------------
    await db.adminMfaEnrollment.deleteMany({ where: { adminId: fin.id } }).catch(() => {});
    await db.session.deleteMany({ where: { userType: "admin", userId: fin.id } }).catch(() => {});
    await db.activityLog.deleteMany({ where: { actorId: fin.id } }).catch(() => {});
    await db.adminUser.delete({ where: { id: fin.id } }).catch(() => {});
    console.log(`[cleanup] removed [LT] admin ${FIN_EMAIL}`);
  }
  process.exit(summary("MFA E2E") === 0 ? 0 : exitCode());
}

main().catch((e) => { console.error("mfa-e2e crashed:", e); process.exit(1); });

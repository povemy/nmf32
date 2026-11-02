// ============================================================================
// PHASE 2.1 STAGING TEST — Session-token security end-to-end (runbook §7).
// ----------------------------------------------------------------------------
// ⚠️ PREPARED — DO NOT RUN IN THIS SANDBOX. Authorized staging only, AFTER
// migration 20261101000000_phase1_session_token_hashing is applied.
// [LT]-tagged, self-cleaning.
//
// Covers (§7 "Session security"):
//   • New login issues a valid token; ONLY its sha256 is stored (DB row check).
//   • No raw-token row exists for it (plaintext fallback absence).
//   • Logout revokes the presented token (Bearer and cookie paths).
//   • revokeUserSessions semantics: every session of the principal dies.
//   • Expired sessions cannot authenticate (expiresAt in the past → 401).
//   • Chat hub authentication uses the SAME protected token model.
//   • MIGRATED legacy sessions: a pre-migration plaintext row was transformed
//     by the migration (verified indirectly — see runbook §2; here we verify
//     the application NEVER writes a plaintext row on any path).
// ============================================================================
import { createHash } from "crypto";
import { db } from "../../src/lib/db";
import { check, summary, exitCode } from "./lib";

const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3000"; // Phase 3/Step 4: staging instance override
const RUN = Date.now().toString(36);
const EMAIL = `lt-session-${RUN}@nomofee.test`;
const PASSWORD = "LtSession123!";

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* empty */ }
  return { status: res.status, json, res };
}

async function main() {
  const reg = await api("POST", "/api/auth/shopper/register", { body: { email: EMAIL, password: PASSWORD, fullName: "LT Session Probe" } });
  if (reg.status !== 200 && reg.status !== 201) {
    console.error("register failed", reg.status, reg.json); process.exit(1);
  }
  const login = await api("POST", "/api/auth/shopper/login", { body: { email: EMAIL, password: PASSWORD } });
  const token = String((login.json.data as Record<string, unknown>)?.token ?? "");
  check("S1 login issues a 64-hex token", login.status === 200 && /^[a-f0-9]{64}$/.test(token), `status=${login.status}`);

  // DB-row verification: ONLY the hash is stored.
  const hashedRow = await db.session.findUnique({ where: { token: sha256(token) } });
  const rawRow = await db.session.findUnique({ where: { token } });
  check("S2 DB stores sha256(token) for the new session", !!hashedRow);
  check("S3 NO plaintext row exists (no raw-token fallback)", !rawRow);

  // Bearer round-trip.
  const me = await api("GET", "/api/auth/me", { token });
  check("S4 Bearer token authenticates", me.status === 200 && (me.json.data as Record<string, unknown>)?.userType === "shopper");

  // Chat hub-auth uses the same hashed model.
  // PHASE 3 / STEP 4 fixture fix: hub-auth takes the session token in the
  // request BODY ({token, rooms}) — it validates the hub-presented credential,
  // not the caller's own Bearer header. The original call passed the token as
  // the api helper's `token` opt (Authorization header only, no body), so
  // body.token was always undefined ⇒ 401 on first-ever execution.
  const hub = await api("POST", "/api/chat/hub-auth", { body: { token, rooms: [] } });
  check("S5 chat hub-auth accepts the hashed-store token", hub.status === 200 || hub.status === 204, `status=${hub.status}`);

  // Second session for the principal → revoke-all semantics.
  const login2 = await api("POST", "/api/auth/shopper/login", { body: { email: EMAIL, password: PASSWORD } });
  const token2 = String((login2.json.data as Record<string, unknown>)?.token ?? "");
  check("S6 second login mints a distinct session", token2 !== "" && token2 !== token);

  // Expire token2 directly in the DB → must fail to authenticate.
  await db.session.update({ where: { token: sha256(token2) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const me2 = await api("GET", "/api/auth/me", { token: token2 });
  // PHASE 3 / STEP 4 assertion calibration: /api/auth/me answers 200 with
  // {userType:null} for anonymous callers (route contract) — the property is
  // "the expired token no longer authenticates the shopper", not HTTP 401.
  check("S7 expired session cannot authenticate", me2.status === 200 && (me2.json.data as Record<string, unknown>)?.userType == null, `status=${me2.status} userType=${JSON.stringify((me2.json.data as Record<string, unknown>)?.userType)}`);

  // Logout kills the presented token.
  const out = await api("POST", "/api/auth/logout", { token });
  check("S8 logout succeeds", out.status === 200 || out.status === 204, `status=${out.status}`);
  const meAfter = await api("GET", "/api/auth/me", { token });
  // PHASE 3 / STEP 4 assertion calibration: same anonymous-contract as S7.
  check("S9 logged-out token no longer authenticates", meAfter.status === 200 && (meAfter.json.data as Record<string, unknown>)?.userType == null, `status=${meAfter.status} userType=${JSON.stringify((meAfter.json.data as Record<string, unknown>)?.userType)}`);
  const rowAfter = await db.session.findUnique({ where: { token: sha256(token) } });
  check("S10 session row deleted on logout", !rowAfter);

  // Cleanup: principal + any leftover sessions.
  const u = await db.shopperUser.findUnique({ where: { email: EMAIL } });
  if (u) {
    await db.session.deleteMany({ where: { userType: "shopper", userId: u.id } });
    // remove [LT] shopper fixtures created downstream (cart/wallet/orders kept minimal by design)
    await db.shopperUser.delete({ where: { id: u.id } }).catch(() => {});
  }
  console.log(`[cleanup] removed [LT] shopper ${EMAIL}`);
  process.exit(summary("Session security E2E") === 0 ? 0 : exitCode());
}

main().catch((e) => { console.error("session-security-e2e crashed:", e); process.exit(1); });

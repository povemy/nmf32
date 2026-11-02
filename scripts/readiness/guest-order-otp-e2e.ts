// ============================================================================
// FINAL CLOSURE STAGING TEST — Guest-order OTP + email-verified claiming
// (mandate §7). Everything the unit tests cannot reach: challenge rows, CAS
// consumption, attempt lockout, grants over real HTTP, the registration
// claiming attack, and exactly-once legitimate claiming.
// ----------------------------------------------------------------------------
// ⚠️ PREPARED — DO NOT RUN IN THIS SANDBOX. Authorized staging only, AFTER
// migration 20261104000000 is applied AND a transactional email provider is
// configured. All fixtures are [LT]-tagged and self-cleaning. ZERO financial
// writes: the test orders stay payment_pending on purpose (the receipt's
// payment gate is proven via 401-before-409 ordering, not via a paid order).
//
// OTP code retrieval — two HONEST modes (no simulated delivery):
//   A) MAILPIT_URL=http://127.0.0.1:8025 — a REAL local SMTP provider; the
//      script reads the code from its REST inbox (/api/v1/messages).
//   B) GUEST_OTP_TEST_CODE=123456 — operator-driven manual run: a human
//      reads the code from the real mailbox and provides it.
//
// Covers (§7 list):
//   1  Knowledge-pair-only lookup DENIAL (existing order → 401, no data;
//      non-existent order → IDENTICAL 401 — no existence oracle).
//   2  OTP request uniformity (200 for existing AND non-existing pairs).
//   3  OTP brute-force lockout: 5 wrong codes lock the challenge — then the
//      CORRECT code is STILL rejected while the row is unexpired (attempt
//      counters survive re-issuance; only TTL expiry resets them).
//   4  OTP verification + grant issuance (grant present, order-bound).
//   5  OTP replay prevention (same code twice → second verify 401).
//   6  Grant authorization: right order → 200; wrong orderNumber → 401;
//      forged grant → 401.
//   7  Receipt authorization: unauthenticated → 401 BEFORE the payment gate
//      (never 409); grant-holder on payment_pending → 409 NOT_PAID (grant
//      accepted, payment gate retained).
//   8  ATTACK: register an account with the victim's email (unverified) →
//      login claims NOTHING; the guest orders stay shopperId=null; the
//      unverified account cannot read them either.
//   9  Legitimate claiming EXACTLY ONCE: verify email ownership → both guest
//      orders claimed; re-verify/re-login → 0 more.
//  10  Authenticated shopper ownership: owner session lookup → 200; a
//      DIFFERENT shopper's session → 401 (uniform).
//
// Rate-limit budget: sleeps are placed so every per-IP minute window stays
// under its ceiling (lookup 10/min, otp-verify 10/min, register 5/min). The
// pair request count is 3 (= the 3/h pair limit). One staging-only shortcut:
// after the lockout proof, the [LT] challenge row's expiresAt is aged out
// directly (DB write to the TEST'S OWN row) to avoid a real 10-minute sleep.
// ============================================================================
// @ts-nocheck
import { db } from "../../src/lib/db";
import { check, summary, exitCode } from "./lib";

const BASE = process.env.STAGING_BASE_URL ?? "http://127.0.0.1:3000";
const RUN = Date.now().toString(36);
const MAILPIT = process.env.MAILPIT_URL ?? "";
const MANUAL_CODE = process.env.GUEST_OTP_TEST_CODE ?? "";
const PASSWORD = "LtGuestOtp123!";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, unknown>;
async function api(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: Json = {};
  try { json = (await res.json()) as Json; } catch { /* empty */ }
  return { status: res.status, json };
}
const data = (j: Json) => (j.data ?? {}) as Record<string, unknown>;
const errCode = (j: Json) => ((j.error as { code?: string } | undefined)?.code ?? "");

/** Read the freshest 6-digit code from the configured REAL provider.
 *  `subjectPart` narrows to a specific email; empty = any code email.
 *  PHASE 3 / STEP 4 fix: Mailpit's LIST endpoint (/api/v1/messages) returns
 *  message summaries WITHOUT the Text body — the code regex always saw "".
 *  Match the subject in the list, then fetch the message DETAIL
 *  (/api/v1/message/{ID}) for the body (verified live against Mailpit
 *  v1.21: list hit found, Text empty; detail contains the 6-digit code). */
async function readCodeFromMailbox(subjectPart: string): Promise<string> {
  if (MANUAL_CODE) return MANUAL_CODE;
  if (!MAILPIT) throw new Error("Set MAILPIT_URL (real local provider) or GUEST_OTP_TEST_CODE (operator run)");
  for (let i = 0; i < 30; i++) {
    await sleep(1_000);
    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=10`);
    if (!res.ok) continue;
    const body = (await res.json()) as { messages?: { ID?: string; Subject?: string }[] };
    const messages = body.messages ?? [];
    const hit = subjectPart
      ? messages.find((m) => (m.Subject ?? "").includes(subjectPart))
      : messages[0];
    if (hit?.ID) {
      const detail = await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`);
      if (detail.ok) {
        const dm = (await detail.json()) as { Text?: string };
        const m = (dm.Text ?? "").match(/\b(\d{6})\b/);
        if (m) return m[1];
      }
    }
  }
  throw new Error(`No OTP email (subject~${subjectPart || "any"}) with a 6-digit code arrived within 30s`);
}

async function shopperSession(email: string, password: string) {
  const res = await fetch(`${BASE}/api/auth/shopper/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, json, cookie };
}

async function main() {
  const store = await db.store.findFirst({ select: { id: true } });
  if (!store) throw new Error("no store fixture for [LT] guest order");

  const victimEmail = `lt-guest-victim-${RUN}@nomofee.test`;
  const otherEmail = `lt-guest-other-${RUN}@nomofee.test`;
  const orderNumber = `NM-LT${RUN.slice(-6).toUpperCase()}`;

  // ---- fixtures: two LEGACY guest orders (shopperId null, payment_pending) ---
  // No items/history/payment rows; deleted wholesale at the end. Keeping them
  // payment_pending makes this script 100% non-financial.
  const order1 = await db.order.create({
    data: {
      storeId: store.id,
      orderNumber,
      customerName: "LT Guest Victim",
      customerEmail: victimEmail,
      customerPhone: "+60120000000",
      status: "payment_pending",
      currency: "MYR",
      totalMinor: 4_200,
      shippingAddressJson: JSON.stringify({ line1: "[LT] test", city: "KL", postcode: "50000", country: "MY" }),
    },
  });
  const order2 = await db.order.create({
    data: {
      storeId: store.id,
      orderNumber: `NM-LT2${RUN.slice(-6).toUpperCase()}`,
      customerName: "LT Guest Victim",
      customerEmail: victimEmail,
      status: "payment_pending",
      currency: "MYR",
      totalMinor: 1_100,
    },
  });

  try {
    // -- 1. Knowledge-pair-only lookup DENIAL -----------------------------------
    const existing = await api("GET", `/api/orders/lookup?email=${encodeURIComponent(victimEmail)}&orderNumber=${orderNumber}`);
    check("1a knowledge-pair lookup DENIED (existing order)", existing.status === 401 && errCode(existing.json) === "ORDER_VERIFICATION_REQUIRED", `status=${existing.status}`);
    const ghost = await api("GET", `/api/orders/lookup?email=${encodeURIComponent(victimEmail)}&orderNumber=NM-DOESNOTEXIST`);
    check(
      "1b ghost order → IDENTICAL 401 body (no oracle)",
      ghost.status === 401 && errCode(ghost.json) === "ORDER_VERIFICATION_REQUIRED" && JSON.stringify(data(ghost.json)) === JSON.stringify(data(existing.json)),
      `status=${ghost.status}`
    );

    // -- 2. OTP request uniformity ----------------------------------------------
    const req1 = await api("POST", "/api/orders/otp/request", { body: { email: victimEmail, orderNumber } });
    check("2a OTP request (existing pair) → uniform 200", req1.status === 200 && data(req1.json).sent === true, `status=${req1.status}`);
    const reqGhost = await api("POST", "/api/orders/otp/request", { body: { email: victimEmail, orderNumber: "NM-DOESNOTEXIST" } });
    check(
      "2b OTP request (ghost pair) → IDENTICAL 200 body",
      reqGhost.status === 200 && JSON.stringify(data(reqGhost.json)) === JSON.stringify(data(req1.json)),
      `status=${reqGhost.status}`
    );
    const realCode = await readCodeFromMailbox(orderNumber);

    // -- 3. Brute-force lockout (5 wrong → even the CORRECT code fails) ---------
    const wrongCode = realCode === "000000" ? "000001" : "000000"; // guaranteed ≠ the real code
    for (let i = 1; i <= 5; i++) {
      const wrong = await api("POST", "/api/orders/otp/verify", { body: { email: victimEmail, orderNumber, code: wrongCode } });
      check(`3.${i} wrong code #${i} → uniform 401`, wrong.status === 401 && errCode(wrong.json) === "INVALID", `status=${wrong.status}`);
    }
    const correctWhileLocked = await api("POST", "/api/orders/otp/verify", { body: { email: victimEmail, orderNumber, code: realCode } });
    check("3.6 CORRECT code after 5 wrong → still 401 (locked; counter survives re-issuance)", correctWhileLocked.status === 401, `status=${correctWhileLocked.status}`);

    // Staging-only shortcut (see header): age out the [LT] challenge row so a
    // fresh issuance can proceed without a 10-minute wall-clock sleep. This
    // writes ONLY to this test's own row.
    await db.emailOtpChallenge.updateMany({
      where: { purpose: "guest-order", subjectId: order1.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const req2 = await api("POST", "/api/orders/otp/request", { body: { email: victimEmail, orderNumber } });
    check("3.7 re-issuance after expiry → 200", req2.status === 200, `status=${req2.status}`);
    const freshCode = await readCodeFromMailbox(orderNumber);

    // -- 4. Verification + grant issuance ---------------------------------------
    const good = await api("POST", "/api/orders/otp/verify", { body: { email: victimEmail, orderNumber, code: freshCode } });
    const grant = data(good.json).accessGrant as string | undefined;
    check("4a correct code → 200 + accessGrant (v1…)", good.status === 200 && typeof grant === "string" && grant.startsWith("v1."), `status=${good.status}`);

    // -- 5. Replay prevention ---------------------------------------------------
    const replay = await api("POST", "/api/orders/otp/verify", { body: { email: victimEmail, orderNumber, code: freshCode } });
    check("5 same code replay → 401 (challenge consumed)", replay.status === 401 && errCode(replay.json) === "INVALID", `status=${replay.status}`);

    await sleep(65_000); // fresh lookup rate-limit window

    // -- 6. Grant authorization --------------------------------------------------
    const withGrant = await api("GET", `/api/orders/lookup?orderNumber=${orderNumber}`, { token: grant });
    check("6a grant lookup → 200 with order data", withGrant.status === 200 && data(withGrant.json).orderNumber === orderNumber, `status=${withGrant.status}`);
    const wrongNumber = await api("GET", `/api/orders/lookup?orderNumber=${`NM-LT2${RUN.slice(-6).toUpperCase()}`}`, { token: grant });
    check("6b grant is order-specific (other order's number → 401)", wrongNumber.status === 401, `status=${wrongNumber.status}`);
    const forged = `v1.${order2.id}.${Date.now() + 600_000}.${"0".repeat(64)}`;
    const forgedRes = await api("GET", `/api/orders/lookup?orderNumber=${`NM-LT2${RUN.slice(-6).toUpperCase()}`}`, { token: forged });
    check("6c forged grant → 401", forgedRes.status === 401, `status=${forgedRes.status}`);

    // -- 7. Receipt authorization ordering --------------------------------------
    const receiptAnon = await api("GET", `/api/orders/receipt?orderNumber=${orderNumber}`);
    check("7a receipt unauthenticated → 401 BEFORE the payment gate (never 409)", receiptAnon.status === 401, `status=${receiptAnon.status}`);
    const receiptGrant = await api("GET", `/api/orders/receipt?orderNumber=${orderNumber}`, { token: grant });
    check("7b receipt with grant → payment gate retained (409 NOT_PAID)", receiptGrant.status === 409 && errCode(receiptGrant.json) === "NOT_PAID", `status=${receiptGrant.status}`);

    // -- 8. ATTACK: register an account with the victim's email (unverified) ----
    const reg = await api("POST", "/api/auth/shopper/register", {
      body: { email: victimEmail, password: PASSWORD, fullName: "LT Guest Attacker" },
    });
    check("8a registration itself succeeds (email delivery is never a blocker)", reg.status === 200, `status=${reg.status}`);
    const regToken = data(reg.json).token as string;
    const attackerSession = await shopperSession(victimEmail, PASSWORD);
    const claimedAtLogin = data(attackerSession.json).claimed as { ordersClaimed?: number } | undefined;
    check(
      "8b UNVERIFIED login claims NOTHING",
      attackerSession.status === 200 && data(attackerSession.json).emailVerified === false && (claimedAtLogin?.ordersClaimed ?? 0) === 0,
      `claimed=${JSON.stringify(claimedAtLogin)}`
    );
    const s1 = await db.order.findUnique({ where: { id: order1.id }, select: { shopperId: true } });
    const s2 = await db.order.findUnique({ where: { id: order2.id }, select: { shopperId: true } });
    check("8c guest orders remain unclaimed (shopperId still null)", s1?.shopperId == null && s2?.shopperId == null);
    const attackerLookup = await api("GET", `/api/orders/lookup?orderNumber=${orderNumber}`, { cookie: attackerSession.cookie });
    check("8d unverified account CANNOT read the guest order (401)", attackerLookup.status === 401, `status=${attackerLookup.status}`);

    // -- 9. Legitimate claiming EXACTLY ONCE ------------------------------------
    const evReq = await api("POST", "/api/auth/shopper/email-verification/request", { token: regToken });
    check("9a email-verification request → 200", evReq.status === 200, `status=${evReq.status}`);
    const evCode = await readCodeFromMailbox("");
    const evGood = await api("POST", "/api/auth/shopper/email-verification/verify", { token: regToken, body: { code: evCode } });
    check(
      "9b verification → verified + BOTH guest orders claimed exactly once",
      evGood.status === 200 && data(evGood.json).verified === true && data(evGood.json).ordersClaimed === 2,
      `status=${evGood.status} claimed=${JSON.stringify(data(evGood.json).ordersClaimed)}`
    );
    const evAgain = await api("POST", "/api/auth/shopper/email-verification/verify", { token: regToken, body: { code: evCode } });
    check(
      "9c second verify → alreadyVerified, claims 0 more",
      evAgain.status === 200 && data(evAgain.json).alreadyVerified === true && data(evAgain.json).ordersClaimed === 0,
      `status=${evAgain.status}`
    );
    const ownerSession = await shopperSession(victimEmail, PASSWORD);
    const claimedAgain = data(ownerSession.json).claimed as { ordersClaimed?: number } | undefined;
    check("9d re-login after verification claims nothing more", (claimedAgain?.ordersClaimed ?? 0) === 0, `claimed=${JSON.stringify(claimedAgain)}`);
    const after1 = await db.order.findUnique({ where: { id: order1.id }, select: { shopperId: true } });
    const after2 = await db.order.findUnique({ where: { id: order2.id }, select: { shopperId: true } });
    check("9e orders now owned by the verified account", after1?.shopperId != null && after2?.shopperId != null);

    await sleep(65_000); // fresh lookup window for the ownership checks

    // -- 10. Authenticated ownership + foreign-session denial -------------------
    const ownerLookup = await api("GET", `/api/orders/lookup?orderNumber=${orderNumber}`, { cookie: ownerSession.cookie });
    check("10a OWNING session lookup → 200", ownerLookup.status === 200, `status=${ownerLookup.status}`);
    const otherReg = await api("POST", "/api/auth/shopper/register", {
      body: { email: otherEmail, password: PASSWORD, fullName: "LT Guest Other" },
    });
    check("10b foreign shopper registered", otherReg.status === 200, `status=${otherReg.status}`);
    const otherSession = await shopperSession(otherEmail, PASSWORD);
    const otherLookup = await api("GET", `/api/orders/lookup?orderNumber=${orderNumber}`, { cookie: otherSession.cookie });
    check("10c FOREIGN session → uniform 401 (no oracle)", otherLookup.status === 401, `status=${otherLookup.status}`);
  } finally {
    // ---- self-cleaning: [LT] rows ONLY; zero financial records touched --------
    const ltShoppers = await db.shopperUser.findMany({
      where: { email: { in: [victimEmail, otherEmail] } },
      select: { id: true },
    });
    for (const v of ltShoppers) {
      await db.session.deleteMany({ where: { userId: v.id, userType: "shopper" } }).catch(() => undefined);
      await db.emailOtpChallenge.deleteMany({ where: { purpose: "shopper-email", subjectId: v.id } }).catch(() => undefined);
    }
    await db.emailOtpChallenge.deleteMany({
      where: { purpose: "guest-order", subjectId: { in: [order1.id, order2.id] } },
    }).catch(() => undefined);
    await db.order.deleteMany({ where: { id: { in: [order1.id, order2.id] } } }).catch(() => undefined);
    for (const v of ltShoppers) {
      await db.shopperUser.deleteMany({ where: { id: v.id } }).catch(() => undefined);
    }
  }
  return summary("guest-order-otp-e2e");
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[LT] FATAL:", err);
    process.exit(1);
  });

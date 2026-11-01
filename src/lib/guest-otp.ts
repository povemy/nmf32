// ============================================================================
// Guest-order ownership verification (FINAL CLOSURE §1/§3) — email OTP
// challenges + short-lived order-access grants.
//
// AUTHORIZATION MODEL (corrected — see docs/security/guest-order-otp-design.md):
//   The knowledge pair (email + NM- order number) can ONLY *request* a
//   verification challenge. It NEVER authorizes order data. Sensitive order
//   information (lookup + receipt) requires EITHER:
//     (a) a short-lived, order-specific, HMAC-protected access grant issued
//         ONLY after a successful OTP verification (this module), OR
//     (b) an authenticated shopper session that OWNS the order
//         (order.shopperId === me.id — normal account ownership).
//   Unauthenticated traffic never receives customer PII, and responses are
//   uniform (no order-existence oracle).
//
// Primitive inventory (all stdlib crypto; mirrors import-cap.ts / mfa.ts):
//   • OTP code        : 6 digits, CSPRNG + rejection sampling (uniform, no
//                       modulo bias). TTL 10 minutes, max 5 wrong attempts.
//   • Storage         : ONE row per (purpose, subjectId) in EmailOtpChallenge
//                       (unique index). The code is stored ONLY as
//                       HMAC-SHA256(EMAIL_OTP_SECRET, "otp:v1:<purpose>:
//                       <subjectId>:<dayBucket>:<code>") — a KEYED hash, so a
//                       database read cannot brute-force the 10^6 space
//                       offline. Never logged; never returned.
//   • Day-bucket      : UTC epoch day bound into the hash. Verification tries
//                       BOTH the current and the previous day bucket, so a
//                       code issued before UTC midnight remains valid through
//                       its full intended 10-minute expiry after rollover.
//   • Attempts        : CAS-guarded increments (updateMany WHERE attempts <
//                       MAX) — bounded at 5 even under concurrency. The
//                       counter is CARRIED OVER on re-issuance while a row is
//                       unexpired and only resets after expiry: repeated
//                       issuance cannot reset brute-force accounting.
//   • Consumption     : CAS — guest-order rows are DELETEd
//                       (WHERE id + codeHash) on success; shopper-email rows
//                       transition verifiedAt: null → now (WHERE verifiedAt IS
//                       NULL). Concurrent duplicates produce exactly ONE
//                       winner; replay of the same code is impossible.
//   • Access grant    : "v1.<orderId>.<expiryMs>.<hmac>" where
//                       hmac = HMAC-SHA256(ORDER_ACCESS_SECRET,
//                       "oag:v1:<orderId>:<expiryMs>"). Order-specific
//                       (orderId bound), purpose-specific (the "oag:v1:"
//                       domain tag + dedicated secret — it is not an import
//                       capability, not a session, valid nowhere else),
//                       15-minute TTL, no refresh, stateless MAC (rotation of
//                       ORDER_ACCESS_SECRET invalidates all outstanding grants
//                       instantly). NEVER logged, never persisted client-side.
//
// DB guard: every EmailOtpChallenge access treats Prisma P2021/P2022 (table /
// column does not exist — migration 20261104000000 not applied yet) as
// "feature unavailable" and FAILS CLOSED (issuance/storage probe → 503;
// claiming gate → unverified), exactly like the AdminMfaEnrollment dev
// contract. The app therefore runs BEFORE the migration lands, and no
// existing query is affected (no column was added to any existing table).
//
// NEVER log the OTP code, the codeHash or a grant token — audit rows carry
// ids/status only.
// ============================================================================
import { randomBytes } from "crypto";
import { db } from "./db";
import { ApiError } from "./api";
import { hmacSha256Hex, safeEqualHex } from "./password";
import { isPrismaMissingTableError } from "./mfa";

/* ------------------------------------------------------------- constants */

export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;
export const EMAIL_OTP_DIGITS = 6;
/** Access-grant lifetime — short by design; no refresh token exists. */
export const ORDER_ACCESS_GRANT_TTL_MS = 15 * 60 * 1000;

/** The two challenge purposes sharing this machinery. */
export type EmailOtpPurpose = "guest-order" | "shopper-email";

const OTP_HASH_DOMAIN = "otp:v1:";
const GRANT_DOMAIN = "oag:v1:";
const DAY_MS = 86_400_000;

/* --------------------------------------------------------------- secrets */

/** HMAC key for OTP code hashes. Fail-closed in production (503) — mirrors
 *  IMPORT_CAP_SECRET; dev falls back to the documented demo constant so the
 *  logic is testable without env setup. */
export function emailOtpSecret(): string {
  const secret = process.env.EMAIL_OTP_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(
      503,
      "EMAIL_OTP_SECRET_UNSET",
      "EMAIL_OTP_SECRET is not configured — email verification is disabled (fail closed)"
    );
  }
  return "sm_email_otp_dev";
}

/** HMAC key for order-access grants (separate from the OTP secret: rotating
 *  one must not silently invalidate the other's outstanding artifacts). */
export function orderAccessSecret(): string {
  const secret = process.env.ORDER_ACCESS_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(
      503,
      "ORDER_ACCESS_SECRET_UNSET",
      "ORDER_ACCESS_SECRET is not configured — order access grants are disabled (fail closed)"
    );
  }
  return "sm_order_access_dev";
}

/* ------------------------------------------------------------ pure crypto */

/** Cryptographically secure, UNIFORM 6-digit code (rejection sampling over a
 *  32-bit CSPRNG draw — no modulo bias). */
export function generateOtpCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 10 ** EMAIL_OTP_DIGITS) * 10 ** EMAIL_OTP_DIGITS;
  let v: number;
  do {
    v = randomBytes(4).readUInt32BE(0);
  } while (v >= limit);
  return (v % 10 ** EMAIL_OTP_DIGITS).toString().padStart(EMAIL_OTP_DIGITS, "0");
}

/** UTC epoch-day bucket for a timestamp. */
export function otpDayBucket(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}

/** Buckets a verification at `nowMs` must try: today and YESTERDAY — a code
 *  issued before UTC midnight stays valid through its 10-minute TTL after
 *  the rollover, so the previous bucket must still match. */
export function otpCandidateBuckets(nowMs: number): number[] {
  const today = otpDayBucket(nowMs);
  return [today, today - 1];
}

/** Keyed hash binding a code to (purpose, subject, day-bucket). The secret
 *  parameter keeps this pure/testable; production callers use the default. */
export function otpCodeHash(
  code: string,
  purpose: EmailOtpPurpose,
  subjectId: string,
  bucket: number,
  secret: string = emailOtpSecret()
): string {
  return hmacSha256Hex(secret, `${OTP_HASH_DOMAIN}${purpose}:${subjectId}:${bucket}:${code}`);
}

/** Normalize user-submitted code input: digits only, exactly 6 → string, else
 *  null (a malformed code is simply an invalid code — uniform downstream). */
export function normalizeOtpCode(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/[^0-9]/g, "");
  return digits.length === EMAIL_OTP_DIGITS ? digits : null;
}

/* ------------------------------------------------- order-access grants */

/** Mint a 15-minute, single-order access grant. Called ONLY after a
 *  successfully consumed guest-order OTP (the OTP IS the proof of email
 *  ownership; the grant is the short-lived authorization artifact). */
export function issueOrderAccessGrant(orderId: string, nowMs: number = Date.now()): string {
  const expiresAtMs = nowMs + ORDER_ACCESS_GRANT_TTL_MS;
  const mac = hmacSha256Hex(orderAccessSecret(), `${GRANT_DOMAIN}${orderId}:${expiresAtMs}`);
  return `v1.${orderId}.${expiresAtMs}.${mac}`;
}

export type OrderAccessGrant = { orderId: string; expiresAtMs: number };

/** Verify an access grant: strict shape checks, absolute expiry (minted
 *  server-side — no skew tolerance needed), constant-time MAC compare.
 *  Returns null on ANY failure — callers treat null as "not authorized". */
export function verifyOrderAccessGrant(
  raw: string | null | undefined,
  nowMs: number = Date.now()
): OrderAccessGrant | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [version, orderId, expiresAt, mac] = parts;
  if (version !== "v1") return null;
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(orderId)) return null;
  if (!/^\d{13,16}$/.test(expiresAt)) return null;
  if (!/^[0-9a-f]{64}$/.test(mac)) return null;
  const expiresAtMs = Number(expiresAt);
  if (expiresAtMs <= nowMs) return null;
  let secret: string;
  try {
    secret = orderAccessSecret();
  } catch {
    return null; // production without the secret → nothing can verify
  }
  if (!safeEqualHex(mac, hmacSha256Hex(secret, `${GRANT_DOMAIN}${orderId}:${expiresAtMs}`))) {
    return null;
  }
  return { orderId, expiresAtMs };
}

/* ------------------------------------------- storage probe (P2021 guard) */

let storageState: "unknown" | "ready" | "missing" = "unknown";
let warnedMissingModel = false;

/** The EmailOtpChallenge model accessor, or null when the loaded Prisma
 *  client predates the schema change (dev server started before
 *  `prisma generate`; production always ships client+schema together).
 *  Missing MODEL must fail closed exactly like a missing TABLE — a stale
 *  client would otherwise throw a bare TypeError (500) and, on the claiming
 *  gate, could break LOGIN. */
function emailOtpModel(): typeof db.emailOtpChallenge | null {
  const model = (db as unknown as { emailOtpChallenge?: typeof db.emailOtpChallenge }).emailOtpChallenge;
  if (!model) {
    if (!warnedMissingModel) {
      warnedMissingModel = true;
      console.warn(
        "[guest-otp] the loaded Prisma client has no EmailOtpChallenge model — regenerate the client (bunx prisma generate) and restart; email verification is disabled (fail closed) until then"
      );
    }
    return null;
  }
  return model;
}

const EMAIL_OTP_UNAVAILABLE = () =>
  new ApiError(
    503,
    "EMAIL_OTP_UNAVAILABLE",
    "Email verification storage is not initialized on this deployment (fail closed)"
  );

/** Throws 503 EMAIL_OTP_UNAVAILABLE while the EmailOtpChallenge table does
 *  not exist (migration 20261104000000 not applied) or the loaded client
 *  predates the model. MUST be called BEFORE any order/account lookup on
 *  public routes — the 503 must be uniform for every caller so it can never
 *  act as an order-existence oracle. The negative result is cached for the
 *  process lifetime (restart after the migration lands / client regen;
 *  production applies migrations before deploy, so the first probe
 *  succeeds). */
export async function assertEmailOtpStorage(): Promise<void> {
  if (storageState === "ready") return;
  if (storageState === "missing") throw EMAIL_OTP_UNAVAILABLE();
  const model = emailOtpModel();
  if (!model) {
    storageState = "missing";
    throw EMAIL_OTP_UNAVAILABLE();
  }
  try {
    await model.findFirst({ select: { id: true } });
    storageState = "ready";
  } catch (e) {
    if (isPrismaMissingTableError(e)) {
      storageState = "missing";
      console.warn(
        "[guest-otp] EmailOtpChallenge table missing — migration 20261104000000 not applied; email verification is disabled (fail closed) until the migration lands and the process restarts"
      );
      throw EMAIL_OTP_UNAVAILABLE();
    }
    throw e;
  }
}

/* ------------------------------------------------------ challenge issuing */

export type IssueEmailOtpResult = {
  issued: boolean;
  suppressed?: "locked" | "already-verified" | "delivery-failed";
};

/** Issue (or re-issue) a challenge for (purpose, subjectId) and deliver the
 *  code through `deliver`. Semantics:
 *  • already-verified shopper-email rows are never re-issued;
 *  • a LOCKED (attempts ≥ MAX) unexpired row is never re-issued — repeated
 *    issuance cannot reset brute-force accounting (attempt counters carry
 *    over and only reset after the row expires);
 *  • a successful re-issue REPLACES the code/hash and extends the expiry
 *    (latest email wins — the victim can always use the newest code);
 *  • delivery failures do NOT propagate (the caller-side uniform response
 *    must be preserved); they are returned as suppressed "delivery-failed"
 *    and audited by the caller.
 *  The code is passed to `deliver` ONLY — never stored or logged in clear. */
export async function issueEmailOtp(input: {
  purpose: EmailOtpPurpose;
  subjectId: string;
  deliver: (code: string) => Promise<void>;
  nowMs?: number;
}): Promise<IssueEmailOtpResult> {
  await assertEmailOtpStorage();
  const model = emailOtpModel();
  if (!model) throw EMAIL_OTP_UNAVAILABLE(); // probe caches "missing" — unreachable, kept for type narrowing
  const now = input.nowMs ?? Date.now();

  const existing = await model.findUnique({
    where: { purpose_subjectId: { purpose: input.purpose, subjectId: input.subjectId } },
  });
  if (existing?.verifiedAt) return { issued: false, suppressed: "already-verified" };
  if (existing && existing.expiresAt.getTime() > now && existing.attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
    return { issued: false, suppressed: "locked" };
  }

  const code = generateOtpCode();
  const codeHash = otpCodeHash(code, input.purpose, input.subjectId, otpDayBucket(now));
  const expiresAt = new Date(now + EMAIL_OTP_TTL_MS);
  // Attempt carry-over: reset ONLY when the previous row is gone/expired.
  // (verifiedAt is deliberately NOT in `update` — a row that raced to
  // verified between our read and this upsert keeps its verified state.)
  const attempts = existing && existing.expiresAt.getTime() > now ? existing.attempts : 0;

  await model.upsert({
    where: { purpose_subjectId: { purpose: input.purpose, subjectId: input.subjectId } },
    create: { purpose: input.purpose, subjectId: input.subjectId, codeHash, attempts: 0, expiresAt },
    update: { codeHash, attempts, expiresAt },
  });

  try {
    await input.deliver(code);
  } catch (err) {
    // Fail-soft on purpose: propagating a provider error on the public
    // request route would turn "delivery attempted" into an order-existence
    // oracle. The row stays (harmless — unguessable, TTL-bounded); the user
    // simply re-requests.
    console.warn(
      `[guest-otp] delivery failed for purpose=${input.purpose}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { issued: false, suppressed: "delivery-failed" };
  }
  return { issued: true };
}

/* ----------------------------------------------------- challenge verifying */

export type VerifyEmailOtpResult =
  | { ok: true; verifiedAt: Date | null }
  | {
      ok: false;
      reason: "no-challenge" | "expired" | "locked" | "wrong-code" | "already-verified" | "consume-race";
    };

/** Verify a submitted code against the live challenge for (purpose,
 *  subjectId). All failure reasons map to the SAME uniform 401 at the route
 *  layer — reasons exist for tests/audits, not for clients.
 *
 *  Order of checks: existence → already-verified → expiry → lockout →
 *  constant-time hash compare (BOTH day buckets — midnight rollover) →
 *  CAS consume. The CAS consume is what makes verification exactly-once:
 *  • guest-order    : DELETE WHERE (id, codeHash) — replay finds no row;
 *  • shopper-email  : UPDATE verifiedAt=now WHERE verifiedAt IS NULL — the
 *    row PERSISTS as the durable email-ownership proof that gates claiming,
 *    and only ONE concurrent verify can win. */
export async function verifyEmailOtp(input: {
  purpose: EmailOtpPurpose;
  subjectId: string;
  code: string;
  nowMs?: number;
}): Promise<VerifyEmailOtpResult> {
  await assertEmailOtpStorage();
  const model = emailOtpModel();
  if (!model) return { ok: false, reason: "no-challenge" }; // probe caches "missing" — unreachable, kept for type narrowing
  const now = input.nowMs ?? Date.now();

  const code = normalizeOtpCode(input.code);
  if (!code) return { ok: false, reason: "wrong-code" };

  const row = await model.findUnique({
    where: { purpose_subjectId: { purpose: input.purpose, subjectId: input.subjectId } },
  });
  if (!row) return { ok: false, reason: "no-challenge" };
  if (row.verifiedAt) return { ok: false, reason: "already-verified" };
  if (row.expiresAt.getTime() <= now) return { ok: false, reason: "expired" };
  if (row.attempts >= EMAIL_OTP_MAX_ATTEMPTS) return { ok: false, reason: "locked" };

  const matched = otpCandidateBuckets(now).some((b) =>
    safeEqualHex(otpCodeHash(code, input.purpose, input.subjectId, b), row.codeHash)
  );
  if (!matched) {
    // CAS increment — the WHERE bound keeps attempts ≤ MAX even under
    // concurrent guesses; a lost race simply reads as "locked".
    await model.updateMany({
      where: { id: row.id, attempts: { lt: EMAIL_OTP_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "wrong-code" };
  }

  if (input.purpose === "guest-order") {
    const consumed = await model.deleteMany({
      where: { id: row.id, codeHash: row.codeHash },
    });
    if (consumed.count !== 1) return { ok: false, reason: "consume-race" };
    return { ok: true, verifiedAt: null };
  }

  const consumed = await model.updateMany({
    where: { id: row.id, codeHash: row.codeHash, verifiedAt: null },
    data: { verifiedAt: new Date(now) },
  });
  if (consumed.count !== 1) return { ok: false, reason: "consume-race" };
  return { ok: true, verifiedAt: new Date(now) };
}

/* ------------------------------------------ shopper email-ownership proof */

/** Durable email-ownership proof for a shopper account — gates
 *  claimGuestStateForShopper(). P2021-tolerant: table missing → false
 *  (claiming disabled, fail closed) so the app runs pre-migration. */
export async function getShopperEmailVerified(shopperId: string): Promise<boolean> {
  const model = emailOtpModel();
  if (!model) return false; // stale client → unverified → claiming disabled (fail closed)
  try {
    const row = await model.findUnique({
      where: { purpose_subjectId: { purpose: "shopper-email", subjectId: shopperId } },
      select: { verifiedAt: true },
    });
    return row?.verifiedAt != null;
  } catch (e) {
    if (isPrismaMissingTableError(e)) {
      console.warn(
        "[guest-otp] EmailOtpChallenge table missing — shopper email verification reads as UNVERIFIED; guest-order claiming is disabled (fail closed) until migration 20261104000000 lands"
      );
      return false;
    }
    throw e;
  }
}

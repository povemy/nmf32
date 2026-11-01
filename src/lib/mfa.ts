// ============================================================================
// Administrator TOTP MFA (Phase 1 / C4) — enrollment storage, login challenges
// and code verification. Stdlib crypto ONLY (no new deps).
//
// Layers:
//   • TOTP (RFC 6238 / RFC 4226): HMAC-SHA1, 30s steps, 6 digits, ±1 step
//     verification window, over a base32 (RFC 4648) 20-byte secret.
//   • Secret at rest: AES-256-GCM, key = sha256(MFA_ENCRYPTION_KEY). Format
//     "base64(iv).base64(tag).base64(ct)". Missing key: dev → one-time-warned
//     default key; production → 503 MFA_NOT_CONFIGURED (fail-closed, mirrors
//     the PSP_WEBHOOK_SECRET pattern).
//   • Recovery codes: 10 × randomToken(5) (10 hex chars), stored as a JSON
//     array of sha256(code) digests, one-time use (removed on use + persisted).
//   • Login challenges: in-memory Map (module-level, single process — same
//     architecture as the in-memory rate limiter), randomToken(32), 5-min TTL,
//     PROGRESSIVE cooldowns (3 fails → 60 s lock; each repeat doubles it,
//     capped at 10 min — Phase 2.1 removed the old 8-fail "permanent" lock so
//     no one can permanently lock out an administrator), PLUS a cross-challenge
//     per-admin throttle that pauses challenge MINTING for admins who keep
//     failing (prevents challenge-cycling to reset the counter).
//   • TOTP replay protection (Phase 2.1): the accepted time-step counter is
//     persisted on the enrollment (lastUsedTotpCounter) and consumed with a
//     CAS updateMany — the same valid code can never verify twice, and the
//     enrollment-confirm code is burned the same way.
//
// DB guard: getMfaEnrollment() treats Prisma P2021/P2022 (table/column does
// not exist) as UNENROLLED, so the app runs BEFORE migration
// 20261101000002 is applied (dev) while migrated production gets full
// enforcement.
//
// NEVER log the TOTP secret, the otpauth URL, recovery codes or submitted
// codes — audit actions carry counts/status only.
// ============================================================================
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { randomToken, verifyPassword } from "./password";
import * as passwordModule from "./password";
import { ApiError, logActivity } from "./api";
import { roleRequiresMfa } from "./admin-caps";

/* ------------------------------------------------------- TOTP constants */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Verification window: codes from counter-1 … counter+1 are accepted. */
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;

/* --------------------------------------------------- base32 (RFC 4648) */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Final partial group — pad with zero bits on the right.
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 decode (tolerates padding + whitespace + case). Throws on
 *  characters outside the alphabet. */
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character '${ch}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/* ------------------------------------------------------- TOTP (RFC 6238) */

/** HOTP code (RFC 4226): HMAC-SHA1 over the 8-byte big-endian counter,
 *  dynamic truncation, `digits` decimal digits (zero-padded). */
export function totpCode(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(counterBuf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** TOTP counter for a Unix timestamp (seconds). */
export function totpCounterAt(timeSeconds: number, step = TOTP_STEP_SECONDS): number {
  return Math.floor(timeSeconds / step);
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verify a 6-digit code against the secret with a ±window-step window at
 *  `nowMs` (default: current time). Non-digit input simply fails. */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs = Date.now(),
  window = TOTP_WINDOW,
  step = TOTP_STEP_SECONDS
): boolean {
  return verifyTotpDetailed(secret, code, nowMs, window, step).ok;
}

/** PHASE 2.1 (§5-C): verifyTotp that also reports WHICH time-step counter
 *  matched — required for replay protection (the accepted counter is persisted
 *  and never accepted again). `counter` is present only when ok. */
export function verifyTotpDetailed(
  secret: Buffer,
  code: string,
  nowMs = Date.now(),
  window = TOTP_WINDOW,
  step = TOTP_STEP_SECONDS
): { ok: boolean; counter?: number } {
  const normalized = (code ?? "").replace(/[^0-9]/g, "");
  if (normalized.length !== TOTP_DIGITS) return { ok: false };
  const counter = totpCounterAt(Math.floor(nowMs / 1000), step);
  for (let i = -window; i <= window; i++) {
    if (safeEqualStr(totpCode(secret, counter + i), normalized)) return { ok: true, counter: counter + i };
  }
  return { ok: false };
}

/** Fresh 20-byte TOTP secret (base32 + raw buffer). */
export function generateTotpSecret(): { secret: Buffer; secretBase32: string } {
  const secret = randomBytes(TOTP_SECRET_BYTES);
  return { secret, secretBase32: base32Encode(secret) };
}

/** otpauth:// provisioning URL for an admin (email = account label). */
export function otpauthUrl(admin: { email: string }, secretBase32: string, issuer = "NOMOFEE"): string {
  return (
    `otpauth://totp/${issuer}:${encodeURIComponent(admin.email)}` +
    `?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
  );
}

/* ------------------------------------------- secret encryption (AES-GCM) */

const DEV_FALLBACK_KEY = "sm_mfa_dev_key";
let devKeyWarned = false;

/** True when MFA crypto is usable in this environment: an explicit
 *  MFA_ENCRYPTION_KEY is set, OR we are outside production (dev default key). */
export function mfaEncryptionConfigured(): boolean {
  const key = process.env.MFA_ENCRYPTION_KEY;
  if (key && key.trim() !== "") return true;
  return process.env.NODE_ENV !== "production";
}

/** AES-256-GCM key = sha256(MFA_ENCRYPTION_KEY). Fail-closed in production
 *  when the key is unset (503 MFA_NOT_CONFIGURED); dev gets a one-time-warned
 *  default so local flows work end-to-end. */
function mfaKey(): Buffer {
  const envKey = process.env.MFA_ENCRYPTION_KEY;
  if (envKey && envKey.trim() !== "") {
    return createHash("sha256").update(envKey, "utf8").digest();
  }
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(503, "MFA_NOT_CONFIGURED", "MFA_ENCRYPTION_KEY is not set — two-factor authentication is unavailable.");
  }
  if (!devKeyWarned) {
    devKeyWarned = true;
    console.warn("[mfa] MFA_ENCRYPTION_KEY not set — using the development default key. Set MFA_ENCRYPTION_KEY in production.");
  }
  return createHash("sha256").update(DEV_FALLBACK_KEY, "utf8").digest();
}

/** Encrypt a secret → "base64(iv).base64(tag).base64(ct)". */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mfaKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

/** Decrypt "base64(iv).base64(tag).base64(ct)". Throws on tampering (GCM tag
 *  mismatch), malformed input or a changed key. */
export function decryptSecret(enc: string): string {
  const parts = enc.split(".");
  if (parts.length !== 3) throw new Error("malformed MFA secret ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", mfaKey(), Buffer.from(parts[0], "base64"));
  decipher.setAuthTag(Buffer.from(parts[1], "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]);
  return pt.toString("utf8");
}

/** Verify a TOTP code against an enrollment's ENCRYPTED secret (±1 step).
 *  Tampered/undecryptable secrets fail closed (false); ApiError 503
 *  (unconfigured production key) still propagates. */
export function verifyTotpForSecretEnc(secretEnc: string, code: string, nowMs = Date.now()): boolean {
  try {
    const secret = base32Decode(decryptSecret(secretEnc));
    return verifyTotp(secret, code, nowMs);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return false;
  }
}

/** PHASE 2.1 (§5-C): detailed variant used by the confirm route so the code
 *  burned at confirmation can never be replayed at login. */
export function verifyTotpForSecretEncDetailed(
  secretEnc: string,
  code: string,
  nowMs = Date.now()
): { ok: boolean; counter?: number } {
  try {
    const secret = base32Decode(decryptSecret(secretEnc));
    return verifyTotpDetailed(secret, code, nowMs);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return { ok: false };
  }
}

/* ------------------------------------------- TOTP replay guard (§5-C) */

let replayWarned = false;

/** CAS-guarded consumption of a TOTP time-step counter: the update lands only
 *  when the stored counter is OLDER than `counter` (or null). Returns false
 *  when the counter was already used (replay) or a concurrent verification
 *  consumed it first — exactly one parallel replay can ever win.
 *  Pre-migration deployments (table OR column missing): protection is skipped
 *  with a loud one-time warning — identical fail-open contract to the Phase 1
 *  table-absence guard (production always deploys migrations first). */
export async function consumeTotpCounter(adminId: string, counter: number): Promise<boolean> {
  try {
    const res = await db.adminMfaEnrollment.updateMany({
      where: {
        adminId,
        OR: [{ lastUsedTotpCounter: null }, { lastUsedTotpCounter: { lt: counter } }],
      },
      data: { lastUsedTotpCounter: counter },
    });
    return res.count === 1;
  } catch (e) {
    if (isPrismaMissingTableError(e)) {
      if (!replayWarned) {
        replayWarned = true;
        console.warn(
          "[mfa] TOTP replay protection unavailable — apply migrations 20261101000002 + 20261103000000 to enable it"
        );
      }
      return true; // column/table absent (unmigrated dev) — fail-open, warn once
    }
    throw e;
  }
}

/* ------------------------------------------------------- recovery codes */

export const RECOVERY_CODE_COUNT = 10;

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Canonical recovery-code form: lowercase alphanumerics only. */
export function normalizeRecoveryCode(raw: string): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** "abcdefghij" → "abcde-fghij" (display grouping only). */
export function formatRecoveryCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** 10 recovery codes (10 hex chars each) + the JSON array of sha256 digests
 *  to persist. Plaintext codes exist ONLY in the caller's response. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashesJson: string } {
  const codes = Array.from({ length: count }, () => randomToken(5));
  return { codes, hashesJson: JSON.stringify(codes.map((c) => sha256Hex(c))) };
}

/** Parse the stored hashesJson → string[] of sha256 hex digests (defensive:
 *  non-string / non-digest entries dropped; malformed JSON → []). */
export function parseRecoveryHashes(hashesJson: string): string[] {
  try {
    const parsed = JSON.parse(hashesJson ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h));
  } catch {
    return [];
  }
}

/** Index of the matching recovery code in the stored hashes, or -1. */
export function matchRecoveryCode(hashesJson: string, rawCode: string): number {
  const normalized = normalizeRecoveryCode(rawCode);
  if (normalized === "") return -1;
  return parseRecoveryHashes(hashesJson).indexOf(sha256Hex(normalized));
}

/** Pure removal: returns the updated hashesJson with the hash at `index`
 *  removed (one-time-use burn). Out-of-range index → input unchanged. */
export function removeRecoveryHash(hashesJson: string, index: number): string {
  const hashes = parseRecoveryHashes(hashesJson);
  if (index < 0 || index >= hashes.length) return hashesJson;
  return JSON.stringify([...hashes.slice(0, index), ...hashes.slice(index + 1)]);
}

/* --------------------------------------------------------- enrollment DB */

export type MfaEnrollment = {
  adminId: string;
  secretEnc: string;
  recoveryHashes: string;
  confirmedAt: Date | null;
};

/** P2021 (table does not exist) / P2022 (column does not exist) — the
 *  AdminMfaEnrollment migration has not been applied. */
export function isPrismaMissingTableError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code === "P2021" || e.code === "P2022";
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return code === "P2021" || code === "P2022";
}

/** Current enrollment for an admin, or null. P2021/P2022 → null (unenrolled)
 *  so the app runs before migration 20261101000002 is applied; migrated
 *  production gets full enforcement. */
export async function getMfaEnrollment(adminId: string): Promise<MfaEnrollment | null> {
  try {
    const row = await db.adminMfaEnrollment.findUnique({ where: { adminId } });
    if (!row) return null;
    return {
      adminId: row.adminId,
      secretEnc: row.secretEnc,
      recoveryHashes: row.recoveryHashes,
      confirmedAt: row.confirmedAt,
    };
  } catch (e) {
    if (isPrismaMissingTableError(e)) {
      console.warn("[mfa] enrollment table missing — migration 20261101000002 not applied; treating as unenrolled");
      return null;
    }
    throw e;
  }
}

/* ------------------------------------------------- login challenge (map) */

export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Consecutive failures (since the last lock) that trigger a cooldown lock. */
export const MFA_FAIL_LOCK_THRESHOLD = 3;
/** FIRST cooldown duration; subsequent locks double it (60→120→240→480…). */
export const MFA_FAIL_LOCK_MS = 60 * 1000;
/** Hard cap for a single cooldown lock (10 minutes). */
export const MFA_LOCK_MAX_MS = 10 * 60 * 1000;
/** Total failures that escalate the cooldown straight to the cap. */
export const MFA_TOTAL_FAIL_LIMIT = 8;

export type MfaChallengeState = {
  adminId: string;
  expiresAt: number;
  /** Failures since the last imposed lock (reset whenever a lock fires). */
  failures: number;
  /** Lifetime failures on this challenge (never reset). */
  totalFailures: number;
  /** Cooldown locks imposed so far — drives the escalating duration. */
  lockCount: number;
  /** Challenges are unusable before this timestamp (never "permanent": the
   *  maximum possible cooldown is MFA_LOCK_MAX_MS and the challenge itself
   *  expires at expiresAt). */
  lockedUntil: number;
};

/** Fresh challenge state (used by tests + createMfaChallenge). */
export function freshChallengeState(adminId: string, expiresAt: number): MfaChallengeState {
  return { adminId, expiresAt, failures: 0, totalFailures: 0, lockCount: 0, lockedUntil: 0 };
}

/** Pure status check: valid | locked (with retryAfterSeconds) | expired. */
export function challengeStatus(
  state: MfaChallengeState,
  now: number
): { status: "valid" | "locked" | "expired"; retryAfterSeconds?: number } {
  if (now >= state.expiresAt) return { status: "expired" };
  if (now < state.lockedUntil) {
    return { status: "locked", retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntil - now) / 1000)) };
  }
  return { status: "valid" };
}

/** Pure failure accounting: after a WRONG code at `now`, what does the
 *  challenge look like and which failure reason applies?
 *
 *  PHASE 2.1 (§5-A): PROGRESSIVE COOLDOWNS — no permanent lockout exists any
 *  more. Every lock is temporary and doubles with each repetition:
 *    • lock #1 (3 consecutive failures) → 60 s cooldown
 *    • lock #2 → 120 s · lock #3 → 240 s · lock #4 → 480 s
 *    • any lock after 8 TOTAL failures, or lock #5+ → 600 s cap
 *  A challenge that hits the cap simply outlives its own 5-minute TTL — the
 *  attacker gains nothing, the legitimate administrator is never permanently
 *  locked out by anyone else's activity (challenges require the password to
 *  obtain in the first place, and a fresh sign-in always starts clean). */
export function recordChallengeFailure(
  state: MfaChallengeState,
  now: number
): { next: MfaChallengeState; outcome: "INVALID" | "LOCKED"; cooldownMs: number; retryAfterSeconds: number } {
  const totalFailures = state.totalFailures + 1;
  const failures = state.failures + 1;
  const lockNow = failures >= MFA_FAIL_LOCK_THRESHOLD || totalFailures >= MFA_TOTAL_FAIL_LIMIT;
  if (lockNow) {
    const lockCount = state.lockCount + 1;
    const escalated = totalFailures >= MFA_TOTAL_FAIL_LIMIT || lockCount >= 5;
    const cooldownMs = escalated
      ? MFA_LOCK_MAX_MS
      : Math.min(MFA_FAIL_LOCK_MS * 2 ** (lockCount - 1), MFA_LOCK_MAX_MS);
    return {
      next: { ...state, failures: 0, totalFailures, lockCount, lockedUntil: Math.max(state.lockedUntil, now + cooldownMs) },
      outcome: "LOCKED",
      cooldownMs,
      retryAfterSeconds: Math.max(1, Math.ceil(cooldownMs / 1000)),
    };
  }
  return { next: { ...state, failures, totalFailures }, outcome: "INVALID", cooldownMs: 0, retryAfterSeconds: 0 };
}

// Module-level in-memory challenge store — single process, consistent with the
// existing in-memory rate limiter architecture (lib/rate-limit.ts).
const challenges = new Map<string, MfaChallengeState>();
let lastChallengeSweep = 0;

function sweepChallenges(now: number): void {
  if (now - lastChallengeSweep < 60_000) return;
  lastChallengeSweep = now;
  for (const [token, state] of challenges) {
    if (now >= state.expiresAt) challenges.delete(token);
  }
}

/* --------------------------------------- per-admin cross-challenge throttle */
// PHASE 2.1 (§5-A): without this, an attacker holding a stolen password could
// cycle FRESH challenges (each new sign-in mints one) to reset the per-challenge
// failure counter and grind codes indefinitely. The throttle accumulates MFA
// failures PER ADMIN across challenges and applies its own escalating cooldown
// to challenge MINTING. It cannot be armed by unauthenticated traffic: a
// challenge only exists after the password verified, so only someone who
// already passed the password gate can accrue failures here — a legit admin
// who types a wrong code recovers after at most ADMIN_MFA_THROTTLE_MAX_MS.
const adminThrottle = new Map<string, { failures: number; lockCount: number; lockedUntil: number }>();
let lastThrottleSweep = 0;

/** Cross-challenge failures (within the window) that trigger an admin cooldown. */
export const ADMIN_MFA_THROTTLE_FAIL_LIMIT = 6;
/** Failure accrual window (rolling, refreshed by each failure). */
export const ADMIN_MFA_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
/** Per-admin mint cooldown cap. */
export const ADMIN_MFA_THROTTLE_MAX_MS = 10 * 60 * 1000;

function sweepAdminThrottle(now: number): void {
  if (now - lastThrottleSweep < 60_000) return;
  lastThrottleSweep = now;
  for (const [adminId, t] of adminThrottle) {
    if (t.lockedUntil < now - ADMIN_MFA_THROTTLE_WINDOW_MS) adminThrottle.delete(adminId);
  }
}

/** Mint-time gate: is challenge creation currently cooled down for this admin? */
export function adminMfaThrottleStatus(adminId: string, now = Date.now()): { locked: boolean; retryAfterSeconds?: number } {
  sweepAdminThrottle(now);
  const t = adminThrottle.get(adminId);
  if (!t || now >= t.lockedUntil) return { locked: false };
  return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((t.lockedUntil - now) / 1000)) };
}

/** Record an MFA failure against the admin (cross-challenge). */
function noteAdminMfaFailure(adminId: string, now: number): void {
  const t = adminThrottle.get(adminId) ?? { failures: 0, lockCount: 0, lockedUntil: 0 };
  t.failures += 1;
  if (t.failures >= ADMIN_MFA_THROTTLE_FAIL_LIMIT) {
    t.lockCount += 1;
    t.failures = 0;
    const cooldown = Math.min(MFA_FAIL_LOCK_MS * 2 ** (t.lockCount - 1), ADMIN_MFA_THROTTLE_MAX_MS);
    t.lockedUntil = Math.max(t.lockedUntil, now + cooldown);
  }
  adminThrottle.set(adminId, t);
}

/** Mint a login challenge for a (password-verified) admin. TTL 5 min.
 *  PHASE 2.1: refuses (429 MFA_ACCOUNT_COOLDOWN) while the cross-challenge
 *  throttle holds a cooldown for this admin. */
export async function createMfaChallenge(adminId: string): Promise<{ challenge: string; expiresAt: number }> {
  const now = Date.now();
  sweepChallenges(now);
  const throttle = adminMfaThrottleStatus(adminId, now);
  if (throttle.locked) {
    throw new ApiError(
      429,
      "MFA_ACCOUNT_COOLDOWN",
      `Too many incorrect codes — new sign-in attempts are paused for ${throttle.retryAfterSeconds}s`,
      { retryAfterSeconds: throttle.retryAfterSeconds }
    );
  }
  const challenge = randomToken(32);
  const expiresAt = now + MFA_CHALLENGE_TTL_MS;
  challenges.set(challenge, freshChallengeState(adminId, expiresAt));
  return { challenge, expiresAt };
}

/* ------------------------------------------------------- audit (mfa) */

async function auditMfaEvent(
  adminId: string,
  action: "admin.mfa.enrolled" | "admin.mfa.confirmed" | "admin.mfa.disabled" | "admin.mfa.recovery_used" | "admin.mfa.verify_failed",
  meta: Record<string, unknown>,
  email?: string
): Promise<void> {
  try {
    let actorLabel = email ?? null;
    if (!actorLabel) {
      const admin = await db.adminUser.findUnique({ where: { id: adminId }, select: { email: true } });
      actorLabel = admin?.email ?? null;
    }
    await logActivity({
      actorType: "admin",
      actorId: adminId,
      actorLabel,
      action,
      entityType: "admin_mfa",
      entityId: adminId,
      meta,
    });
  } catch {
    // Audit is best-effort — a failed log write must never break the auth flow.
  }
}

/* --------------------------------------------------- challenge verify */

export type MfaVerifyResult =
  | { ok: true; adminId: string; usedRecoveryCode: boolean }
  | {
      ok: false;
      reason: "INVALID" | "EXPIRED" | "LOCKED";
      /** Failure-arm extras (informational, optional): how many wrong codes
       *  remain before the next lock, and how long a lock still runs. */
      attemptsRemaining?: number;
      retryAfterSeconds?: number;
    };

/** Verify a login challenge: TOTP (±1 step) OR one-time recovery code.
 *  Progressive lockout per challenge; success consumes the challenge.
 *  NEVER logs the submitted code. */
export async function verifyMfaChallenge(challengeToken: string, code: string): Promise<MfaVerifyResult> {
  const token = (challengeToken ?? "").trim();
  const now = Date.now();
  sweepChallenges(now);
  const state = challenges.get(token);
  // Unknown token: already used, swept, or garbage — one uniform answer.
  if (!state) return { ok: false, reason: "EXPIRED" };

  const status = challengeStatus(state, now);
  if (status.status === "expired") {
    challenges.delete(token);
    return { ok: false, reason: "EXPIRED" };
  }
  if (status.status === "locked") {
    return { ok: false, reason: "LOCKED", retryAfterSeconds: status.retryAfterSeconds };
  }

  // Login enforcement only applies to CONFIRMED enrollments. An enrollment
  // that vanished (or was never confirmed) can never satisfy this challenge.
  const enrollment = await getMfaEnrollment(state.adminId);
  if (!enrollment || !enrollment.confirmedAt) {
    challenges.delete(token);
    return { ok: false, reason: "EXPIRED" };
  }

  const attempt = (code ?? "").trim();

  // 1) TOTP path (6-digit authenticator code) — PHASE 2.1 (§5-C): the matched
  //    time-step counter is CAS-consumed; a replay of the SAME valid code (or
  //    an older still-in-window code) is rejected exactly like a wrong code.
  let secret: Buffer;
  try {
    secret = base32Decode(decryptSecret(enrollment.secretEnc));
  } catch (e) {
    if (e instanceof ApiError) throw e; // 503 MFA_NOT_CONFIGURED — fail-closed
    // Undecryptable secret (corrupt row / rotated key): the challenge can
    // never succeed — retire it and fail closed.
    challenges.delete(token);
    return { ok: false, reason: "INVALID" };
  }
  const totp = verifyTotpDetailed(secret, attempt, now);
  if (totp.ok) {
    const consumed = await consumeTotpCounter(state.adminId, totp.counter!);
    if (consumed) {
      challenges.delete(token);
      return { ok: true, adminId: state.adminId, usedRecoveryCode: false };
    }
    // Replayed time step — uniform INVALID (never reveal WHY it failed).
    await auditMfaEvent(state.adminId, "admin.mfa.verify_failed", { replay: true });
    const replayRec = recordChallengeFailure(state, now);
    challenges.set(token, replayRec.next);
    noteAdminMfaFailure(state.adminId, now);
    if (replayRec.outcome === "LOCKED") {
      return { ok: false, reason: "LOCKED", retryAfterSeconds: replayRec.retryAfterSeconds, attemptsRemaining: 0 };
    }
    return { ok: false, reason: "INVALID", attemptsRemaining: remainingAttempts(replayRec.next) };
  }

  // 2) Recovery-code path (one-time; hash burned BEFORE success is reported).
  const recoveryIndex = matchRecoveryCode(enrollment.recoveryHashes, attempt);
  if (recoveryIndex >= 0) {
    const remainingHashes = removeRecoveryHash(enrollment.recoveryHashes, recoveryIndex);
    // Optimistic-concurrency burn: the update only lands if the stored hash
    // list is still the one we matched against — two parallel replays of the
    // same code cannot BOTH consume it.
    const burn = await db.adminMfaEnrollment.updateMany({
      where: { adminId: state.adminId, recoveryHashes: enrollment.recoveryHashes },
      data: { recoveryHashes: remainingHashes },
    });
    if (burn.count === 0) {
      // Concurrent verify already burned this code — treat as a wrong code.
      const rec = recordChallengeFailure(state, now);
      challenges.set(token, rec.next);
      noteAdminMfaFailure(state.adminId, now);
      if (rec.outcome === "LOCKED") {
        await auditMfaEvent(state.adminId, "admin.mfa.verify_failed", { cooldown: rec.cooldownMs });
        return { ok: false, reason: "LOCKED", retryAfterSeconds: rec.retryAfterSeconds };
      }
      return { ok: false, reason: "INVALID", attemptsRemaining: remainingAttempts(rec.next) };
    }
    challenges.delete(token);
    await auditMfaEvent(state.adminId, "admin.mfa.recovery_used", { via: "login" });
    return { ok: true, adminId: state.adminId, usedRecoveryCode: true };
  }

  // 3) Wrong code — progressive lockout (audit only when a lock fires, to
  //    avoid per-attempt spam). Every failure also feeds the cross-challenge
  //    per-admin throttle so challenge-cycling cannot reset the counters.
  const rec = recordChallengeFailure(state, now);
  challenges.set(token, rec.next);
  noteAdminMfaFailure(state.adminId, now);
  if (rec.outcome === "LOCKED") {
    await auditMfaEvent(state.adminId, "admin.mfa.verify_failed", {
      cooldown: rec.cooldownMs,
      totalFailures: rec.next.totalFailures,
    });
    return { ok: false, reason: "LOCKED", retryAfterSeconds: rec.retryAfterSeconds, attemptsRemaining: 0 };
  }
  return { ok: false, reason: "INVALID", attemptsRemaining: remainingAttempts(rec.next) };
}

function remainingAttempts(state: MfaChallengeState): number {
  return Math.max(0, Math.min(MFA_FAIL_LOCK_THRESHOLD - state.failures, MFA_TOTAL_FAIL_LIMIT - state.totalFailures));
}

/* ------------------------------------- MANDATORY ENROLLMENT GATE (§5-B) */

let gateWarned = false;

/** Roles that hold any FINANCIAL capability must have a CONFIRMED TOTP
 *  enrollment before they may exercise privileged admin functionality.
 *  Derived from the ADMIN_CAPS matrix (pure — see admin-caps.ts), so the
 *  privileged set stays true if caps evolve: currently {superadmin, finance,
 *  ops} (ops holds refunds.manage + disputes.manage).
 *
 *  Return values:
 *    enrollmentRequired: false — no restriction (non-privileged role, OR
 *      privileged with a confirmed enrollment).
 *    enrollmentRequired: true — RESTRICTED: the admin may only use the MFA
 *      bootstrap routes (enroll/confirm/status + me/logout) until enrollment
 *      is confirmed. Bootstrap is safe: /api/admin/mfa/enroll needs only the
 *      CURRENT PASSWORD (fresh superadmin on a migrated deployment can always
 *      self-recover into full access — NOMOFEE can never be fully locked out).
 *    Table missing (pre-migration deployment) — no enforcement surface yet;
 *      returns false with a loud one-time warning, identical to the Phase 1
 *      contract (enforcement begins the moment migration 20261101000002 lands).
 */
export async function mfaEnrollmentGate(role: string, adminId: string): Promise<{ enrollmentRequired: boolean }> {
  if (!roleRequiresMfa(role)) return { enrollmentRequired: false };
  let row: { confirmedAt: Date | null } | null;
  try {
    row = await db.adminMfaEnrollment.findUnique({ where: { adminId }, select: { confirmedAt: true } });
  } catch (e) {
    if (isPrismaMissingTableError(e)) {
      if (!gateWarned) {
        gateWarned = true;
        console.warn("[mfa] enrollment table missing — mandatory-enrollment gate inactive until 20261101000002 is applied");
      }
      return { enrollmentRequired: false };
    }
    throw e;
  }
  return { enrollmentRequired: !row?.confirmedAt };
}

/* ------------------------------------ admin-route password reauth helper */

// The orchestrator adds `verifyPasswordAsync` to lib/password.ts concurrently
// with this task; prefer it (non-blocking scrypt) when present, otherwise fall
// back to the sync verifier. Both are semantically identical (s1: scrypt).
const pwLib = passwordModule as typeof passwordModule & {
  verifyPasswordAsync?: (password: string, stored: string) => Promise<boolean>;
};
const verifyAsync: ((password: string, stored: string) => Promise<boolean>) | undefined =
  typeof pwLib.verifyPasswordAsync === "function" ? pwLib.verifyPasswordAsync.bind(pwLib) : undefined;

/** Current-password reauthentication for the admin MFA routes. */
export async function verifyAdminPassword(password: string, storedHash: string): Promise<boolean> {
  if (verifyAsync) return verifyAsync(password, storedHash);
  return verifyPassword(password, storedHash);
}

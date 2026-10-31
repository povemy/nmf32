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
//     progressive lockout (3 fails → 60s lock, 8 total fails → locked until
//     expiry).
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
  const normalized = (code ?? "").replace(/[^0-9]/g, "");
  if (normalized.length !== TOTP_DIGITS) return false;
  const counter = totpCounterAt(Math.floor(nowMs / 1000), step);
  for (let i = -window; i <= window; i++) {
    if (safeEqualStr(totpCode(secret, counter + i), normalized)) return true;
  }
  return false;
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
/** Consecutive failures (since the last lock) that trigger a 60s lock. */
export const MFA_FAIL_LOCK_THRESHOLD = 3;
export const MFA_FAIL_LOCK_MS = 60 * 1000;
/** Total failures that lock the challenge until expiry (permanent). */
export const MFA_TOTAL_FAIL_LIMIT = 8;

export type MfaChallengeState = {
  adminId: string;
  expiresAt: number;
  /** Failures since the last imposed lock (reset whenever a 60s lock fires). */
  failures: number;
  /** Lifetime failures on this challenge (never reset). */
  totalFailures: number;
  /** Challenges are unusable before this timestamp; >= expiresAt ⇒ permanent. */
  lockedUntil: number;
};

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
 *    • totalFailures reaches 8   → LOCKED until expiry (permanent).
 *    • failures reaches 3        → LOCKED for 60s, window counter reset.
 *    • otherwise                 → INVALID (attempts remaining shrink). */
export function recordChallengeFailure(
  state: MfaChallengeState,
  now: number
): { next: MfaChallengeState; outcome: "INVALID" | "LOCKED"; permanent: boolean; retryAfterSeconds: number } {
  const totalFailures = state.totalFailures + 1;
  if (totalFailures >= MFA_TOTAL_FAIL_LIMIT) {
    return {
      next: { ...state, totalFailures, lockedUntil: Math.max(state.lockedUntil, state.expiresAt) },
      outcome: "LOCKED",
      permanent: true,
      retryAfterSeconds: Math.max(1, Math.ceil((state.expiresAt - now) / 1000)),
    };
  }
  const failures = state.failures + 1;
  if (failures >= MFA_FAIL_LOCK_THRESHOLD) {
    return {
      next: { ...state, failures: 0, totalFailures, lockedUntil: Math.max(state.lockedUntil, now + MFA_FAIL_LOCK_MS) },
      outcome: "LOCKED",
      permanent: false,
      retryAfterSeconds: Math.ceil(MFA_FAIL_LOCK_MS / 1000),
    };
  }
  return { next: { ...state, failures, totalFailures }, outcome: "INVALID", permanent: false, retryAfterSeconds: 0 };
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

/** Mint a login challenge for a (password-verified) admin. TTL 5 min. */
export async function createMfaChallenge(adminId: string): Promise<{ challenge: string; expiresAt: number }> {
  const now = Date.now();
  sweepChallenges(now);
  const challenge = randomToken(32);
  const expiresAt = now + MFA_CHALLENGE_TTL_MS;
  challenges.set(challenge, { adminId, expiresAt, failures: 0, totalFailures: 0, lockedUntil: 0 });
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

  // 1) TOTP path (6-digit authenticator code).
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
  if (verifyTotp(secret, attempt, now)) {
    challenges.delete(token);
    return { ok: true, adminId: state.adminId, usedRecoveryCode: false };
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
      if (rec.outcome === "LOCKED") {
        await auditMfaEvent(state.adminId, "admin.mfa.verify_failed", { locked: rec.permanent ? "permanent" : "60s" });
        return { ok: false, reason: "LOCKED", retryAfterSeconds: rec.retryAfterSeconds };
      }
      return { ok: false, reason: "INVALID", attemptsRemaining: remainingAttempts(rec.next) };
    }
    challenges.delete(token);
    await auditMfaEvent(state.adminId, "admin.mfa.recovery_used", { via: "login" });
    return { ok: true, adminId: state.adminId, usedRecoveryCode: true };
  }

  // 3) Wrong code — progressive lockout (audit only when a lock fires, to
  //    avoid per-attempt spam).
  const rec = recordChallengeFailure(state, now);
  challenges.set(token, rec.next);
  if (rec.outcome === "LOCKED") {
    await auditMfaEvent(state.adminId, "admin.mfa.verify_failed", {
      locked: rec.permanent ? "permanent" : "60s",
      totalFailures: rec.next.totalFailures,
    });
    return { ok: false, reason: "LOCKED", retryAfterSeconds: rec.retryAfterSeconds, attemptsRemaining: 0 };
  }
  return { ok: false, reason: "INVALID", attemptsRemaining: remainingAttempts(rec.next) };
}

function remainingAttempts(state: MfaChallengeState): number {
  return Math.max(0, Math.min(MFA_FAIL_LOCK_THRESHOLD - state.failures, MFA_TOTAL_FAIL_LIMIT - state.totalFailures));
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

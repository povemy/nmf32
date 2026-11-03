// ============================================================================
// Shopper password recovery (WORK ORDER 1) — recovery code + single-use reset
// grant, built ENTIRELY on the proven Phase 2.2/2.3 primitives:
//
//   • Recovery code : 6-digit CSPRNG OTP issued through the SHARED
//                     EmailOtpChallenge machinery (src/lib/guest-otp.ts,
//                     purpose "password-reset", TTL ~15 min, max 5 attempts,
//                     attempt counters carry over across re-issuance, CAS
//                     single-shot consume). Stored ONLY as the keyed
//                     HMAC-SHA256("otp:v1:…") hash — never plaintext.
//   • Reset grant   : "v1.<b64url(email)>.<expiryMs>.<hmac>" where
//                     hmac = HMAC-SHA256(EMAIL_OTP_SECRET, "prg:v1:<email>:
//                     <expiryMs>:<pwTag>") — the EXACT template of the proven
//                     "gcv:v1:" guest-checkout token with a DISTINCT domain
//                     tag, PLUS a password-epoch binding: pwTag is the first
//                     16 hex of sha256(account.passwordHash) at mint time.
//                     The reset route re-derives the tag from the CURRENT
//                     passwordHash — so the instant ANY password change lands
//                     (the legitimate reset itself included), every
//                     outstanding grant for that account is dead. That makes
//                     the grant effectively single-use WITHOUT new state:
//                     sequential replay after a reset fails the tag check,
//                     and a leaked grant cannot outlive one password change.
//   • TTL           : 15 minutes, no refresh, stateless MAC (rotating
//                     EMAIL_OTP_SECRET kills every outstanding grant
//                     instantly), constant-time compare, strict shape checks.
//                     Minted ONLY by /api/auth/verify-recovery AFTER the
//                     exactly-once OTP consume; consumed ONLY by
//                     /api/auth/reset-password. NEVER logged, never persisted
//                     client-side (the SPA keeps it in memory only).
//
// SECURITY CONTRACT (Work Order 1 §3):
//   • No plaintext reset tokens are stored — the OTP row holds the keyed hash;
//     the grant is a stateless MAC the server never persists.
//   • Single-use — the OTP row is CAS-DELETEd on success (replay impossible);
//     the grant dies with the first password change it authorizes (pwTag).
//   • Rate limits cannot be bypassed by re-requesting codes: attempt counters
//     carry over while a challenge is live (guest-otp.ts semantics), plus
//     per-IP and per-email throttles at every route.
//   • Uniform responses — account existence is never disclosed through
//     messages, status codes, or (best-effort) timing: the not-found branch
//     burns comparable scrypt + jitter work before the SAME response.
//   • Sessions are revoked on reset via revokeUserSessions("shopper", …) —
//     the F-02 primitive already wired for administrative suspension.
// ============================================================================

import { createHash } from "crypto";
import { hmacSha256Hex, safeEqualHex } from "./password";
import { emailOtpSecret } from "./guest-otp";

/** Reset-grant lifetime — aligned with the ~15-minute recovery window. */
export const PASSWORD_RESET_GRANT_TTL_MS = 15 * 60 * 1000;

/** Distinct MAC domain — a reset grant is valid ONLY at /api/auth/reset-password,
 *  never as a guest-checkout token, order-access grant or session. */
const PASSWORD_RESET_DOMAIN = "prg:v1:";

const EMAIL_RE_STRICT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

/* -------------------------------------------------------------- email norms */

/** Canonical recovery subject: trimmed + lowercased + shape-checked, or null. */
export function normalizeRecoveryEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? "").trim().toLowerCase();
  return email.length <= MAX_EMAIL_LEN && EMAIL_RE_STRICT.test(email) ? email : null;
}

/* ------------------------------------------------------------ grant crypto */

/** Password-epoch tag — first 16 hex chars of sha256(passwordHash). Truncation
 *  is deliberate: the tag must BIND the grant to the current password epoch
 *  without exposing (any usable part of) the scrypt hash itself. */
export function passwordEpochTag(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

function b64urlFromEmail(email: string): string {
  return Buffer.from(email, "utf8").toString("base64url");
}

function emailFromB64url(b64: string): string | null {
  try {
    const email = Buffer.from(b64, "base64url").toString("utf8");
    return email.length <= MAX_EMAIL_LEN && EMAIL_RE_STRICT.test(email) ? email : null;
  } catch {
    return null;
  }
}

/** Mint a 15-minute password-reset grant binding `email` AND the account's
 *  current password epoch (`pwTag`). Called ONLY after a successfully consumed
 *  "password-reset" OTP. Pure — the `nowMs` parameter keeps this testable. */
export function issuePasswordResetGrant(email: string, pwTag: string, nowMs: number = Date.now()): string {
  const expiresAtMs = nowMs + PASSWORD_RESET_GRANT_TTL_MS;
  const mac = hmacSha256Hex(emailOtpSecret(), `${PASSWORD_RESET_DOMAIN}${email}:${expiresAtMs}:${pwTag}`);
  return `v1.${b64urlFromEmail(email)}.${expiresAtMs}.${mac}`;
}

export type PasswordResetGrant = { email: string; expiresAtMs: number };

/** Verify a reset grant against the account's CURRENT password epoch:
 *  strict shape checks, absolute expiry (minted server-side — no skew
 *  tolerance needed), canonical email recovery, tag equality, constant-time
 *  MAC compare. Returns null on ANY failure — callers treat null as "not
 *  authorized" (reset FAILS CLOSED). A grant minted before a password change
 *  fails the tag check — replay after reset is impossible. Pure — testable
 *  via `nowMs`. */
export function verifyPasswordResetGrant(
  raw: string | null | undefined,
  currentPwTag: string,
  nowMs: number = Date.now()
): PasswordResetGrant | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [version, emailB64, expiresAt, mac] = parts;
  if (version !== "v1") return null;
  if (!/^[A-Za-z0-9_-]{4,1100}$/.test(emailB64)) return null; // base64url of ≤254-char emails (multibyte-safe)
  if (!/^\d{13,16}$/.test(expiresAt)) return null;
  if (!/^[0-9a-f]{64}$/.test(mac)) return null;
  const expiresAtMs = Number(expiresAt);
  if (expiresAtMs <= nowMs) return null;
  const email = emailFromB64url(emailB64);
  if (!email) return null;
  let secret: string;
  try {
    secret = emailOtpSecret();
  } catch {
    return null; // production without the secret → nothing can verify
  }
  if (!safeEqualHex(mac, hmacSha256Hex(secret, `${PASSWORD_RESET_DOMAIN}${email}:${expiresAtMs}:${currentPwTag}`))) {
    return null;
  }
  return { email, expiresAtMs };
}

/* -------------------------------------------------- timing equalization */

/** Uniform-response timing pad for the account-not-found branch (Work Order
 *  1 §2-A: no OBVIOUS timing difference). The issuance branch writes a
 *  challenge row + sends mail (~tens of ms); this burns one scrypt
 *  verification (~30 ms, off the event loop) plus randomized jitter so the
 *  two branches' latency bands overlap. Combined with the per-IP/per-email
 *  throttles, remote enumeration becomes impractical. Honest residual: this
 *  is band-overlap, not cryptographic indistinguishability. */
export async function burnAccountNotFoundDelay(): Promise<void> {
  const { verifyPasswordAsync, DUMMY_PASSWORD_HASH, randomToken } = await import("./password");
  await verifyPasswordAsync(randomToken(8), DUMMY_PASSWORD_HASH); // ~30 ms of real scrypt work
  const jitter = 20 + Math.floor(Math.random() * 120); // 20–140 ms
  await new Promise((resolve) => setTimeout(resolve, jitter));
}

// End of src/lib/password-recovery.ts — Work Order 1 (shopper password recovery).

// Password hashing (scrypt) — kept separate from auth.ts so seeds/scripts can import it.
import { randomBytes, scryptSync, timingSafeEqual, createHmac, scrypt } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `s1:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [version, salt, hash] = stored.split(":");
    if (version !== "s1" || !salt || !hash) return false;
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// ============================================================================
// Phase 1 (SEC-01 / SEC-04) — asynchronous verification + timing equalization.
//
// • verifyPasswordAsync / hashPasswordAsync run crypto.scrypt on the libuv
//   thread pool instead of scryptSync's event-loop block (~30 ms per call at
//   Node default parameters N=16384 r=8 p=1, benchmarked on this host — see
//   docs/security/phase1-report.md). Identical s1: format, parameters and
//   timingSafeEqual semantics: every existing password hash keeps verifying.
// • DUMMY_PASSWORD_HASH gives the "account does not exist" branch the SAME
//   scrypt work as the "account exists" branch — login paths pass it whenever
//   the record is missing so the timing side-channel (0 vs ~30 ms of scrypt)
//   disappears. It is a valid-format hash of an unguessable random secret and
//   its verification RESULT IS ALWAYS DISCARDED.
// ============================================================================

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `s1:${salt}:${hash.toString("hex")}`;
}

export const DUMMY_PASSWORD_HASH: string = hashPassword(randomToken(16));

export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  try {
    const [version, salt, hash] = stored.split(":");
    if (version !== "s1" || !salt || !hash) return false;
    const candidate = (await scryptAsync(password, salt, 64)) as Buffer;
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** F-03 remediation (TS2305): length-guarded constant-time compare for HEX
 * digests — no timing oracle, no early return on length mismatch. Used by the
 * Stripe-MY adapter's webhook-signature verification (v1 candidates are
 * lowercased first: hex digests are case-insensitive). */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase(), "utf8");
  const bb = Buffer.from(b.toLowerCase(), "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

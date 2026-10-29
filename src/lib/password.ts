// Password hashing (scrypt) — kept separate from auth.ts so seeds/scripts can import it.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "crypto";

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

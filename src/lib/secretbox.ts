// AES-256-GCM secretbox for marketplace access/refresh tokens (Phase 4).
// Key source: env IMPORT_TOKEN_ENC_KEY (hex/base64/passphrase). In dev sandbox a
// deterministic fallback key is derived so the feature works, with a startup
// console warning telling deployers to set a real key (README documents it).
// PRODUCTION FAILS CLOSED (C3): with the key unset/short, sealSecret/openSecret
// throw 503 SECRETBOX_NOT_CONFIGURED (mirrors lib/mfa.ts) instead of encrypting
// marketplace OAuth tokens under a publicly-derivable dev key. NOTE: importing
// ApiError from "./api" is cycle-safe — api.ts pulls in only next/server,
// @prisma/client and ./db, none of which import this module.
//
// KEY ROTATION: every ciphertext is version-tagged ("v1:") and there is exactly
// ONE active key — sha256(IMPORT_TOKEN_ENC_KEY) — with no dual-key reading.
// Rotation = set a NEW IMPORT_TOKEN_ENC_KEY and run a decrypt+re-encrypt
// maintenance script (openSecret each stored token with the old key, sealSecret
// with the new) during a short maintenance freeze; pre-rotation "v1" rows
// cannot be opened after the swap, which is why the freeze is required.
import crypto from "crypto";
import { ApiError } from "./api";

let cachedKey: Buffer | null = null;
let warned = false;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.IMPORT_TOKEN_ENC_KEY;
  if (raw && raw.length >= 16) {
    cachedKey = crypto.createHash("sha256").update(raw).digest();
  } else if (process.env.NODE_ENV === "production") {
    // C3 fail-closed: the dev fallback below is deterministic and publicly
    // derivable (host+cwd) — never an acceptable key for real marketplace
    // OAuth tokens. Match the MFA_ENCRYPTION_KEY 503 pattern.
    throw new ApiError(
      503,
      "SECRETBOX_NOT_CONFIGURED",
      "IMPORT_TOKEN_ENC_KEY is not configured — encrypted marketplace token storage is disabled (fail closed)"
    );
  } else {
    if (!warned) {
      warned = true;
      console.warn(
        "[secretbox] IMPORT_TOKEN_ENC_KEY not set — using derived development key. Set a strong key before production."
      );
    }
    // Dev fallback: deterministic per-deployment (host+path). NOT for production.
    cachedKey = crypto
      .createHash("sha256")
      .update(`shopmesh-dev-key:${process.env.HOSTNAME ?? "local"}:${process.cwd()}`)
      .digest();
  }
  return cachedKey;
}

/** Encrypt a secret → "v1:<iv_b64>:<tag_b64>:<cipher_b64>" (never logs plaintext). */
export function sealSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** Decrypt a sealed secret; returns null on tamper/parse failure. The key is
 *  resolved BEFORE the try on purpose: a production SECRETBOX_NOT_CONFIGURED
 *  throw must not be swallowed by the tamper→null catch below — configuration
 *  errors fail closed (503), only ciphertext failures degrade to null. */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const key = getKey();
  try {
    const [v, ivB64, tagB64, dataB64] = sealed.split(":");
    if (v !== "v1" || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

/** Constant-time string compare for token hashes. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

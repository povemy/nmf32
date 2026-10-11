// AES-256-GCM secretbox for marketplace access/refresh tokens (Phase 4).
// Key source: env IMPORT_TOKEN_ENC_KEY (hex/base64/passphrase). In dev sandbox a
// deterministic fallback key is derived so the feature works, with a startup
// console warning telling deployers to set a real key (README documents it).
import crypto from "crypto";

let cachedKey: Buffer | null = null;
let warned = false;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.IMPORT_TOKEN_ENC_KEY;
  if (raw && raw.length >= 16) {
    cachedKey = crypto.createHash("sha256").update(raw).digest();
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

/** Decrypt a sealed secret; returns null on tamper/parse failure. */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    const [v, ivB64, tagB64, dataB64] = sealed.split(":");
    if (v !== "v1" || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
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

// ============================================================================
// C4 unit tests — PURE crypto/logic coverage for src/lib/mfa.ts (bun:test).
// NO database: only the base32 / TOTP / AES-GCM / recovery-code / challenge
// pure helpers are exercised. DB-backed flows (enrollment reads, recovery
// burns) are covered by route-level behaviour, not here.
// ============================================================================
import { beforeAll, describe, expect, test } from "bun:test";
import {
  MFA_CHALLENGE_TTL_MS,
  MFA_FAIL_LOCK_MS,
  MFA_FAIL_LOCK_THRESHOLD,
  MFA_TOTAL_FAIL_LIMIT,
  base32Decode,
  base32Encode,
  challengeStatus,
  createMfaChallenge,
  decryptSecret,
  encryptSecret,
  formatRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  matchRecoveryCode,
  mfaEncryptionConfigured,
  normalizeRecoveryCode,
  otpauthUrl,
  parseRecoveryHashes,
  recordChallengeFailure,
  removeRecoveryHash,
  sha256Hex,
  totpCode,
  totpCounterAt,
  verifyMfaChallenge,
  verifyTotp,
  type MfaChallengeState,
} from "@/lib/mfa";
import { ApiError } from "@/lib/api";

// RFC 6238 §Appendix B reference secret (ASCII, 20 bytes).
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

beforeAll(() => {
  // Deterministic, isolated key for the crypto tests (call-time read, so
  // setting it here covers every encrypt/decrypt below).
  process.env.MFA_ENCRYPTION_KEY = "bun-test-mfa-key-0123456789";
});

/* ------------------------------------------------------------ base32 */

describe("base32 (RFC 4648)", () => {
  test("RFC 6238 reference secret encodes exactly", () => {
    expect(base32Encode(RFC_SECRET)).toBe(RFC_SECRET_B32);
  });

  test("RFC 6238 reference secret decodes exactly", () => {
    expect(base32Decode(RFC_SECRET_B32).toString("ascii")).toBe("12345678901234567890");
  });

  test("roundtrip across lengths 0..40 (incl. non-byte-aligned tails)", () => {
    for (let len = 0; len <= 40; len++) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  test("decode tolerates lowercase + padding, rejects invalid characters", () => {
    expect(base32Decode(RFC_SECRET_B32.toLowerCase()).toString("ascii")).toBe("12345678901234567890");
    expect(base32Decode(RFC_SECRET_B32 + "====").toString("ascii")).toBe("12345678901234567890");
    expect(() => base32Decode("ABC1")).toThrow(); // '1' is not in the RFC 4648 alphabet
    expect(() => base32Decode("ABC!")).toThrow();
  });
});

/* -------------------------------------------------------------- TOTP */

describe("TOTP (RFC 6238 vectors, SHA1, 6 digits, 30s)", () => {
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  test.each(vectors)("T=%d → %s", (t, expected) => {
    expect(totpCode(RFC_SECRET, totpCounterAt(t))).toBe(expected);
  });

  test("verifyTotp accepts the live code and ±1 step, rejects ±2 steps", () => {
    const counter = totpCounterAt(1111111111); // 37037037
    const at = (c: number) => c * 30 * 1000; // counter → epoch ms
    const code = totpCode(RFC_SECRET, counter);
    expect(verifyTotp(RFC_SECRET, code, at(counter))).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, at(counter - 1))).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, at(counter + 1))).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, at(counter - 2))).toBe(false);
    expect(verifyTotp(RFC_SECRET, code, at(counter + 2))).toBe(false);
  });

  test("verifyTotp rejects wrong codes, non-digit and wrong-length input", () => {
    const counter = totpCounterAt(1234567890);
    const at = counter * 30 * 1000;
    const live = totpCode(RFC_SECRET, counter);
    // A deterministic wrong code: first 6-digit string that matches neither
    // counter-1, counter nor counter+1.
    const accepted = new Set([totpCode(RFC_SECRET, counter - 1), live, totpCode(RFC_SECRET, counter + 1)]);
    let wrong = "000000";
    while (accepted.has(wrong)) wrong = (Number(wrong) + 1).toString().padStart(6, "0");
    expect(verifyTotp(RFC_SECRET, wrong, at)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12 34", at)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "1234567", at)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "", at)).toBe(false);
  });

  test("generated secrets are 20 bytes / 32 base32 chars and self-verify", () => {
    const { secret, secretBase32 } = generateTotpSecret();
    expect(secret.length).toBe(20);
    expect(secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    const code = totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000)));
    expect(verifyTotp(secret, code, Date.now())).toBe(true);
  });

  test("otpauthUrl follows the NOMOFEE provisioning contract", () => {
    expect(otpauthUrl({ email: "ops@nomofee.test" }, RFC_SECRET_B32)).toBe(
      `otpauth://totp/NOMOFEE:ops%40nomofee.test?secret=${RFC_SECRET_B32}&issuer=NOMOFEE&algorithm=SHA1&digits=6&period=30`
    );
  });
});

/* --------------------------------------------------------- encryption */

describe("AES-256-GCM secret encryption", () => {
  test("roundtrip: decrypt(encrypt(x)) === x", () => {
    const plaintext = base32Encode(Buffer.from("totp-secret-material"));
    const enc = encryptSecret(plaintext);
    expect(enc).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(decryptSecret(enc)).toBe(plaintext);
  });

  test("tampered ciphertext fails (GCM tag mismatch)", () => {
    const enc = encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const [iv, tag, ct] = enc.split(".");
    // Deterministic tamper: swap the first base64 char of the ciphertext.
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(() => decryptSecret(`${iv}.${tag}.${flipped}`)).toThrow();
    // Tampering the tag also fails.
    const tagFlipped = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
    expect(() => decryptSecret(`${iv}.${tagFlipped}.${ct}`)).toThrow();
  });

  test("wrong key fails; malformed input fails", () => {
    const enc = encryptSecret("GEZDGNBVGY3TQOJQ");
    const saved = process.env.MFA_ENCRYPTION_KEY;
    try {
      process.env.MFA_ENCRYPTION_KEY = "a-different-key-entirely";
      expect(() => decryptSecret(enc)).toThrow();
    } finally {
      process.env.MFA_ENCRYPTION_KEY = saved;
    }
    expect(() => decryptSecret("not-a-valid-secret-blob")).toThrow();
    expect(() => decryptSecret("a.b")).toThrow();
  });

  test("mfaEncryptionConfigured + production fail-closed (503 MFA_NOT_CONFIGURED)", () => {
    expect(mfaEncryptionConfigured()).toBe(true); // env key set in beforeAll
    const savedKey = process.env.MFA_ENCRYPTION_KEY;
    const savedEnv = process.env.NODE_ENV;
    // NODE_ENV is typed read-only by Next's ambient declarations — mutate
    // through a widened record for this fail-closed simulation.
    const env = process.env as Record<string, string | undefined>;
    try {
      delete process.env.MFA_ENCRYPTION_KEY;
      // Dev/test: usable via the warned default key.
      expect(mfaEncryptionConfigured()).toBe(true);
      expect(decryptSecret(encryptSecret("dev-default-key-material"))).toBe("dev-default-key-material");
      // Production without a key: fail closed.
      env.NODE_ENV = "production";
      expect(mfaEncryptionConfigured()).toBe(false);
      expect(() => encryptSecret("nope")).toThrow(ApiError);
      try {
        encryptSecret("nope");
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ApiError && e.status === 503 && e.code === "MFA_NOT_CONFIGURED").toBe(true);
      }
    } finally {
      process.env.MFA_ENCRYPTION_KEY = savedKey;
      env.NODE_ENV = savedEnv;
    }
  });
});

/* ------------------------------------------------------ recovery codes */

describe("recovery codes", () => {
  test("generateRecoveryCodes: 10 codes, 10 hex chars, sha256 hashes match", () => {
    const { codes, hashesJson } = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{10}$/);
    const hashes = parseRecoveryHashes(hashesJson);
    expect(hashes).toHaveLength(10);
    codes.forEach((c, i) => expect(hashes[i]).toBe(sha256Hex(c)));
  });

  test("matchRecoveryCode finds the right index and normalizes input", () => {
    const { codes, hashesJson } = generateRecoveryCodes();
    const target = codes[3];
    expect(matchRecoveryCode(hashesJson, target)).toBe(3);
    // Display grouping + case-insensitivity both normalize to the same code.
    expect(matchRecoveryCode(hashesJson, formatRecoveryCode(target))).toBe(3);
    expect(matchRecoveryCode(hashesJson, target.toUpperCase())).toBe(3);
    expect(matchRecoveryCode(hashesJson, " " + target + " ")).toBe(3);
    expect(matchRecoveryCode(hashesJson, "0000000000")).toBe(-1);
    expect(matchRecoveryCode(hashesJson, "")).toBe(-1);
    expect(matchRecoveryCode(hashesJson, target.slice(0, 9))).toBe(-1);
  });

  test("one-time removal: hash burned exactly once, siblings untouched", () => {
    const { codes, hashesJson } = generateRecoveryCodes();
    const idx = matchRecoveryCode(hashesJson, codes[7]);
    expect(idx).toBe(7);
    const after = removeRecoveryHash(hashesJson, idx);
    expect(parseRecoveryHashes(after)).toHaveLength(9);
    expect(matchRecoveryCode(after, codes[7])).toBe(-1); // burned
    expect(matchRecoveryCode(after, codes[6])).toBe(6); // siblings shift by one
    expect(matchRecoveryCode(after, codes[8])).toBe(7);
    // Out-of-range removal is a no-op.
    expect(removeRecoveryHash(after, -1)).toBe(after);
    expect(removeRecoveryHash(after, 99)).toBe(after);
  });

  test("parseRecoveryHashes is defensive against malformed storage", () => {
    expect(parseRecoveryHashes("[]")).toEqual([]);
    expect(parseRecoveryHashes("not json")).toEqual([]);
    expect(parseRecoveryHashes('["abc", null, 42, "' + "a".repeat(64) + '"]')).toEqual(["a".repeat(64)]);
  });

  test("formatRecoveryCode groups 10-char codes as 5-5", () => {
    expect(formatRecoveryCode("abcdefghij")).toBe("abcde-fghij");
    expect(normalizeRecoveryCode("ABCDE-FGHIJ")).toBe("abcdefghij");
  });
});

/* --------------------------------------------------- challenge (map) */

function freshChallenge(now: number): MfaChallengeState {
  return { adminId: "admin_1", expiresAt: now + MFA_CHALLENGE_TTL_MS, failures: 0, totalFailures: 0, lockedUntil: 0 };
}

describe("challenge map logic (pure)", () => {
  const now = 1_700_000_000_000;

  test("challengeStatus: valid → locked → expired", () => {
    const state = freshChallenge(now);
    expect(challengeStatus(state, now).status).toBe("valid");
    const locked: MfaChallengeState = { ...state, lockedUntil: now + MFA_FAIL_LOCK_MS };
    const st = challengeStatus(locked, now);
    expect(st.status).toBe("locked");
    expect(st.retryAfterSeconds).toBe(60);
    expect(challengeStatus(locked, now + MFA_FAIL_LOCK_MS - 1).status).toBe("locked");
    expect(challengeStatus(locked, now + MFA_FAIL_LOCK_MS).status).toBe("valid");
    expect(challengeStatus(state, state.expiresAt - 1).status).toBe("valid");
    expect(challengeStatus(state, state.expiresAt).status).toBe("expired");
  });

  test("progressive lockout: 3 failures → 60s lock (window resets)", () => {
    let state = freshChallenge(now);
    const f1 = recordChallengeFailure(state, now);
    expect(f1.outcome).toBe("INVALID");
    expect(f1.next.failures).toBe(1);
    const f2 = recordChallengeFailure(f1.next, now);
    expect(f2.outcome).toBe("INVALID");
    expect(f2.next.failures).toBe(2);
    const f3 = recordChallengeFailure(f2.next, now);
    expect(f3.outcome).toBe("LOCKED");
    expect(f3.permanent).toBe(false);
    expect(f3.retryAfterSeconds).toBe(60);
    expect(f3.next.failures).toBe(0); // window reset
    expect(f3.next.totalFailures).toBe(MFA_FAIL_LOCK_THRESHOLD);
    expect(challengeStatus(f3.next, now).status).toBe("locked");
    // Lock lifts after 60s (challenge itself still alive).
    expect(challengeStatus(f3.next, now + MFA_FAIL_LOCK_MS).status).toBe("valid");
  });

  test("progressive lockout: 8 TOTAL failures → locked until expiry (permanent)", () => {
    let state = freshChallenge(now);
    let t = now;
    let permanent: ReturnType<typeof recordChallengeFailure> | null = null;
    for (let i = 1; i <= MFA_TOTAL_FAIL_LIMIT; i++) {
      const rec = recordChallengeFailure(state, t);
      state = rec.next;
      if (rec.permanent) permanent = rec;
      // Advance past any 60s lock so only the TOTAL limit can stop us.
      t = Math.max(t, state.lockedUntil) + 1000;
    }
    expect(permanent).not.toBeNull();
    expect(permanent!.outcome).toBe("LOCKED");
    expect(permanent!.next.lockedUntil).toBeGreaterThanOrEqual(state.expiresAt);
    // Still locked right up to expiry — long after any 60s window ended…
    expect(challengeStatus(state, state.expiresAt - 1).status).toBe("locked");
    // …and only expiry ends it.
    expect(challengeStatus(state, state.expiresAt).status).toBe("expired");
    // Exactly 8 failures were needed — the 7th was still a plain INVALID.
    expect(state.totalFailures).toBe(MFA_TOTAL_FAIL_LIMIT);
  });

  test("lock cadence: 3, 6 (locks), 7 INVALID, 8 permanent", () => {
    let state = freshChallenge(now);
    let t = now;
    const outcomes: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const rec = recordChallengeFailure(state, t);
      outcomes.push(rec.outcome);
      state = rec.next;
      t = Math.max(t, state.lockedUntil) + 1000;
    }
    expect(outcomes).toEqual(["INVALID", "INVALID", "LOCKED", "INVALID", "INVALID", "LOCKED", "INVALID", "LOCKED"]);
  });
});

describe("challenge map wiring (no DB)", () => {
  test("createMfaChallenge mints a 64-hex token with a 5-minute TTL", async () => {
    const before = Date.now();
    const { challenge, expiresAt } = await createMfaChallenge("admin_probe");
    const after = Date.now();
    expect(challenge).toMatch(/^[a-f0-9]{64}$/);
    expect(expiresAt).toBeGreaterThanOrEqual(before + MFA_CHALLENGE_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + MFA_CHALLENGE_TTL_MS);
  });

  test("verifyMfaChallenge answers EXPIRED for an unknown/already-used token", async () => {
    const res = await verifyMfaChallenge("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "123456");
    expect(res).toEqual({ ok: false, reason: "EXPIRED" });
  });
});

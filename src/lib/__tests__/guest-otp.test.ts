// ============================================================================
// FINAL CLOSURE unit tests — PURE crypto/logic coverage for
// src/lib/guest-otp.ts (bun:test). NO database: only the code generation,
// day-bucket hash, midnight-rollover and order-access-grant primitives are
// exercised here (mirroring mfa.test.ts's pure-crypto style). The DB-backed
// flows (challenge rows, CAS consume, attempt counters, claiming) are covered
// by the STAGING-ONLY pack: scripts/readiness/guest-order-otp-e2e.ts.
// ============================================================================
import { beforeAll, describe, expect, test } from "bun:test";
import {
  EMAIL_OTP_DIGITS,
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_TTL_MS,
  ORDER_ACCESS_GRANT_TTL_MS,
  generateOtpCode,
  normalizeOtpCode,
  otpCandidateBuckets,
  otpCodeHash,
  otpDayBucket,
  issueOrderAccessGrant,
  verifyOrderAccessGrant,
  emailOtpSecret,
  orderAccessSecret,
} from "@/lib/guest-otp";
import { createHmac } from "crypto";

const DAY_MS = 86_400_000;
/** A fixed reference time: 2026-11-04T23:55:00Z (5 minutes before UTC midnight). */
const PRE_MIDNIGHT_MS = Date.UTC(2026, 10, 4, 23, 55, 0);
/** Five minutes AFTER the UTC midnight rollover. */
const POST_MIDNIGHT_MS = PRE_MIDNIGHT_MS + 10 * 60 * 1000;

beforeAll(() => {
  // Dev fallback secrets must be active for deterministic hashing in tests
  // (bun:test does not run with NODE_ENV=production).
  expect(emailOtpSecret().length).toBeGreaterThan(0);
  expect(orderAccessSecret().length).toBeGreaterThan(0);
});

describe("generateOtpCode — CSPRNG 6-digit codes", () => {
  test("always produces exactly 6 zero-padded digits", () => {
    for (let i = 0; i < 2_000; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  test("covers the full digit space without modulo bias artifacts", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i++) seen.add(generateOtpCode());
    // 5,000 draws from a uniform 10^6 space should see >4,900 distinct codes
    // (expected ≈ 4,987; a biased generator skews this badly).
    expect(seen.size).toBeGreaterThan(4_900);
    // Every leading digit 0-9 appears (zero-padding works, no range clipping).
    const leading = new Set([...seen].map((c) => c[0]));
    expect(leading.size).toBe(10);
  });

  test("constants pin the challenge contract", () => {
    expect(EMAIL_OTP_DIGITS).toBe(6);
    expect(EMAIL_OTP_MAX_ATTEMPTS).toBe(5);
    expect(EMAIL_OTP_TTL_MS).toBe(10 * 60 * 1000);
    expect(ORDER_ACCESS_GRANT_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe("normalizeOtpCode — input normalization", () => {
  test("accepts plain and lightly-formatted 6-digit input", () => {
    expect(normalizeOtpCode("123456")).toBe("123456");
    expect(normalizeOtpCode(" 123 456 ")).toBe("123456");
    expect(normalizeOtpCode("123-456")).toBe("123456");
  });
  test("rejects wrong length, non-digits and junk", () => {
    expect(normalizeOtpCode("12345")).toBeNull();
    expect(normalizeOtpCode("1234567")).toBeNull();
    expect(normalizeOtpCode("abcdef")).toBeNull();
    expect(normalizeOtpCode("")).toBeNull();
    expect(normalizeOtpCode(null)).toBeNull();
    expect(normalizeOtpCode(undefined)).toBeNull();
  });
});

describe("day-bucket + HMAC hash — midnight rollover", () => {
  test("bucket is the UTC epoch day", () => {
    expect(otpDayBucket(0)).toBe(0);
    expect(otpDayBucket(DAY_MS - 1)).toBe(0);
    expect(otpDayBucket(DAY_MS)).toBe(1);
    // 2026-11-04 is epoch day 20761 — pinned so drift is caught.
    expect(otpDayBucket(PRE_MIDNIGHT_MS)).toBe(20_761);
  });

  test("candidates are today and YESTERDAY (never tomorrow)", () => {
    const c = otpCandidateBuckets(POST_MIDNIGHT_MS);
    expect(c).toEqual([20_762, 20_761]);
  });

  test("a code issued before UTC midnight still hashes-match after rollover", () => {
    // Issued 23:55 (bucket D=20761); verified 00:05 next day (bucket D+1).
    const code = "482901";
    const subjectId = "order_cuid_1";
    const issuedHash = otpCodeHash(code, "guest-order", subjectId, otpDayBucket(PRE_MIDNIGHT_MS));
    const matches = otpCandidateBuckets(POST_MIDNIGHT_MS).some(
      (b) => otpCodeHash(code, "guest-order", subjectId, b) === issuedHash
    );
    expect(matches).toBe(true); // the 10-minute TTL carries it across midnight
  });

  test("hashes are purpose-, subject- and code-bound (challenge binding)", () => {
    const h = otpCodeHash("111222", "guest-order", "orderA", 20_761);
    expect(otpCodeHash("111222", "shopper-email", "orderA", 20_761)).not.toBe(h);
    expect(otpCodeHash("111222", "guest-order", "orderB", 20_761)).not.toBe(h);
    expect(otpCodeHash("111223", "guest-order", "orderA", 20_761)).not.toBe(h);
    expect(otpCodeHash("111222", "guest-order", "orderA", 20_760)).not.toBe(h);
  });

  test("hash is HMAC-SHA256 keyed by the secret (64 lowercase hex)", () => {
    const secret = "sm_email_otp_dev";
    const expected = createHmac("sha256", secret)
      .update(`otp:v1:guest-order:orderA:20761:111222`)
      .digest("hex");
    expect(otpCodeHash("111222", "guest-order", "orderA", 20_761, secret)).toBe(expected);
    expect(otpCodeHash("111222", "guest-order", "orderA", 20_761)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("issueOrderAccessGrant / verifyOrderAccessGrant", () => {
  const orderId = "clkx0testorder0001";

  test("mint → verify round-trip returns the bound order and expiry", () => {
    const now = PRE_MIDNIGHT_MS;
    const grant = issueOrderAccessGrant(orderId, now);
    const parsed = verifyOrderAccessGrant(grant, now + 1_000);
    expect(parsed).not.toBeNull();
    expect(parsed!.orderId).toBe(orderId);
    expect(parsed!.expiresAtMs).toBe(now + ORDER_ACCESS_GRANT_TTL_MS);
  });

  test("grant expires exactly at TTL (15 minutes, no grace)", () => {
    const now = POST_MIDNIGHT_MS;
    const grant = issueOrderAccessGrant(orderId, now);
    expect(verifyOrderAccessGrant(grant, now + ORDER_ACCESS_GRANT_TTL_MS - 1)).not.toBeNull();
    expect(verifyOrderAccessGrant(grant, now + ORDER_ACCESS_GRANT_TTL_MS)).toBeNull();
  });

  test("order-specific: swapping the orderId breaks the MAC", () => {
    const grant = issueOrderAccessGrant(orderId);
    const parts = grant.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    const forged = `v1.clkx0OTHERorder00.${parts[2]}.${parts[3]}`;
    expect(verifyOrderAccessGrant(forged)).toBeNull();
    // The legitimate grant still names only its own order.
    expect(verifyOrderAccessGrant(grant)!.orderId).toBe(orderId);
  });

  test("tampering with expiry or MAC fails verification", () => {
    const grant = issueOrderAccessGrant(orderId);
    const [v, id, exp, mac] = grant.split(".");
    // Extended expiry without re-signing.
    expect(verifyOrderAccessGrant(`${v}.${id}.${Number(exp) + 60_000}.${mac}`)).toBeNull();
    // Truncated/flipped MAC.
    expect(verifyOrderAccessGrant(`${v}.${id}.${exp}.${mac.slice(0, 62)}aa`)).toBeNull();
    expect(verifyOrderAccessGrant(`${v}.${id}.${exp}.${"0".repeat(64)}`)).toBeNull();
  });

  test("malformed inputs never verify (uniform null)", () => {
    expect(verifyOrderAccessGrant(null)).toBeNull();
    expect(verifyOrderAccessGrant("")).toBeNull();
    expect(verifyOrderAccessGrant("v1")).toBeNull();
    expect(verifyOrderAccessGrant("v1.only")).toBeNull();
    expect(verifyOrderAccessGrant("v1.a.b.c.d")).toBeNull();
    expect(verifyOrderAccessGrant("v2.orderId.1234567890123." + "a".repeat(64))).toBeNull();
    // Session-token-shaped Bearer values must never parse as grants.
    expect(verifyOrderAccessGrant("f".repeat(64))).toBeNull();
    expect(verifyOrderAccessGrant(`${"ab".repeat(32)}`)).toBeNull();
  });

  test("grants are distinct per issuance (no cross-order replay surface)", () => {
    const a = issueOrderAccessGrant(orderId);
    const b = issueOrderAccessGrant("clkx0differentorder");
    expect(a).not.toBe(b);
    expect(verifyOrderAccessGrant(a)!.orderId).toBe(orderId);
    expect(verifyOrderAccessGrant(b)!.orderId).toBe("clkx0differentorder");
    // A grant for order A cannot be re-labelled as order B (route cross-checks
    // the orderNumber too — defense in depth on both layers).
    const wrongNumber = verifyOrderAccessGrant(a);
    expect(wrongNumber!.orderId === "clkx0differentorder").toBe(false);
  });
});

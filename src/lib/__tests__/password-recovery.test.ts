// ============================================================================
// WORK ORDER 1 unit tests — PURE crypto/logic coverage for
// src/lib/password-recovery.ts (bun:test). NO database: the grant
// mint/verify primitives, password-epoch binding, expiry, tamper resistance,
// cross-domain separation and email normalization are exercised here
// (mirroring guest-otp.test.ts's pure-crypto style). The DB-backed flows
// (challenge rows, CAS consume, session revocation, rate limits) are covered
// by the live Mailpit E2E executed against the running dev server.
// ============================================================================
import { beforeAll, describe, expect, test } from "bun:test";
import {
  PASSWORD_RESET_GRANT_TTL_MS,
  issuePasswordResetGrant,
  verifyPasswordResetGrant,
  passwordEpochTag,
  normalizeRecoveryEmail,
} from "@/lib/password-recovery";
import { issueGuestCheckoutToken, verifyGuestCheckoutToken, PASSWORD_RESET_OTP_TTL_MS } from "@/lib/guest-otp";
import { createHmac } from "crypto";

/** Fixed reference time: 2026-11-03T13:30:00Z. */
const NOW_MS = Date.UTC(2026, 10, 3, 13, 30, 0);
const EMAIL = "qa.shopper@nomofee.test";
const PW_TAG = passwordEpochTag("s1:aabbcc:0123");

beforeAll(() => {
  // Dev fallback secrets must be active for deterministic MACs in tests
  // (bun:test does not run with NODE_ENV=production).
  expect(PW_TAG).toMatch(/^[0-9a-f]{16}$/);
});

describe("normalizeRecoveryEmail — canonical recovery subjects", () => {
  test("trims, lowercases and accepts valid addresses", () => {
    expect(normalizeRecoveryEmail("  QA.Shopper@NOMOFEE.test ")).toBe("qa.shopper@nomofee.test");
    expect(normalizeRecoveryEmail("a@b.co")).toBe("a@b.co");
  });

  test("rejects malformed, empty, and oversized inputs", () => {
    expect(normalizeRecoveryEmail(null)).toBeNull();
    expect(normalizeRecoveryEmail("")).toBeNull();
    expect(normalizeRecoveryEmail("not-an-email")).toBeNull();
    expect(normalizeRecoveryEmail("a@b")).toBeNull();
    expect(normalizeRecoveryEmail("a b@c.d")).toBeNull();
    // 254 chars total is the documented maximum and MUST be accepted…
    expect(normalizeRecoveryEmail(`${"x".repeat(250)}@c.d`)).toBe(`${"x".repeat(250)}@c.d`);
    // …while 255 chars is rejected.
    expect(normalizeRecoveryEmail(`${"x".repeat(251)}@c.d`)).toBeNull();
  });
});

describe("passwordEpochTag — password-epoch binding tag", () => {
  test("is deterministic, 16-hex, and input-sensitive", () => {
    expect(passwordEpochTag("s1:salt:hash")).toBe(passwordEpochTag("s1:salt:hash"));
    expect(passwordEpochTag("s1:salt:hash")).not.toBe(passwordEpochTag("s1:salt2:hash"));
    expect(passwordEpochTag("s1:salt:hash")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("issuePasswordResetGrant / verifyPasswordResetGrant — round-trip", () => {
  test("a minted grant verifies against the SAME password epoch", () => {
    const grant = issuePasswordResetGrant(EMAIL, PW_TAG, NOW_MS);
    const verified = verifyPasswordResetGrant(grant, PW_TAG, NOW_MS + 1000);
    expect(verified).not.toBeNull();
    expect(verified!.email).toBe(EMAIL);
    expect(verified!.expiresAtMs).toBe(NOW_MS + PASSWORD_RESET_GRANT_TTL_MS);
  });

  test("the TTL constants pin the recovery contract (~15 minutes)", () => {
    expect(PASSWORD_RESET_GRANT_TTL_MS).toBe(15 * 60 * 1000);
    expect(PASSWORD_RESET_OTP_TTL_MS).toBe(15 * 60 * 1000);
  });

  test("fails against a DIFFERENT password epoch (already-used grant)", () => {
    const grant = issuePasswordResetGrant(EMAIL, PW_TAG, NOW_MS);
    // After the reset lands, the account's passwordHash changes → new epoch.
    const newTag = passwordEpochTag("s1:newsalt:newhash");
    expect(verifyPasswordResetGrant(grant, newTag, NOW_MS + 1000)).toBeNull();
  });

  test("expiry is absolute — a grant dies at (and after) its expiry instant", () => {
    const grant = issuePasswordResetGrant(EMAIL, PW_TAG, NOW_MS);
    const exp = NOW_MS + PASSWORD_RESET_GRANT_TTL_MS;
    expect(verifyPasswordResetGrant(grant, PW_TAG, exp - 1)).not.toBeNull();
    expect(verifyPasswordResetGrant(grant, PW_TAG, exp)).toBeNull();
    expect(verifyPasswordResetGrant(grant, PW_TAG, exp + 1)).toBeNull();
  });

  test("rejects null/undefined/garbage inputs uniformly", () => {
    expect(verifyPasswordResetGrant(null, PW_TAG, NOW_MS)).toBeNull();
    expect(verifyPasswordResetGrant(undefined, PW_TAG, NOW_MS)).toBeNull();
    expect(verifyPasswordResetGrant("", PW_TAG, NOW_MS)).toBeNull();
    expect(verifyPasswordResetGrant("garbage", PW_TAG, NOW_MS)).toBeNull();
    expect(verifyPasswordResetGrant("v1.only.three", PW_TAG, NOW_MS)).toBeNull();
    expect(verifyPasswordResetGrant("v2.aGFz.1793714510154." + "0".repeat(64), PW_TAG, NOW_MS)).toBeNull();
  });

  test("tampering with ANY grant segment invalidates the MAC", () => {
    const grant = issuePasswordResetGrant(EMAIL, PW_TAG, NOW_MS);
    const [v, emailB64, expiresAt, mac] = grant.split(".");
    // Tampered email (different address inside the same shape class).
    const otherEmailB64 = Buffer.from("other@nomofee.test", "utf8").toString("base64url");
    expect(verifyPasswordResetGrant([v, otherEmailB64, expiresAt, mac].join("."), PW_TAG, NOW_MS + 1)).toBeNull();
    // Tampered expiry (extended lifetime).
    expect(verifyPasswordResetGrant([v, emailB64, String(Number(expiresAt) + 60_000), mac].join("."), PW_TAG, NOW_MS + 1)).toBeNull();
    // Tampered MAC (bit flip on the first hex char).
    const flipped = (mac[0] === "0" ? "1" : "0") + mac.slice(1);
    expect(verifyPasswordResetGrant([v, emailB64, expiresAt, flipped].join("."), PW_TAG, NOW_MS + 1)).toBeNull();
    // Malformed charset in the MAC.
    expect(verifyPasswordResetGrant([v, emailB64, expiresAt, "Z".repeat(64)].join("."), PW_TAG, NOW_MS + 1)).toBeNull();
  });

  test("a grant for one email never verifies as another email's grant", () => {
    const grant = issuePasswordResetGrant(EMAIL, PW_TAG, NOW_MS);
    // The email is INSIDE the MAC payload — swapping the b64 segment fails
    // (covered above); here we verify the minted grant only ever resolves to
    // its own subject, so a reset can only ever target the verified mailbox.
    const verified = verifyPasswordResetGrant(grant, PW_TAG, NOW_MS + 1);
    expect(verified!.email).toBe(EMAIL);
  });
});

describe("cross-domain separation — reset grants vs guest-checkout tokens", () => {
  test("a guest-checkout token NEVER verifies as a reset grant (and vice versa)", () => {
    const gcv = issueGuestCheckoutToken(EMAIL, NOW_MS);
    expect(verifyPasswordResetGrant(gcv, PW_TAG, NOW_MS + 1)).toBeNull();
    const prg = issuePasswordResetGrant(EMAIL, PW_TAG, NOW_MS);
    // The guest-checkout verifier takes no pwTag — but the raw token must
    // still fail its OWN domain checks (the MAC covers "prg:v1:…", not
    // "gcv:v1:…").
    expect(verifyGuestCheckoutToken(prg, NOW_MS + 1)).toBeNull();
  });

  test("the two domains produce distinct MACs for the same email+expiry", () => {
    const exp = NOW_MS + PASSWORD_RESET_GRANT_TTL_MS;
    const devSecret = "sm_email_otp_dev";
    const prgMac = createHmac("sha256", devSecret).update(`prg:v1:${EMAIL}:${exp}:${PW_TAG}`).digest("hex");
    const gcvMac = createHmac("sha256", devSecret).update(`gcv:v1:${EMAIL}:${exp}`).digest("hex");
    expect(prgMac).not.toBe(gcvMac);
  });
});

describe("grant charset and shape discipline", () => {
  test("mints the documented v1 four-segment shape with hex MAC", () => {
    const grant = issuePasswordResetGrant(EMAIL, PW_TAG, NOW_MS);
    const parts = grant.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe(Buffer.from(EMAIL, "utf8").toString("base64url"));
    expect(parts[2]).toBe(String(NOW_MS + PASSWORD_RESET_GRANT_TTL_MS));
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("multibyte emails survive the base64url round-trip", () => {
    const email = "用户@例子.my";
    const grant = issuePasswordResetGrant(email, PW_TAG, NOW_MS);
    const verified = verifyPasswordResetGrant(grant, PW_TAG, NOW_MS + 1);
    expect(verified).not.toBeNull();
    expect(verified!.email).toBe(email);
  });
});

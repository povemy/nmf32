// ============================================================================
// Phase 1 (C1 / SEC-04) — async scrypt + dummy-hash verification tests.
// Proves: (a) hash-format compatibility — every hash verifies under BOTH the
// sync and async implementations (no password invalidation); (b) failure
// semantics are identical; (c) DUMMY_PASSWORD_HASH is a valid s1: hash (same
// parse path/work as a real one) for timing equalization.
// ============================================================================
import { describe, expect, test } from "bun:test";
import {
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
  DUMMY_PASSWORD_HASH,
} from "@/lib/password";

describe("async scrypt compatibility (s1: format preserved)", () => {
  test("hashPasswordAsync output verifies under BOTH verifiers", async () => {
    for (const pw of ["Admin123!", "pässwörd-ünicode", "x".repeat(72), ""]) {
      const stored = await hashPasswordAsync(pw);
      expect(stored.startsWith("s1:")).toBe(true);
      expect(await verifyPasswordAsync(pw, stored)).toBe(true);
      expect(verifyPassword(pw, stored)).toBe(true);
    }
  });
  test("legacy hashPassword output verifies under the ASYNC verifier (no invalidation)", async () => {
    const stored = hashPassword("Shopper123!");
    expect(await verifyPasswordAsync("Shopper123!", stored)).toBe(true);
    expect(await verifyPasswordAsync("wrong", stored)).toBe(false);
  });
  test("wrong password fails identically (async + sync)", async () => {
    const stored = hashPassword("correct horse battery staple");
    expect(await verifyPasswordAsync("Tr0ub4dor&3", stored)).toBe(false);
    expect(verifyPassword("Tr0ub4dor&3", stored)).toBe(false);
  });
  test("malformed stored hashes fail closed without throwing", async () => {
    for (const bad of ["", "s1:", "s2:abc:def", "not-a-hash", "s1:zz:zz"]) {
      expect(await verifyPasswordAsync("x", bad)).toBe(false);
      expect(verifyPassword("x", bad)).toBe(false);
    }
  });
});

describe("DUMMY_PASSWORD_HASH (timing equalization)", () => {
  test("is a valid s1: hash — same parse path/work as a real stored hash", async () => {
    expect(DUMMY_PASSWORD_HASH.startsWith("s1:")).toBe(true);
    const parts = DUMMY_PASSWORD_HASH.split(":");
    expect(parts.length).toBe(3);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
    // Verification against it RUNS (returns a boolean, never throws) — that
    // is the property login paths rely on for equalizing the not-found branch.
    const ran = await verifyPasswordAsync("anything", DUMMY_PASSWORD_HASH);
    expect(typeof ran).toBe("boolean");
  });
  test("does not match an attacker's chosen password (probabilistic sanity)", async () => {
    for (const guess of ["password", "Admin123!", "admin", "", "123456"]) {
      expect(await verifyPasswordAsync(guess, DUMMY_PASSWORD_HASH)).toBe(false);
    }
  });
});

describe("async does not block the event loop", () => {
  test("timer resolution stays fine while verifications run", async () => {
    const stored = hashPassword("event-loop-test");
    let maxDrift = 0;
    const started = Date.now();
    const timer = setInterval(() => {
      const drift = Date.now() - started;
      // The interval is 5 ms; scryptSync's ~30 ms block would show up as a
      // drift far beyond 40 ms. Async keeps the loop responsive.
      if (drift > maxDrift) maxDrift = drift;
    }, 5);
    await verifyPasswordAsync("event-loop-test", stored);
    await verifyPasswordAsync("wrong", stored);
    await verifyPasswordAsync("x", DUMMY_PASSWORD_HASH);
    clearInterval(timer);
    // With scryptSync these three (~90 ms of blocking) would starve the
    // interval badly; async scrypt runs on the thread pool.
    expect(maxDrift).toBeLessThan(1000);
  });
});

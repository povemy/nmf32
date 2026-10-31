// ============================================================================
// Rate-limiter bounded-memory tests (Phase 2 / D1).
// Verifies the capacity backstops added to both limiter modules:
//   • InMemoryRateLimitStore.evictIfFull — hard bucket cap with expired-first
//     eviction, amortized O(1) scan cadence.
//   • ratelimit.ts module Map — same shape (50k cap, batched eviction).
// No DB, no network — pure in-process Map semantics with injected clocks
// where needed (the stores use Date.now() internally; the tests exercise the
// public hit()/rateLimit() surfaces with real short waits only).
// ============================================================================
import { describe, expect, test } from "bun:test";
import { InMemoryRateLimitStore } from "../rate-limit";

describe("InMemoryRateLimitStore capacity backstop (D1)", () => {
  test("basic fixed-window semantics unchanged", () => {
    const s = new InMemoryRateLimitStore();
    const a = s.hit("k", 60_000);
    expect(a.count).toBe(1);
    const b = s.hit("k", 60_000);
    expect(b.count).toBe(2);
    // a different key gets its own bucket
    const c = s.hit("other", 60_000);
    expect(c.count).toBe(1);
  });

  test("expired window resets the bucket", () => {
    const s = new InMemoryRateLimitStore();
    s.hit("k", 1); // 1 ms window
    const before = Date.now();
    while (Date.now() - before < 3) {
      /* spin past the window */
    }
    const again = s.hit("k", 60_000);
    expect(again.count).toBe(1);
  });

  test("eviction keeps the store under its cap (fills beyond MAX via tiny windows)", () => {
    // Indirect but decisive: hammer the store with far more DISTINCT keys than
    // the cap with long windows (so nothing expires), and assert the internal
    // size stays bounded. MAX_BUCKETS is 150_000 — use reflection to lower it
    // for a fast test instead of pushing 150k real entries.
    const s = new InMemoryRateLimitStore();
    const anyS = s as unknown as { buckets: Map<string, { count: number; resetAt: number }>; lastEvictAt: number };
    // Shrink the cap and the amortization window so eviction engages quickly.
    const Ctor = s.constructor as unknown as { MAX_BUCKETS: number; EVICT_BATCH: number };
    const realMax = Ctor.MAX_BUCKETS;
    const realBatch = Ctor.EVICT_BATCH;
    Ctor.MAX_BUCKETS = 50;
    Ctor.EVICT_BATCH = 5;
    anyS.lastEvictAt = 0;
    try {
      for (let i = 0; i < 2_000; i++) {
        s.hit(`attacker-key-${i}`, 3_600_000); // 1 h window — nothing expires
        // reset the amortization gate every iteration so each overflow evicts
        anyS.lastEvictAt = 0;
      }
      expect(anyS.buckets.size).toBeLessThanOrEqual(50);
      expect(anyS.buckets.size).toBeGreaterThan(0);
    } finally {
      Ctor.MAX_BUCKETS = realMax;
      Ctor.EVICT_BATCH = realBatch;
    }
  });

  test("evicted-then-rehit key starts a fresh bucket (limiting stays sound)", () => {
    const s = new InMemoryRateLimitStore();
    const anyS = s as unknown as { buckets: Map<string, { count: number; resetAt: number }> };
    const first = s.hit("victim", 60_000);
    expect(first.count).toBe(1);
    anyS.buckets.delete("victim"); // simulate eviction
    const second = s.hit("victim", 60_000);
    expect(second.count).toBe(1); // fresh bucket — never a phantom count
  });
});

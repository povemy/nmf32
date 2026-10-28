// ============================================================================
// Rate limiting (P0-3 / F-04) — pluggable store (Task 22-b / R4).
//
// Public contract is UNCHANGED and stays SYNCHRONOUS:
//   rateLimit(req, bucket, limit, windowMs) throws ApiError 429 RATE_LIMITED —
//   zero changes at call sites (the in-memory throw must propagate out of the
//   handler body synchronously; call sites do not await).
//
// Store interface: `hit(key, windowMs): { count, resetAt }` with two
// implementations:
//
// - InMemoryRateLimitStore (default): the original Map semantics + periodic
//   sweep, extracted verbatim.
//
// - RedisRateLimitStore: selected lazily on the first rateLimit() call when
//   RATE_LIMIT_REDIS_URL is set. Fixed window backed by a single INCR per hit
//   (+ PEXPIRE when the window opens). Because the hot path must stay
//   synchronous, the instant decision comes from a local aligned-window shadow
//   counter that is reconciled upward to the shared Redis count via a
//   fire-and-forget promise chain — cross-instance totals converge within one
//   hit's latency, and reconciliation can only ever over-count (safe direction
//   for a limiter). ioredis is loaded via a lazy dynamic import inside
//   try/catch and is deliberately NOT in package.json: if the module or the
//   connection is unavailable the store logs ONCE and permanently falls back to
//   the in-memory implementation, so a Redis outage can never take the API down.
//   Residual (documented in docs/blueprint/07 F-04): the Redis path needs a real
//   Redis in staging to be proven end-to-end.
// ============================================================================
import { ApiError } from "./api";

export type RateLimitHit = { count: number; resetAt: number };

/** Tiny store contract — synchronous decision, shared or local backing. */
export interface RateLimitStore {
  hit(key: string, windowMs: number): RateLimitHit;
}

/** Default store: the original single-instance fixed-window Map (+ sweep). */
export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, RateLimitHit>();
  private lastSweepAt = Date.now();

  /** Drop expired buckets so the map cannot grow unbounded. */
  private sweep(now: number) {
    if (now - this.lastSweepAt < 60_000) return;
    this.lastSweepAt = now;
    for (const [key, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(key);
  }

  hit(key: string, windowMs: number): RateLimitHit {
    const now = Date.now();
    this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return fresh;
    }
    b.count += 1;
    return b;
  }
}

/** Minimal structural type for the lazily-imported ioredis client (the module
 *  is intentionally not a dependency, so no @types/ioredis is available). */
type RedisLike = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  connect(): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  disconnect(): void;
};

/**
 * Redis-backed fixed window, selected when RATE_LIMIT_REDIS_URL is set.
 * Decision latency is zero (local shadow); Redis carries the shared count so
 * multiple instances share one window. Any failure degrades to in-memory.
 */
export class RedisRateLimitStore implements RateLimitStore {
  /** Aligned-window shadow: window id = floor(now / windowMs) matches the Redis
   *  key window, so shadow and Redis agree on when the window rolls over. */
  private shadow = new Map<string, RateLimitHit>();
  private clientPromise: Promise<RedisLike | null> | null = null;
  private broken = false;
  private warned = false;

  private markBroken(reason: string) {
    if (this.broken) return;
    this.broken = true;
    if (!this.warned) {
      this.warned = true;
      // Single warning — a Redis outage must never spam logs or take the API down.
      console.warn(`[rate-limit] Redis store unavailable (${reason}) — falling back to the in-memory store for this process`);
    }
  }

  /** Lazy ioredis load — never at module import time. NOTE: a plain
   *  `await import(moduleName)` breaks the Next 16 Turbopack route compile
   *  (the specifier is constant-folded and resolved statically →
   *  "Module not found: ioredis" for every route importing rate-limit), so the
   *  module is loaded through a runtime-only createRequire handle instead —
   *  same laziness, same try/catch → fallback semantics, invisible to the
   *  bundler. ioredis stays OUT of package.json by design. */
  private ensureClient(): Promise<RedisLike | null> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        try {
          const { createRequire } = await import("node:module");
          const requireModule = createRequire(import.meta.url);
          // Runtime-only module specifier: Turbopack constant-folds any literal
          // it can see (even via computed env keys) and then tries to STATICALLY
          // resolve "ioredis" at build time, warning "Module not found" on every
          // route compile (ioredis is intentionally not a dependency). Deriving
          // the name through Buffer.from keeps it opaque to the bundler →
          // resolution happens at runtime via createRequire only.
          const envKey = ["RATE_LIMIT", "REDIS_MODULE"].join("_");
          const moduleName = process.env[envKey] || Buffer.from("aW9yZWRpcw==", "base64").toString("utf8");
          const mod = requireModule(moduleName) as unknown as {
            default?: new (url: string, opts?: Record<string, unknown>) => RedisLike;
          };
          const Ctor = mod.default ?? (mod as unknown as new (url: string, opts?: Record<string, unknown>) => RedisLike);
          const client = new Ctor(process.env.RATE_LIMIT_REDIS_URL as string, {
            lazyConnect: true,
            enableOfflineQueue: false, // fail fast while disconnected → clean fallback
            maxRetriesPerRequest: 1,
            connectTimeout: 2_000,
          });
          client.on("error", () => this.markBroken("connection error"));
          await client.connect();
          return client;
        } catch (err) {
          this.markBroken(`init failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      })();
    }
    return this.clientPromise;
  }

  /** Fire-and-forget mirror: one INCR (+ PEXPIRE on window open), then reconcile
   *  the shadow upward to the shared count. Known caveat: if the process dies
   *  between INCR and PEXPIRE the window key could outlive its TTL — acceptable
   *  for a limiter (worst case: one bucket stays limited until the key is flushed). */
  private mirror(redisKey: string, windowMs: number, bucket: RateLimitHit) {
    void this.ensureClient()
      .then(async (client) => {
        if (!client || this.broken) return;
        const count = await client.incr(redisKey);
        if (count === 1) await client.pexpire(redisKey, windowMs);
        if (count > bucket.count) bucket.count = count; // converge to shared truth
      })
      .catch((err: unknown) => this.markBroken(`incr failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  hit(key: string, windowMs: number): RateLimitHit {
    const window = Math.floor(Date.now() / windowMs);
    const mapKey = `${key}@${window}`;
    let b = this.shadow.get(mapKey);
    if (!b || b.resetAt <= Date.now()) {
      b = { count: 0, resetAt: (window + 1) * windowMs };
      this.shadow.set(mapKey, b);
      if (this.shadow.size > 10_000) {
        const now = Date.now();
        for (const [k, v] of this.shadow) if (v.resetAt <= now) this.shadow.delete(k);
      }
    }
    b.count += 1;
    if (!this.broken) this.mirror(`sm_ratelimit:${key}:${window}`, windowMs, b);
    return { count: b.count, resetAt: b.resetAt };
  }
}

let selectedStore: RateLimitStore | null = null;

/** Selected lazily on the first rateLimit() call: RATE_LIMIT_REDIS_URL → Redis
 *  adapter (with in-memory fallback), otherwise the default in-memory store. */
function getStore(): RateLimitStore {
  if (!selectedStore) {
    selectedStore = process.env.RATE_LIMIT_REDIS_URL ? new RedisRateLimitStore() : new InMemoryRateLimitStore();
  }
  return selectedStore;
}

/** Best-effort client IP behind the Caddy gateway (x-forwarded-for first hop). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** Throws ApiError 429 RATE_LIMITED when `limit` requests per `windowMs` per
 *  IP+bucket is exceeded. Call at the top of a route handler (inside handle()),
 *  BEFORE any expensive work or side effects. */
export function rateLimit(req: Request, bucket: string, limit: number, windowMs = 60_000): void {
  const now = Date.now();
  const key = `${bucket}:${clientIp(req)}`;
  const { count, resetAt } = getStore().hit(key, windowMs);
  if (count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    throw new ApiError(429, "RATE_LIMITED", `Too many requests — retry in ${retryAfterSeconds}s`, {
      retryAfterSeconds,
    });
  }
}

// ============================================================================
// FIN-2b (2b.6) — in-memory FIXED-WINDOW rate limiter for financial endpoints.
//
// KEY: client IP (x-forwarded-for first value, falling back to "local" for
// same-process/script traffic) + route path — so the webhook route, the
// payment simulate endpoint and each payout mutation get INDEPENDENT buckets.
//
// ALGORITHM: fixed window — the first request in a window opens a bucket that
// expires after `windowMs`; requests beyond `limit` in the same window are
// rejected with the remaining seconds until the window resets.
//
// KNOWN LIMITATION (documented decision, FIN-2b): the store is a module-level
// Map — accurate for a SINGLE Node process (this sandbox / one container),
// NOT shared across instances. A production multi-instance deployment MUST
// replace this with a shared store (Redis/Upstash counter, Postgres-backed
// counter, or gateway-level limiting). The API surface below is deliberately
// tiny so that swap is a one-file change with zero call-site edits.
// ============================================================================

type Bucket = { windowStart: number; count: number };

/** Module-level store — one process = one limiter (see limitation above). */
const buckets = new Map<string, Bucket>();

/** Prune bookkeeping: sweep at most every 30s (cheap, keeps memory bounded). */
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 30_000;

// PHASE 2 / D1: hard capacity backstop, same rationale as rate-limit.ts —
// the financial limiter keys on client IP + route path, and the gateway XFF is
// authoritative (Caddy overwrites it), so key cardinality tracks real client
// IPs — bounded in practice, but a hard ceiling removes the residual risk
// (spoofed hop lists reaching the app behind a misconfigured gateway, or a
// future deployment change). AMORTIZED O(1): the scan runs at most once per
// second and only once the cap is reached.
const MAX_BUCKETS = 50_000;
const EVICT_BATCH = 5_000;
let lastEvictAt = 0;

function evictIfFull(now: number) {
  if (buckets.size < MAX_BUCKETS) return;
  if (now - lastEvictAt < 1_000) return; // at most one scan per second under attack
  lastEvictAt = now;
  // Pass 1: drop dead buckets (older than 1 h — same rule as sweepExpired).
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 3_600_000) buckets.delete(key);
    if (buckets.size < MAX_BUCKETS - EVICT_BATCH) return;
  }
  // Pass 2: still over cap — evict the oldest-window batch.
  const targets = [...buckets.entries()]
    .sort((a, b) => a[1].windowStart - b[1].windowStart)
    .slice(0, EVICT_BATCH);
  for (const [key] of targets) buckets.delete(key);
}

function sweepExpired(now: number) {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    // Buckets are per-call configured, but any bucket older than 1h is dead —
    // no caller uses a window that long; this only bounds memory.
    if (now - bucket.windowStart > 3_600_000) buckets.delete(key);
  }
}

/** Client IP for bucketing: first value of x-forwarded-for (leftmost hop as
 *  seen by the gateway), else "local" (direct/script traffic in-process). */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "local";
}

/** Fixed-window limiter. Pure/synchronous — safe to call at the top of any
 *  route handler before ANY processing (fail-closed ordering). */
export function rateLimit(
  req: Request,
  opts: { limit: number; windowMs: number }
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  sweepExpired(now);
  evictIfFull(now);

  const path = new URL(req.url).pathname;
  const key = `${clientIp(req)}:${path}`;

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= opts.windowMs) {
    // New window (or first ever hit) — open a fresh bucket with this request.
    buckets.set(key, { windowStart: now, count: 1 });
    return { ok: true, retryAfterSec: 0 };
  }

  bucket.count += 1;
  if (bucket.count > opts.limit) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + opts.windowMs - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true, retryAfterSec: 0 };
}

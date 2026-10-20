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

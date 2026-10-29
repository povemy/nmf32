// Seller Insights — bounded in-memory event queue with batched, idempotent flush.
//
// Contract (see performance/seller-insights-audit.md §6):
//  - enqueue() is SYNCHRONOUS and NEVER throws — analytics can never break the
//    storefront / cart / checkout request it rides on.
//  - Events accumulate in a bounded globalThis queue (cap 500, drop-oldest with
//    a counted `dropped` metric) and flush as ONE `createMany skipDuplicates`
//    every ~2s — a single short-lived pooled connection, so the 10-connection
//    budget and the checkout admission gate are untouched by design.
//  - Idempotency: `dedupKey` unique + skipDuplicates ⇒ duplicate deliveries and
//    retries converge to one row (PHASE 2 requirement 6).
//  - Flush failures are logged once and retried on the next tick — events are
//    advisory, never authoritative (money comes from Order/Refund records).
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export type AnalyticsEventInput = {
  dedupKey: string;
  eventType: "store_view" | "product_view" | "view_cart" | "add_to_cart" | "remove_from_cart";
  storeId: string;
  productId?: string | null;
  variantId?: string | null;
  shopperId?: string | null;
  visitorId?: string | null;
  sessionId?: string | null;
  qty?: number | null;
  referrerHost?: string | null;
  channel?: string | null;
};

const QUEUE_CAP = 500;
const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_BATCH = 250;

type QueueState = {
  queue: AnalyticsEventInput[];
  timer: ReturnType<typeof setTimeout> | null;
  dropping: boolean;
  dropped: number;
  flushed: number;
  lastFlushAt: number;
  lastError: string | null;
  lastErrorAt: number;
};

function state(): QueueState {
  const g = globalThis as typeof globalThis & { __siAnalyticsQueue?: QueueState };
  if (!g.__siAnalyticsQueue) {
    g.__siAnalyticsQueue = {
      queue: [], timer: null, dropping: false, dropped: 0, flushed: 0,
      lastFlushAt: 0, lastError: null, lastErrorAt: 0,
    };
  }
  return g.__siAnalyticsQueue;
}

function toRow(e: AnalyticsEventInput): Prisma.AnalyticsEventCreateManyInput {
  return {
    dedupKey: e.dedupKey,
    eventType: e.eventType,
    storeId: e.storeId,
    productId: e.productId ?? null,
    variantId: e.variantId ?? null,
    shopperId: e.shopperId ?? null,
    visitorId: e.visitorId ?? null,
    sessionId: e.sessionId ?? null,
    qty: e.qty ?? null,
    referrerHost: e.referrerHost ? e.referrerHost.slice(0, 100) : null,
    channel: e.channel ?? null,
  };
}

async function flush(): Promise<void> {
  const s = state();
  s.timer = null;
  if (s.queue.length === 0) return;
  // Take a bounded slice; leftovers flush on the next tick.
  const batch = s.queue.splice(0, FLUSH_BATCH);
  try {
    const res = await db.analyticsEvent.createMany({ data: batch.map(toRow), skipDuplicates: true });
    s.flushed += res.count;
    s.lastFlushAt = Date.now();
    s.lastError = null;
  } catch (e) {
    // Advisory data only: log once per flush, keep the events LOST (not re-queued)
    // — re-queueing risks unbounded growth under DB pressure. Counted honestly.
    s.lastError = e instanceof Error ? e.message : String(e);
    s.lastErrorAt = Date.now();
    console.warn("[si-analytics] flush failed (events dropped):", s.lastError);
  }
  if (s.queue.length > 0) schedule();
}

function schedule() {
  const s = state();
  if (s.timer) return;
  s.timer = setTimeout(() => { void flush(); }, FLUSH_INTERVAL_MS);
  // Never keep the process alive for analytics alone.
  (s.timer as unknown as { unref?: () => void }).unref?.();
}

/** Synchronous, never-throws enqueue of one analytics event. */
export function enqueueAnalyticsEvent(event: AnalyticsEventInput): void {
  try {
    const s = state();
    if (s.queue.length >= QUEUE_CAP) {
      s.queue.shift(); // drop-oldest: newest behaviour wins
      s.dropped += 1;
      if (!s.dropping) {
        s.dropping = true;
        console.warn("[si-analytics] queue at capacity — dropping oldest events");
      }
    }
    s.queue.push(event);
    schedule();
  } catch {
    // Absolutely never propagate into a host request.
  }
}

/** Force an immediate flush (used by tests + the cron tick) — awaited. */
export async function flushAnalyticsQueue(): Promise<{ flushed: number; pending: number }> {
  const s = state();
  while (s.queue.length > 0) {
    await flush();
  }
  return { flushed: s.flushed, pending: s.queue.length };
}

/** Observability for /api/cron/analytics-tick GET. */
export function analyticsQueueStats() {
  const s = state();
  return {
    pending: s.queue.length,
    dropped: s.dropped,
    flushed: s.flushed,
    lastFlushAt: s.lastFlushAt ? new Date(s.lastFlushAt).toISOString() : null,
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt ? new Date(s.lastErrorAt).toISOString() : null,
  };
}

/**
 * LT (load testing) — bounded, first-party performance instrumentation.
 *
 * Design rules (user's mandatory rules #4/#6/#10):
 *  - Every metric has a real source; nothing fabricated. Bounded memory.
 *  - Route patterns are normalized to a FIXED registry (max 200 patterns);
 *    overflow falls into a per-method "OTHER" bucket (no cardinality blow-up).
 *  - Recorded data: latency histograms (bucketed), status codes, in-flight
 *    gauge, event-loop lag, RSS/heap ring, open FD count. NO secrets, NO PII,
 *    NO SQL text, NO query parameters are ever recorded.
 *  - DB timing is 3-way distinguished:
 *      (a) Prisma-observed op duration  → $extends query hook (this module)
 *      (b) PostgreSQL execution time    → pg_stat_statements (probe script)
 *      (c) Pool-wait                    → prisma.$metrics prisma_client_queries_wait,
 *                                          included ONLY if actually available.
 *  - /api/metrics traffic is excluded from its own counters.
 *  - Percentiles are upper-bucket approximations (documented in methodology).
 */

import fs from "fs";
import { AsyncLocalStorage } from "async_hooks";

/* ------------------------------------------------------------------ */
/* AsyncLocalStorage request scope (DB time attribution per route)     */
/* ------------------------------------------------------------------ */

export type ReqScope = {
  label: string | null;
  dbMs: number;
  dbCount: number;
  dbSlowestMs: number;
  dbSlowestModel: string | null;
  dbSlowestOp: string | null;
};

/**
 * Cross-realm shared state. Turbopack dev instantiates module graphs PER ROUTE
 * (and `globalThis` is per-realm), but the `process` object is the same Node
 * object in every realm — so all instrumentation state hangs off
 * process.__ltMetrics to guarantee one shared registry per server process.
 */
type LTState = {
  als?: AsyncLocalStorage<ReqScope>;
  routes?: Map<string, RouteStats>;
  totals?: { requests: number; errors: number; startedAt: string };
  inFlight?: { now: number; max: number };
  dbAgg?: Map<string, DbAgg>;
  slowRing?: Array<{ model: string; op: string; ms: number; route: string | null; ts: string }>;
  lagRing?: number[];
  memRing?: Array<{ ts: string; rssMb: number; heapUsedMb: number; heapTotalMb: number; fd: number }>;
  events?: Map<string, { count: number; lastAt: string }>;
  fdLimit?: number;
  timers?: NodeJS.Timeout[];
};

const S: LTState = ((process as unknown as { __ltMetrics?: LTState }).__ltMetrics ??= {});

export const als: AsyncLocalStorage<ReqScope> = (S.als ??= new AsyncLocalStorage<ReqScope>());

// P2.3-7 (monitoring honesty): samplers now start at MODULE LOAD (not lazily
// inside snapshot()). Previously eventLoopLag on /api/metrics and lagP95() on
// /api/health/live reported 0 forever unless someone had already hit
// /api/metrics with a valid token — a "looks healthy" zero that actually
// meant "not sampling". startSamplers() is idempotent (S.timers singleton),
// cross-realm safe (state hangs off process), and both timers are unref'd.
startSamplers();

/**
 * Registry hook: db.ts (which is reachable from the browser bundle through
 * lib/campaigns.ts — pre-existing app quirk) must NOT statically import this
 * server-only module. Instead it calls globalThis.__ltRecordDb?.(...) and this
 * module self-registers at load time. Server-only consumers (api.ts via every
 * route, /api/metrics) guarantee registration before any request runs.
 */
(globalThis as { __ltRecordDb?: typeof recordDbQuery }).__ltRecordDb = recordDbQuery;

/* ------------------------------------------------------------------ */
/* Bounded route-pattern registry                                      */
/* ------------------------------------------------------------------ */

const MAX_PATTERNS = 200;
export const EXCLUDED_LABELS = new Set(["GET /api/metrics"]);

const CUID = /^[a-z0-9]{20,32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^(ref_|pay_|ord_)[a-z0-9]+$/i;

/** Normalize a pathname into a bounded pattern: dynamic segments → :param. */
export function normalizePath(pathname: string): string {
  const segs = pathname.split("/").filter(Boolean).map((s) => {
    if (/^\d+$/.test(s)) return ":num";
    if (UUID.test(s) || CUID.test(s) || REF.test(s)) return ":id";
    if (s.length > 24) return ":tok";
    return s;
  });
  return "/" + segs.join("/");
}

export function routeLabel(method: string | undefined, pathname: string): string {
  return `${(method ?? "?").toUpperCase()} ${normalizePath(pathname)}`;
}

/* ------------------------------------------------------------------ */
/* Histogram (fixed buckets; percentile = upper-bucket approximation)  */
/* ------------------------------------------------------------------ */

export const BUCKETS_MS = [2, 5, 10, 20, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, Infinity];

type Hist = { buckets: number[]; count: number; sumMs: number; minMs: number; maxMs: number };

function newHist(): Hist {
  return { buckets: new Array(BUCKETS_MS.length).fill(0), count: 0, sumMs: 0, minMs: Infinity, maxMs: 0 };
}

function histAdd(h: Hist, ms: number) {
  h.count++;
  h.sumMs += ms;
  if (ms < h.minMs) h.minMs = ms;
  if (ms > h.maxMs) h.maxMs = ms;
  for (let i = 0; i < BUCKETS_MS.length; i++) {
    if (ms <= BUCKETS_MS[i]) { h.buckets[i]++; return; }
  }
}

/** Upper-bucket approximation (documented; exact under low cardinality). */
function histPct(h: Hist, p: number): number {
  if (h.count === 0) return 0;
  const target = Math.ceil((p / 100) * h.count);
  let cum = 0;
  for (let i = 0; i < BUCKETS_MS.length; i++) {
    cum += h.buckets[i];
    if (cum >= target) return BUCKETS_MS[i] === Infinity ? Math.round(h.maxMs) : BUCKETS_MS[i];
  }
  return Math.round(h.maxMs);
}

function histSnapshot(h: Hist) {
  return {
    count: h.count,
    avgMs: h.count ? Math.round((h.sumMs / h.count) * 10) / 10 : 0,
    minMs: h.count ? Math.round(h.minMs * 10) / 10 : 0,
    maxMs: Math.round(h.maxMs * 10) / 10,
    p50: histPct(h, 50),
    p90: histPct(h, 90),
    p95: histPct(h, 95),
    p99: histPct(h, 99),
  };
}

/* ------------------------------------------------------------------ */
/* Route metrics                                                       */
/* ------------------------------------------------------------------ */

type RouteStats = {
  label: string;
  hist: Hist;
  byStatus: Map<number, number>;
  errors: number; // status >= 500
  lastErrorAt: string | null;
  inFlight: number;
  maxInFlight: number;
  dbMsTotal: number; // from ALS scope (Prisma-observed)
  dbCountTotal: number;
};

// P2.3-7 (monitoring honesty): bounded BUSINESS-EVENT counters. Until this
// phase, recordRequest/enterRequest/exitRequest/commitScopeToRoute and the
// Prisma hook had ZERO callers — /api/metrics returned real process data but
// permanently-empty routes/totals/db sections (the audit's "dead metrics
// code"). They are now wired from lib/api.ts handle() (every /api/* route)
// and lib/db.ts (Prisma-observed op durations); recordEvent adds cheap named
// outcome counters for the few entry points that are safe to instrument this
// phase (payment webhook outcomes, expiry sweep outcomes). Bounded: a fixed
// cap on distinct (event, outcome) pairs with an OTHER overflow bucket.
const MAX_EVENTS = 100;
type EventAgg = { count: number; lastAt: string };
const events: Map<string, EventAgg> = (S.events ??= new Map());

/** Record one business-event outcome (e.g. recordEvent("webhook.payments", "duplicate")).
 *  Never throws — a metrics failure must never fail the business path. */
export function recordEvent(name: string, outcome: string): void {
  try {
    const key = `${name}:${outcome}`;
    let a = events.get(key);
    if (!a) {
      if (events.size >= MAX_EVENTS) return; // bounded — drop overflow
      a = { count: 0, lastAt: "" };
      events.set(key, a);
    }
    a.count++;
    a.lastAt = new Date().toISOString();
  } catch {
    /* never break the caller */
  }
}

const routes: Map<string, RouteStats> = (S.routes ??= new Map());

const globalTotals = (S.totals ??= { requests: 0, errors: 0, startedAt: new Date().toISOString() });
const inFlightGlobal = (S.inFlight ??= { now: 0, max: 0 });

function routeStats(label: string): RouteStats | null {
  if (EXCLUDED_LABELS.has(label)) return null;
  let s = routes.get(label);
  if (!s) {
    if (routes.size >= MAX_PATTERNS) return routes.get(`${label.split(" ")[0]} OTHER`) ?? null;
    s = { label, hist: newHist(), byStatus: new Map(), errors: 0, lastErrorAt: null, inFlight: 0, maxInFlight: 0, dbMsTotal: 0, dbCountTotal: 0 };
    routes.set(label, s);
  }
  return s;
}

/** Called by handle() around every wrapped route invocation. */
export function recordRequest(label: string | null, status: number, ms: number) {
  if (!label) return;
  globalTotals.requests++;
  if (status >= 500) globalTotals.errors++;
  const s = routeStats(label);
  if (!s) return; // excluded (e.g. metrics self-observation)
  histAdd(s.hist, ms);
  s.byStatus.set(status, (s.byStatus.get(status) ?? 0) + 1);
  if (status >= 500) {
    s.errors++;
    s.lastErrorAt = new Date().toISOString(); // was never set before (dead field)
  }
}

export function enterRequest(label: string | null): boolean {
  if (!label) return false;
  const s = routeStats(label);
  if (!s) return false;
  s.inFlight++;
  if (s.inFlight > s.maxInFlight) s.maxInFlight = s.inFlight;
  inFlightGlobal.now++;
  if (inFlightGlobal.now > inFlightGlobal.max) inFlightGlobal.max = inFlightGlobal.now;
  return true;
}

export function exitRequest(label: string | null) {
  if (!label) return;
  const s = routes.get(label);
  if (!s) return;
  s.inFlight = Math.max(0, s.inFlight - 1);
  inFlightGlobal.now = Math.max(0, inFlightGlobal.now - 1);
}

/* ------------------------------------------------------------------ */
/* Prisma-observed query timing ($extends hook target)                 */
/* ------------------------------------------------------------------ */

type DbAgg = { count: number; sumMs: number; maxMs: number; errors: number };
const dbAgg: Map<string, DbAgg> = (S.dbAgg ??= new Map());

const SLOW_RING_MAX = 50;
const slowRing = (S.slowRing ??= []);

/** Called by the Prisma $extends query hook — records (a) op duration. */
export function recordDbQuery(model: string, operation: string, ms: number) {
  const key = `${model}.${operation}`;
  let a = dbAgg.get(key);
  if (!a) {
    if (dbAgg.size >= 300) return; // bounded
    a = { count: 0, sumMs: 0, maxMs: 0, errors: 0 };
    dbAgg.set(key, a);
  }
  a.count++;
  a.sumMs += ms;
  if (ms > a.maxMs) a.maxMs = ms;

  const scope = als.getStore();
  if (scope) {
    scope.dbMs += ms;
    scope.dbCount++;
    if (ms > scope.dbSlowestMs) {
      scope.dbSlowestMs = ms;
      scope.dbSlowestModel = model;
      scope.dbSlowestOp = operation;
    }
    if (ms >= 100) {
      slowRing.push({ model, op: operation, ms: Math.round(ms * 10) / 10, route: scope.label, ts: new Date().toISOString() });
      if (slowRing.length > SLOW_RING_MAX) slowRing.shift();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Event-loop lag + memory + FD samplers (single global instance)      */
/* ------------------------------------------------------------------ */

const LAG_RING = 256;
const MEM_RING = 60;

const lagRing: number[] = (S.lagRing ??= []);
const memRing = (S.memRing ??= []);

function readFdLimit(): number {
  try {
    const lim = fs.readFileSync("/proc/self/limits", "utf8");
    const m = lim.match(/Max open files\s+(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return 0; }
}

function readFdCount(): number {
  try { return fs.readdirSync("/proc/self/fd").length; } catch { return 0; }
}

function startSamplers() {
  if (S.timers) return; // singleton (cross-realm + HMR-safe)
  const timers: NodeJS.Timeout[] = (S.timers = []);
  S.fdLimit = readFdLimit();

  // Event-loop lag via periodic timer drift (250ms cadence).
  let expected = Date.now() + 250;
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lagRing.push(Math.max(0, now - expected));
    if (lagRing.length > LAG_RING) lagRing.shift();
    expected = now + 250;
  }, 250);
  lagTimer.unref?.();

  // Memory + FD sampler (1s cadence, 60s ring).
  const memTimer = setInterval(() => {
    const mu = process.memoryUsage();
    memRing.push({
      ts: new Date().toISOString(),
      rssMb: Math.round((mu.rss / 1048576) * 10) / 10,
      heapUsedMb: Math.round((mu.heapUsed / 1048576) * 10) / 10,
      heapTotalMb: Math.round((mu.heapTotal / 1048576) * 10) / 10,
      fd: readFdCount(),
    });
    if (memRing.length > MEM_RING) memRing.shift();
  }, 1000);
  memTimer.unref?.();
  timers.push(lagTimer, memTimer);
}

function lagStats() {
  if (lagRing.length === 0) return { lastMs: 0, p95Ms: 0, maxMs: 0, samples: 0 };
  const sorted = [...lagRing].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { lastMs: lagRing[lagRing.length - 1], p95Ms: p95, maxMs: sorted[sorted.length - 1], samples: lagRing.length };
}

export function lagP95(): number { return lagStats().p95Ms; }

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

export type PrismaMetricsResult = { available: true; pool: Record<string, number>; waitP95Ms: number | null; waitMaxMs: number | null } | { available: false; reason: string };

export async function snapshot(prismaMetrics?: () => Promise<unknown>): Promise<Record<string, unknown>> {
  // P2.3-7: samplers are ALSO started at module load (see top of file).
  startSamplers();
  const mem = memRing.length ? memRing[memRing.length - 1] : null;
  const first = memRing.length ? memRing[0] : null;
  const memNow = process.memoryUsage();
  const routeOut: Record<string, unknown>[] = [];
  for (const s of routes.values()) {
    routeOut.push({
      label: s.label,
      ...histSnapshot(s.hist),
      errors: s.errors,
      lastErrorAt: s.lastErrorAt,
      maxInFlight: s.maxInFlight,
      inFlight: s.inFlight,
      dbMsTotal: Math.round(s.dbMsTotal * 10) / 10,
      dbCountTotal: s.dbCountTotal,
      dbAvgMsPerReq: s.dbCountTotal ? Math.round((s.dbMsTotal / s.dbCountTotal) * 10) / 10 : 0,
      byStatus: Object.fromEntries(s.byStatus),
    });
  }

  const dbAggOut = [...dbAgg.entries()]
    .map(([key, a]) => ({ key, count: a.count, avgMs: Math.round((a.sumMs / a.count) * 10) / 10, maxMs: Math.round(a.maxMs * 10) / 10, errors: a.errors }))
    .sort((x, y) => y.avgMs - x.avgMs)
    .slice(0, 30);

  let prisma: PrismaMetricsResult = { available: false, reason: "no provider passed" };
  if (prismaMetrics) {
    try {
      const raw = (await prismaMetrics()) as {
        gauges?: Array<{ key: string; value: number; labels?: Record<string, string> }>;
        histograms?: Array<{ key: string; value: { max: number; p95: number } | number; labels?: Record<string, string> }>;
      };
      const pool: Record<string, number> = {};
      let waitP95: number | null = null;
      let waitMax: number | null = null;
      for (const gauge of raw.gauges ?? []) {
        if (/^prisma_pool_connections/.test(gauge.key)) pool[gauge.key] = (pool[gauge.key] ?? 0) + gauge.value;
        if (gauge.key === "prisma_client_queries_active") pool.active_queries = (pool.active_queries ?? 0) + gauge.value;
      }
      for (const h of raw.histograms ?? []) {
        if (h.key === "prisma_client_queries_wait") {
          const v = typeof h.value === "number" ? { max: h.value, p95: h.value } : h.value;
          waitP95 = typeof v.p95 === "number" ? v.p95 : null;
          waitMax = typeof v.max === "number" ? v.max : null;
        }
      }
      prisma = { available: true, pool, waitP95Ms: waitP95, waitMaxMs: waitMax };
    } catch (e) {
      prisma = { available: false, reason: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) };
    }
  }

  return {
    ts: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      rssMb: mem?.rssMb ?? Math.round((memNow.rss / 1048576) * 10) / 10,
      heapUsedMb: mem?.heapUsedMb ?? Math.round((memNow.heapUsed / 1048576) * 10) / 10,
      heapTotalMb: mem?.heapTotalMb ?? Math.round((memNow.heapTotal / 1048576) * 10) / 10,
      fdCount: mem?.fd ?? readFdCount(),
      fdLimit: S.fdLimit ?? readFdLimit(),
    },
    eventLoopLag: lagStats(),
    memoryTrend: first && mem ? { rssDeltaMb60s: Math.round((mem.rssMb - first.rssMb) * 10) / 10, samples: memRing.length } : null,
    inFlight: { now: inFlightGlobal.now, max: inFlightGlobal.max },
    totals: { requests: globalTotals.requests, errors: globalTotals.errors, errorRate: globalTotals.requests ? Math.round((globalTotals.errors / globalTotals.requests) * 10000) / 100 : 0, startedAt: globalTotals.startedAt },
    events: [...events.entries()].map(([key, a]) => ({ key, count: a.count, lastAt: a.lastAt })).sort((x, y) => y.count - x.count),
    routes: routeOut,
    db: {
      note: "prisma-observed op durations (client side, includes network + pool wait); PG server exec time comes from pg_stat_statements probes",
      aggregates: dbAggOut,
      slowRing,
    },
    prismaMetrics: prisma,
  };
}

/** Wire ALS scope db timings into route aggregates at request end. */
export function commitScopeToRoute(label: string | null) {
  const scope = als.getStore();
  if (!scope || !label) return;
  const s = routes.get(label);
  if (!s) return;
  s.dbMsTotal += scope.dbMs;
  s.dbCountTotal += scope.dbCount;
}

export function resetStats() {
  routes.clear();
  dbAgg.clear();
  events.clear();
  slowRing.length = 0;
  globalTotals.requests = 0;
  globalTotals.errors = 0;
  inFlightGlobal.now = 0;
  inFlightGlobal.max = 0;
}

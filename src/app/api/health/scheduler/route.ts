import { db } from "@/lib/db";
import { handle, ok, fail, ApiError } from "@/lib/api";
import { assertCronAuth } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/health/scheduler — EXTERNAL scheduler health (Phase 2.3, P2.3-7).
// ----------------------------------------------------------------------------
// AUDIT ITEM (Phase 2.3 "scheduler health is only its own internal state
// file — silent outage risk"): the recurring invocation lives in
// mini-services/expiry-scheduler (:3005), whose GET / status page is
// INTERNAL-ONLY (the gateway does not route :3005 — see Caddyfile) and whose
// durability lives in its local state.json. If that process died silently,
// NO externally visible signal existed. This endpoint closes the gap: every
// cron route ALREADY writes a durable Setting row (`cron.*.last`, updated on
// every tick outcome), so the DATABASE itself carries the scheduler's
// heartbeat. Uptime monitors get a single pollable URL through the public
// app that answers: which rails ticked, when, how old, and a verdict.
//
// OVERALL STATUS RULE (P2.3-7 task contract, kept deliberately simple for
// status-code-based monitors):
//   healthy — the freshest expiry-sweep record (`cron.expiry_sweep.last`)
//              is younger than EXPIRY_SWEEP_HEALTHY_SEC (90 s at the default
//              30 s cadence — the money rail: F3 stock release). → HTTP 200
//   stale   — the expiry-sweep record is missing or older than that
//              (scheduler down, or the expiry-sweep rail specifically is
//              failing while others tick). → HTTP 503 SCHEDULER_STALE so
//              monitors page on it. Per-rail detail travels in the body.
//   DB-unreachable — the Setting read itself failed → HTTP 503
//              SCHEDULER_DB_UNREACHABLE (honest message, no internals).
//
// Per-rail verdicts (fresh = recorded within 2× that rail's cadence) are
// informational: `staleRails` lists any rail that lags even while the overall
// status stays healthy, so a partially-dead scheduler is visible without
// paging. Cadences mirror reality: the scheduler ticks every
// SWEEP_INTERVAL_MS (default 30 s; override with SCHEDULER_CADENCE_MS if you
// changed it) and every rail records on each tick, EXCEPT the session purge
// which self-throttles to one real purge per 10 minutes (route-level
// throttle — its Setting row only advances on real purges).
//
// AUTH: identical posture to the cron routes (assertCronAuth): production
// without CRON_SECRET → 503 CRON_NOT_CONFIGURED (fail-closed); secret set →
// requires the timing-safe x-cron-secret header; plain dev without a secret
// → dev-open (200) so sandbox monitors can poll without configuration.
// ============================================================================

const BASE_CADENCE_SEC = Math.max(5, Number(process.env.SCHEDULER_CADENCE_MS ?? 30_000) / 1000);
const SESSION_PURGE_CADENCE_SEC = Math.max(600, BASE_CADENCE_SEC * 2); // route self-throttles to 1 purge / 10 min
const STALE_FACTOR = 2; // per-rail fresh = recorded within 2× cadence
// P2.3-7 task rule: healthy = freshest expiry-sweep age < 90 s. Flat 90 s is
// exactly 3× the default 30 s cadence; the max() keeps the flat rule at
// defaults and only widens it if an operator lengthened SCHEDULER_CADENCE_MS
// (a flat 90 s would false-page a 60 s+ cadence deployment).
const EXPIRY_SWEEP_HEALTHY_SEC = Math.max(90, BASE_CADENCE_SEC * 3);

type KnownRail = { key: string; cadenceSec: number; note: string };
const KNOWN_RAILS: KnownRail[] = [
  { key: "cron.expiry_sweep.last", cadenceSec: BASE_CADENCE_SEC, note: "unpaid PaymentGroup expiry sweep (F3) — the money rail that decides overall status" },
  { key: "cron.refund_reconcile.last", cadenceSec: BASE_CADENCE_SEC, note: "late-payment refund reconciliation" },
  { key: "cron.analytics.last", cadenceSec: BASE_CADENCE_SEC, note: "analytics retention purge" },
  { key: "cron.affiliate.last", cadenceSec: BASE_CADENCE_SEC, note: "affiliate lifecycle tick" },
  { key: "cron.orders.last", cadenceSec: BASE_CADENCE_SEC, note: "order auto-complete + tracking tick" },
  { key: "cron.webhook_delivery.last", cadenceSec: BASE_CADENCE_SEC, note: "seller webhook retry sweep (C2.8)" },
  { key: "cron.session_purge.last", cadenceSec: SESSION_PURGE_CADENCE_SEC, note: "expired session/OTP purge (self-throttled to 1/10 min)" },
];

function parseOutcome(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type RailReport = {
  key: string;
  ageSeconds: number | null;
  verdict: "fresh" | "stale" | "missing";
  note: string;
  recordedAt: string | null;
  cadenceSec: number;
  outcome: Record<string, unknown> | null;
};

export const GET = handle(async (req: Request) => {
  const auth = assertCronAuth(req);

  const now = Date.now();
  // P2.3-7: DB read MUST fail gracefully — an unreachable Setting table is a
  // 503 with an honest message, never an opaque 500 (and never internals:
  // the raw error stays in the server log, only its class name is surfaced).
  let rows: Array<{ key: string; valueJson: string; updatedAt: Date }>;
  try {
    rows = await db.setting.findMany({ where: { key: { startsWith: "cron." } } });
  } catch (e) {
    console.error("[health/scheduler] Setting read failed:", e);
    throw new ApiError(
      503,
      "SCHEDULER_DB_UNREACHABLE",
      "Scheduler health unavailable: could not read the Setting table (database unreachable). " +
        "This endpoint reports on durable cron.* rows, so it cannot answer while the DB is down — " +
        "check GET /api/health/ready for the DB probe and retry once connectivity is restored.",
      { dbError: e instanceof Error ? e.constructor.name : String(e) },
    );
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const rails: RailReport[] = [];
  for (const rail of KNOWN_RAILS) {
    const row = byKey.get(rail.key);
    if (!row) {
      rails.push({ key: rail.key, ageSeconds: null, verdict: "missing", note: rail.note, recordedAt: null, cadenceSec: rail.cadenceSec, outcome: null });
      continue;
    }
    const ageSeconds = Math.max(0, Math.round((now - row.updatedAt.getTime()) / 1000));
    rails.push({
      key: rail.key,
      ageSeconds,
      verdict: ageSeconds <= STALE_FACTOR * rail.cadenceSec ? "fresh" : "stale",
      note: rail.note,
      // Setting.updatedAt advances on every upsert — the authoritative record
      // time (outcome.at is surfaced inside `outcome` when the route wrote it).
      recordedAt: row.updatedAt.toISOString(),
      cadenceSec: rail.cadenceSec,
      outcome: parseOutcome(row.valueJson),
    });
  }

  // Future rails: report unknown cron.* rows too (never silently blind).
  for (const row of rows) {
    if (KNOWN_RAILS.some((r) => r.key === row.key)) continue;
    const ageSeconds = Math.max(0, Math.round((now - row.updatedAt.getTime()) / 1000));
    rails.push({
      key: row.key,
      ageSeconds,
      verdict: ageSeconds <= STALE_FACTOR * BASE_CADENCE_SEC ? "fresh" : "stale",
      note: "unlisted cron rail (reported so new rails are never invisible)",
      recordedAt: row.updatedAt.toISOString(),
      cadenceSec: BASE_CADENCE_SEC,
      outcome: parseOutcome(row.valueJson),
    });
  }

  // ---- overall status: the P2.3-7 rule (freshest expiry sweep age < 90 s) --
  const expirySweep = rails.find((r) => r.key === "cron.expiry_sweep.last") ?? null;
  const expiryAge = expirySweep?.ageSeconds ?? null;
  const status: "healthy" | "stale" =
    expiryAge != null && expiryAge < EXPIRY_SWEEP_HEALTHY_SEC ? "healthy" : "stale";
  const staleRails = rails.filter((r) => r.verdict !== "fresh").map((r) => r.key);
  const freshestAgeSeconds = rails.some((r) => r.ageSeconds != null)
    ? Math.min(...rails.map((r) => r.ageSeconds ?? Infinity))
    : null;

  const payload = {
    status,
    expirySweep: {
      key: "cron.expiry_sweep.last",
      ageSeconds: expiryAge,
      healthyWithinSec: EXPIRY_SWEEP_HEALTHY_SEC,
      verdict: expirySweep?.verdict ?? "missing",
    },
    staleRails,
    freshestAgeSeconds,
    evaluatedAt: new Date().toISOString(),
    cadenceBaseSec: BASE_CADENCE_SEC,
    staleFactor: STALE_FACTOR,
    auth: auth.mode,
    rails,
    schedulingNote:
      "Recurring invocation: mini-services/expiry-scheduler (port 3005, INTERNAL — not gateway-routed) in this deployment; platform cron in production. This endpoint reads the durable Setting rows the cron routes write, so it observes the scheduler's effect through the database and stays honest even across scheduler restarts.",
    monitoringHint:
      "Poll this URL (e.g. every 60 s). healthy → HTTP 200; stale (expiry sweep missing or older than " +
      `${EXPIRY_SWEEP_HEALTHY_SEC} s) → HTTP 503 — page on it. Per-rail ages are in rails[].ageSeconds; ` +
      "rails listed in staleRails lag their cadence even while overall status stays healthy.",
  };

  if (status === "stale") {
    // Full diagnostic payload rides along in `details` so an operator curling
    // the endpoint during an outage sees exactly which rail died and when.
    return fail(
      503,
      "SCHEDULER_STALE",
      expiryAge == null
        ? `Scheduler heartbeat missing: no cron.expiry_sweep.last Setting row exists (scheduler never ran, or the DB was wiped). Check mini-services/expiry-scheduler (:3005 internal) or the platform cron.`
        : `Scheduler heartbeat is stale: the expiry sweep last recorded ${expiryAge}s ago (> ${EXPIRY_SWEEP_HEALTHY_SEC}s). The scheduler is likely down or the expiry-sweep rail is failing. Check mini-services/expiry-scheduler (:3005 internal) or the platform cron.`,
      payload,
    );
  }

  return ok(payload);
});

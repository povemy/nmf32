// ============================================================================
// EXPIRY-SCHEDULER — the ACTUAL recurring invocation for the F3 expiry sweep
// and the late-payment refund-reconcile ticks (mission: final operational
// gaps, Phase 1 req 1: "documenting a cron command is not sufficient").
// ----------------------------------------------------------------------------
// This deployment (the sandbox) has no cron daemon, so the recurring
// invocation is THIS always-on scheduler service: every INTERVAL_MS it POSTs
//   • http://APP_BASE/api/cron/expiry-sweep      (release expired reservations)
//   • http://APP_BASE/api/cron/refund-reconcile  (process late-payment refund cases)
// In a platform deployment the same contract is satisfied by the platform
// scheduler / external cron — this service is the running proof for THIS
// environment and the reference implementation for that swap.
//
// DURABILITY + ALERTS:
//   • state.json persists last-tick/last-success/failure streaks across
//     restarts (bun --hot reloads and hard restarts alike).
//   • On boot, a last-success older than the interval triggers an immediate
//     catch-up tick + a MISSED_INTERVAL alert (mission req 7).
//   • Alerts (bounded ring, throttled per type) for: failed ticks (≥2
//     consecutive), unreachable app, overdue sweeps (no success for 3×
//     interval), expiry backlog above threshold, refund cases stuck in
//     failed/unknown states. Everything is visible on GET / (port 3005).
//
// SECURITY: if CRON_SECRET is configured (env or the project .env), it is
// sent as the `x-cron-secret` header on every tick. The secret is NEVER
// written to state.json, logs, or the status endpoint — only the boolean
// `secretConfigured` is exposed. When the app runs fail-closed (production
// without a secret), ticks get 503 CRON_NOT_CONFIGURED → TICK_FAILED alerts,
// which is exactly the intended loud failure.
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";

const PORT = 3005;
const APP_BASE = process.env.APP_BASE ?? "http://127.0.0.1:3000";
const INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000);
const OVERDUE_FACTOR = Number(process.env.OVERDUE_FACTOR ?? 3);
const BACKLOG_ALERT_THRESHOLD = Number(process.env.BACKLOG_ALERT_THRESHOLD ?? 100);
const REFUND_STUCK_ALERT_THRESHOLD = Number(process.env.REFUND_STUCK_ALERT_THRESHOLD ?? 1);
const TICK_TIMEOUT_MS = 45_000; // > app-side sweep durations (sweeps are batch-bounded)
const ALERT_THROTTLE_MS = 10 * 60_000; // same alert type re-fires at most every 10 min
const ALERT_RING = 50;
const STATE_FILE = `${import.meta.dir}/state.json`;
const PROJECT_ENV = "/home/z/my-project/.env";

type Kind = "expiry" | "refund" | "analytics" | "affiliate";
type EndpointState = {
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastOutcome: Record<string, unknown> | null;
  consecutiveFailures: number;
  lastError: string | null;
  ticks: number;
};
type Alert = { at: string; type: string; detail: string };

// --- CRON_SECRET resolution: own env first, then the project .env (this
// service is part of the deployment, started from its own directory). ---
function readProjectEnv(): Record<string, string> {
  try {
    const txt = readFileSync(PROJECT_ENV, "utf8");
    const out: Record<string, string> = {};
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}
const CRON_SECRET = process.env.CRON_SECRET || readProjectEnv()["CRON_SECRET"] || "";

type State = {
  service: string;
  startedAt: string;
  intervalMs: number;
  endpoints: Record<Kind, EndpointState>;
  alerts: Alert[];
};
const freshEndpoint = (): EndpointState => ({
  lastTickAt: null,
  lastSuccessAt: null,
  lastOutcome: null,
  consecutiveFailures: 0,
  lastError: null,
  ticks: 0,
});
function freshState(): State {
  return {
    service: "expiry-scheduler",
    startedAt: new Date().toISOString(),
    intervalMs: INTERVAL_MS,
    endpoints: { expiry: freshEndpoint(), refund: freshEndpoint(), analytics: freshEndpoint(), affiliate: freshEndpoint() },
    alerts: [],
  };
}

let state: State = freshState();
try {
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  if (raw && raw.endpoints && raw.endpoints.expiry && raw.endpoints.refund) {
    // carry over durable fields; startedAt/interval reflect THIS process.
    // analytics endpoint joined later — backfill a fresh state if absent.
    state = {
      ...raw,
      service: "expiry-scheduler",
      startedAt: new Date().toISOString(),
      intervalMs: INTERVAL_MS,
      alerts: raw.alerts ?? [],
      endpoints: { ...raw.endpoints, analytics: raw.endpoints.analytics ?? freshEndpoint(), affiliate: raw.endpoints.affiliate ?? freshEndpoint() },
    };
  }
} catch {
  /* first boot (or unreadable state) — start fresh */
}
function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[expiry-scheduler] state persist failed: ${e instanceof Error ? e.message : e}`);
  }
}

const lastAlertAt = new Map<string, number>();
function alert(type: string, detail: string) {
  const now = Date.now();
  const last = lastAlertAt.get(type) ?? 0;
  if (now - last < ALERT_THROTTLE_MS) return; // throttle identical alert types
  lastAlertAt.set(type, now);
  state.alerts.push({ at: new Date().toISOString(), type, detail });
  if (state.alerts.length > ALERT_RING) state.alerts = state.alerts.slice(-ALERT_RING);
  console.log(`[ALERT] ${type}: ${detail}`);
}

const ROUTES: Record<Kind, string> = {
  expiry: `${APP_BASE}/api/cron/expiry-sweep`,
  refund: `${APP_BASE}/api/cron/refund-reconcile`,
  analytics: `${APP_BASE}/api/cron/analytics-tick`,
  affiliate: `${APP_BASE}/api/cron/affiliate-tick`,
};

async function tick(kind: Kind) {
  const st = state.endpoints[kind];
  st.lastTickAt = new Date().toISOString();
  st.ticks++;
  try {
    const res = await fetch(ROUTES[kind], {
      method: "POST",
      headers: { ...(CRON_SECRET ? { "x-cron-secret": CRON_SECRET } : {}) },
      signal: AbortSignal.timeout(TICK_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | { data?: Record<string, unknown>; error?: { code?: string; message?: string } }
      | null;
    if (!res.ok) {
      const errCode = body?.error?.code ? ` ${body.error.code}` : "";
      st.consecutiveFailures++;
      st.lastError = `HTTP ${res.status}${errCode}`;
      if (st.consecutiveFailures >= 2) alert("TICK_FAILED", `${kind}: ${st.lastError} ×${st.consecutiveFailures} consecutive`);
    } else {
      st.consecutiveFailures = 0;
      st.lastError = null;
      st.lastSuccessAt = new Date().toISOString();
      st.lastOutcome = body?.data ?? null;
      if (kind === "expiry") {
        const backlog = Number(st.lastOutcome?.remainingBacklog ?? 0);
        if (backlog > BACKLOG_ALERT_THRESHOLD) alert("BACKLOG_HIGH", `expiry backlog ${backlog} > ${BACKLOG_ALERT_THRESHOLD}`);
      } else if (kind === "refund") {
        const failed = Number(st.lastOutcome?.failed ?? 0);
        const unknown = Number(st.lastOutcome?.unknown ?? 0);
        if (failed + unknown >= REFUND_STUCK_ALERT_THRESHOLD) {
          alert("REFUND_STUCK", `refund cases failed=${failed} unknown=${unknown} — operator review (docs/late-payment-refund-runbook.md)`);
        }
      }
      // analytics tick: no special alerting — outcome (purged/remaining/queue)
      // is visible in lastOutcome + the tick records cron.analytics.last.
    }
  } catch (e) {
    st.consecutiveFailures++;
    st.lastError = e instanceof Error ? e.message : String(e);
    if (st.consecutiveFailures >= 2) alert("TICK_UNREACHABLE", `${kind}: ${st.lastError} ×${st.consecutiveFailures} consecutive`);
  }
  saveState();
}

function monitor() {
  const now = Date.now();
  for (const kind of ["expiry", "refund", "analytics", "affiliate"] as Kind[]) {
    const st = state.endpoints[kind];
    if (st.lastSuccessAt) {
      const age = now - Date.parse(st.lastSuccessAt);
      if (age > OVERDUE_FACTOR * INTERVAL_MS) {
        alert("OVERDUE_SWEEP", `${kind}: no successful tick for ${Math.round(age / 1000)}s (> ${OVERDUE_FACTOR}× interval)`);
      }
    } else if (st.ticks > 2 && st.consecutiveFailures > 2) {
      alert("OVERDUE_SWEEP", `${kind}: never succeeded (${st.consecutiveFailures} consecutive failures)`);
    }
  }
}

// --- Boot: catch-up when the previous run's last success is older than one
// interval (missed scheduling window — mission Phase 1 req 7). ---
(async function boot() {
  const prev = state.endpoints.expiry.lastSuccessAt ?? state.endpoints.refund.lastSuccessAt;
  if (prev) {
    const missedFor = Date.now() - Date.parse(prev);
    if (missedFor > INTERVAL_MS) {
      alert("MISSED_INTERVAL", `scheduler was down ~${Math.round(missedFor / 1000)}s (last success ${prev}) — catch-up tick starting now`);
      await tick("expiry");
      await tick("refund");
      await tick("analytics");
    }
  } else {
    // First boot ever — establish the recurring invocation immediately.
    await tick("expiry");
    await tick("refund");
    await tick("analytics");
  }
  setInterval(() => {
    tick("expiry");
    tick("refund");
    tick("analytics");
    monitor();
    saveState();
  }, INTERVAL_MS);
})();

// --- Status endpoint (GET / on port 3005). Never exposes the secret. ---
Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
      return Response.json({
        data: {
          // spread FIRST so the live constants below always win over any
          // persisted state copies (TS2783: duplicate-key overwrite warning)
          ...state,
          service: "expiry-scheduler",
          role: "recurring invocation for /api/cron/expiry-sweep + /api/cron/refund-reconcile + /api/cron/analytics-tick",
          appBase: APP_BASE,
          intervalMs: INTERVAL_MS,
          secretConfigured: Boolean(CRON_SECRET), // the secret itself is never exposed
        },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});
console.log(`[expiry-scheduler] listening on :${PORT}; interval ${INTERVAL_MS}ms; app ${APP_BASE}; secret ${CRON_SECRET ? "configured" : "not configured (dev-open)"}`);

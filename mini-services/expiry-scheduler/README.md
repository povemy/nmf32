# expiry-scheduler (port 3005)

The **actual recurring invocation** for the F3 expiry sweep, the late-payment
refund-reconcile ticks and the C2.8 webhook-delivery retry sweep (missions:
*Close Final Operational and Payment-Recovery Gaps*, Phase 1 + Phase 2.3 C2.8).
The sandbox has no cron daemon — this always-on service IS the
scheduler for this deployment; a platform scheduler / external cron is the
production equivalent (same contract: `POST /api/cron/expiry-sweep`,
`POST /api/cron/refund-reconcile` and `POST /api/cron/webhook-delivery` on an
interval).

- `bun run dev` (bun --hot) — run from this directory.
- Interval: `SWEEP_INTERVAL_MS` (default 30 000 ms). Service objective: an
  expired reservation is released within interval + one bounded sweep pass
  (≤ 2 × interval, far inside the ≤ 5 min target in
  `performance/readiness-checklist.md`).
- `webhook` kind (C2.8): retries pending seller webhook deliveries on the
  backoff schedule 1m → 5m → 15m → 1h → 4h → 12h → 24h (8 attempts total,
  then terminal `failed`). The sweep route is deadline-aware (~35 s) so the
  45 s tick timeout is never breached; leftover due rows roll to the next
  tick. Outcome is recorded in Setting `cron.webhook_delivery.last`.
- Auth: sends `x-cron-secret` from `CRON_SECRET` (own env, else the project
  `.env`). The secret never appears in state, logs, or the status endpoint.
- Durable state: `state.json` (last tick / last success / failure streaks /
  alert ring). On boot, a stale last-success triggers an immediate catch-up
  tick + `MISSED_INTERVAL` alert.
- Alerts (throttled, visible on `GET http://localhost:3005/`): `TICK_FAILED`,
  `TICK_UNREACHABLE`, `OVERDUE_SWEEP`, `MISSED_INTERVAL`, `BACKLOG_HIGH`,
  `REFUND_STUCK`, `WEBHOOK_BACKLOG_HIGH`.
- Env knobs: `APP_BASE`, `SWEEP_INTERVAL_MS`, `OVERDUE_FACTOR`,
  `BACKLOG_ALERT_THRESHOLD`, `REFUND_STUCK_ALERT_THRESHOLD`.

## External monitoring (Phase 2.3 — P2.3-7)

This service's own status page (`GET :3005`) is **internal-only** — the gateway
does not route port 3005 — so an external uptime monitor cannot see it, and a
dead scheduler used to be a *silent* outage. External monitors should instead
poll the app's scheduler-health endpoint, which reads the durable
`cron.*.last` Setting rows this scheduler's ticks produce:

```bash
# dev (no CRON_SECRET configured — dev-open): plain poll
curl -s http://<app>/api/health/scheduler

# production / any CRON_SECRET deployment (timing-safe header, like cron routes)
curl -s -H "x-cron-secret: $CRON_SECRET" http://<app>/api/health/scheduler
```

Status: `healthy` → HTTP 200 (freshest expiry-sweep record younger than 90 s);
`stale` (the `cron.expiry_sweep.last` row is missing or older than 90 s —
scheduler likely down or the money rail failing) → HTTP 503, so status-code-
based monitors page on it. Per-rail ages are in `rails[].ageSeconds`; rails in
`staleRails` lag their cadence without failing the overall status.
See `src/app/api/health/scheduler/route.ts` and
`docs/phase23/process-supervision.md` for the full contract.

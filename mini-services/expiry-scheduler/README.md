# expiry-scheduler (port 3005)

The **actual recurring invocation** for the F3 expiry sweep and the late-payment
refund-reconcile ticks (mission: *Close Final Operational and Payment-Recovery
Gaps*, Phase 1). The sandbox has no cron daemon — this always-on service IS the
scheduler for this deployment; a platform scheduler / external cron is the
production equivalent (same contract: `POST /api/cron/expiry-sweep` and
`POST /api/cron/refund-reconcile` on an interval).

- `bun run dev` (bun --hot) — run from this directory.
- Interval: `SWEEP_INTERVAL_MS` (default 30 000 ms). Service objective: an
  expired reservation is released within interval + one bounded sweep pass
  (≤ 2 × interval, far inside the ≤ 5 min target in
  `performance/readiness-checklist.md`).
- Auth: sends `x-cron-secret` from `CRON_SECRET` (own env, else the project
  `.env`). The secret never appears in state, logs, or the status endpoint.
- Durable state: `state.json` (last tick / last success / failure streaks /
  alert ring). On boot, a stale last-success triggers an immediate catch-up
  tick + `MISSED_INTERVAL` alert.
- Alerts (throttled, visible on `GET http://localhost:3005/`): `TICK_FAILED`,
  `TICK_UNREACHABLE`, `OVERDUE_SWEEP`, `MISSED_INTERVAL`, `BACKLOG_HIGH`,
  `REFUND_STUCK`.
- Env knobs: `APP_BASE`, `SWEEP_INTERVAL_MS`, `OVERDUE_FACTOR`,
  `BACKLOG_ALERT_THRESHOLD`, `REFUND_STUCK_ALERT_THRESHOLD`.

# Process supervision (Phase 2.3 — P2.3-7)

How the three services + gateway run **today** (verified in this deployment)
and the recommended **production** supervision. Verified facts vs
recommendations are marked.

## Topology today (VERIFIED)

| Service | Port | How it starts today | Notes |
|---|---|---|---|
| Web app (Next.js 16) | :3000 | `bun run dev` (ensure-env → `next dev -p 3000 \| tee dev.log`), kept alive by `scripts/dev-supervisor.sh` (DEV-SANDBOX ONLY — never production) | single-route UI + all `/api/*` |
| Chat hub (socket.io) | :3003 + internal relay :3103 | `cd mini-services/chat-service && bun run dev` (`bun --hot index.ts`) | relay :3103 is same-process, secret-gated |
| Expiry scheduler | :3005 | `cd mini-services/expiry-scheduler && bun run dev` (`bun --hot index.ts`) | ticks the 7 cron rails every `SWEEP_INTERVAL_MS` (30 s) |
| Gateway (Caddy) | :81 | Caddyfile at repo root | routes `XTransformPort=3003` → chat, everything else → :3000; :3005/:3103 are deliberately NOT routable |

## Production recommendation: systemd (RECOMMENDATION)

The deployment runbook (`docs/ops/phase21-deployment-runbook.md` §3) already
assumes systemd units (`systemctl stop nomofee-scheduler nomofee-chat
nomofee-web`) — systemd is the consistent choice. Env lives in ONE file,
`/etc/nomofee/nomofee.env` (600, root-owned), containing every boot-fatal
secret from `.env.example` (`SUPABASE_DATABASE_URL`, `PSP_WEBHOOK_SECRET`,
`CRON_SECRET`, `MFA_ENCRYPTION_KEY`, `IMPORT_TOKEN_ENC_KEY`,
`ORDER_ACCESS_SECRET`, `EMAIL_OTP_SECRET`, `EMAIL_PROVIDER=resend` +
`RESEND_API_KEY` + `EMAIL_FROM`, plus warn-level `METRICS_TOKEN`,
`SHIPPING_WEBHOOK_SECRET`, `CHAT_RELAY_SECRET`, `IMPORT_CAP_SECRET`,
`RESEND_WEBHOOK_SECRET`) — the web app's boot gate
(`src/instrumentation-node.ts` → `enforceProductionSecrets`) aborts startup
with the exact missing-key list otherwise.

```ini
# /etc/systemd/system/nomofee-web.service
[Unit]
Description=NOMOFEE web (Next.js standalone)
After=network-online.target
[Service]
Type=simple
User=nomofee
WorkingDirectory=/opt/nomofee
EnvironmentFile=/etc/nomofee/nomofee.env
Environment=NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
ExecStart=/usr/bin/env bun /opt/nomofee/.next/standalone/server.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/nomofee-chat.service
[Unit]
Description=NOMOFEE chat hub (socket.io :3003 + relay :3103)
After=network-online.target
[Service]
Type=simple
User=nomofee
WorkingDirectory=/opt/nomofee/mini-services/chat-service
EnvironmentFile=/etc/nomofee/nomofee.env
ExecStart=/usr/bin/env bun index.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/nomofee-scheduler.service
[Unit]
Description=NOMOFEE expiry scheduler (cron rails, :3005)
After=network-online.target nomofee-web.service
[Service]
Type=simple
User=nomofee
WorkingDirectory=/opt/nomofee/mini-services/expiry-scheduler
EnvironmentFile=/etc/nomofee/nomofee.env
Environment=APP_BASE=http://127.0.0.1:3000
ExecStart=/usr/bin/env bun index.ts   # NOT --hot in production
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
```

Build/deploy sequence stays per the runbook: `bun run build` → stop order
web → chat → scheduler → `bunx prisma migrate deploy` → start order web →
chat → scheduler. Caddy runs as its own system service with a production
Caddyfile (ACME on :80/:443 instead of the sandbox's :81).

## The scheduler outage lesson (VERIFIED endpoint)

The scheduler's own state (`state.json`, alerts on `GET :3005`) is invisible
from outside the host — the gateway does not route :3005. A dead scheduler was
a **silent** outage (audit finding). External monitors now poll
`GET /api/health/scheduler`, which reads the durable `cron.*.last` Setting
rows each tick produces:

```bash
curl -s -H "x-cron-secret: $CRON_SECRET" https://<host>/api/health/scheduler
# healthy (freshest expiry-sweep record < 90 s) → 200; stale (expiry sweep
# missing or ≥ 90 s old) → 503; DB unreachable → 503 SCHEDULER_DB_UNREACHABLE
```

Pair it with `GET /api/health/live` (process liveness, no DB) and — if a
`METRICS_TOKEN` is configured — `GET /api/metrics` (route latency, status
codes, event-loop lag, DB op aggregates; all real since P2.3-7).

## Log rotation (RECOMMENDATION)

- Under systemd all three units log to **journald** — do NOT `tee` to
  `dev.log`/`server.log` in production (those are dev conveniences). Bound
  journald in `/etc/systemd/journald.conf`: `SystemMaxUse=2G`,
  `MaxRetentionSec=30day`, then `systemctl restart systemd-journald`.
- Scheduler `state.json` is small, bounded state — include `/opt/nomofee` in
  normal backups; it never contains the cron secret.

**Verified:** ports, start commands, gateway routing (:81), the health
endpoints' live behavior (curl'd in this deployment), the boot-gate secret
list. **Recommendations:** the unit files above, journald bounds, deployment
paths/user.

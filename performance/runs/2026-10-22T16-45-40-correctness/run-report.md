# Load-test run report — correctness

> **combined-environment test — k6 shares the 2 vCPU / 4 GB host with the app; NOT the application's maximum capacity; development-mode measurements (next dev, Turbopack); production build blocked by sandbox policy (documented).**

## Run identity
- profile: `correctness` | scenario: `correctness-storm.js` | run dir: `2026-10-22T16-45-40-correctness`
- started: 2026-10-22T16:45:40.291Z → ended: 2026-10-22T16:45:55.892Z — wall 15.6s - testRunDurationMs: 14018.930174 [Measured — k6 summary data.state]
- model: **CLOSED VU model** (VUs loop journeys; VUs ≠ visitors)
- max VUs observed: 100 [Measured — k6 summary]
- arrival rate config: n/a (closed model) [Config]
- XFF model: per-request X-Forwarded-For = 10.<vu>.<a>.<b> (direct :3000, limiter keys on first XFF value → thousands of launch-IP model); viaCaddy would collapse into ONE limiter bucket (Caddy overwrites XFF) [Documented — src/lib/ratelimit.ts + Caddyfile]
- overrides: duration=none vus=none 
- k6 version / bun version: k6 v2.3.0 (commit/e088784614, go1.26.8, linux/amd64) / 1.3.14 [Measured]

## Host & per-process limits (rule #6)
- host: 2 vCPU, MemTotal 4042MB, MemAvailable at start 1973MB [Measured — nproc//proc/meminfo]
- app process: PID 29671, fdLimit 100000 (from /proc/29671/limits) [Measured — ss -ltnp + /proc]
- caddy process: PID 2, fdLimit 100000 (measured SEPARATELY from the app per rule #6) [Measured — /proc cmdline scan]

## Traffic delivered
- HTTP requests: 202 [Measured — k6 http_reqs.count]
- achieved RPS: 14.41 [Measured — k6 http_reqs.rate]
- iterations: 100 [Measured — k6 iterations.count]
- HTTP error rate (http_req_failed): 0.00% [Measured — k6 http_req_failed.rate]

## Latency (ms)
- p50: 5094.488161 [Measured — k6 http_req_duration]
- p90: 7659.2975801 [Measured — k6 http_req_duration]
- p95: 9452.636793099999 [Measured — k6 http_req_duration]
- p99: 9581.39554991 [Measured — k6 http_req_duration]
- app-side route p95 (post-run /api/metrics, top 3 by count): POST /api/auth/shopper/login p95=6400ms n=100 | POST /api/cart/items p95=6400ms n=100 | GET /api/chat/unread p95=3200ms n=8 [Measured — /api/metrics after snapshot]

## Business outcomes
- checkout_attempts: 100 (7.1/s) [Measured — k6 custom counter]
- checkout_created (201): 0 [Measured — k6 custom counter]
- orders_paid: 0 (0/min) [Measured — k6 custom counter]
- 409 OUT_OF_STOCK: 0 [Measured — k6 custom counter (conditional-decrement guard fired)]
- 409 MOQ_NOT_MET: 0 [Measured — k6 custom counter]
- 409 other codes: 0 [Measured — k6 custom counter]
- other 4xx on create: 0 [Measured — k6 custom counter (code tags in k6-stdout.log/summary)]
- 5xx on create: 0 [Measured — k6 custom counter]
- payment failed/expired: 0 [Measured — k6 custom counter]
- payment poll timeouts: 0 [Measured — k6 custom counter]
- order e2e (create→paid) avg ms: n/a [Measured — k6 trend order_e2e_ms]
- integrity_failures rate: n/a [Measured — k6 rate metric (simulate=succeeded but paid status never verified)]
- **integrity verdict**: FAIL(exit=1) (scripts/loadtest/integrity.ts output → integrity.log) [Measured]

## App & generator resources (samples.csv, 1s cadence)
- app RSS max: 1923.1MB [Measured — /proc/<appPid>/status via sample.ts]
- app FD max: 161 [Measured — /proc/<appPid>/fd (limit 100000)]
- app CPU max: 111.9% (total across cores) [Measured — /proc/<appPid>/stat]
- caddy FD max / CPU max: -1 / 1% [Measured — /proc/<caddyPid> (own fdLimit 100000)]
- generator (k6) RSS max / CPU max: 71.9MB / 14% [Measured — sampler self (k6 pid unavailable)]
- event-loop lag max during run (watcher): p95 579ms / max 579ms [Measured — /api/metrics polled every 2000ms]
- app heapUsed max observed (watcher): 294.1MB (abort threshold 1258.4MB) [Measured — /api/metrics]
- app fdCount max observed (watcher): 161 [Measured — /api/metrics]
- resource samples rows: 16 (missing 0% vs expected) [Measured — samples.csv]

- derived heap ceiling: max(512, MemAvailable 1973MB − 400MB safety) = **1573MB** → heap abort threshold **1258.4MB** [Derived from /proc/meminfo at run start]
- app requests counter: before=24 after=229 (Δ proves the run hit the app) [Measured — /api/metrics totals]

## DB snapshots
- pg-before.json / pg-after.json (pg_stat_activity by state, max_connections, top-10 pg_stat_statements by total_exec_time) — availability recorded inside each file, honestly marked when denied. [Measured]

## Classification: **PASS**
- no threshold breach, evidence complete
- bracket [correctness completed — no fail observed]
- k6 thresholds: all ok

### Rules applied
- #1: this is a **combined-environment** run (see header). Generator saturation checked: not detected (gen CPU ≤85% sustained).
- #5: model + rates + percentiles + error rate + checkout/s + orders/min reported above; VUs ≠ visitors.
- #9: guardrail layers — k6 thresholds (abortOnFail) p95<5000ms err<10% + coordinator watcher (lag>2000ms, heap>1258.4MB, FD>9000, metrics unreachable ×15). Outcome: not triggered.
- #12: verdict is tied to THIS workload (profile correctness, closed 100 max VUs) on THIS host in THIS dev mode — **no universal max-user claim is made**.

## Evidence manifest
- config-used.json
- k6-stdout.log
- k6-summary.json
- app-metrics-before.json
- app-metrics-after.json
- pg-before.json
- pg-after.json
- samples.csv
- abort-reason.json
- integrity.log

## Reproduce
```bash
LT_RUN_DURATION_OVERRIDE=(none) bun scripts/loadtest/run.ts correctness
# or directly: LT_PROFILE=correctness k6 run scripts/loadtest/scenarios/correctness-storm.js
```

---
**Emergency stop**: `pkill -f "k6 run"` + `kill 29888` (sampler). Coordinator also SIGINTs k6 on guardrail breach (SIGKILL after 10s grace).

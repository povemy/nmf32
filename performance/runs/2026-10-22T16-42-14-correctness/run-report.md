# Load-test run report — correctness

> **combined-environment test — k6 shares the 2 vCPU / 4 GB host with the app; NOT the application's maximum capacity; development-mode measurements (next dev, Turbopack); production build blocked by sandbox policy (documented).**

## Run identity
- profile: `correctness` | scenario: `correctness-storm.js` | run dir: `2026-10-22T16-42-14-correctness`
- started: 2026-10-22T16:42:14.590Z → ended: 2026-10-22T16:42:48.083Z — wall 33.5s - testRunDurationMs: 31922.731968 [Measured — k6 summary data.state]
- model: **CLOSED VU model** (VUs loop journeys; VUs ≠ visitors)
- max VUs observed: 100 [Measured — k6 summary]
- arrival rate config: n/a (closed model) [Config]
- XFF model: per-request X-Forwarded-For = 10.<vu>.<a>.<b> (direct :3000, limiter keys on first XFF value → thousands of launch-IP model); viaCaddy would collapse into ONE limiter bucket (Caddy overwrites XFF) [Documented — src/lib/ratelimit.ts + Caddyfile]
- overrides: duration=none vus=none 
- k6 version / bun version: k6 v2.3.0 (commit/e088784614, go1.26.8, linux/amd64) / 1.3.14 [Measured]

## Host & per-process limits (rule #6)
- host: 2 vCPU, MemTotal 4042MB, MemAvailable at start 1159MB [Measured — nproc//proc/meminfo]
- app process: PID 14689, fdLimit 100000 (from /proc/14689/limits) [Measured — ss -ltnp + /proc]
- caddy process: PID 2, fdLimit 100000 (measured SEPARATELY from the app per rule #6) [Measured — /proc cmdline scan]

## Traffic delivered
- HTTP requests: 247 [Measured — k6 http_reqs.count]
- achieved RPS: 7.74 [Measured — k6 http_reqs.rate]
- iterations: 45 [Measured — k6 iterations.count]
- HTTP error rate (http_req_failed): 18.22% [Measured — k6 http_req_failed.rate]

## Latency (ms)
- p50: 5942.189591 [Measured — k6 http_req_duration]
- p90: 13841.0908354 [Measured — k6 http_req_duration]
- p95: 17054.759876699998 [Measured — k6 http_req_duration]
- p99: 20000.8915175 [Measured — k6 http_req_duration]
- app-side route p95 (post-run /api/metrics, top 3 by count): GET /api/sf/lt-main-store/products/lt-flash-perf-item p95=16507ms n=1259 | POST /api/cart/items p95=12800ms n=887 | POST /api/auth/shopper/login p95=22331ms n=543 [Measured — /api/metrics after snapshot]

## Business outcomes
- checkout_attempts: 100 (3.1/s) [Measured — k6 custom counter]
- checkout_created (201): 0 [Measured — k6 custom counter]
- orders_paid: 0 (0/min) [Measured — k6 custom counter]
- 409 OUT_OF_STOCK: 0 [Measured — k6 custom counter (conditional-decrement guard fired)]
- 409 MOQ_NOT_MET: 0 [Measured — k6 custom counter]
- 409 other codes: 0 [Measured — k6 custom counter]
- other 4xx on create: 0 [Measured — k6 custom counter (code tags in k6-stdout.log/summary)]
- 5xx on create: 34 [Measured — k6 custom counter]
- payment failed/expired: 0 [Measured — k6 custom counter]
- payment poll timeouts: 0 [Measured — k6 custom counter]
- order e2e (create→paid) avg ms: n/a [Measured — k6 trend order_e2e_ms]
- integrity_failures rate: n/a [Measured — k6 rate metric (simulate=succeeded but paid status never verified)]
- **integrity verdict**: FAIL(exit=1) (scripts/loadtest/integrity.ts output → integrity.log) [Measured]

## App & generator resources (samples.csv, 1s cadence)
- app RSS max: 2431.1MB [Measured — /proc/<appPid>/status via sample.ts]
- app FD max: 162 [Measured — /proc/<appPid>/fd (limit 100000)]
- app CPU max: 120.9% (total across cores) [Measured — /proc/<appPid>/stat]
- caddy FD max / CPU max: -1 / 1% [Measured — /proc/<caddyPid> (own fdLimit 100000)]
- generator (k6) RSS max / CPU max: 77.6MB / 12% [Measured — sampler self (k6 pid unavailable)]
- event-loop lag max during run (watcher): p95 5ms / max 3099ms [Measured — /api/metrics polled every 2000ms]
- app heapUsed max observed (watcher): 609.9MB (abort threshold 607.2MB) [Measured — /api/metrics]
- app fdCount max observed (watcher): 163 [Measured — /api/metrics]
- resource samples rows: 34 (missing 0% vs expected) [Measured — samples.csv]

- derived heap ceiling: max(512, MemAvailable 1159MB − 400MB safety) = **759MB** → heap abort threshold **607.2MB** [Derived from /proc/meminfo at run start]
- app requests counter: before=4458 after=4714 (Δ proves the run hit the app) [Measured — /api/metrics totals]

## DB snapshots
- pg-before.json / pg-after.json (pg_stat_activity by state, max_connections, top-10 pg_stat_statements by total_exec_time) — availability recorded inside each file, honestly marked when denied. [Measured]

## Classification: **ABORTED**
- coordinator watcher aborted k6: heap_used {"observedHeapUsedMb":609.9,"thresholdMb":607.2,"derivedCeilingMb":759,"at":"2026-10-22T16:42:47.856Z"}
- bracket [completed up to the abort (stage attribution not instrumented — see k6-stdout.log timeline), first fail: heap_used]
- k6 thresholds: all ok

### Rules applied
- #1: this is a **combined-environment** run (see header). Generator saturation checked: not detected (gen CPU ≤85% sustained).
- #5: model + rates + percentiles + error rate + checkout/s + orders/min reported above; VUs ≠ visitors.
- #9: guardrail layers — k6 thresholds (abortOnFail) p95<5000ms err<10% + coordinator watcher (lag>2000ms, heap>607.2MB, FD>9000, metrics unreachable ×15). Outcome: ABORTED by heap_used.
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
**Emergency stop**: `pkill -f "k6 run"` + `kill 29339` (sampler). Coordinator also SIGINTs k6 on guardrail breach (SIGKILL after 10s grace).

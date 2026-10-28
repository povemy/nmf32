# Load-test run report — ramp

> **combined-environment test — k6 shares the 2 vCPU / 4 GB host with the app; NOT the application's maximum capacity; development-mode measurements (next dev, Turbopack); production build blocked by sandbox policy (documented).**

## Run identity
- profile: `ramp` | scenario: `browse.js` | run dir: `2026-10-22T16-13-02-ramp`
- started: 2026-10-22T16:13:02.219Z → ended: 2026-10-22T16:19:35.338Z — wall 393.1s - testRunDurationMs: 391804.50772 [Measured — k6 summary data.state]
- model: **CLOSED VU model** (VUs loop journeys; VUs ≠ visitors)
- max VUs observed: 200 [Measured — k6 summary]
- arrival rate config: n/a (closed model) [Config]
- XFF model: per-request X-Forwarded-For = 10.<vu>.<a>.<b> (direct :3000, limiter keys on first XFF value → thousands of launch-IP model); viaCaddy would collapse into ONE limiter bucket (Caddy overwrites XFF) [Documented — src/lib/ratelimit.ts + Caddyfile]
- overrides: duration=none vus=none 
- k6 version / bun version: k6 v2.3.0 (commit/e088784614, go1.26.8, linux/amd64) / 1.3.14 [Measured]

## Host & per-process limits (rule #6)
- host: 2 vCPU, MemTotal 4042MB, MemAvailable at start 1501MB [Measured — nproc//proc/meminfo]
- app process: PID 4883, fdLimit 100000 (from /proc/4883/limits) [Measured — ss -ltnp + /proc]
- caddy process: PID 2, fdLimit 100000 (measured SEPARATELY from the app per rule #6) [Measured — /proc cmdline scan]

## Traffic delivered
- HTTP requests: 4841 [Measured — k6 http_reqs.count]
- achieved RPS: 12.36 [Measured — k6 http_reqs.rate]
- iterations: 4503 [Measured — k6 iterations.count]
- HTTP error rate (http_req_failed): 0.00% [Measured — k6 http_req_failed.rate]

## Latency (ms)
- p50: 717.275746 [Measured — k6 http_req_duration]
- p90: 2544.620958 [Measured — k6 http_req_duration]
- p95: 3836.769382 [Measured — k6 http_req_duration]
- p99: 5325.46635180001 [Measured — k6 http_req_duration]
- app-side route p95 (post-run /api/metrics, top 3 by count): GET /api/market/home p95=3200ms n=1555 | GET /api/market/products p95=1600ms n=1246 | GET /api/sf/lt-main-store/products/lt-flash-perf-item p95=6400ms n=1004 [Measured — /api/metrics after snapshot]

## Business outcomes
- checkout_attempts: 0 (0/s) [Measured — k6 custom counter]
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
- integrity: n/a (not a correctness run)

## App & generator resources (samples.csv, 1s cadence)
- app RSS max: 2553.3MB [Measured — /proc/<appPid>/status via sample.ts]
- app FD max: 156 [Measured — /proc/<appPid>/fd (limit 100000)]
- app CPU max: 97.9% (total across cores) [Measured — /proc/<appPid>/stat]
- caddy FD max / CPU max: -1 / 3% [Measured — /proc/<caddyPid> (own fdLimit 100000)]
- generator (k6) RSS max / CPU max: 126.0MB / 24% [Measured — sampler self (k6 pid unavailable)]
- event-loop lag max during run (watcher): p95 94ms / max 829ms [Measured — /api/metrics polled every 2000ms]
- app heapUsed max observed (watcher): 897.6MB (abort threshold 880.8MB) [Measured — /api/metrics]
- app fdCount max observed (watcher): 157 [Measured — /api/metrics]
- resource samples rows: 394 (missing 0% vs expected) [Measured — samples.csv]

- derived heap ceiling: max(512, MemAvailable 1501MB − 400MB safety) = **1101MB** → heap abort threshold **880.8MB** [Derived from /proc/meminfo at run start]
- app requests counter: before=626 after=5640 (Δ proves the run hit the app) [Measured — /api/metrics totals]

## DB snapshots
- pg-before.json / pg-after.json (pg_stat_activity by state, max_connections, top-10 pg_stat_statements by total_exec_time) — availability recorded inside each file, honestly marked when denied. [Measured]

## Classification: **ABORTED**
- coordinator watcher aborted k6: heap_used {"observedHeapUsedMb":897.6,"thresholdMb":880.8,"derivedCeilingMb":1101,"at":"2026-10-22T16:19:35.078Z"}
- bracket [completed up to the abort (stage attribution not instrumented — see k6-stdout.log timeline), first fail: heap_used]
- k6 thresholds: all ok

### Rules applied
- #1: this is a **combined-environment** run (see header). Generator saturation checked: not detected (gen CPU ≤85% sustained).
- #5: model + rates + percentiles + error rate + checkout/s + orders/min reported above; VUs ≠ visitors.
- #9: guardrail layers — k6 thresholds (abortOnFail) p95<5000ms err<10% + coordinator watcher (lag>2000ms, heap>880.8MB, FD>9000, metrics unreachable ×15). Outcome: ABORTED by heap_used.
- #12: verdict is tied to THIS workload (profile ramp, closed 200 max VUs) on THIS host in THIS dev mode — **no universal max-user claim is made**.

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
- integrity.log — *(not produced this run)*

## Reproduce
```bash
LT_RUN_DURATION_OVERRIDE=(none) bun scripts/loadtest/run.ts ramp
# or directly: LT_PROFILE=ramp k6 run scripts/loadtest/scenarios/browse.js
```

---
**Emergency stop**: `pkill -f "k6 run"` + `kill 7051` (sampler). Coordinator also SIGINTs k6 on guardrail breach (SIGKILL after 10s grace).

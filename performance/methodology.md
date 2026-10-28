# Methodology (LT) — how the numbers were produced

Traffic models (rule #5):
- CLOSED (ramping-vus / constant-vus): VUs loop journeys with think-time 0.5–2.5 s; measures sustainable session load. VUs ≠ visitors.
- OPEN (constant/ramping-arrival-rate): journeys arrive at a configured rate regardless of completion; models launch bursts; drops iterations when VU pool exhausts (counted, reported).
- XFF model: direct-:3000 requests carry unique `10.<vu>.<a>.<b>` X-Forwarded-For (limiter keys on first XFF) → models thousands of launch IPs. `--via-caddy` collapses into one bucket (Caddy overwrites XFF) — documented, not run.
- Journey mix: browse = home 30% / search 25% / PDP 20% / storefront 10% / suggest 10% / cart 5%. Spike = PDP 55% / cart 15% / checkout 20% / browse 10%. Purchase = full checkout journeys (unique idem keys, simulate "succeeded", status polling, paid verification).

Metrics chain (rule #4 — three distinct DB sources):
1. Prisma-observed op duration — $extends hook (client-side incl. network+pool wait), aggregated per model.op + per request via AsyncLocalStorage.
2. PostgreSQL exec time — pg_stat_statements probes (READABLE, verified).
3. Pool wait + connection gauges — prisma.$metrics (previewFeatures "metrics"); reported only because actually available; `null` = no contention observed (never fabricated as 0).
- App resources: /proc/<pid>/status VmRSS, fd count, CPU jiffies (1 s sampler); caddy measured separately (rule #6); k6 generator self-sampled (never saturated → no INCONCLUSIVE-for-generator runs).
- k6 summary: handleSummary JSON + `--summary-export` fallback (v2.3.0 ramping-arrival-rate executor quirk: handleSummary never fires — Measured, workaround archived in run.ts).
- Percentiles from fixed buckets are upper-bound approximations (documented).

Evidence archive (rule #10): performance/runs/<ts>-<profile>/ = config-used.json, k6-stdout.log, k6-summary.json/k6-export.json, app-metrics-before/after.json, pg-before/after.json, samples.csv, integrity.log, run-report.md (labels every number Measured/Derived/Assumed; classification PASS/DEGRADED/ABORTED/INCONCLUSIVE).

Safety (rules #7/#9): env-guard fail-closed (DB host allowlist, ready-check, mock-PSP-only, sandbox signature, no prod markers) — ran before seed/cleanup/integrity; [LT]-marked data; cleanup constrained to test-owned rows; cycle protocol cleanup→seed→storm→integrity; watcher aborts (lag/heap/RSS/FD/metrics-streak) — all verified firing; no OOM targeted.

Known measurement limitations: dev-mode only (rule #2 — no prod extrapolation); combined environment (rule #1 — generator shares host, sampled, never saturated); bucketed percentiles; ramp stage-split not retained; soak not run (REPORT.md §7).

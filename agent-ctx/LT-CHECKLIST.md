# LT-CHECKLIST — Load Testing, Observability & Capacity Planning (NOMOFEE)

Governing doc: upload/Pasted Content_1792680041430.txt (MASTER ENGINEERING PROMPT)
+ user's 12 Mandatory Accuracy/Safety/Capacity rules (chat 2026-10-22).

## USER'S 12 RULES → TASK MAP (each is a hard constraint)

| # | Rule | Where enforced |
|---|------|----------------|
| 1 | Separate app vs generator capacity; combined-environment label if shared | run reports label "combined-environment (k6 shares 2 vCPU / 4 GB)"; gen CPU/RSS/achieved RPS sampled every 1s into run archive |
| 2 | No dev→prod extrapolation; attempt prod build only if permitted; else document blocker | BLOCKER documented: sandbox policy forbids `next build` (see performance/ block note). All results labeled "development-mode, combined-environment" |
| 3 | Distinct health endpoints: /live (no DB) + /ready (bounded, short timeout); full-ledger check excluded from routine polling | src/app/api/health/live/route.ts (no DB), src/app/api/health/ready/route.ts (SELECT 1, 1.2s race timeout); existing /api/health untouched, excluded from test polling |
| 4 | Bounded, secure instrumentation; distinguish Prisma-observed vs PG-exec vs pool-wait; never claim pool-wait unless actually available; exclude /api/metrics from counters; token-gated; no secrets/PII/SQL params | src/lib/metrics.ts (bounded route-pattern registry ≤200, histogram buckets, slow-query ring 50 w/ model+op+ms only, NO sql text/params); Prisma $extends query timing; prisma client metrics (`prisma_client_queries_wait` etc.) probed at runtime — included only if actually available; pg_stat_statements probed — included only if granted |
| 5 | Right traffic model: closed VU sessions AND open arrival bursts; report VUs, arrival rate, RPS, p50/90/95/99, error rate, checkout attempts/s, completed orders/min, integrity outcomes; VU ≠ real visitors | scenarios: browse.js (closed), arrival-burst variant (open), purchase.js (closed+open), spike.js (open ramp); report template enforces the fields + VU≠visitors note |
| 6 | Measure FD limits for Node AND Caddy independently; DB occupancy/query duration/errors; verify pg_stat_activity perms; keep overhead low; do NOT raise connection_limit without evidence | coordinator samples /proc/<pid>/fd + /proc/<pid>/limits for app process and caddy separately; pg_stat_activity probe (SELECT count(*)) — recorded available/unavailable; pool gauges from client metrics if available; connection_limit stays 10 unless evidence says otherwise |
| 7 | Protect test data & external systems; fail-closed env guard; deterministic [LT] seed; repeatable cleanup constrained to test records; verify no real external side effects (PSP mock only, notify=DB rows, shipping tick local) | scripts/loadtest/env-guard.ts (fails closed unless DB host = expected Supabase pooler, psp.mock allowed, [LT] isolation verified); seed.ts/cleanup.ts marker-scoped; external-side-effect audit table in architecture doc |
| 8 | Separate inventory tests: perf scenario w/ ample stock vs correctness scenario (simultaneous purchase, idempotency, oversell, duplicates, ledger) | scenarios: purchase/stress use stock=1,000,000 LT product; correctness-storm.js = 100 VUs vs stock=60, then scripts/loadtest/integrity.ts verifies exact decrement, no negative, idempotent replays→duplicate, ledger invariants |
| 9 | Guardrail stress: configurable latency/error/lag/memory/FD thresholds + hard load cap + threshold accumulation time + coordinator stop; NO OOM targeting on dev server | stress.js thresholds (abortOnFail) from config.json: p95>5s, err>10%, lag>2s, heap>80% of observed baseline ceiling, FD>900, max VUs cap; coordinator SIGINT stop documented |
| 10 | Preserve evidence; label Measured/Derived/Assumed; archive config, versions, env, data counts, raw k6, app snapshots, resource samples, DB snapshots if permitted, cleanup status; report bracket [highest pass, first fail]; gen-saturation or incomplete monitoring ⇒ INCONCLUSIVE | performance/runs/<ts>-<profile>/ (config, raw k6 JSON, metric snapshots before/after, resource samples.csv, pg snapshots, report.md); report template enforces labels + bracket + inconclusive rules |
| 11 | Do not assume bottleneck; hypotheses confirmed with evidence; baseline first; one change at a time; rerun same workload | hypotheses H1..H6 listed in current-risks.md with "confirm-by" test; fixes only after baseline evidence; each fix reruns identical profile id |
| 12 | No universal max-user claim; verdict states workload, rates, HW, DB config, env, duration, errors, integrity, limitations; 30-min influencer verdict tied to explicit arrival pattern + checkout workload | final report template: capacity-verdict section with all mandatory fields; launch verdict computed from spike.js arrival pattern, not VU count |

## PHASE MAP (master prompt → execution)

- P1 Audit → performance/architecture-audit.md, critical-user-journeys.md, current-risks.md (from completed audit)
- P2 Strategy → performance/methodology.md + scenarios/*.js + config.json
- P3 Test data → scripts/loadtest/{env-guard,seed,cleanup,integrity}.ts
- P4 Monitoring → src/lib/metrics.ts, /api/metrics, /api/health/{live,ready}, probes
- P5 Targets → provisional SLOs in config.json (labeled provisional)
- P6 Runs → smoke → baseline → ramp → spike → guarded stress → soak(optional bg) → recovery
- P7 Capacity → performance/REPORT.md (brackets, labels, launch readiness)
- P8 Fixes → evidence-gated, one at a time, re-run same profile id
- P9/P10 → report + acceptance checklist

## PROTECTED AREAS (do not modify)

- Business logic: checkout create/pricing, webhook process.ts, psp.ts, ledger, stock guard — MEASURE ONLY
- Existing /api/health semantics
- prisma schema DATA MODEL (generator previewFeatures addition allowed; NO db push)
- src/components/** (no frontend changes in this task)

## FILE MAP (new)

- src/lib/metrics.ts; src/app/api/metrics/route.ts; src/app/api/health/live/route.ts; src/app/api/health/ready/route.ts
- src/lib/api.ts handle() — instrumentation hook ONLY (no behavior change)
- prisma/schema.prisma generator block: previewFeatures ["metrics"] (no db push)
- scripts/loadtest/{env-guard,seed,cleanup,integrity,run,sample}.ts; scripts/loadtest/scenarios/*.js; scripts/loadtest/config.json
- performance/{architecture-audit.md,critical-user-journeys.md,current-risks.md,methodology.md,REPORT.md,runs/}

## VERIFICATION PLAN

- lint 0; every new route curl-verified; metrics snapshot delta proves counters real (rule: prove monitoring works)
- integrity.ts green after correctness storm; cleanup restores pre-seed counts
- every run dir contains raw evidence; every number in reports labeled

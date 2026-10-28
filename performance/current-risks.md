# Current risks & hypothesis ledger (LT) — 2026-10-22

Rule #11 protocol: hypotheses stated BEFORE testing; status updated only with measured evidence; fixes one at a time, same-workload retests (REPORT.md §11).

| # | Hypothesis (pre-test) | Evidence collected | Status |
|---|---|---|---|
| H1 | Checkout query count (30–60/order) × pool=10 × 40 ms RTT caps checkout throughput | order_e2e 5.4 s avg at 5 VU; create p95 36.3 s at 100-way; paid plateau 16.5–20.2/min across all profiles | **CONFIRMED** (F2) |
| H2 | Zero server-side caching makes browse DB/CPU-bound | home ≈239 ms DB time/req; browse CPU 98% at 100 VU; RPS ceiling ≈12 for browse mix | **CONFIRMED** (F5) |
| H3 | Auth double-read adds measurable load | login p95 6.4 s in storm (2 reads queued behind pool); minor at low load | CONFIRMED (secondary) |
| H4 | FD exhaustion (1,024) would be the first wall | Measured per-process: app/caddy limits are 100,000; max FDs seen 68 | **REFUTED** for this host |
| H5 | Dev-mode overhead inflates latency/CPU | Turbopack RSS floor 1.85 GB; CPU first ceiling in every failing profile | CONFIRMED (dev-mode; no prod factor claimed — rule #2) |
| H6 | Concurrent same-key checkout → 500 (P2002) | unique keys used by harness; duplicates impossible by schema (559 groups/559 keys counted); P2002 path exists for the legacy duplicate-key user error, unexercised | PLAUSIBLE, unexercised |

## New risks found by testing (ranked)

- **F1 Payment-confirmation 500s under concurrency (P2034 serialization conflicts, no retry)** — 58% cumulative; 100% during storm; buyer-visible at "Pay now". FIX planned (bounded retry), retest protocol in REPORT.md §11.
- **F2 Checkout/create pool starvation under rush** — 67/100 creates 500, p95 36.3 s.
- **F3 Unpaid groups freeze stock 30 min (no restock on expiry/failure)** — 352 pending groups measured; campaign-design decision needed.
- **F4 Host OOM frontier** — kernel kills at 1.82–1.97 GB app RSS; watcher RSS guard prevents unguarded occurrence on the dev server.
- **F5 No server-side cache + per-request auth reads** — browse ceiling ≈12 RPS on 2 dev-mode cores.
- **F6 (product search, discovered by harness)**: slug tokens not present in title/description make an existing product unfindable via search (relevance window ordered by salesCount among 5k catalog) — search UX risk for large catalogs; out of LT scope, flagged for product.

## Guardrail verification (rule #9)

- k6 layer 1 (abortOnFail p95>5s / errors>10%): fired on spike@6/s and spike@120/s. ✓
- Coordinator layer 2 (watcher): heap_used abort fired on ramp (897.6 > 880.8 MB); RSS_oom_guard armed with derived thresholds (verified in preflight logs); metrics-unreachable streak abort armed. ✓
- Emergency stop documented (pkill k6 + sampler kill; k6.pid persisted). ✓
- No OOM targeted on the dev server: all guarded runs stopped before kernel action; both OOM kills occurred OUTSIDE guarded runs (pre-ladder compile + early unguarded restart), logged as environment evidence.

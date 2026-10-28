# Critical user journeys (LT) — functional status 2026-10-22

All journeys exercised under load with outcome accounting (k6 custom counters + app status maps):

1. Browse home → 200 always; ≈239 ms DB time/req server-side (5 parallel queries + card includes). Functional ✓, perf: DB-bound.
2. Search/browse products → 200; relevance mode = ILIKE tokens + 200-row window re-ranked by salesCount. Functional ✓ (S1). Perf: unindexable ILIKE + window nondeterminism (slug-tokens not in title → item unfindable via search — hit by harness, worked around via PDP fallback; NOTED as product search limitation, not fixed in LT).
3. PDP (storefront product) → 200; LT store required a published home page (STORE_NOT_PUBLISHED 404 measured first, then published by harness). Functional ✓.
4. Login → 200 (p95 6.4 s during 100-way storm). Functional ✓. Perf: 2 DB reads + pool queueing.
5. Cart add/get → 201/200. Functional ✓.
6. Checkout create → 201 with unique Idempotency-Key; 409 OUT_OF_STOCK/MOQ paths exist and are counted; 500 under pool starvation (F2). Correctness ✓ (integrity PASS), capacity ✗ under rush.
7. Payment simulate → 200 exact-once normally; **500 under concurrency (F1, P2034 conflicts, no retry)**. Data never corrupted (claim-first tx, rollbacks verified by ledger invariants).
8. Payment status poll → 200. ✓
9. Order history / seller surfaces — not load-tested (admin/seller flows out of scope; verified functional by prior rounds).
10. Storefront tick / chat — local-only side effects verified (no external calls). Chat service unaffected (separate process).

Business correctness under concurrent rush (rule #8): oversell guard exact (60/60), zero duplicate idemKeys, ledger invariants green, wallet cache == truth — PASS in every integrity run (see runs/*/integrity.log).

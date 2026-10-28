# External Load-Test Kit (k6) — NOMOFEE Staging Capacity Ladder

Mission Phase 6. Runs **on a dedicated external generator** — never on the app/DB
host, never against production. Mirrors the in-sandbox harness data formats
(`scripts/readiness/load-scenarios.ts`): `[LT]` shoppers, `lt-*` idem keys, same
checkout/webhook shapes — one system, two drivers.

## Fail-closed target guard (built into every profile)

Every profile's `setup()` aborts the whole test unless ALL hold:

- `TARGET_CONFIRM` = `staging` | `dev-sandbox-local` (unset/`production`/typo → abort);
- `/api/health` answers and reports `deployment.nodeEnv ≠ production`;
- `deployment.dbFingerprint` matches `DB_FINGERPRINT` when pinned;
- staging runs REQUIRE `DB_FINGERPRINT` (16-hex from the staging app's health);
- staging runs REFUSE the public demo webhook secret (`WEBHOOK_SECRET` must be
  the staging value — never a production secret).

`http_req_failed` counts **raw infrastructure failures only** (409 semantic
rejections and 503 `CHECKOUT_BUSY` are expected, controlled responses — the
"zero raw 5xx" criterion).

## One-time setup (DB-side box with staging access)

```bash
# 1. staging knobs on the TARGET env (app) — payment-path stress needs them:
#    WEBHOOK_RATE_LIMIT_PER_MIN=6000  SIMULATE_RATE_LIMIT_PER_MIN=6000
#    (defaults 60/10 stay unchanged everywhere else; see production-topology.md §5)
# 2. fixtures (creates [LT] products with controlled stock):
RUN_ID=<runid> FLASH_STOCK=2000 bun scripts/loadtest-k6/fixtures-setup.ts
# 3. copy scripts/loadtest-k6/ (lib.js, profiles/, fixtures.json) to the generator
```

## The ladder (run in order; archive every `--summary-export` JSON)

| Step | Command (generator) | Purpose |
|---|---|---|
| A smoke | `k6 run -e TARGET_CONFIRM=staging -e BASE=… -e DB_FINGERPRINT=… -e WEBHOOK_SECRET=… -e RUN_ID=smoke-1 profiles/smoke.js` | fresh deployment sanity, 1 VU |
| B baseline | `… -e RUN_ID=base-1 -e RATE=2 -e DURATION=5m profiles/baseline.js` | normal-journey baseline |
| C ramp | `… -e RUN_ID=ramp-1 -e STAGE_SECONDS=120 profiles/ramp.js --summary-export=ramp.json` | first failing bracket (2→20 j/s) |
| D burst | `… -e RUN_ID=burst-1 -e BURST_PEAK=30 profiles/burst.js` | influencer crowd + flash-sale buyers |
| E stress | `… -e RUN_ID=stress-1 -e PEAK=8 profiles/checkout-stress.js` | checkout/payment stress, duplicates, same-seller contention |
| F recovery | `… -e RUN_ID=recov-1 profiles/recovery.js` | abandoned checkouts expire → sweep; late payments → 409 + obligations |
| G soak | `… -e RUN_ID=soak-1 -e RATE=<40% of C's passing peak> -e DURATION=30m profiles/soak.js` | sustained load, leak/backlog observation |

All profiles need `-e BASE=https://staging…` etc. (export them once).

## Post-run (DB-side box)

```bash
RUN_ID=<runid> bun scripts/loadtest-k6/verify-integrity.ts   # oversell, idem, T1, ledger, backlog
RUN_ID=<runid> bun scripts/loadtest-k6/fixtures-cleanup.ts   # [LT]-owned rows only
curl -s $BASE/api/cron/refund-reconcile -H "x-cron-secret: …" # post-F refund counts
```

Archive generator utilization evidence alongside (CPU/mem/network of the
generator during each run — a saturated generator makes the run inconclusive).

## DRAFT thresholds (for stakeholder review — NOT silently adopted)

- checkout create p95 ≤ 3 s / p99 ≤ 5 s at 100 concurrent buyers (C/E);
- browsing p95 ≤ 1.5 s (D);
- zero raw 5xx — every non-success semantic (409/503 + `Retry-After`);
- oversell 0; every idem key ≤ 1 order; every paid order exactly 1 T1;
- release of abandoned stock ≤ 5 min; soak without backlog growth/leak.

Virtual-user counts are NOT capacity: report journeys/s, checkout attempts/s,
completed paid orders/min, response-category mix, and the first failing bracket
with the derived headroom (see performance/staging-capacity-report.md).

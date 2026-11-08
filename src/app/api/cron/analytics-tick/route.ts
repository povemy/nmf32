import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { toJson, parseJson } from "@/lib/json";
import { assertCronAuth } from "@/lib/cron-auth";
import { analyticsQueueStats, flushAnalyticsQueue } from "@/lib/analytics/queue";
import type { AnalyticsTickData, AnalyticsTickStatusData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// ============================================================================
// ANALYTICS RETENTION TICK (cron) — Seller Insights maintenance.
// ----------------------------------------------------------------------------
// Durable-tick pattern shared with the F3 expiry sweep and refund-reconcile:
// this route is the worker TICK (the recurring invocation is
// mini-services/expiry-scheduler, port 3005); every run records its outcome in
// Setting `cron.analytics.last`.
//
//   • Deletes AnalyticsEvent rows older than `analytics.retention_days`
//     (Setting; default 180, clamped 7–730) — browsing/cart events ONLY.
//     Order / payment / refund / ledger records are NEVER touched: sales
//     history is authoritative and permanent.
//   • Bounded batches (1000 per tick) so a single tick can never hold a long
//     transaction; the scheduler's 30 s cadence drains any backlog.
//   • Flushes the in-memory event queue first (durability), then purges.
//   • cron-auth guarded (fail-closed in production, timing-safe secret).
// ============================================================================

const BATCH = 1000;
const LAST_RUN_KEY = "cron.analytics.last";
const RETENTION_SETTING_KEY = "analytics.retention_days";
const DEFAULT_RETENTION_DAYS = 180;

/** F-11 remediation: retention now reads Setting `analytics.retention_days`
 *  (the key the admin Settings page edits and the registry documents) with
 *  env `SI_RETENTION_DAYS` as the fallback when the row is absent/malformed
 *  — previously this read ONLY the env var, so the admin edited a dead key.
 *  Clamped 7–730 to match the registry field's min/max. */
async function retentionDays(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: RETENTION_SETTING_KEY } });
  const fromSetting = parseJson<number>(row?.valueJson, NaN);
  const raw = Number.isFinite(fromSetting)
    ? fromSetting
    : Number(process.env.SI_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  return Math.min(730, Math.max(7, Number.isFinite(raw) ? raw : DEFAULT_RETENTION_DAYS));
}

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const t0 = performance.now();

  // 1. Durability: drain the in-memory collection queue before purging.
  const flush = await flushAnalyticsQueue();

  // 2. Retention purge — browsing/cart events only, bounded batch.
  //    (Prisma deleteMany has no `take`: select a bounded id batch, then delete
  //    by id — same bounded-work guarantee as the other tick routes.)
  const days = await retentionDays();
  const cutoff = new Date(Date.now() - days * 86_400_000);
  let purged = 0;
  let rounds = 0;
  for (;;) {
    const stale = await db.analyticsEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    if (stale.length === 0) break;
    const res = await db.analyticsEvent.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    purged += res.count;
    rounds += 1;
    if (stale.length < BATCH || rounds >= 20) break; // ≤ 20k rows per tick
  }

  const remaining = await db.analyticsEvent.count();
  const oldest = await db.analyticsEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });

  const outcome: AnalyticsTickData = {
    ranAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    purged,
    flush,
    remaining,
    oldestEventAt: oldest?.createdAt.toISOString() ?? null,
    auth: auth.mode,
  };
  await db.setting.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, valueJson: toJson(outcome), description: "Last analytics retention tick outcome (Seller Insights)" },
    update: { valueJson: toJson(outcome) },
  });
  return ok(outcome);
});

// GET — operator observability without triggering a tick (cron-auth guarded).
export const GET = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const [lastSetting, total, byType, oldest] = await Promise.all([
    db.setting.findUnique({ where: { key: LAST_RUN_KEY } }),
    db.analyticsEvent.count(),
    db.analyticsEvent.groupBy({ by: ["eventType"], _count: { _all: true } }),
    db.analyticsEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const byTypeCounts: Record<string, number> = Object.fromEntries(
    byType.map((r): [string, number] => [r.eventType, r._count._all]),
  );
  const status: AnalyticsTickStatusData = {
    total,
    byType: byTypeCounts,
    oldestEventAt: oldest?.createdAt.toISOString() ?? null,
    retentionDays: await retentionDays(),
    queue: analyticsQueueStats(),
    lastRun: lastSetting ? (JSON.parse(lastSetting.valueJson) as AnalyticsTickData) : null,
    auth: auth.mode,
  };
  return ok(status);
});

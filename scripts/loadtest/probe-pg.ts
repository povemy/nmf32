/**
 * LT probe: verifies (a) pg_stat_activity readability, (b) pg_stat_statements
 * availability, (c) measures DB round-trip latency for SELECT 1.
 * Fails closed (exit 1) if env-guard conditions are not met later — this probe
 * is read-only and safe. Results are printed as KEY VALUE lines for the audit.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
async function main() {
  try {
    const a = await db.$queryRaw<Array<{ n: number; maxc: string }>>`
      SELECT count(*)::int AS n, (SELECT setting FROM pg_settings WHERE name='max_connections') AS maxc
      FROM pg_stat_activity`;
    console.log("PG_STAT_ACTIVITY_OK", JSON.stringify(a));
  } catch (e: any) {
    console.log("PG_STAT_ACTIVITY_DENIED", String(e?.message ?? e).slice(0, 140));
  }
  try {
    const s = await db.$queryRaw<Array<{ n: number; avg_ms: number }>>`
      SELECT count(*)::int AS n, coalesce(round(avg(mean_exec_time)::numeric,2),0) AS avg_ms FROM pg_stat_statements`;
    console.log("PG_STAT_STATEMENTS_OK", JSON.stringify(s));
  } catch (e: any) {
    console.log("PG_STAT_STATEMENTS_DENIED", String(e?.message ?? e).slice(0, 140));
  }
  const samples: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t = performance.now();
    await db.$queryRaw`SELECT 1`;
    samples.push(performance.now() - t);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sorted = [...samples].sort((x, y) => x - y);
  console.log("RTT_SELECT1_MS avg", avg.toFixed(1), "p50", sorted[7].toFixed(1), "max", sorted[14].toFixed(1));
}
main().finally(() => db.$disconnect());

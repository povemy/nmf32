/**
 * LT-3 pg-snap.ts — PostgreSQL snapshot for run archives (rule #6/#10).
 *
 * Captures, each block independently try/caught and reported honestly:
 *   - server version + time
 *   - pg_stat_activity: connection counts BY STATE (verifies readability;
 *     "unavailable" is recorded verbatim when the role lacks permission)
 *   - max_connections (pg_settings)
 *   - pg_stat_statements top-10 by total_exec_time (only if the extension is
 *     readable; query text truncated to 140 chars, parameters are normalised
 *     by PG itself — no secrets/PII beyond what PG already normalises)
 *
 * Usage: bun scripts/loadtest/pg-snap.ts [output.json]
 *   Writes JSON to output.json when given; always prints the same JSON to
 *   stdout. Exit code is ALWAYS 0 — unavailability is data, not an error.
 *
 * NOTE: uses the app's own Prisma datasource (SUPABASE_DATABASE_URL via the
 * Supavisor SESSION pooler) — the SAME path the app uses, so what we measure
 * includes the pooler hop the app actually experiences.
 */

import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

type Block<T> = { available: true; data: T } | { available: false; reason: string };

async function tryBlock<T>(fn: () => Promise<T>): Promise<Block<T>> {
  try {
    return { available: true, data: await fn() };
  } catch (e) {
    return { available: false, reason: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

async function main() {
  const db = new PrismaClient();
  const snap: Record<string, unknown> = { ts: new Date().toISOString(), source: "scripts/loadtest/pg-snap.ts (bun, Prisma raw queries)" };

  snap.server = await tryBlock(async () => {
    const v = await db.$queryRaw<Array<{ version: string; now: string; db: string }>>`
      SELECT version() AS version, now()::text AS now, current_database() AS db`;
    return v[0];
  });

  snap.activity = await tryBlock(async () => {
    const byState = await db.$queryRaw<Array<{ state: string | null; n: number }>>`
      SELECT state, count(*)::int AS n FROM pg_stat_activity GROUP BY state ORDER BY n DESC`;
    const total = byState.reduce((a, r) => a + Number(r.n), 0);
    return { totalConnections: total, byState };
  });

  snap.maxConnections = await tryBlock(async () => {
    const r = await db.$queryRaw<Array<{ setting: string }>>`
      SELECT setting FROM pg_settings WHERE name = 'max_connections'`;
    return r[0] ? Number(r[0].setting) : null;
  });

  snap.statStatementsTop10 = await tryBlock(async () => {
    const rows = await db.$queryRaw<Array<{ queryid: string; calls: number; total_ms: number; mean_ms: number; rows: number; query: string }>>`
      SELECT queryid::text AS queryid,
             calls::bigint AS calls,
             round(total_exec_time::numeric, 1) AS total_ms,
             round(mean_exec_time::numeric, 2) AS mean_ms,
             rows::bigint AS rows,
             left(query, 140) AS query
      FROM pg_stat_statements
      ORDER BY total_exec_time DESC
      LIMIT 10`;
    return rows;
  });

  await db.$disconnect().catch(() => undefined);

  const text = JSON.stringify(snap, null, 2);
  const outPath = process.argv[2];
  if (outPath) {
    writeFileSync(outPath, text);
    console.log(`[pg-snap] wrote ${outPath}`);
  }
  console.log(text);
}

main().catch((e) => {
  // Total failure (e.g. DB unreachable) — still exit 0 with an honest record.
  const text = JSON.stringify({ ts: new Date().toISOString(), fatal: String(e instanceof Error ? e.message : e).slice(0, 200) }, null, 2);
  const outPath = process.argv[2];
  if (outPath) writeFileSync(outPath, text);
  console.log(text);
});

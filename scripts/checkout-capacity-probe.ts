// ============================================================================
// capacity-probe.ts — Phase 2 of the checkout-capacity review (read-only).
//
// Documents, with MEASURED values, the connection budget of this deployment:
//   - Prisma client version + datasource facts (from package.json/schema/env)
//   - PostgreSQL server version, max_connections, reserved connections
//   - current pg_stat_activity usage (who is connected, in what state)
//   - Supavisor pooler facts via SHOW POOLS / SHOW CLIENTS / SHOW SERVERS
//     (supported by Supavisor; recorded as unavailable if they error)
//
// Uses ONE dedicated connection, sequentially — safe next to the app's pool
// (10) under the Supavisor session ceiling (15, measured EMAXCONNSESSION).
// Output: performance/checkout-capacity/probes/<ts>-capacity.json
// ============================================================================
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "fs";

const OUT_DIR = "performance/checkout-capacity/probes";
mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const probe = new PrismaClient({ log: [] });
  const facts: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    app: {
      framework: "Next.js 16 (App Router, dev mode via Turbopack)",
      prismaClient: "6.11.x (package.json ^6.11.1)",
      poolLimit: "connection_limit=10, connect_timeout=10 (datasource URL, .env)",
      poolerMode: "Supavisor SESSION pooling (port 5432, sslmode=require)",
      instances: "1 (sandbox adaptation, worklog.md)",
    },
  };

  try {
    const ver = await probe.$queryRawUnsafe<{ version: string }[]>("SELECT version()");
    facts.pgVersion = ver[0]?.version ?? null;
  } catch (e) {
    facts.pgVersion = `ERROR: ${String(e).slice(0, 200)}`;
  }

  try {
    const settings = await probe.$queryRawUnsafe<{ name: string; setting: string; unit: string | null }[]>(
      `SELECT name, setting, unit FROM pg_settings
       WHERE name IN ('max_connections','superuser_reserved_connections','reserved_connections','shared_buffers','work_mem')`
    );
    facts.pgSettings = settings;
  } catch (e) {
    facts.pgSettings = `ERROR: ${String(e).slice(0, 200)}`;
  }

  try {
    const byState = await probe.$queryRawUnsafe<{ state: string | null; n: number }[]>(
      `SELECT state, count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
       GROUP BY state ORDER BY n DESC`
    );
    const total = await probe.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`
    );
    const byApp = await probe.$queryRawUnsafe<{ application_name: string; usename: string; n: number }[]>(
      `SELECT application_name, usename, count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
       GROUP BY application_name, usename ORDER BY n DESC`
    );
    facts.pgStatActivity = { byState, total: total[0]?.n, byApp };
  } catch (e) {
    facts.pgStatActivity = `ERROR: ${String(e).slice(0, 200)}`;
  }

  // Supavisor exposes pgbouncer-style SHOW commands over the pooler port.
  for (const cmd of ["SHOW POOLS", "SHOW CLIENTS", "SHOW SERVERS"]) {
    try {
      const rows = await probe.$queryRawUnsafe(cmd);
      facts[cmd.replace(" ", "_")] = rows;
    } catch (e) {
      facts[cmd.replace(" ", "_")] = `UNAVAILABLE: ${String(e).slice(0, 200)}`;
    }
  }

  const file = `${OUT_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}-capacity.json`;
  writeFileSync(file, JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts, null, 2));
  console.log(`\n[capacity-probe] written: ${file}`);
  await probe.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// RX-PRV Phase 3 — Supavisor TRANSACTION-mode pooler compatibility probe.
// ISOLATED: throwaway PrismaClient pointed at :6543 (pgbouncer=true). The app
// .env/config is NOT modified. Tests the exact patterns the app uses:
//   (1) plain query   (2) interactive READ COMMITTED tx   (3) raw SAVEPOINT
//   inside a tx (FIN-1 ledger dedup pattern)   (4) Serializable claim race
//   (webhook pattern)   (5) repeated queries (prepared-statement path)
// @ts-nocheck
import { PrismaClient, Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";

const url5432 = readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
if (!url5432) throw new Error("no url");
const u = new URL(url5432);
u.port = "6543";
u.searchParams.set("pgbouncer", "true");
u.searchParams.set("connection_limit", "5");
u.searchParams.set("pool_timeout", "10");
const txUrl = u.toString();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const redact = (e: any) => String(e?.message ?? e).replace(/postgresql:\/\/[^ ]*/g, "<URL>").slice(0, 160);

const db = new PrismaClient({ datasourceUrl: txUrl });
console.log("probe target: pooler :6543 (transaction mode), pgbouncer=true, connection_limit=5");

// (1) simple query
try {
  const rows = await db.$queryRawUnsafe<number[]>(`SELECT 1 AS v`);
  check("T1: plain query over transaction pooler", rows[0]?.v === 1);
} catch (e) { check("T1: plain query", false, redact(e)); }

// (2) interactive READ COMMITTED tx (checkout pattern shape)
try {
  const r = await db.$transaction(async (tx) => {
    const a = await tx.setting.count();
    const b = await tx.store.count();
    return a + b;
  });
  check("T2: interactive READ COMMITTED tx", typeof r === "number");
} catch (e) { check("T2: interactive tx", false, redact(e)); }

// (3) SAVEPOINT inside tx (FIN-1 postTransaction dedup pattern)
try {
  const r = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SAVEPOINT fin1_probe_sp`);
    await tx.$executeRawUnsafe(`SELECT 1`); // statement after savepoint
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT fin1_probe_sp`);
    return true;
  });
  check("T3: SAVEPOINT/ROLLBACK TO inside tx", r === true);
} catch (e) { check("T3: SAVEPOINT", false, redact(e)); }

// (4) Serializable claim race ×6 (webhook claim-first pattern shape)
try {
  // create a probe row
  const probe = await db.setting.create({ data: { key: `lt-txpool-probe-${Date.now().toString(36)}`, valueJson: '"0"' } });
  const claim = () => db.$transaction(async (tx) => {
    const c = await tx.setting.updateMany({
      where: { id: probe.id, valueJson: { not: '"claimed"' } },
      data: { valueJson: '"claimed"' },
    });
    if (c.count === 0) return "duplicate";
    return "claimed";
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 8000 });
  const rs = await Promise.all(Array.from({ length: 6 }, () => claim().catch((e) => `ERR:${redact(e).slice(0, 60)}`)));
  const winners = rs.filter((r) => r === "claimed").length;
  const errors = rs.filter((r) => String(r).startsWith("ERR")).length;
  console.log("   claim outcomes:", JSON.stringify(rs));
  check("T4: Serializable claim → exactly one winner", winners === 1, `winners=${winners} errors=${errors}`);
  // informational: whether losers error or degrade to duplicate
  console.log(`   FINDING T4-MEASURED: losers: ${rs.filter((r) => r === "duplicate").length} duplicate / ${errors} error`);
  await db.setting.delete({ where: { id: probe.id } });
} catch (e) { check("T4: serializable claim race", false, redact(e)); }

// (5) repeated queries (prepared-statement reuse path)
try {
  let okCount = 0;
  for (let i = 0; i < 12; i++) {
    await db.$queryRawUnsafe(`SELECT count(*) FROM "Store"`);
    okCount++;
  }
  check("T5: 12 repeated raw queries (prepared statement path)", okCount === 12);
} catch (e) { check("T5: repeated queries", false, redact(e)); }

await db.$disconnect();
console.log(failures === 0 ? "\nTXPOOL PROBE: ALL PASS" : `\nTXPOOL PROBE: ${failures} FAILURES`);
process.exit(failures);

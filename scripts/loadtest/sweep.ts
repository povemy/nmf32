// ============================================================================
// loadtest/sweep.ts — checkout-capacity review Phase 5 (controlled concurrency
// levels + deliberate-overload check), observation of the EXISTING F2 gate.
//
// Usage:
//   bun scripts/loadtest/sweep.ts --label baseline
//   bun scripts/loadtest/sweep.ts --label after-c1 --levels 12,100,120
//
// Per level N: pre-login N buyers (unmeasured) → N simultaneous create
// requests → client-side latency classes + integrity; concurrently a poller
// samples pg_stat_activity (500 ms) for real pool occupancy; afterwards the
// server's [CHECKOUT_TIMING] lines (CHECKOUT_TIMING=1) are parsed from
// dev.log into per-phase latency anatomy for the SAME requests.
//
// Classification follows the review contract: deliberate overload responses
// (503 CHECKOUT_BUSY) are reported SEPARATELY from genuine infrastructure
// failures (any other 5xx / network error). Business 4xx stays its own class.
//
// Guardrails: [LT]-owned data only; stock is huge for the storm variant so no
// oversell is engineered; no OOM is attempted; ledger verified once per run.
// Evidence: performance/checkout-capacity/runs/<ts>-sweep-<label>.json
// ============================================================================
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { execSync } from "child_process";
import { cpus, loadavg } from "os";
import { db } from "../../src/lib/db";
import { BASE, LT_PASSWORD, loginShopper, createCheckout, classify, summarize, pct } from "./util";

type Args = { label: string; levels: number[]; skipLedger: boolean };
const args = process.argv.slice(2);
const getArg = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const ARGS: Args = {
  label: getArg("--label", "adhoc"),
  levels: getArg("--levels", "1,12,25,50,100,120").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0),
  skipLedger: args.includes("--skip-ledger"),
};
const RUN_ID = `lt-sweep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const OUT_DIR = "performance/checkout-capacity/runs";
mkdirSync(OUT_DIR, { recursive: true });

const DEV_LOG = "/home/z/my-project/dev.log";
function devLogSize(): number {
  try { return statSync(DEV_LOG).size; } catch { return 0; }
}
function readDevLogFrom(from: number): string {
  try {
    const size = statSync(DEV_LOG).size;
    if (size <= from) return "";
    const fd = openSync(DEV_LOG, "r");
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, size - from, from);
    closeSync(fd);
    return buf.toString("utf8");
  } catch { return ""; }
}

type TimingRecord = Record<string, number | string>;
function parseTimingLines(chunk: string, prefix: string): TimingRecord[] {
  const out: TimingRecord[] = [];
  for (const line of chunk.split("\n")) {
    const i = line.indexOf("[CHECKOUT_TIMING] ");
    if (i < 0) continue;
    try {
      const rec = JSON.parse(line.slice(i + 18)) as TimingRecord;
      if (typeof rec.idemKey === "string" && rec.idemKey.startsWith(prefix)) out.push(rec);
    } catch { /* partial line — skip */ }
  }
  return out;
}

function dist(vals: number[]): { p50: number; p95: number; max: number; avg: number } {
  if (vals.length === 0) return { p50: 0, p95: 0, max: 0, avg: 0 };
  const s = [...vals].sort((a, b) => a - b);
  return {
    p50: pct(s, 50),
    p95: pct(s, 95),
    max: Math.round(s[s.length - 1]),
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

// --- server process CPU/RSS via /proc (best-effort) -------------------------
function nextServerPid(): number | null {
  try {
    const out = execSync("pgrep -f next-server | head -1").toString().trim();
    return out ? Number(out) : null;
  } catch { return null; }
}
function procCpuAndRss(pid: number | null): { cpuJiffies: number; rssKb: number } | null {
  if (!pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
    const utime = Number(stat[13]), stime = Number(stat[14]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = Number((status.match(/VmRSS:\s+(\d+) kB/) ?? [])[1] ?? 0);
    return { cpuJiffies: utime + stime, rssKb: rss };
  } catch { return null; }
}

// --- pg pool poller (own single-connection client; runs DURING storms) ------
type PoolSample = { t: number; total: number; active: number; idleInTx: number; idle: number; other: number };
async function pollPoolDuring<T>(fn: () => Promise<T>, intervalMs = 500): Promise<{ result: T; samples: PoolSample[] }> {
  const probe = new PrismaClient({ log: [], datasources: { db: { url: process.env.SUPABASE_DATABASE_URL } } });
  const samples: PoolSample[] = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const rows = await probe.$queryRawUnsafe<{ state: string | null; n: number }[]>(
          `SELECT state, count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
           GROUP BY state`
        );
        const totalRows = await probe.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`
        );
        const get = (s: string | null) => rows.find((r) => r.state === s)?.n ?? 0;
        samples.push({
          t: Date.now(),
          total: totalRows[0]?.n ?? 0,
          active: get("active"),
          idleInTx: get("idle in transaction"),
          idle: get("idle"),
          other: rows.filter((r) => r.state !== "active" && r.state !== "idle in transaction" && r.state !== "idle").reduce((a, b) => a + b.n, 0),
        });
      } catch { /* poller must never disturb the run */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    await probe.$disconnect().catch(() => {});
  })();
  // let the poller connect BEFORE the storm starts
  await new Promise((r) => setTimeout(r, 700));
  const result = await fn();
  stop = true;
  await loop;
  return { result, samples };
}

async function buyerEmails(n: number): Promise<string[]> {
  const rows = await db.shopperUser.findMany({
    where: { email: { startsWith: "lt-buyer-", endsWith: "@lt.test" } },
    select: { email: true },
    orderBy: { email: "asc" },
    take: n,
  });
  if (rows.length < n) throw new Error(`need ${n} [LT] buyers, found ${rows.length} — run scripts/loadtest/seed.ts first`);
  return rows.map((r) => r.email);
}

async function variantId(slug: string): Promise<string> {
  const v = await db.productVariant.findFirst({
    where: { product: { slug, store: { slug: "lt-main-store" } } },
    select: { id: true },
  });
  if (!v) throw new Error(`missing [LT] variant ${slug} — run seed first`);
  return v.id;
}

type LevelResult = Record<string, unknown>;

async function runLevel(buyers: number, storm: string, emails: string[], cookies: string[], ordersBefore: number): Promise<LevelResult> {
  const prefix = `${RUN_ID}-n${buyers}-`;
  const logStart = devLogSize();
  const pid = nextServerPid();
  const cpu0 = procCpuAndRss(pid);

  const { result, samples } = await pollPoolDuring(async () => {
    const t0 = performance.now();
    const results = await Promise.all(
      Array.from({ length: buyers }, (_, i) =>
        createCheckout({
          cookie: cookies[i % cookies.length],
          variantId: storm,
          qty: 1,
          idemKey: `${prefix}${i}`,
          email: emails[i % emails.length],
        })
      )
    );
    return { results, wallSec: (performance.now() - t0) / 1000 };
  });

  const { results, wallSec } = result;
  const classes = { created: 0, business: 0, overload: 0, infra: 0, network: 0 };
  const codes: Record<string, number> = {};
  for (const r of results) {
    const code = r.body.error?.code;
    if (r.status === 201 || r.status === 200) classes.created++;
    else if (r.status === 503 && code === "CHECKOUT_BUSY") classes.overload++;
    else if (r.status >= 500 || r.status === 0) classes.infra++;
    else if (r.status >= 400) classes.business++;
    const k = code ?? `${r.status}`;
    codes[k] = (codes[k] ?? 0) + 1;
  }

  // integrity — [LT] storm variant + store orders
  const stockAfter = (await db.productVariant.findUnique({ where: { id: storm }, select: { stock: true } }))!.stock;
  const newOrders = (await db.order.count({ where: { store: { slug: "lt-main-store" }, createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } } })) - ordersBefore;
  const dupGroups = (await db.paymentGroup.groupBy({
    by: ["idemKey"],
    where: { idemKey: { startsWith: prefix } },
    _count: { _all: true },
  })).filter((g) => g._count._all > 1).length;

  // server-side latency anatomy for THIS level's requests
  const recs = parseTimingLines(readDevLogFrom(logStart), prefix);
  const field = (f: string) => recs.map((r) => Number(r[f] ?? 0)).filter((v) => Number.isFinite(v));
  const anatomy: Record<string, unknown> = {
    records: recs.length,
    totalMs: dist(field("totalMs")),
    gateWaitMs: dist(field("gateWaitMs")),
    authMs: dist(field("authMs")),
    idemMs: dist(field("idemMs")),
    bodyMs: dist(field("bodyMs")),
    pricingMs: dist(field("pricingMs")),
    voucherMs: dist(field("voucherMs")),
    commissionMs: dist(field("commissionMs")),
    cartMs: dist(field("cartMs")),
    counterMs: dist(field("counterMs")),
    txAcquireMs: dist(field("txAcquireMs")),
    txExecMs: dist(field("txExecMs")),
    postTxMs: dist(field("postTxMs")),
    txStatementsAvg: recs.length ? Math.round((field("txStatements").reduce((a, b) => a + b, 0) / recs.length) * 10) / 10 : 0,
    loopLagMaxMs: Math.max(0, ...field("loopLagMs")),
    gateQueuedMax: Math.max(0, ...field("gateQueued")),
    gateActiveMax: Math.max(0, ...field("gateActive")),
  };

  const cpu1 = procCpuAndRss(pid);
  const serverCpuPct =
    cpu0 && cpu1 ? Math.round(((cpu1.cpuJiffies - cpu0.cpuJiffies) / (wallSec * 1000)) * 1000) / 10 : null; // jiffies→%: delta/(wall_s*100)*100
  const poolByStateMax = {
    total: Math.max(0, ...samples.map((s) => s.total)),
    active: Math.max(0, ...samples.map((s) => s.active)),
    idleInTx: Math.max(0, ...samples.map((s) => s.idleInTx)),
    idle: Math.max(0, ...samples.map((s) => s.idle)),
  };

  return {
    buyers, wallSec: Math.round(wallSec * 100) / 100,
    create: { ...summarize(results), classes, codes, attemptsPerSec: Math.round((buyers / wallSec) * 100) / 100, ordersPerMin: Math.round((classes.created / wallSec) * 60) },
    integrity: { newOrders, createdCount: classes.created, ordersMatchCreated: newOrders === classes.created, duplicateIdempotencyGroups: dupGroups, stockAfter },
    anatomy,
    pool: { samples: samples.length, byStateMax: poolByStateMax, note: "pg_stat_activity via dedicated 1-connection client; 500 ms interval; includes Supabase internal backends" },
    server: { cpuPctDuringLevel: serverCpuPct, rssKbEnd: cpu1?.rssKb ?? null, note: "combined-environment dev sandbox; CPU from /proc jiffies delta (best-effort)" },
  };
}

async function main() {
  const levels = ARGS.levels;
  const maxBuyers = Math.max(...levels);
  const emails = await buyerEmails(maxBuyers);
  console.log(`[sweep ${ARGS.label}] pre-login ${emails.length} buyers (conc 10, unmeasured)…`);
  const cookies: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < emails.length) {
      const i = next++;
      cookies[i] = await loginShopper(emails[i]);
    }
  }));

  const storm = await variantId("lt-perf-storm-item");
  const stockBefore = (await db.productVariant.findUnique({ where: { id: storm }, select: { stock: true } }))!.stock;
  let ordersBefore = await db.order.count({ where: { store: { slug: "lt-main-store" }, createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } } });

  const levelResults: LevelResult[] = [];
  let replayProbe: Record<string, unknown> | null = null;
  let replayKey: string | null = null;

  for (const n of levels) {
    console.log(`\n[sweep] level n=${n} …`);
    const res = await runLevel(n, storm, emails, cookies, ordersBefore);
    ordersBefore = (res.integrity as { newOrders: number }).newOrders + ordersBefore;
    levelResults.push({ level: `n${n}`, ...res });
    const created = res.create as { classes: { created: number; overload: number; infra: number; business: number } };
    console.log(`  created=${created.classes.created} overload=${created.classes.overload} infra=${created.classes.infra} business=${created.classes.business}`);
    if (created.classes.created > 0 && !replayKey) {
      replayKey = `${RUN_ID}-n${n}-0`; // first created checkout of this run
    }
    // integrity after each level
    if (!(res.integrity as { ordersMatchCreated: boolean }).ordersMatchCreated) {
      console.log(`  WARNING: orders mismatch at n=${n}`);
    }
  }

  // Replay-bypass probe: re-POST a created checkout's key DURING fresh load.
  if (replayKey) {
    console.log(`\n[sweep] replay-bypass probe (key ${replayKey}) under fresh 24-load…`);
    const emails24 = emails.slice(0, 24);
    const t0 = performance.now();
    const [replay] = await Promise.all([
      createCheckout({
        cookie: cookies[0],
        variantId: storm,
        qty: 1,
        idemKey: replayKey, // SAME key → idempotent replay path (gate bypass)
        email: emails[0],
      }),
      ...emails24.map((email, i) =>
        createCheckout({ cookie: cookies[i], variantId: storm, qty: 1, idemKey: `${RUN_ID}-replaybg-${i}`, email })
      ),
    ]);
    const replayMs = Math.round(performance.now() - t0);
    replayProbe = {
      replayStatus: replay.status,
      replayMs,
      duplicateFlag: (replay.body as { data?: { duplicate?: boolean } }).data?.duplicate ?? null,
      backgroundLoad: 24,
      note: "replay must return 200 duplicate=true WITHOUT admission-gate wait while new load queues",
    };
    console.log(`  replay: ${replay.status} in ${replayMs} ms (duplicate=${replayProbe.duplicateFlag})`);
  }

  // Ledger integrity (whole-DB invariant runner; read-only)
  let ledger: Record<string, unknown> = { skipped: true };
  if (!ARGS.skipLedger) {
    const proc = Bun.spawnSync(["bun", "scripts/verify-ledger.ts"], { cwd: process.cwd() + "/", stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString() + proc.stderr.toString();
    ledger = { exitCode: proc.exitCode, failLines: out.split("\n").filter((l) => l.includes("FAIL")).slice(0, 5), pass: proc.exitCode === 0 && !out.includes("FAIL") };
  }

  const evidence = {
    runId: RUN_ID, label: ARGS.label, base: BASE, capturedAt: new Date().toISOString(),
    levels: ARGS.levels,
    stormStockBefore: stockBefore,
    results: levelResults,
    replayBypass: replayProbe,
    ledger,
    env: {
      platform: `${process.platform}/${process.arch}`,
      cpus: cpus().length,
      loadavg: loadavg().map((l) => Math.round(l * 100) / 100),
      generatorRssKb: process.memoryUsage().rss,
      note: "dev-mode combined-environment Measured (app + generator share this host); do not extrapolate to production",
    },
  };

  const file = `${OUT_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}-sweep-${ARGS.label}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`\n[sweep] evidence: ${file}`);
  console.log(JSON.stringify(levelResults.map((r) => ({
    level: r.level,
    p50: (r.create as { p50: number }).p50,
    p95: (r.create as { p95: number }).p95,
    p99: (r.create as { p99: number }).p99,
    wall: r.wallSec,
    created: (r.create as { classes: { created: number } }).classes.created,
    overload: (r.create as { classes: { overload: number } }).classes.overload,
    infra: (r.create as { classes: { infra: number } }).classes.infra,
    ordersPerMin: (r.create as { ordersPerMin: number }).ordersPerMin,
    gateWaitP50: (r.anatomy as { gateWaitMs: { p50: number } }).gateWaitMs.p50,
    txAcquireP50: (r.anatomy as { txAcquireMs: { p50: number } }).txAcquireMs.p50,
    txExecP50: (r.anatomy as { txExecMs: { p50: number } }).txExecMs.p50,
    poolTotalMax: (r.pool as { byStateMax: { total: number } }).byStateMax.total,
  })), null, 1));
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

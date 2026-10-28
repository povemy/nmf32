/**
 * LT-3 sample.ts — tiny resource sampler for run archives (rule #1/#6/#10).
 *
 * Every `--interval-ms` (default 1000) appends ONE CSV row:
 *   ts,epochMs,appRSSkb,appFD,appCPUpct,caddyFD,caddyCPUpct,
 *   hostMemAvailableMb,load1,genRSSkb,genCPUpct,k6Alive
 *
 * Sources (all /proc, no external commands, negligible overhead):
 *   appRSSkb   /proc/<appPid>/status  VmRSS
 *   appFD      count of /proc/<appPid>/fd            (-1 = unreadable, e.g. root-owned)
 *   appCPUpct  delta(utime+stime) / wall / CLK_TCK × 100, total across cores
 *   caddyFD / caddyCPUpct  same, for the caddy process (independent — rule #6)
 *   hostMemAvailableMb  /proc/meminfo MemAvailable / 1024
 *   load1     /proc/loadavg first field
 *   gen*      the LOAD GENERATOR process: k6 (pid read from --k6-pidfile when
 *             present) else this sampler itself (documented in every report)
 *   k6Alive   1 when /proc/<k6pid> exists
 *
 * Lifecycle: the coordinator spawns it and stops it with SIGTERM; a
 * --max-seconds belt-and-braces cap auto-stops it if the coordinator dies.
 * Usage:
 *   bun scripts/loadtest/sample.ts --pid <appPid> --caddy-pid <caddyPid> \
 *     --out <dir>/samples.csv [--interval-ms 1000] [--k6-pidfile <path>] \
 *     [--max-seconds 3600]
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";

const CLK_TCK = 100; // USER_HZ on Linux (standard)

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = process.argv[i + 1] ?? "";
  }
  return out;
}
const A = args();
const APP_PID = Number(A.pid || 0);
const CADDY_PID = Number(A["caddy-pid"] || 0);
const OUT = A.out || "/tmp/lt-samples.csv";
const INTERVAL_MS = Math.max(200, Number(A["interval-ms"] || 1000));
const PIDFILE = A["k6-pidfile"] || "";
const MAX_SECONDS = Number(A["max-seconds"] || 0);

type CpuAcc = { ticks: number; wallMs: number };
const cpuAcc = new Map<number, CpuAcc>();

function readStatus(pid: number): { rssKb: number } | null {
  if (!pid) return null;
  try {
    const s = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = s.match(/VmRSS:\s+(\d+) kB/);
    return { rssKb: m ? Number(m[1]) : 0 };
  } catch {
    return null;
  }
}

function readFdCount(pid: number): number {
  if (!pid) return -1;
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return -1; // unreadable (permissions) — recorded honestly
  }
}

function readCpuPct(pid: number, nowMs: number): number {
  if (!pid) return -1;
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const idx = s.lastIndexOf(")");
    const parts = s.slice(idx + 2).split(" ");
    const utime = Number(parts[11]); // field 14 overall
    const stime = Number(parts[12]); // field 15 overall
    const ticks = utime + stime;
    const prev = cpuAcc.get(pid);
    cpuAcc.set(pid, { ticks, wallMs: nowMs });
    if (!prev) return 0; // first sample: no delta yet
    const dTicks = ticks - prev.ticks;
    const dWallS = (nowMs - prev.wallMs) / 1000;
    if (dWallS <= 0) return prev ? 0 : 0;
    return Math.round(((dTicks / CLK_TCK) / dWallS) * 1000) / 10;
  } catch {
    return -1;
  }
}

function readMemAvailableMb(): number {
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : -1;
  } catch {
    return -1;
  }
}

function readLoad1(): number {
  try {
    return Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) || 0;
  } catch {
    return -1;
  }
}

function k6Pid(): number {
  if (!PIDFILE) return 0;
  try {
    const t = readFileSync(PIDFILE, "utf8").trim();
    const p = Number(t);
    return p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

const exists = (pid: number) => pid > 0 && existsSync(`/proc/${pid}`);

async function main() {
  const sink = Bun.file(OUT).writer();
  await sink.write("ts,epochMs,appRSSkb,appFD,appCPUpct,caddyFD,caddyCPUpct,hostMemAvailableMb,load1,genRSSkb,genCPUpct,k6Alive\n");
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const startedAt = Date.now();
  let rows = 0;

  while (!stopped) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const app = readStatus(APP_PID);
    const k6 = k6Pid();
    const genIsK6 = exists(k6);
    const genPid = genIsK6 ? k6 : process.pid;
    const gen = readStatus(genPid);

    const row = [
      nowIso,
      now,
      app ? app.rssKb : -1,
      readFdCount(APP_PID),
      readCpuPct(APP_PID, now),
      readFdCount(CADDY_PID),
      readCpuPct(CADDY_PID, now),
      readMemAvailableMb(),
      readLoad1(),
      gen ? gen.rssKb : -1,
      readCpuPct(genPid, now),
      genIsK6 ? 1 : 0,
    ].join(",");

    await sink.write(row + "\n");
    await sink.flush();
    rows++;

    if (MAX_SECONDS > 0 && now - startedAt > MAX_SECONDS * 1000) {
      console.log(`[sample] max-seconds cap reached (${rows} rows) — stopping`);
      break;
    }
    await Bun.sleep(INTERVAL_MS);
  }

  await sink.end();
  console.log(`[sample] stopped — ${rows} rows in ${OUT}`);
}

main();

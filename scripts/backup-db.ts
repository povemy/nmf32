// ============================================================================
// BACKUP-DB — SQLite database backup (P1 ops round)
// ============================================================================
// Usage:  bun scripts/backup-db.ts [label]      (label default: "manual")
// Output: db/backup/custom.db.<label>-<UTC timestamp>
//
// CORRECTNESS NOTE — live-copy consistency:
//   A plain file copy (fs.copyFileSync) of a LIVE SQLite database can catch it
//   MID-WRITE: the copied file may contain a partially applied transaction or
//   miss content still sitting in a journal/WAL sidecar file. The safe
//   procedure is either (a) stop the app first, or (b) use SQLite's backup API
//   which takes a consistent snapshot (also handles WAL/journal sidecars).
//
//   This script therefore tries the `sqlite3` CLI's `.backup` command FIRST
//   (that is SQLite's backup API). If the sqlite3 CLI is not available on the
//   host (no guarantee in this sandbox), it falls back to fs.copyFileSync and
//   prints a WARNING that the app should be stopped for a fully consistent
//   copy. The fallback is also what you get when the DB file is not currently
//   being written (e.g. dev server stopped) — in that case the copy is exact.
//
// Behaviour:
//   - refuses to overwrite an existing target (exit 1)
//   - prints the resulting backup path on success (exit 0)
//   - exit 1 on any failure
//
// Restore: stop the app, move the current db/custom.db aside, copy the backup
//   over it, restart, then verify with `bun scripts/fin-reconcile.ts`.
//   See docs/ops/production-readiness.md ("Backups") for the full drill.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// <project>/scripts/backup-db.ts -> <project>
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DB = path.join(PROJECT_ROOT, "db", "custom.db");
const BACKUP_DIR = path.join(PROJECT_ROOT, "db", "backup");

function fail(msg: string): never {
  console.error(`[backup-db] ERROR: ${msg}`);
  process.exit(1);
}

// --- inputs -----------------------------------------------------------------
const rawLabel = process.argv[2]?.trim() || "manual";
// Keep labels filesystem-safe (letters, digits, dot, dash, underscore).
const label = rawLabel.replace(/[^A-Za-z0-9._-]+/g, "-");
if (!label) fail("label resolved to an empty string");

const utcStamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z"); // e.g. 20261018T131530Z
const target = path.join(BACKUP_DIR, `custom.db.${label}-${utcStamp}`);

// --- preconditions ----------------------------------------------------------
if (!fs.existsSync(SOURCE_DB)) fail(`source database not found: ${SOURCE_DB}`);
fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (fs.existsSync(target)) {
  fail(`refusing to overwrite existing backup target: ${target}`);
}

// --- strategy 1: sqlite3 CLI .backup (SQLite backup API — consistent) -------
let usedSqlite3 = false;
try {
  const proc = spawnSync("sqlite3", [
    SOURCE_DB,
    `.backup '${target}'`,
  ]);
  const ok =
    !proc.error &&
    proc.status === 0 &&
    fs.existsSync(target) &&
    fs.statSync(target).size > 0;
  if (ok) {
    usedSqlite3 = true;
  } else if (fs.existsSync(target)) {
    // A partial/garbage target from the failed CLI attempt — remove it so the
    // fallback below starts clean (we created it; this is not an overwrite).
    fs.rmSync(target);
  }
} catch {
  // sqlite3 binary not found / not executable — fall through to file copy.
  if (fs.existsSync(target)) fs.rmSync(target);
}

// --- strategy 2: plain file copy (fallback) ----------------------------------
if (!usedSqlite3) {
  console.warn(
    "[backup-db] WARNING: sqlite3 CLI unavailable or failed — using a plain " +
      "file copy. A copy of a LIVE database can be inconsistent (caught " +
      "mid-write, journal/WAL sidecars not captured). Stop the app first for " +
      "a fully consistent copy."
  );
  try {
    fs.copyFileSync(SOURCE_DB, target);
  } catch (e) {
    if (fs.existsSync(target)) fs.rmSync(target);
    fail(`copyFileSync failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
    fail(`fallback copy produced an empty or missing file: ${target}`);
  }
}

const sizeBytes = fs.statSync(target).size;
console.log(
  `[backup-db] OK (${usedSqlite3 ? "sqlite3 .backup API" : "plain copy, see WARNING above"})`
);
console.log(`[backup-db] source : ${SOURCE_DB}`);
console.log(`[backup-db] backup : ${target}`);
console.log(`[backup-db] size   : ${sizeBytes} bytes`);

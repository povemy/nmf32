/**
 * ensure-env.ts — boot-time credential guard for NOMOFEE.
 *
 * Why this exists: this sandbox's harness resets `.env` to a stale 50-byte
 * SQLite-only file on session restarts, which removes SUPABASE_DATABASE_URL
 * and crashes Prisma (P1012). This script runs BEFORE the dev server boots
 * (wired into the `dev`, `db:push`, `db:generate`, `db:migrate`, `db:reset`
 * npm scripts) and restores `.env` from a durable vault if the required keys
 * are missing.
 *
 * Vault priority:
 *   1. upload/.env.vault      — ossfs mount, survives sandbox/resets/rsync
 *   2. /tmp/nomofee-env/.env  — tmp snapshot
 *   3. /tmp/my-project/.env   — legacy tmp snapshot
 *
 * Security: NEVER prints secret values — only key names, paths, byte counts.
 * A matching vault is copied verbatim to `.env` (no value parsing).
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(PROJECT_ROOT, ".env");

const VAULT_SOURCES = [
  join(PROJECT_ROOT, "upload", ".env.vault"),
  "/tmp/nomofee-env/.env",
  "/tmp/my-project/.env",
];

const SECONDARY_SNAPSHOTS = ["/tmp/nomofee-env/.env", "/tmp/my-project/.env"];

const REQUIRED_KEYS = [
  "SUPABASE_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function parseKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function hasAllKeys(text: string): boolean {
  const keys = parseKeys(text);
  return REQUIRED_KEYS.every((k) => keys.has(k));
}

function log(msg: string): void {
  // Prefix makes the line easy to spot in dev.log.
  console.log(`[ensure-env] ${msg}`);
}

function main(): number {
  if (!existsSync(ENV_PATH)) {
    log(".env missing entirely");
  } else {
    const current = readFileSync(ENV_PATH, "utf8");
    if (hasAllKeys(current)) {
      log(`.env OK — keys present: ${[...parseKeys(current)].sort().join(", ")}`);
      return 0;
    }
    const present = [...parseKeys(current)].filter((k) => (REQUIRED_KEYS as readonly string[]).includes(k));
    log(`.env broken (stale reset detected) — required keys found: ${present.length}/${REQUIRED_KEYS.length}`);
  }

  for (const vault of VAULT_SOURCES) {
    if (!existsSync(vault)) continue;
    let text: string;
    try {
      text = readFileSync(vault, "utf8");
    } catch {
      continue;
    }
    if (!hasAllKeys(text)) continue;

    writeFileSync(ENV_PATH, text);
    try {
      chmodSync(ENV_PATH, 0o600);
    } catch {
      // Some filesystems (e.g. ossfs mounts) don't support chmod — non-fatal.
    }
    log(`.env RESTORED from vault ${vault} (${Buffer.byteLength(text)} bytes)`);

    // Self-heal the tmp snapshots so the chain stays intact even if the
    // primary vault is later removed.
    if (vault === VAULT_SOURCES[0]) {
      for (const snap of SECONDARY_SNAPSHOTS) {
        try {
          mkdirSync(dirname(snap), { recursive: true });
          copyFileSync(vault, snap);
        } catch {
          // Best-effort only.
        }
      }
      log("secondary snapshots refreshed");
    }
    return 0;
  }

  log("FATAL: .env is missing required keys and NO vault contains them.");
  log(`Required keys: ${REQUIRED_KEYS.join(", ")}`);
  log(`Vault locations checked: ${VAULT_SOURCES.join(", ")}`);
  return 1;
}

process.exit(main());

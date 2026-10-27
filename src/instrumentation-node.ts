/**
 * instrumentation-node.ts — Node-runtime vault loader for NOMOFEE.
 *
 * ONLY imported dynamically from src/instrumentation.ts when
 * NEXT_RUNTIME === "nodejs" — never bundled for the Edge Runtime.
 *
 * Why this exists: this sandbox's harness resets `.env` to a stale
 * 50-byte SQLite-only file on session restarts, which removes
 * SUPABASE_DATABASE_URL and crashes Prisma (P1012). If those variables
 * are missing at server boot, this guard reloads them from the durable
 * vault so the server always starts with credentials — even when Next.js
 * is started directly (bypassing scripts/ensure-env.ts) or when a
 * mid-session `.env` reset triggers a Turbopack reload.
 *
 * Vault priority:
 *   1. $NOMOFEE_ENV_VAULT       — optional explicit override
 *   2. upload/.env.vault        — ossfs mount, survives sandbox resets/rsync
 *   3. /tmp/nomofee-env/.env    — tmp snapshot
 *   4. /tmp/my-project/.env     — legacy tmp snapshot
 *
 * Rules:
 *  - NEVER overrides a variable already present in process.env
 *    (explicit environment always wins).
 *  - NEVER logs secret values — only key names and vault paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED = [
  "SUPABASE_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export async function registerNodeEnvGuard(): Promise<void> {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length === 0) return;

  console.warn(
    `[instrumentation] env guard: missing at boot: ${missing.join(", ")} — loading from vault`,
  );

  const candidates = [
    process.env.NOMOFEE_ENV_VAULT, // optional explicit override
    join(process.cwd(), "upload", ".env.vault"), // durable ossfs mount
    "/tmp/nomofee-env/.env",
    "/tmp/my-project/.env",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const vault of candidates) {
    if (!existsSync(vault)) continue;

    let loaded = 0;
    try {
      const text = readFileSync(vault, "utf8");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        if (process.env[key] !== undefined) continue; // never override explicit env
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
        loaded++;
      }
    } catch {
      continue; // unreadable vault — try next candidate
    }

    if (loaded > 0) {
      console.log(`[instrumentation] env guard: ${loaded} var(s) loaded from ${vault}`);
    }

    const stillMissing = REQUIRED.filter((k) => !process.env[k]);
    if (stillMissing.length === 0) return;
    if (loaded > 0) {
      console.error(
        `[instrumentation] vault ${vault} lacked: ${stillMissing.join(", ")} — trying next`,
      );
    }
  }

  console.error(
    `[instrumentation] env guard FATAL: SUPABASE_* credentials unavailable at boot ` +
      `(checked vaults: ${candidates.join(", ")}). Database-backed routes will fail.`,
  );
}

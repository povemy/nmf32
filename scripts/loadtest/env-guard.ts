// ============================================================================
// LT env-guard — FAIL-CLOSED safety gate (LT-CHECKLIST rule #7).
// Every LT script (seed/cleanup/integrity) calls runEnvGuard() first and
// REFUSES to touch the database unless ALL checks pass:
//   (a) SUPABASE_DATABASE_URL host == the Supabase pooler host extracted from
//       this project's .env (hard allowlist — the ONLY permitted DB host)
//   (b) the target app answers on GET /api/health/ready
//   (c) the mock PSP is the only registered payment provider (src/lib/psp.ts)
//   (d) the DB carries THIS dev sandbox's data signature (demo store +
//       build-specific Setting) — protects against pointing at a foreign DB
//   (e) no production markers anywhere in the connection string / NODE_ENV
// Prints one PASS/FAIL line per check; exits 1 on any failure.
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PSP_PROVIDERS } from "../../src/lib/psp";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");

export type GuardCheck = { name: string; ok: boolean; detail: string };
export type GuardResult = { ok: boolean; checks: GuardCheck[]; dbUrl: string };

/** Extract the SUPABASE_DATABASE_URL declared in the project .env (source of truth). */
function envDeclaredDbUrl(): string | null {
  try {
    const raw = readFileSync(join(PROJECT_ROOT, ".env"), "utf8");
    const line = raw.split("\n").find((l) => l.trim().startsWith("SUPABASE_DATABASE_URL="));
    return line ? line.split("=").slice(1).join("=").trim() : null;
  } catch {
    return null;
  }
}

function parseDbUrl(url: string): { host: string; dbname: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname, dbname: (u.pathname || "/").replace(/^\//, "") };
  } catch {
    return { host: "", dbname: "" };
  }
}

/**
 * Script-side connection budget. Supavisor SESSION mode caps TOTAL clients at
 * pool_size=15 and the dev server already owns a pool — LT scripts must be
 * polite: force a small per-process pool instead of the URL's connection_limit.
 */
function budgetedDbUrl(limit: number): string {
  const url = process.env.SUPABASE_DATABASE_URL ?? "";
  if (!url) return url;
  const u = new URL(url);
  const params = new URLSearchParams(u.search);
  params.delete("connection_limit");
  params.set("connection_limit", String(limit));
  params.set("pool_timeout", params.get("pool_timeout") ?? "15");
  u.search = params.toString();
  return u.toString();
}
export { budgetedDbUrl };

export const LT_TARGET_URL = process.env.LT_TARGET_URL ?? "http://localhost:3000";

export async function runEnvGuard(passedClient?: PrismaClient): Promise<GuardResult> {
  const checks: GuardCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // ── (a) DB host allowlist — from .env, never from a guess ────────────────────
  const declared = envDeclaredDbUrl();
  const declaredParsed = declared ? parseDbUrl(declared) : { host: "", dbname: "" };
  const POOLER_PATTERN = /^aws-0-[a-z0-9-]+\.pooler\.supabase\.com$/;
  const runtimeUrl = process.env.SUPABASE_DATABASE_URL ?? "";
  const runtimeParsed = parseDbUrl(runtimeUrl);

  let aOk = false;
  let aDetail = "";
  if (!declared) {
    aDetail = ".env has no SUPABASE_DATABASE_URL line";
  } else if (!POOLER_PATTERN.test(declaredParsed.host)) {
    aDetail = `.env host "${declaredParsed.host}" is not a Supabase pooler host`;
  } else if (!runtimeUrl) {
    aDetail = "process.env.SUPABASE_DATABASE_URL is unset (Prisma would fail)";
  } else if (runtimeParsed.host !== declaredParsed.host) {
    aDetail = `runtime host "${runtimeParsed.host}" != .env allowlist "${declaredParsed.host}"`;
  } else {
    aOk = true;
    aDetail = `host=${runtimeParsed.host} (== .env allowlist) db=${runtimeParsed.dbname}`;
  }
  add("(a) DB host == .env Supabase-pooler allowlist", aOk, aDetail);

  // ── (e) production markers — checked before any connection attempt ──────────
  const needle = "prod";
  const hay = `${runtimeParsed.host} ${runtimeParsed.dbname} ${runtimeUrl} ${process.env.NODE_ENV ?? ""}`.toLowerCase();
  const eOk = !hay.includes(needle) && process.env.NODE_ENV !== "production";
  add("(e) no production markers in host/db/env", eOk, `NODE_ENV=${process.env.NODE_ENV ?? "unset"}, scanned host+dbname+url`);

  if (!aOk || !eOk) {
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
    console.log("ENV-GUARD: FAIL (fail-closed, aborting before touching the DB)");
    return { ok: false, checks, dbUrl: runtimeUrl };
  }

  const db = passedClient ?? new PrismaClient({ datasources: { db: { url: budgetedDbUrl(3) } } });

  // ── (b) target app readiness ──────────────────────────────────────────────────
  let bOk = false;
  let bDetail = "";
  try {
    const res = await fetch(`${LT_TARGET_URL}/api/health/ready`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json()) as { data?: { status?: string } };
    bOk = res.status === 200 && body?.data?.status === "ready";
    bDetail = `${LT_TARGET_URL}/api/health/ready → ${res.status} ${body?.data?.status ?? "?"}`;
  } catch (err) {
    bDetail = `${LT_TARGET_URL}/api/health/ready unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
  add("(b) target app /api/health/ready", bOk, bDetail);

  // ── (c) mock PSP is the ONLY registered provider ─────────────────────────────
  const providerIds = Object.keys(PSP_PROVIDERS);
  const cOk = providerIds.length === 1 && providerIds[0] === "mock" && PSP_PROVIDERS.mock.sandboxOnly === true;
  add(
    "(c) mock PSP only (psp.ts registry)",
    cOk,
    `providers: ${providerIds.join(" | ")}; mock.sandboxOnly=${String(PSP_PROVIDERS.mock?.sandboxOnly)} (real gateways are notes/candidates, not registered)`
  );

  // ── (d) sandbox data signature — THIS dev database ───────────────────────────
  let dOk = false;
  let dDetail = "";
  try {
    const demoStore = await db.store.findUnique({ where: { slug: "bytebazaar" }, select: { status: true } });
    const buildSetting = await db.setting.findUnique({ where: { key: "ranking.weights" }, select: { updatedAt: true } });
    const productTotal = await db.product.count();
    const ltMarker = await db.setting.findUnique({ where: { key: "lt.seed.state" }, select: { updatedAt: true } });
    dOk = !!demoStore && demoStore.status === "live" && !!buildSetting && productTotal < 10_000;
    dDetail =
      `store[bytebazaar]=${demoStore?.status ?? "MISSING"}, Setting[ranking.weights]=${buildSetting ? "present" : "MISSING"}, ` +
      `productTotal=${productTotal} (<10000 guard), lt.seed.state=${ltMarker ? "present" : "absent (pre-seed run)"}`;
  } catch (err) {
    dDetail = `DB signature probe failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
  }
  add("(d) sandbox data signature (dev DB proof)", dOk, dDetail);

  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
  const ok = checks.every((c) => c.ok);
  console.log(ok ? "ENV-GUARD: PASS (all checks green)" : "ENV-GUARD: FAIL (fail-closed, aborting)");
  if (!passedClient) await db.$disconnect();
  return { ok, checks, dbUrl: runtimeUrl };
}

// Standalone: bun scripts/loadtest/env-guard.ts
if (import.meta.main) {
  const res = await runEnvGuard();
  process.exit(res.ok ? 0 : 1);
}

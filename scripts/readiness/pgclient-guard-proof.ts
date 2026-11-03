// ============================================================================
// pgclient-guard-proof.ts — negative + positive proof for the lib.ts pgClient
// safety guard (Phase 3 / Work 1 review hardening).
// ----------------------------------------------------------------------------
// Proves, LIVE against the real database (read-only — only SHOW/pg_catalog):
//   1. SUPABASE_DATABASE_URL env override WITHOUT a schema pin  → REFUSED
//      (the accidental-public foot-gun: an unpinned raw session resolves
//      unqualified fault DDL to the role-default public schema).
//   2. Env override pinning schema=public                        → REFUSED
//      (public is never a valid fault-injection target).
//   3. Env override pinning schema=nomofee_staging               → ALLOWED,
//      session search_path verified == nomofee_staging (the Step 4 staging
//      posture).
//
// The dev-default posture (no env override, .env URL, no pin) is intentionally
// NOT exercised here: that is the historical dev behavior this hardening
// deliberately preserves, and connecting unguarded would prove nothing.
//
// Run: bun scripts/readiness/pgclient-guard-proof.ts
// Exits non-zero on any unexpected outcome.
// @ts-nocheck
import { readFileSync } from "node:fs";

const DEV_URL = readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim() ?? "";
if (!DEV_URL) {
  console.error("FATAL: .env SUPABASE_DATABASE_URL missing");
  process.exit(1);
}
const pin = (schema) => {
  const u = new URL(DEV_URL);
  u.searchParams.set("schema", schema);
  return u.toString();
};

let failures = 0;
const expectRefusal = async (name, url) => {
  process.env.SUPABASE_DATABASE_URL = url;
  delete require.cache[require.resolve("../../scripts/readiness/lib.ts")];
  try {
    const { pgClient } = await import("./lib");
    const c = await pgClient(); // must throw before/around connect
    await c.end().catch(() => {});
    console.log(`FAIL  ${name} — connection was NOT refused`);
    failures++;
  } catch (e) {
    const msg = String(e?.message ?? e);
    const citesPublic = /public/i.test(msg);
    console.log(`PASS  ${name} — refused: ${msg.slice(0, 110)}${citesPublic ? "" : "  (warning: message does not mention public)"}`);
  }
};
const expectPinned = async (name, url, wantSchema) => {
  process.env.SUPABASE_DATABASE_URL = url;
  delete require.cache[require.resolve("../../scripts/readiness/lib.ts")];
  const { pgClient } = await import("./lib");
  const c = await pgClient();
  try {
    const sp = (await c.query("SHOW search_path")).rows[0].search_path;
    const n = (await c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1", [wantSchema])).rows[0].n;
    const ok = sp === wantSchema;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} — search_path="${sp}" (want ${wantSchema}), ${n} tables visible in schema`);
    if (!ok) failures++;
  } finally {
    await c.end().catch(() => {});
  }
};

console.log("pgClient guard proof — cases:");
await expectRefusal("unpinned env override (dev URL, no schema pin)", DEV_URL);
await expectRefusal("env override pinning schema=public", pin("public"));
await expectPinned("env override pinning schema=nomofee_staging", pin("nomofee_staging"), "nomofee_staging");
delete process.env.SUPABASE_DATABASE_URL;
console.log(failures === 0 ? "\npgclient-guard-proof: ALL PASS" : `\npgclient-guard-proof: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

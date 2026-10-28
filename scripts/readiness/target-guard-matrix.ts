// ============================================================================
// TARGET-GUARD MATRIX — decision-matrix verification for the fail-closed
// load-test environment guard (mission: env separation, Phase 1 §1.2).
// Spawns each case in a SUBPROCESS because the guard refuses via process.exit.
// Re-runnable: `bun scripts/readiness/target-guard-matrix.ts`
// @ts-nocheck
import { writeFileSync } from "node:fs";

const FP = process.env.LOADTEST_DB_FINGERPRINT ?? (await (async () => {
  const r = await fetch("http://127.0.0.1:3000/api/health");
  const j = await r.json();
  return j?.data?.deployment?.dbFingerprint ?? "";
})());

const PRELUDE = 'import {assertTestTarget} from "./scripts/readiness/target-guard";';
const CASES = [
  { id: "T1", expect: "REFUSE", desc: "confirm unset", env: {}, code: `${PRELUDE} await assertTestTarget();` },
  { id: "T2", expect: "REFUSE", desc: "confirm=production", env: { LOADTEST_TARGET_CONFIRM: "production" }, code: `${PRELUDE} await assertTestTarget();` },
  { id: "T3", expect: "CONFIRM", desc: "confirm=dev-sandbox-local", env: { LOADTEST_TARGET_CONFIRM: "dev-sandbox-local" }, code: `${PRELUDE} const t=await assertTestTarget(); console.log("CONFIRMED", t.confirmed, t.dbFingerprint);` },
  { id: "T4", expect: "REFUSE", desc: "staging without pinned fingerprint", env: { LOADTEST_TARGET_CONFIRM: "staging" }, code: `${PRELUDE} await assertTestTarget();` },
  { id: "T5", expect: "REFUSE", desc: "staging + WRONG pinned fingerprint", env: { LOADTEST_TARGET_CONFIRM: "staging", LOADTEST_DB_FINGERPRINT: "0000000000000000" }, code: `${PRELUDE} await assertTestTarget();` },
  { id: "T6", expect: "CONFIRM", desc: "staging + correct pinned fingerprint", env: { LOADTEST_TARGET_CONFIRM: "staging", LOADTEST_DB_FINGERPRINT: FP }, code: `${PRELUDE} const t=await assertTestTarget(); console.log("CONFIRMED", t.confirmed, t.dbFingerprint);` },
  { id: "T7", expect: "REFUSE", desc: "unreachable target base", env: { LOADTEST_TARGET_CONFIRM: "dev-sandbox-local", LOADTEST_BASE: "http://127.0.0.1:3999" }, code: `${PRELUDE} await assertTestTarget();` },
];

const results = [];
let failures = 0;
for (const c of CASES) {
  const proc = Bun.spawnSync(["bun", "-e", c.code], { env: { ...process.env, ...c.env }, cwd: "/home/z/my-project" });
  const out = (proc.stdout.toString() + proc.stderr.toString()).trim();
  const refused = out.includes("REFUSED");
  const confirmed = out.includes("CONFIRMED");
  const observed = refused ? "REFUSE" : confirmed ? "CONFIRM" : "ERROR";
  const pass = observed === c.expect;
  if (!pass) failures++;
  const firstLine = out.split("\n").find((l) => l.includes("REFUSED") || l.includes("CONFIRMED")) ?? out.split("\n")[0] ?? "";
  console.log(`${pass ? "PASS" : "FAIL"}  ${c.id} ${c.desc} — expected ${c.expect}, observed ${observed}`);
  if (!pass) console.log(`      ${firstLine}`);
  results.push({ id: c.id, desc: c.desc, expect: c.expect, observed, pass, detail: firstLine.trim(), exitCode: proc.exitCode });
}

const report = {
  suite: "target-guard-matrix",
  at: new Date().toISOString(),
  appFingerprint: FP,
  cases: results,
  failures,
};
writeFileSync(`performance/runs/${new Date().toISOString().slice(0, 10)}-target-guard.json`, JSON.stringify(report, null, 2));
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"} — saved performance/runs/${new Date().toISOString().slice(0, 10)}-target-guard.json`);
process.exit(failures === 0 ? 0 : 1);

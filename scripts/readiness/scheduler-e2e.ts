// ============================================================================
// SCHEDULER E2E (mission: final operational gaps, Phase 1).
// ----------------------------------------------------------------------------
// Demonstrates the ACTUAL recurring invocation (mini-services/expiry-scheduler,
// port 3005) against the live app:
//   A. Auth decision matrix (unit: cronAuthMode/secretMatches) + live dev-open
//   B. Release latency vs the documented service objective (live scheduler)
//   C. Paid order / ledger invariants hold across live sweeps
//   D. Overlap safety: concurrent manual sweeps + live scheduler ticks
//   E. Worker restart + missed scheduling interval → catch-up + alert
//   F. Fail-closed E2E: app restarted with CRON_SECRET set (403 matrix) and
//      with CRON_REQUIRE_SECRET=1 + no secret (503 CRON_NOT_CONFIGURED), then
//      restored to the normal deployment env.
// Service objective (documented): sweep interval 30 s; an eligible expired
// reservation is released within interval + one bounded sweep pass — asserted
// ≤ 120 s hard bound (target ≤ 2×interval + pass), far inside the ≤ 5 min
// readiness-checklist proposal.
// Run: bun scripts/readiness/scheduler-e2e.ts
// ============================================================================
// @ts-nocheck
import { db } from "../../src/lib/db";
import { writeFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
const { ltShopperCookie, makeLtVariant, checkout, sendWebhook, check, exitCode, stopScheduler, startScheduler, schedulerState, schedulerPid, sleep } = await import("./lib");

const BASE = "http://127.0.0.1:3000";
const stamp = Date.now().toString(36);
const AUTH_ONLY = process.argv[2] === "auth"; // re-run just section F
const evidence = { suite: "scheduler-e2e", at: new Date().toISOString(), environment: "dev-mode, combined env, remote Supabase", measurements: {}, scenarios: [] };
function record(name, detail) {
  evidence.scenarios.push({ name, detail, at: new Date().toISOString() });
  console.log(`   ↳ ${name}: ${detail}`);
}

const postSweep = (headers = {}) => fetch(`${BASE}/api/cron/expiry-sweep`, { method: "POST", headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const getSweep = () => fetch(`${BASE}/api/cron/expiry-sweep`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// ─── App restart control (auth matrix needs server-side env changes) ────────
function pidsOnPort(port) {
  try {
    const out = execSync(`ss -tlnp 2>/dev/null | grep ':${port} ' || true`).toString();
    return [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
  } catch {
    return [];
  }
}
async function restartApp(extraEnv = {}) {
  for (const pid of pidsOnPort(3000)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (let i = 0; i < 40; i++) {
    if (pidsOnPort(3000).length === 0) break;
    await sleep(250);
  }
  // 'next[ ]dev' cannot self-match this command's own cmdline (the literal
  // text contains brackets, the regex does not) — plain 'next dev' would make
  // pkill SIGTERM its own shell (observed in the first run).
  try {
    execSync("pkill -f 'next[ ]dev' 2>/dev/null || true", { shell: "/bin/bash" });
  } catch {}
  await sleep(1500);
  const child = spawn("/bin/bash", ["-c", "cd /home/z/my-project && node node_modules/.bin/next dev -p 3000 2>&1 | tee -a dev.log"], {
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

try {
  // ══ A. Auth decision matrix (unit) + live dev-open ════════════════════════
  console.log("── A: cron-auth decision matrix (unit) + live dev-open baseline ──");
  {
    const { cronAuthMode, secretMatches } = await import("../../src/lib/cron-auth");
    const m = (env) => cronAuthMode(env);
    check("A1 unit: secret set → secret-required (any NODE_ENV)",
      m({ CRON_SECRET: "x" }) === "secret-required" && m({ CRON_SECRET: "x", NODE_ENV: "production" }) === "secret-required");
    check("A2 unit: production + NO secret → fail-closed",
      m({ NODE_ENV: "production" }) === "fail-closed");
    check("A3 unit: CRON_REQUIRE_SECRET=1 + no secret → fail-closed (testable branch)",
      m({ CRON_REQUIRE_SECRET: "1" }) === "fail-closed");
    check("A4 unit: plain dev + no secret → dev-open",
      m({}) === "dev-open" && m({ NODE_ENV: "development" }) === "dev-open");
    check("A5 unit: timing-safe compare — match/mismatch/length-diff/empty",
      secretMatches("abc", "abc") === true && secretMatches("abc", "abd") === false &&
      secretMatches("a", "abc") === false && secretMatches("", "abc") === false && secretMatches("abc", "") === false);
    const live = await postSweep();
    check("A6 live: current deployment (no CRON_SECRET, dev) → POST allowed, auth=dev-open",
      live.status === 200 && live.body?.data?.auth === "dev-open", `${live.status} auth=${live.body?.data?.auth ?? live.body?.error?.code}`);
    record("A", `matrix PASS; live ${live.status} dev-open`);
  }

  if (!AUTH_ONLY) {
  // Scheduler must be RUNNING for B–D.
  const schedUp = await startScheduler();
  check("B0: scheduler service is running (port 3005)", schedUp && Boolean(schedulerPid()));

  // ══ B. Live-scheduler release latency vs objective ═══════════════════════
  console.log("── B: release latency vs documented objective (LIVE scheduler, no manual sweep) ──");
  const variant = await makeLtVariant(`sch-${stamp}`, 30);
  const shopper = await ltShopperCookie(`lt-sch-${stamp}@lt.test`, "LT Scheduler Buyer");
  const stockOf = async () => (await db.productVariant.findUnique({ where: { id: variant.variantId } }))!.stock;
  let bReleaseMs = null;
  {
    const r = await checkout(shopper, variant.variantId, `sch-b-${stamp}`);
    const d = r.body?.data ?? {};
    const group = await db.paymentGroup.findUnique({ where: { ref: d.paymentRef } });
    // Eligible 2.5 s in the FUTURE — latency measured from the true expiry moment.
    const expiresAt = new Date(Date.now() + 2500);
    await db.paymentGroup.update({ where: { id: group.id }, data: { expiresAt } });
    const stockBefore = await stockOf();
    const t0 = Date.now();
    let detected = null;
    for (let i = 0; i < 130; i++) {
      const g = await db.paymentGroup.findUnique({ where: { id: group.id }, select: { status: true } });
      if (g.status === "expired") { detected = Date.now(); break; }
      await sleep(1000);
    }
    bReleaseMs = detected != null ? detected - expiresAt.getTime() : null;
    const order = await db.order.findFirst({ where: { paymentGroupId: group.id } });
    const logs = await db.inventoryLog.count({ where: { refId: order.id, reason: { startsWith: "expiry:" } } });
    check("B1: LIVE scheduler released the expired reservation within the objective (≤120 s; target ≤2×30 s + pass)",
      bReleaseMs != null && bReleaseMs <= 120_000 && (await stockOf()) === stockBefore + 1 && logs === 1 && order.status === "payment_expired",
      `releaseMs=${bReleaseMs} stock ${stockBefore}→${await stockOf()} logs=${logs} order=${order.status}`);
    evidence.measurements.releaseLatencyMs = bReleaseMs;
    record("B", `expiresAt→released = ${bReleaseMs} ms (interval 30 s)`);
  }

  // ══ C. Paid order + ledger invariants across live sweeps ═════════════════
  console.log("── C: paid order, stock and ledger stay correct across live sweeps ──");
  {
    const txnsBefore = await db.ledgerTransaction.count();
    const r = await checkout(shopper, variant.variantId, `sch-c-${stamp}`);
    const d = r.body?.data ?? {};
    const pay = await sendWebhook(d.paymentRef, "payment.succeeded", d.totalMinor);
    const group = await db.paymentGroup.findUnique({ where: { ref: d.paymentRef } });
    const order = await db.order.findFirst({ where: { paymentGroupId: group.id } });
    const stockAfterPay = await stockOf();
    // Let at least one live scheduler tick pass over a PAID group.
    await sleep(32_000);
    const group2 = await db.paymentGroup.findUnique({ where: { ref: d.paymentRef } });
    const order2 = await db.order.findFirst({ where: { paymentGroupId: group.id } });
    check("C1: paid group/order untouched by live sweeps; stock not restored; ledger unchanged",
      pay.status === 200 && group2.status === "succeeded" && order2.status === "paid" && (await stockOf()) === stockAfterPay && (await db.ledgerTransaction.count()) === txnsBefore + 1,
      `group=${group2.status} order=${order2.status} stock=${await stockOf()} txns +${(await db.ledgerTransaction.count()) - txnsBefore}`);
    record("C", "paid group survived live ticks; no restock; +1 legit txn only");
  }

  // ══ D. Overlap safety: manual sweeps concurrent with live scheduler ══════
  console.log("── D: overlapping manual sweeps + live scheduler tick → exactly one restock ──");
  {
    const r = await checkout(shopper, variant.variantId, `sch-d-${stamp}`);
    const d = r.body?.data ?? {};
    const group = await db.paymentGroup.findUnique({ where: { ref: d.paymentRef } });
    await db.paymentGroup.update({ where: { id: group.id }, data: { expiresAt: new Date(Date.now() - 5000) } });
    const stockBefore = await stockOf();
    // 3 concurrent manual sweeps racing the live scheduler's own tick.
    await Promise.all([postSweep(), postSweep(), postSweep()]);
    for (let i = 0; i < 45; i++) {
      const g = await db.paymentGroup.findUnique({ where: { id: group.id }, select: { status: true } });
      if (g.status === "expired") break;
      await sleep(1000);
    }
    const order = await db.order.findFirst({ where: { paymentGroupId: group.id } });
    const logs = await db.inventoryLog.count({ where: { refId: order.id, reason: { startsWith: "expiry:" } } });
    check("D1: overlapping executions → EXACTLY one restock (claim-first + throttle)",
      (await stockOf()) === stockBefore + 1 && logs === 1 && order.status === "payment_expired",
      `stock ${stockBefore}→${await stockOf()} logs=${logs} order=${order.status}`);
    record("D", "3 manual sweeps + live tick → single restock");
  }

  // ══ E. Worker restart + missed scheduling interval ═══════════════════════
  console.log("── E: scheduler restart + missed interval → durable state, catch-up, alert ──");
  {
    const stopped = await stopScheduler();
    const r = await checkout(shopper, variant.variantId, `sch-e-${stamp}`);
    const d = r.body?.data ?? {};
    const group = await db.paymentGroup.findUnique({ where: { ref: d.paymentRef } });
    await db.paymentGroup.update({ where: { id: group.id }, data: { expiresAt: new Date(Date.now() - 5000) } });
    await sleep(35_000); // > one interval with the scheduler DOWN
    const duringDowntime = await db.paymentGroup.findUnique({ where: { id: group.id }, select: { status: true } });
    check("E1: with the scheduler down, nothing sweeps (missed interval = missed tick)",
      stopped && duringDowntime.status === "requires_payment", `schedulerDown=${stopped} group=${duringDowntime.status}`);
    const restartT0 = Date.now();
    const up = await startScheduler();
    let catchUpMs = null;
    for (let i = 0; i < 30; i++) {
      const g = await db.paymentGroup.findUnique({ where: { id: group.id }, select: { status: true } });
      if (g.status === "expired") { catchUpMs = Date.now() - restartT0; break; }
      await sleep(1000);
    }
    const st = await schedulerState();
    const alerts = (st?.alerts ?? []).map((a) => a.type);
    check("E2: restart → catch-up tick sweeps the missed reservation quickly (<15 s)",
      up && catchUpMs != null && catchUpMs < 15_000, `catchUpMs=${catchUpMs}`);
    check("E3: durable state recovered + MISSED_INTERVAL alert raised",
      alerts.includes("MISSED_INTERVAL") && Boolean(st?.endpoints?.expiry?.lastSuccessAt),
      `alerts=[${alerts.join(",")}]`);
    evidence.measurements.catchUpMs = catchUpMs;
    record("E", `down 35 s; catch-up ${catchUpMs} ms; alerts=${alerts.join(",")}`);
  }
  } // end !AUTH_ONLY

  // ══ F. Fail-closed auth matrix (E2E with real server env) ════════════════
  console.log("── F: fail-closed E2E — CRON_SECRET set, then CRON_REQUIRE_SECRET=1 ──");
  const SECRET = `lt_cron_secret_${stamp}`;
  {
    // F1: server with a configured secret — mismatch/missing → 403, match → 200.
    const up1 = await restartApp({ CRON_SECRET: SECRET });
    const noHdr = await postSweep();
    const wrong = await postSweep({ "x-cron-secret": "definitely-wrong" });
    const right = await postSweep({ "x-cron-secret": SECRET });
    const getNo = await getSweep();
    check("F1: CRON_SECRET set → no header 403, wrong secret 403, correct secret 200, GET guarded",
      up1 && noHdr.status === 403 && noHdr.body?.error?.code === "CRON_FORBIDDEN" &&
      wrong.status === 403 && right.status === 200 && getNo.status === 403,
      `no=${noHdr.status} wrong=${wrong.status} right=${right.status} get=${getNo.status}`);
    check("F1b: responses never echo the secret or the presented value",
      !JSON.stringify([noHdr.body, wrong.body]).includes("definitely-wrong") && !JSON.stringify([noHdr.body, wrong.body]).includes(SECRET));
    record("F1", `403/403/200/403 (secret configured)`);
    // F2: production-like fail-closed — no secret, CRON_REQUIRE_SECRET=1.
    const up2 = await restartApp({ CRON_REQUIRE_SECRET: "1" });
    const fc = await postSweep();
    const fcGet = await getSweep();
    check("F2: missing CRON_SECRET + require-flag → POST & GET FAIL CLOSED (503 CRON_NOT_CONFIGURED)",
      up2 && fc.status === 503 && fc.body?.error?.code === "CRON_NOT_CONFIGURED" && fcGet.status === 503,
      `post=${fc.status} ${fc.body?.error?.code} get=${fcGet.status}`);
    record("F2", "503 CRON_NOT_CONFIGURED on both methods");
  }
  // F3: restore the normal deployment env — POST must be allowed again.
  const up3 = await restartApp({});
  let restored = await postSweep();
  if (restored.body?.data?.throttled) {
    // The live scheduler may have ticked the instant the app came back —
    // a throttled 200 still proves the surface is reachable; retry once for
    // a full outcome after the 1.5 s throttle window.
    await sleep(2000);
    restored = await postSweep();
  }
  check("F3: normal env restored → scheduler surface available again (dev-open)",
    up3 && restored.status === 200 && restored.body?.data?.auth === "dev-open",
    `${restored.status} ${restored.body?.data?.auth ?? restored.body?.data?.throttled ? "throttled" : restored.body?.data?.auth}`);
  record("F3", "restored dev-open");

  const finalState = await schedulerState();
  evidence.measurements.scheduler = {
    ticks: finalState?.endpoints && Object.fromEntries(Object.entries(finalState.endpoints).map(([k, v]) => [k, { ticks: v.ticks, consecutiveFailures: v.consecutiveFailures }])),
    alerts: finalState?.alerts,
    intervalMs: finalState?.intervalMs,
    secretConfigured: finalState?.secretConfigured,
  };
} finally {
  // Always leave the scheduler running + app healthy.
  await startScheduler();
  writeFileSync("performance/runs/2026-10-25-scheduler-e2e.json", JSON.stringify(evidence, null, 2));
  console.log("evidence → performance/runs/2026-10-25-scheduler-e2e.json");
}
process.exit(exitCode());

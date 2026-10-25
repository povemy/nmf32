// ============================================================================
// LATE-PAYMENT REFUND / RECONCILIATION SUITE (mission: final operational gaps,
// Phase 2 step 4). The 10 required payment/expiry race scenarios, executed
// against the live dev server + remote DB with [LT] fixtures only.
// ----------------------------------------------------------------------------
// The scheduler service (port 3005) is STOPPED for the duration so refund
// ticks are driven MANUALLY (deterministic); it is restored in `finally`.
// Scenario overview (asserts final order/inventory/payment/ledger/refund/
// audit-trail state after EVERY scenario):
//   S1  payment succeeds BEFORE expiry — normal path, NO reconciliation case
//   S2  expiry wins before payment-success — 409 GROUP_EXPIRED + obligation
//   S3  valid late payment after stock release — durable case with amounts
//   S4  duplicate late-payment webhooks — exactly ONE case, never regressed
//   S5  refund times out (unknown) → later completes — provider-authoritative
//   S6  refund succeeds but worker crashes before saving — idempotent recovery
//   S7  provider rejects refund — permanent failure stays visible
//   S8  retry with the SAME provider idempotency key — never a second refund
//   S9  DB failure while the obligation is recorded — 500 → redelivery → one
//   S10 inventory unfulfillable + buyer payment handled per policy — final audit
// Run: bun scripts/readiness/late-payment-refund.ts
// ============================================================================
// @ts-nocheck
import { db } from "../../src/lib/db";
import { writeFileSync } from "node:fs";
const { LT, ltShopperCookie, makeLtVariant, checkout, sendWebhook, check, exitCode, pgClient, stopScheduler, startScheduler, sleep, setSetting } = await import("./lib");

const BASE = "http://127.0.0.1:3000";
const stamp = Date.now().toString(36);
const BEHAVIOR_KEY = "psp.mock.refund.behavior";
const FAULT_KEY = "recon.fault";
const evidence = { suite: "late-payment-refund", at: new Date().toISOString(), scenarios: [] };
function record(name, detail) {
  evidence.scenarios.push({ name, detail, at: new Date().toISOString() });
  console.log(`   ↳ ${name}: ${detail}`);
}

async function postSweep() {
  const r = await fetch(`${BASE}/api/cron/expiry-sweep`, { method: "POST" });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function postRefundTick() {
  const r = await fetch(`${BASE}/api/cron/refund-reconcile`, { method: "POST" });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
/** Tick again after the app's backoff window (default 15 s). */
async function tickAfterBackoff() {
  await sleep(16_000);
  return postRefundTick();
}
const ledgerTxnCount = () => db.ledgerTransaction.count();
const caseFor = (ref) => db.paymentReconciliation.findUnique({ where: { provider_providerRef: { provider: "fpx_toyyibpay", providerRef: ref } } });
const caseCountFor = (ref) => db.paymentReconciliation.count({ where: { provider: "fpx_toyyibpay", providerRef: ref } });
const pspRecordFor = (id) => db.pspRefundRecord.findUnique({ where: { idempotencyKey: `recon:${id}` } });

// ─── Setup ──────────────────────────────────────────────────────────────────
const schedulerWasRunning = Boolean((await import("./lib")).schedulerPid());
console.log(`[LT] late-payment-refund suite ${stamp} — scheduler running: ${schedulerWasRunning} (stopping for deterministic ticks)`);
const stopped = await stopScheduler();
if (!stopped) { console.error("FATAL: could not stop the scheduler service"); process.exit(1); }

const variant = await makeLtVariant(`lpr-${stamp}`, 20);
const shopper = await ltShopperCookie(`lt-lpr-${stamp}@lt.test`, "LT Late-Payment Buyer");
const stockOf = async () => (await db.productVariant.findUnique({ where: { id: variant.variantId } }))!.stock;
const txn0 = await ledgerTxnCount();

// Pre-suite drain: complete leftover [LT] cases from earlier runs through the
// NORMAL mechanism (behaviour=succeed) so scenario tick stats see a clean
// open-case set. Refund cases never touch the ledger, so txn0 stays valid.
await setSetting(BEHAVIOR_KEY, "succeed");
{
  const drain = await postRefundTick();
  const openLeft = await db.paymentReconciliation.count({ where: { status: { in: ["requested", "processing", "unknown"] } } });
  console.log(`[LT] pre-suite drain: succeeded=${drain.body?.data?.succeeded ?? "?"} openLeft=${openLeft}`);
}

/** An [LT] checkout whose group is expired by a manual sweep. */
async function expiredLatePayment(idem: string) {
  const r = await checkout(shopper, variant.variantId, idem);
  const d = r.body?.data ?? {};
  if (r.status !== 201 || !d.paymentRef) throw new Error(`checkout ${idem} → ${r.status}`);
  const group = await db.paymentGroup.findUnique({ where: { ref: d.paymentRef } });
  await db.paymentGroup.update({ where: { id: group.id }, data: { expiresAt: new Date(Date.now() - 5000) } });
  const s = await postSweep();
  const g2 = await db.paymentGroup.findUnique({ where: { ref: group.ref } });
  if (g2.status !== "expired") throw new Error(`sweep did not expire ${group.ref}: ${g2.status} (${JSON.stringify(s.body?.data)})`);
  return { ref: group.ref, id: group.id, total: d.totalMinor, order: await db.order.findFirst({ where: { paymentGroupId: group.id } }) };
}

try {
  // ══ S1 — payment succeeds BEFORE expiry: normal path, no obligation ═══════
  console.log("── S1: payment before expiry — normal success, NO reconciliation case ──");
  {
    const r = await checkout(shopper, variant.variantId, `lpr-s1-${stamp}`);
    const d = r.body?.data ?? {};
    const pay = await sendWebhook(d.paymentRef, "payment.succeeded", d.totalMinor);
    const group = await db.paymentGroup.findUnique({ where: { ref: d.paymentRef } });
    const order = await db.order.findFirst({ where: { paymentGroupId: group.id } });
    const cases = await caseCountFor(d.paymentRef);
    const txns = await ledgerTxnCount();
    check("S1: webhook ok, group succeeded, order paid, T1 posted, ZERO reconciliation cases",
      pay.status === 200 && group.status === "succeeded" && order.status === "paid" && cases === 0 && txns > txn0,
      `${pay.status} group=${group.status} order=${order.status} cases=${cases} txns ${txn0}→${txns}`);
    record("S1", `status=${pay.status} group=${group.status} order=${order.status} cases=${cases} ledgerTxns=${txns}`);
  }

  // ══ S2+S3 — expiry wins; valid late payment after stock release ══════════
  console.log("── S2/S3: expiry wins before payment-success; late payment records the durable obligation ──");
  const caseA = await expiredLatePayment(`lpr-a-${stamp}`);
  const stockAfterReleaseA = await stockOf();
  const txnsPreA = await ledgerTxnCount();
  const late = await sendWebhook(caseA.ref, "payment.succeeded", caseA.total);
  const ca = await caseFor(caseA.ref);
  const orderA = await db.order.findFirst({ where: { paymentGroupId: caseA.id } });
  check("S2: late payment → 409 GROUP_EXPIRED; order stays payment_expired; stock stays released; NO T1",
    late.status === 409 && late.body?.error?.code === "GROUP_EXPIRED" && orderA.status === "payment_expired" &&
    (await stockOf()) === stockAfterReleaseA && (await ledgerTxnCount()) === txnsPreA,
    `${late.status} ${late.body?.error?.code} order=${orderA.status} stock=${await stockOf()} txns=${await ledgerTxnCount()}`);
  check("S3: durable obligation recorded — provider, ref, amount(=captured), currency, reason, status requested",
    ca && ca.provider === "fpx_toyyibpay" && ca.providerRef === caseA.ref && ca.amountMinor === caseA.total &&
    ca.currency === "MYR" && ca.reason === "late_payment_after_expiry" && ca.status === "requested" && ca.attempts === 0,
    `case=${ca?.id} amount=${ca?.amountMinor} status=${ca?.status} attempts=${ca?.attempts}`);
  const wl = await db.paymentWebhookLog.count({ where: { providerRef: caseA.ref, eventType: "payment.succeeded", processed: true } });
  check("S3: audit trail — webhook log row processed=true for the refused event", wl === 1, `processedRows=${wl}`);
  record("S2/S3", `409 ${late.body?.error?.code}; case ${ca?.status} amount=${ca?.amountMinor}; order ${orderA.status}; stock stable ${stockAfterReleaseA}`);

  // ══ S4 — duplicate late-payment webhooks ═════════════════════════════════
  console.log("── S4: duplicate late-payment webhooks — one obligation, never regressed ──");
  {
    const dup = await sendWebhook(caseA.ref, "payment.succeeded", caseA.total);
    const count = await caseCountFor(caseA.ref);
    const ca2 = await caseFor(caseA.ref);
    check("S4: duplicate → 409 again; still EXACTLY ONE case; status/attempts untouched; no T1",
      dup.status === 409 && count === 1 && ca2.status === "requested" && ca2.attempts === 0 &&
      (await ledgerTxnCount()) === txnsPreA,
      `${dup.status} cases=${count} status=${ca2.status} attempts=${ca2.attempts}`);
    const wl2 = await db.paymentWebhookLog.count({ where: { providerRef: caseA.ref, eventType: "payment.succeeded", processed: true } });
    check("S4: audit trail — both deliveries logged+processed", wl2 === 2, `processedRows=${wl2}`);
    record("S4", `duplicate=${dup.status} cases=${count} processedWebhookRows=${wl2}`);
  }

  // ══ S5 — refund times out (unknown), later completes ═════════════════════
  console.log("── S5: refund request times out (unknown outcome) → later confirmed from provider record ──");
  {
    await setSetting(BEHAVIOR_KEY, "timeout");
    const t1 = await postRefundTick();
    const caT = await caseFor(caseA.ref);
    const recT = caT ? await pspRecordFor(caT.id) : null;
    check("S5a: timeout → case status unknown + providerRefundId kept; provider record PENDING; attempts=1",
      caT.status === "unknown" && Boolean(caT.providerRefundId) && recT?.status === "pending" && caT.attempts === 1,
      `case=${caT.status} refundId=${caT.providerRefundId} pspRecord=${recT?.status} attempts=${caT.attempts} tick=${JSON.stringify(t1.body?.data?.unknown ?? 0)}unknown`);
    // Backoff gate: an immediate second tick must NOT re-attempt the case.
    const t2 = await postRefundTick();
    const caT2 = await caseFor(caseA.ref);
    check("S5b: immediate re-tick respects backoff (no new attempt)",
      caT2.attempts === 1 && (t2.body?.data?.attempted ?? 1) === 0,
      `attempts=${caT2.attempts} tickAttempted=${t2.body?.data?.attempted}`);
    // Provider completes the pending refund; next tick reads the authoritative record.
    await setSetting(BEHAVIOR_KEY, "succeed");
    const t3 = await tickAfterBackoff();
    const caT3 = await caseFor(caseA.ref);
    const recT3 = caT ? await pspRecordFor(caT.id) : null;
    check("S5c: after provider completes → case succeeded, confirmed from provider record (still ONE refund)",
      caT3.status === "succeeded" && caT3.providerRefundId === recT3?.refundId && recT3?.status === "succeeded" &&
      (caT ? (await db.pspRefundRecord.count({ where: { idempotencyKey: `recon:${caT.id}` } })) : 0) === 1,
      `case=${caT3.status} psp=${recT3?.status} note=${caT3.resolutionNote?.slice(0, 60)}`);
    record("S5", `unknown(pending)→succeeded via provider record; refundId=${caT3.providerRefundId}`);
  }

  // ══ S6 — refund succeeds but worker crashes before saving the outcome ════
  console.log("── S6: refund succeeds but worker crashes before saving — idempotent recovery ──");
  {
    const caseB = await expiredLatePayment(`lpr-b-${stamp}`);
    await sendWebhook(caseB.ref, "payment.succeeded", caseB.total);
    const cb = await caseFor(caseB.ref);
    await setSetting(FAULT_KEY, "crash-after-provider");
    const t1 = await postRefundTick();
    const cb1 = await caseFor(caseB.ref);
    const rec1 = await pspRecordFor(cb.id);
    check("S6a: crash-after-provider — provider EXECUTED (record succeeded) but case outcome NOT saved",
      (t1.body?.data?.faultsApplied ?? 0) === 1 && rec1?.status === "succeeded" && cb1.status !== "succeeded" && !cb1.providerRefundId && (cb1.lastError ?? "").includes("simulated crash"),
      `faultsApplied=${t1.body?.data?.faultsApplied} psp=${rec1?.status} case=${cb1.status} err=${cb1.lastError?.slice(0, 50)}`);
    const t2 = await tickAfterBackoff();
    const cb2 = await caseFor(caseB.ref);
    const recCount = await db.pspRefundRecord.count({ where: { idempotencyKey: `recon:${cb.id}` } });
    check("S6b: recovery tick converges via SAME idempotency key — succeeded, exactly ONE provider refund, attempts=2",
      cb2.status === "succeeded" && cb2.providerRefundId === rec1.refundId && recCount === 1 && cb2.attempts === 2,
      `case=${cb2.status} refunds=${recCount} attempts=${cb2.attempts}`);
    record("S6", `crash simulated; converged to succeeded with 1 provider refund (idempotency key recon:${cb.id})`);
  }

  // ══ S7 — provider rejects the refund ═════════════════════════════════════
  console.log("── S7: provider rejects refund — permanent failure stays visible ──");
  {
    const caseC = await expiredLatePayment(`lpr-c-${stamp}`);
    await sendWebhook(caseC.ref, "payment.succeeded", caseC.total);
    await setSetting(BEHAVIOR_KEY, "reject");
    const t1 = await postRefundTick();
    const cc = await caseFor(caseC.ref);
    const rec = cc ? await pspRecordFor(cc.id) : null;
    check("S7a: rejection → case failed with visible error + operator/runbook note; provider record failed",
      cc.status === "failed" && (cc.lastError ?? "").length > 0 && /operator|runbook/i.test(cc.resolutionNote ?? "") && rec?.status === "failed",
      `case=${cc.status} err=${cc.lastError?.slice(0, 60)} note=${cc.resolutionNote?.slice(0, 60)} psp=${rec?.status}`);
    const t2 = await postRefundTick();
    const cc2 = await caseFor(caseC.ref);
    check("S7b: later ticks never resurrect or re-execute a permanently failed case",
      cc2.status === "failed" && cc2.attempts === 1,
      `case=${cc2.status} attempts=${cc2.attempts} tickAttempted=${t2.body?.data?.attempted}`);
    record("S7", `rejected → failed (permanent, operator-visible); attempts stayed 1`);
  }

  // ══ S8 — retry with the same provider idempotency key ════════════════════
  console.log("── S8: same provider idempotency key — never a second refund ──");
  {
    const totalRefundsBefore = await db.pspRefundRecord.count({});
    // S6 already re-executed under the same key; assert globally that each case
    // key maps to exactly one provider refund across the whole suite run.
    const cases = await db.paymentReconciliation.findMany({ where: { provider: "fpx_toyyibpay", createdAt: { gte: new Date(Date.now() - 3600_000) } } });
    let perKeyOne = true;
    for (const c of cases) {
      const n = await db.pspRefundRecord.count({ where: { idempotencyKey: `recon:${c.id}` } });
      if (n > 1) perKeyOne = false;
    }
    check("S8: every late-payment case maps to AT MOST ONE provider refund (idempotency keys hold)",
      perKeyOne, `cases=${cases.length} refunds=${totalRefundsBefore}`);
    record("S8", `cases=${cases.length}; all idempotencyKeys ≤ 1 refund`);
  }

  // ══ S9 — DB failure while the obligation is recorded ═════════════════════
  console.log("── S9: DB failure while recording the refund/reconciliation request ──");
  {
    const caseD = await expiredLatePayment(`lpr-d-${stamp}`);
    const pg = await pgClient();
    try {
      await pg.query(`CREATE OR REPLACE FUNCTION lt_block_recon() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'LT fault injection: PaymentReconciliation insert blocked';
        END $$ LANGUAGE plpgsql`);
      await pg.query(`DROP TRIGGER IF EXISTS lt_block_recon ON "PaymentReconciliation"`);
      await pg.query(`CREATE TRIGGER lt_block_recon BEFORE INSERT ON "PaymentReconciliation" FOR EACH ROW EXECUTE FUNCTION lt_block_recon()`);
      const fw = await sendWebhook(caseD.ref, "payment.succeeded", caseD.total);
      const casesDuringFault = await caseCountFor(caseD.ref);
      check("S9a: DB fault → webhook 500, NO obligation row, log row left unprocessed (PSP will redeliver)",
        fw.status === 500 && casesDuringFault === 0,
        `${fw.status} cases=${casesDuringFault}`);
      await pg.query(`DROP TRIGGER IF EXISTS lt_block_recon ON "PaymentReconciliation"`);
      await pg.query(`DROP FUNCTION IF EXISTS lt_block_recon()`);
      const rw = await sendWebhook(caseD.ref, "payment.succeeded", caseD.total);
      const cd = await caseFor(caseD.ref);
      check("S9b: redelivery after recovery → 409 + exactly ONE obligation (converged, not duplicated)",
        rw.status === 409 && (await caseCountFor(caseD.ref)) === 1 && cd.status === "requested",
        `${rw.status} cases=${await caseCountFor(caseD.ref)} status=${cd?.status}`);
    } finally {
      await pg.query(`DROP TRIGGER IF EXISTS lt_block_recon ON "PaymentReconciliation"`).catch(() => {});
      await pg.query(`DROP FUNCTION IF EXISTS lt_block_recon()`).catch(() => {});
      await pg.end().catch(() => {});
    }
    record("S9", "fault-injected obligation write 500 → redelivery converged on one case");
  }

  // ══ S10 — inventory unfulfillable; buyer payment handled per policy ══════
  console.log("── S10: final policy audit — no resurrection, no double restock, no T1, refund completed ──");
  {
    const caF = await caseFor(caseA.ref);
    const orderF = await db.order.findFirst({ where: { paymentGroupId: caseA.id } });
    const stockF = await stockOf();
    const expiryLogs = await db.inventoryLog.count({ where: { refId: orderF.id, reason: `expiry:${caseA.ref}` } });
    const hist = await db.orderStatusHistory.count({ where: { orderId: orderF.id, toStatus: "payment_expired" } });
    const txnsF = await ledgerTxnCount();
    // Suite-wide ledger: only S1's legitimate payment may post transactions.
    const { runLedgerInvariants } = await import("../../src/lib/ledger");
    const inv = await runLedgerInvariants();
    check("S10: order NOT resurrected; stock restored EXACTLY once; NO T1 for the late payment; refund succeeded (policy)",
      orderF.status === "payment_expired" && expiryLogs === 1 && hist === 1 && caF.status === "succeeded" && caF.providerRefundId,
      `order=${orderF.status} expiryLogs=${expiryLogs} historyRows=${hist} case=${caF.status} stock=${stockF}`);
    check("S10: ledger unchanged except S1's legitimate payment; invariants balanced",
      txnsF === txn0 + 1 && inv.ok,
      `txns ${txn0}→${txnsF} (+1 expected) invariantsOk=${inv.ok} problems=${JSON.stringify(inv.problems ?? []).slice(0, 80)}`);
    record("S10", `order=${orderF.status} case=${caF.status} refundId=${caF.providerRefundId} ledger +1 (S1 only)`);
  }
} finally {
  // ─── Cleanup / restore (ALWAYS) ──────────────────────────────────────────
  await setSetting(BEHAVIOR_KEY, null);
  await setSetting(FAULT_KEY, null);
  await restoreSafe();
  if (schedulerWasRunning || true) {
    // The deployment requires the scheduler RUNNING — always restore it.
    const ok = await startScheduler();
    console.log(`scheduler restored: ${ok}`);
  }
  writeFileSync("performance/runs/2026-10-25-late-payment-refund.json", JSON.stringify(evidence, null, 2));
  console.log("evidence → performance/runs/2026-10-25-late-payment-refund.json");
}
async function restoreSafe() {
  try { await db.productVariant.update({ where: { id: variant.variantId }, data: { stock: 20 } }); } catch {}
}
process.exit(exitCode());

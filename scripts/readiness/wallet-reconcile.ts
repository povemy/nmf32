// ============================================================================
// WALLET CACHE RECONCILIATION UTILITY (mission: wallet-ledger drift)
// ----------------------------------------------------------------------------
// Read-only by DEFAULT. Compares every seller Wallet's cached balances against
// an INDEPENDENT recomputation from the authoritative double-entry ledger, and
// classifies any mismatch:
//
//   MATCH                 cache == ledger truth now
//   STALE_TIME_MATURITY   totals equal; cache == truth as-of wallet.updatedAt;
//                         mismatch fully explained by holds (availableAt) that
//                         matured after the last cache write → benign staleness,
//                         self-heals on next wallet-affecting event / read.
//   STALE_UNEXPLAINED     totals equal but staleness NOT explained by updatedAt
//                         → needs investigation before any repair.
//   CACHE_VALUE_DRIFT     totals DIFFER (cache lost/gained value vs ledger)
//                         → repairable from truth, but signals a writer defect;
//                         flagged for investigation.
//
// Repair (--apply) rewrites ONLY the derived cache columns from ledger truth.
// It never edits ledger lines/transactions, never fabricates history, and is
// idempotent by construction (re-running writes the same derived values).
// A wallet whose LEDGER itself fails double-entry balance is refused repair.
//
// Usage:
//   bun scripts/readiness/wallet-reconcile.ts                    # audit all wallets (read-only)
//   bun scripts/readiness/wallet-reconcile.ts --wallet <id>      # deep-dive one wallet (event replay)
//   bun scripts/readiness/wallet-reconcile.ts --json <path>      # write evidence JSON (with any mode)
//   bun scripts/readiness/wallet-reconcile.ts --apply --wallet <id> --confirm <id>
//   bun scripts/readiness/wallet-reconcile.ts --apply --all-wallets --confirm ALL
//
// Safety rails:
//   • No write happens without --apply AND a matching --confirm value.
//   • The DB identity (host/db, no credentials) is printed before any apply.
//   • Bounded: audit loads only payable-account lines; deep-dive caps event
//     listings (full data still goes into the JSON evidence file).
// ============================================================================
// @ts-nocheck
import { db } from "../../src/lib/db";
import { walletTruth, ACCOUNTS } from "../../src/lib/ledger";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const val = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const WALLET_ARG = val("--wallet");
const APPLY = flag("--apply");
const ALL_WALLETS = flag("--all-wallets");
const CONFIRM = val("--confirm");
const JSON_OUT = val("--json");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- independent truth via raw SQL
// Deliberately NOT the app's walletTruth(): a second, SQL-side derivation of
// the same authoritative rules (credits mature when availableAt <= now;
// available = matured − debits; pending = credits − matured). If the two
// ever disagree, the FORMULA itself is suspect — exactly what the mission
// asks us to avoid assuming.
async function sqlTruth(accountCode: string) {
  const url = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
  const u = new URL(url);
  const dbId = `${u.host}${u.pathname}`;
  // Independent SQL-side derivation via $queryRaw (server-side aggregation,
  // separate code path from walletTruth's Node loop — one client, so the
  // utility respects the measured Supavisor 15-client session budget when
  // multiple audits/applies run concurrently).
  const rows = await db.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM(CASE WHEN "direction"='credit' THEN "amountMinor" ELSE 0 END),0)::int AS "credits",
       COALESCE(SUM(CASE WHEN "direction"='debit'  THEN "amountMinor" ELSE 0 END),0)::int AS "debits",
       COALESCE(SUM(CASE WHEN "direction"='credit' AND ("availableAt" IS NULL OR "availableAt" <= NOW()) THEN "amountMinor" ELSE 0 END),0)::int AS "matured",
       COUNT(*)::int AS "lines",
       COUNT(DISTINCT "currency")::int AS "currencies",
       COUNT(DISTINCT "walletId")::int AS "walletIds",
       MAX("availableAt") AS "maxHold"
     FROM "LedgerLine" WHERE "accountCode" = $1`,
    accountCode
  );
  const row: any = Array.isArray(rows) ? rows[0] : rows;
  return {
    dbId,
    credits: Number(row.credits),
    debits: Number(row.debits),
    matured: Number(row.matured),
    lines: Number(row.lines),
    currencies: Number(row.currencies),
    walletIds: Number(row.walletIds),
    maxHold: row.maxHold,
    available: Number(row.matured) - Number(row.debits),
    pending: Number(row.credits) - Number(row.matured),
  };
}

// ---------------------------------------------------------------- classification
function truthAsOf(lines, at: Date) {
  let matured = 0, total = 0, debits = 0;
  for (const l of lines) {
    if (l.direction === "credit") {
      total += l.amountMinor;
      if (!l.availableAt || new Date(l.availableAt) <= at) matured += l.amountMinor;
    } else debits += l.amountMinor;
  }
  return { available: matured - debits, pending: total - matured, total: total - debits };
}

function classify(cacheAvail: number, cachePend: number, truthNow: { available: number; pending: number }, truthAtUpdate: { available: number; pending: number } | null) {
  const totalsEqual = cacheAvail + cachePend === truthNow.available + truthNow.pending;
  if (cacheAvail === truthNow.available && cachePend === truthNow.pending) return "MATCH";
  if (!totalsEqual) return "CACHE_VALUE_DRIFT";
  if (truthAtUpdate && truthAtUpdate.available === cacheAvail && truthAtUpdate.pending === cachePend) return "STALE_TIME_MATURITY";
  return "STALE_UNEXPLAINED";
}

// ---------------------------------------------------------------- audit one wallet
async function auditWallet(w, deep: boolean) {
  const payable = ACCOUNTS.sellerPayable(w.id);
  const t0 = Date.now();
  const [truth, sql, lines] = await Promise.all([
    walletTruth(w.id),
    sqlTruth(payable),
    db.ledgerLine.findMany({
      where: { accountCode: payable },
      select: { id: true, direction: true, amountMinor: true, availableAt: true, currency: true, walletId: true, txnId: true, createdAt: true, txn: { select: { txnType: true, occurredAt: true, refType: true, refId: true } } },
      orderBy: [{ txn: { occurredAt: "asc" } }, { createdAt: "asc" }],
    }),
  ]);
  const ms = Date.now() - t0;

  // Cross-validate the two independent derivations.
  const formulaAgrees =
    truth.availableMinor === sql.available &&
    truth.pendingMinor === sql.pending;

  // As-of truth at the cache's last write (small ±2 s tolerance for the gap
  // between `new Date()` inside the refresh and the row's updatedAt stamp).
  const truthAtUpdate = truthAsOf(lines, new Date(w.updatedAt));
  const truthAtUpdatePlus = truthAsOf(lines, new Date(new Date(w.updatedAt).getTime() + 2000));
  const explained =
    truthAtUpdate.available === w.availableMinor && truthAtUpdate.pending === w.pendingMinor
      ? truthAtUpdate
      : truthAtUpdatePlus.available === w.availableMinor && truthAtUpdatePlus.pending === w.pendingMinor
        ? truthAtUpdatePlus
        : null;

  const classification = classify(w.availableMinor, w.pendingMinor, { available: truth.availableMinor, pending: truth.pendingMinor }, explained);

  // Holds that matured strictly after the last cache write (the drift payload).
  const maturedSinceWrite = lines.filter(
    (l) => l.direction === "credit" && l.availableAt && new Date(l.availableAt) > new Date(w.updatedAt) && new Date(l.availableAt) <= new Date()
  );
  const maturedSinceWriteSum = maturedSinceWrite.reduce((s, l) => s + l.amountMinor, 0);

  const result = {
    walletId: w.id,
    sellerId: w.sellerId,
    sellerName: w.seller?.displayName ?? null,
    storeName: w.seller?.store?.name ?? null,
    currency: w.currency,
    cached: { available: w.availableMinor, pending: w.pendingMinor, lifetimeEarned: w.lifetimeEarnedMinor, lifetimeCommission: w.lifetimeCommissionMinor, updatedAt: w.updatedAt },
    appTruth: { available: truth.availableMinor, pending: truth.pendingMinor, lifetimeEarned: truth.lifetimeEarnedMinor, lifetimeCommission: truth.lifetimeCommissionMinor },
    sqlTruth: { available: sql.available, pending: sql.pending, credits: sql.credits, debits: sql.debits, matured: sql.matured, lines: sql.lines },
    crossValidation: { formulaAgrees, currencies: sql.currencies, walletIdsOnAccount: sql.walletIds },
    drift: { available: w.availableMinor - truth.availableMinor, pending: w.pendingMinor - truth.pendingMinor, totalCacheMinusTruth: w.availableMinor + w.pendingMinor - truth.availableMinor - truth.pendingMinor },
    classification,
    stalenessEvidence: {
      holdsMaturedAfterLastWrite: maturedSinceWrite.length,
      holdsMaturedAfterLastWriteSum: maturedSinceWriteSum,
      truthAsOfUpdatedAt: explained ?? truthAtUpdate,
      explainedByUpdatedAt: Boolean(explained),
    },
    auditMs: ms,
  };

  if (deep) {
    // Chronological replay of the wallet's payable account.
    const events: any[] = [];
    let running = truthAsOf([], new Date(0));
    const byTxn = new Map<string, any[]>();
    for (const l of lines) {
      const k = l.txnId;
      if (!byTxn.has(k)) byTxn.set(k, []);
      byTxn.get(k).push(l);
    }
    for (const [txnId, txLines] of byTxn) {
      const at = new Date(txLines[0].txn.occurredAt);
      running = truthAsOf(
        lines.filter((l) => new Date(l.txn.occurredAt) <= at),
        at
      );
      events.push({
        txnId,
        txnType: txLines[0].txn.txnType,
        occurredAt: txLines[0].txn.occurredAt,
        refType: txLines[0].txn.refType,
        refId: txLines[0].txn.refId,
        lines: txLines.map((l) => ({ direction: l.direction, amountMinor: l.amountMinor, availableAt: l.availableAt, memo: l.memo })),
        walletStateAsOfThisEvent: running,
      });
    }
    (result as any).eventReplay = events;
    (result as any).deep = {
      cacheEqualsTruthAsOfUpdatedAt: Boolean(explained),
      lastRefreshAt: w.updatedAt,
      note: explained
        ? "Cache equals ledger truth recomputed as-of the cache's last write → the cache was CORRECT when written; the mismatch is purely holds maturing by clock afterwards."
        : "Cache does NOT equal truth as-of its last write → investigate writer visibility/concurrency.",
    };
  }
  return result;
}

// ---------------------------------------------------------------- main
const mode = APPLY ? "APPLY" : WALLET_ARG ? "DEEP-AUDIT" : "AUDIT";
console.log(`wallet-reconcile — mode: ${mode}${APPLY ? " (WRITES ENABLED)" : " (read-only)"}`);

if (APPLY && !WALLET_ARG && !ALL_WALLETS) {
  console.error("--apply requires --wallet <id> or --all-wallets");
  process.exit(2);
}
if (APPLY && CONFIRM !== (ALL_WALLETS ? "ALL" : WALLET_ARG)) {
  console.error(`--apply requires --confirm ${ALL_WALLETS ? "ALL" : WALLET_ARG} (value must equal the repair target)`);
  process.exit(2);
}

const url = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
const u = new URL(url);
console.log(`database: ${u.host}${u.pathname} (credentials omitted)`);

// Gate: the LEDGER itself must be balanced before any cache repair is legal.
const txns = await db.ledgerTransaction.findMany({ include: { lines: true } });
const unbalanced = txns.filter((t) => {
  const d = t.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
  const c = t.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
  return d !== c;
});
check("ledger double-entry balance (all transactions)", unbalanced.length === 0, unbalanced.length ? `${unbalanced.length} unbalanced: ${unbalanced.slice(0, 3).map((t) => t.id).join(",")}` : `${txns.length} txns checked`);
if (APPLY && unbalanced.length > 0) {
  console.error("REFUSING APPLY: ledger has unbalanced transactions — cache repair would mask a ledger defect. Produce a ledger-repair plan instead.");
  process.exit(3);
}

const walletInclude = { seller: { select: { displayName: true, email: true, store: { select: { name: true } } } } };
const wallets = WALLET_ARG
  ? await db.wallet.findMany({ where: { id: WALLET_ARG }, include: walletInclude })
  : await db.wallet.findMany({ include: walletInclude });

if (WALLET_ARG && wallets.length === 0) {
  console.error(`wallet ${WALLET_ARG} not found`);
  process.exit(2);
}

const results: any[] = [];
const repairs: any[] = [];

for (const w of wallets) {
  const r = await auditWallet(w, mode === "DEEP-AUDIT");
  results.push(r);
  const label = `${r.sellerName ?? w.id} (${w.id})`;
  console.log(
    `\nwallet ${label} [${r.currency}] store=${r.storeName ?? "?"}\n` +
      `  cached    available=${r.cached.available}  pending=${r.cached.pending}  (cache written ${new Date(r.cached.updatedAt).toISOString()})\n` +
      `  app-truth available=${r.appTruth.available}  pending=${r.appTruth.pending}\n` +
      `  sql-truth available=${r.sqlTruth.available}  pending=${r.sqlTruth.pending}  lines=${r.sqlTruth.lines} credits=${r.sqlTruth.credits} debits=${r.sqlTruth.debits} matured=${r.sqlTruth.matured}\n` +
      `  cross-validation: formulaAgrees=${r.crossValidation.formulaAgrees} currencies=${r.crossValidation.currencies} foreignWalletLines=${r.crossValidation.walletIdsOnAccount > 1 ? r.crossValidation.walletIdsOnAccount : 0}\n` +
      `  drift: available ${r.drift.available >= 0 ? "+" : ""}${r.drift.available}, pending ${r.drift.pending >= 0 ? "+" : ""}${r.drift.pending}, total ${r.drift.totalCacheMinusTruth >= 0 ? "+" : ""}${r.drift.totalCacheMinusTruth}\n` +
      `  classification: ${r.classification}` +
      (r.stalenessEvidence.holdsMaturedAfterLastWrite ? ` — ${r.stalenessEvidence.holdsMaturedAfterLastWrite} hold(s) worth ${r.stalenessEvidence.holdsMaturedAfterLastWriteSum} matured after last cache write` : "")
  );
  if (mode === "DEEP-AUDIT") {
    console.log(`  as-of analysis: ${r.deep.note}`);
    for (const ev of r.eventReplay.slice(-15)) {
      console.log(`    ${new Date(ev.occurredAt).toISOString()}  ${ev.txnType.padEnd(18)} ref=${ev.refType ?? "-"}:${(ev.refId ?? "-").slice(0, 12)}  → asOf(avail=${ev.walletStateAsOfThisEvent.available}, pend=${ev.walletStateAsOfThisEvent.pending})`);
      for (const l of ev.lines) console.log(`        ${l.direction.padEnd(6)} ${String(l.amountMinor).padStart(8)}  availableAt=${l.availableAt ? new Date(l.availableAt).toISOString() : "—"}  ${l.memo ?? ""}`);
    }
  }

  if (APPLY && r.classification !== "MATCH") {
    if (r.classification === "STALE_UNEXPLAINED") {
      console.log(`  SKIP repair (STALE_UNEXPLAINED — investigate first; re-run with --wallet for the event replay)`);
      continue;
    }
    // Repair = write the EXACT derived truth (not a delta) → idempotent.
    const before = { available: w.availableMinor, pending: w.pendingMinor };
    await db.wallet.update({
      where: { id: w.id },
      data: {
        availableMinor: r.appTruth.available,
        pendingMinor: r.appTruth.pending,
        lifetimeEarnedMinor: r.appTruth.lifetimeEarned,
        lifetimeCommissionMinor: r.appTruth.lifetimeCommission,
      },
    });
    const after = await db.wallet.findUnique({ where: { id: w.id } });
    const postOk = after.availableMinor === r.appTruth.available && after.pendingMinor === r.appTruth.pending;
    check(`repair ${label} (cache ← truth)`, postOk, `before(avail=${before.available},pend=${before.pending}) → after(avail=${after.availableMinor},pend=${after.pendingMinor})`);
    repairs.push({ walletId: w.id, classification: r.classification, before, after: { available: after.availableMinor, pending: after.pendingMinor }, truth: r.appTruth, verified: postOk });
  }
}

// ---------------------------------------------------------------- collection summary
const matched = results.filter((r) => r.classification === "MATCH").length;
const drifted = results.filter((r) => r.classification !== "MATCH");
const sumAvailDrift = drifted.reduce((s, r) => s + r.drift.available, 0);
const sumPendDrift = drifted.reduce((s, r) => s + r.drift.pending, 0);
const sumTotalDrift = drifted.reduce((s, r) => s + r.drift.totalCacheMinusTruth, 0);
const byClass = drifted.reduce((m, r) => ((m[r.classification] = (m[r.classification] ?? 0) + 1), m), {} as Record<string, number>);

console.log(`\n=== AUDIT SUMMARY ===`);
console.log(`wallets examined: ${results.length}`);
console.log(`matching: ${matched}`);
console.log(`mismatched: ${drifted.length} ${JSON.stringify(byClass)}`);
console.log(`total available-balance drift (cache − truth): ${sumAvailDrift}`);
console.log(`total pending-balance drift (cache − truth): ${sumPendDrift}`);
console.log(`unexplained combined-total drift: ${sumTotalDrift}`);
if (mode === "DEEP-AUDIT" || WALLET_ARG) {
  const target = results[0];
  if (target) {
    console.log(`\nREPORTED-INCIDENT CHECK (wallet cmvizi0ms000zq7niql6b3csg):`);
    if (WALLET_ARG === "cmvizi0ms000zq7niql6b3csg") {
      console.log(`  reported cached: available=0 pending=95292 | truth: available=10764 pending=84528 (Δ ±10764, totals 95292 both)`);
      console.log(`  now-measured cached: available=${target.cached.available} pending=${target.cached.pending} | truth: available=${target.appTruth.available} pending=${target.appTruth.pending} | classification=${target.classification}`);
    }
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), mode, database: `${u.host}${u.pathname}`, summary: { walletsExamined: results.length, matching: matched, mismatched: drifted.length, byClass, sumAvailDrift, sumPendDrift, sumTotalDrift, unbalancedTxns: unbalanced.length }, repairs, wallets: results }, null, 2));
  console.log(`\nevidence JSON written: ${JSON_OUT}`);
}

process.exit(failures === 0 ? 0 : 1);

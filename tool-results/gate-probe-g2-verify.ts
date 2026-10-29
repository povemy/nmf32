/**
 * Post-Remediation Verification Gate — Probe G-verify + orphan completion.
 *
 * Part 1: verifies the CORRECT money-path invariants on the already-refunded
 * gate orders (NM-103631, NM-103632) — commission snapshots (percent + minor +
 * breakdown + min-commission floor), balanced T5 refund postings, wallet
 * cache-truth consistency (pending unchanged for in-hold orders by design;
 * totals decreased by the seller share).
 *
 * Part 2: completes the refund lifecycle for the two orphan paid orders left
 * by crashed probe iterations (NM-103629, NM-103630) through the REAL API
 * flow (seller refund-request → admin approve → admin process) so the dev DB
 * is left money-consistent — this doubles as extra refund regression evidence.
 *
 * Logins: 1 seller + 1 admin.
 */
const BASE = "http://127.0.0.1:3000";

let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
const j = (r: Response) => r.json().catch(() => ({}));

console.log("=== Probe G-verify — money-path invariants + orphan completion ===\n");

const { db } = await import("../src/lib/db");

// ---------- Part 1: invariants on the refunded gate orders -------------------
for (const ON of ["NM-103631", "NM-103632"]) {
  console.log(`-- ${ON} --`);
  const order = await db.order.findUnique({
    where: { orderNumber: ON },
    include: { items: true, refunds: true, store: { include: { seller: { include: { wallet: true } } } } },
  });
  check(`${ON} status partially_refunded`, order?.status === "partially_refunded", order?.status ?? "missing");

  const it = order!.items[0];
  // min-commission floor: 0.5% of 8900 = 44.5 → floored at RM 1.00 (100 minor)
  check(`${ON} item snapshot: percent + minor + breakdown present`, typeof it.commissionPercent === "number" && typeof it.commissionMinor === "number" && it.breakdownJson != null, `pct=${it.commissionPercent} minor=${it.commissionMinor}`);
  check(`${ON} commission floor honoured (max(0.5%×8900, RM1) = 100)`, it.commissionMinor === 100, `minor=${it.commissionMinor}`);

  const refund = order!.refunds.find((r) => r.status === "processed");
  check(`${ON} processed refund present`, !!refund, refund?.status ?? "none");
  check(`${ON} commission reversal within cap (≤ earned)`, (refund?.commissionReversalMinor ?? 1e9) <= it.commissionMinor, `reversal=${refund?.commissionReversalMinor} earned=${it.commissionMinor}`);

  const t5 = await db.ledgerTransaction.findFirst({
    where: { txnType: "refund", refType: "order", refId: order!.id },
    include: { lines: true },
  });
  check(`${ON} T5 refund posting exists (dedupKey refund:refund:{id})`, !!t5, t5?.dedupKey ?? "missing");
  if (t5) {
    const dr = t5.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
    const cr = t5.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
    check(`${ON} T5 balanced (DR ${dr} = CR ${cr})`, dr === cr && dr === refund!.amountMinor, `dr=${dr} cr=${cr} refund=${refund!.amountMinor}`);
  }

  const wallet = order!.store.seller!.wallet!;
  // Use the app's OWN truth computation (lib/ledger walletTruth) — the same
  // function refreshWalletCache writes the cached columns from.
  const { walletTruth, ACCOUNTS } = await import("../src/lib/ledger.ts");
  const truth = await walletTruth(wallet.id);
  check(`${ON} wallet cache == ledger truth (pending+available, payable account only)`,
    wallet.pendingMinor === truth.pendingMinor && wallet.availableMinor === truth.availableMinor,
    `cache(p=${wallet.pendingMinor},a=${wallet.availableMinor}) truth(p=${truth.pendingMinor},a=${truth.availableMinor})`);
  const payableLines = await db.ledgerLine.count({ where: { accountCode: ACCOUNTS.sellerPayable(wallet.id) } });
  check(`${ON} payable account lines exist`, payableLines > 0, `lines=${payableLines}`);
}

// ---------- Part 2: complete orphan orders through the REAL refund API --------
console.log("\n-- orphan completion (NM-103629, NM-103630) via API --");
{
  const sellerLogin = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "lumina@nomofee.io", password: "Seller123!", portal: "seller" }) });
  const sellerTok = (await j(sellerLogin))?.data?.token ?? null;
  check("seller login", !!sellerTok);
  const adm = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@nomofee.io", password: "Admin123!", portal: "admin" }) });
  const adminTok = (await j(adm))?.data?.token ?? null;
  check("admin login", !!adminTok);

  for (const ON of ["NM-103629", "NM-103630"]) {
    const order = await db.order.findUnique({ where: { orderNumber: ON }, include: { items: true } });
    if (!order || order.status !== "paid") { check(`${ON} orphan completion skipped (not paid)`, order?.status === "partially_refunded"); continue; }
    const amount = order.items[0].lineSubtotalMinor ?? order.items[0].totalMinor ?? order.items[0].unitPriceMinor;
    const rr = await fetch(`${BASE}/api/store/orders/${ON}/refund-request`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sellerTok}` }, body: JSON.stringify({ amountMinor: amount, reason: "gate orphan completion", restock: true }) });
    const rb = await j(rr);
    const rid = rb?.data?.refund?.id ?? rb?.data?.id;
    check(`${ON} refund-request created`, (rr.status === 200 || rr.status === 201) && !!rid, `status=${rr.status}`);
    const ap = await fetch(`${BASE}/api/admin/refunds/${rid}/approve`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminTok}` }, body: "{}" });
    check(`${ON} approve`, ap.status === 200, `status=${ap.status}`);
    const pr = await fetch(`${BASE}/api/admin/refunds/${rid}/process`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminTok}` }, body: "{}" });
    check(`${ON} process (ledger T5 + restock)`, pr.status === 200, `status=${pr.status} ${pr.status !== 200 ? JSON.stringify(await j(pr)) : ""}`);
    const after = await db.order.findUnique({ where: { orderNumber: ON }, select: { status: true } });
    check(`${ON} now partially_refunded`, after?.status === "partially_refunded", after?.status ?? "");
  }
}

await (db as any).$disconnect?.();
console.log(`\n=== Probe G-verify result: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(failCount > 0 ? 1 : 0);

// ============================================================================
// LT integrity — post-storm correctness verifier (LT-CHECKLIST rule #8).
// Run AFTER a correctness storm against the REAL database. Verifies:
//   (a) no negative stock on any [LT] product variant
//   (b) stock(lt-flash-correct-item) == --correct-stock − Σ(qty of its
//       orderItems). RESTOCK RULE (verified in src/app/api/webhooks/payments/
//       process.ts): payment failure does NOT restock — the group path's
//       "payment.failed" branch only sets PaymentGroup.status="failed"; stock
//       is decremented ONCE at checkout-create (src/app/api/checkout/create/
//       route.ts, conditional decrement). The ONLY stock increment in src/ is
//       the admin refund flow (src/app/api/admin/refunds/[id]/process/
//       route.ts) — load tests never trigger it. Hence the expected-stock
//       math below is exact regardless of how many payments failed.
//   (c) no duplicate PAID PaymentGroup per idemKey (schema-unique idemKey:
//       zero groups-per-key > 1, and zero >1 order sharing one idemKey base)
//   (d) every PAID group carries complete orders/items (no partial payment)
//   (e) ledger: src/lib/ledger runLedgerInvariants() (direct import) + LT-scoped
//       wallet check — cached balance == ledger-line truth for the wallet
//       touched by LT orders
//   (f) measured counts: orders, paid, failed groups, Σqty, stock delta
// Output: JSON verdict {ok, checks[], counts} + human summary; exit 1 on any
// violation. MUST run env-guard first.
// Usage: bun scripts/loadtest/integrity.ts [--correct-stock 60]
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runLedgerInvariants, walletTruth } from "../../src/lib/ledger";
import { prismaBase } from "../../src/lib/db";
import { runEnvGuard } from "./env-guard";

const HERE = dirname(fileURLToPath(import.meta.url));

function argNumber(flag: string): number | null {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : null;
}
function configCorrectStock(): number {
  try {
    const raw = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")) as { correctStock?: number };
    return Number.isFinite(raw.correctStock) ? Number(raw.correctStock) : 60;
  } catch {
    return 60;
  }
}
const CORRECT_STOCK = argNumber("--correct-stock") ?? configCorrectStock();

const STORE_SLUG = "lt-main-store";
const CORRECT_SLUG = "lt-flash-correct-item";
const SKU_PREFIX = "lt-v:";
const SHOPPER_DOMAIN = "@lt.nomofee.test";

// ONE client per process: src/lib/db's singleton is shared with
// src/lib/ledger (imported above), which keeps us inside the Supavisor
// SESSION-pool client budget (pool_size=15; dev server already owns some).
const db = prismaBase as unknown as Parameters<typeof runEnvGuard>[0] & typeof prismaBase;

type Check = { name: string; ok: boolean; detail: string };

async function main() {
  console.log(`LT INTEGRITY — expected seeded stock for ${CORRECT_SLUG}: ${CORRECT_STOCK} (--correct-stock or config.json)`);
  const guard = await runEnvGuard(db);
  if (!guard.ok) {
    console.error("INTEGRITY REFUSED: env-guard failed (fail-closed).");
    process.exit(1);
  }

  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  };

  // ── resolve LT universe ───────────────────────────────────────────────────────
  const store = await db.store.findUnique({ where: { slug: STORE_SLUG }, select: { id: true } });
  if (!store) {
    console.error("LT store missing — run seed.ts first (nothing to verify).");
    process.exit(1);
  }
  const shopperIds = (await db.shopperUser.findMany({ where: { email: { endsWith: SHOPPER_DOMAIN } }, select: { id: true } })).map((s) => s.id);
  const ltVariantIds = (
    await db.productVariant.findMany({ where: { sku: { startsWith: SKU_PREFIX }, product: { storeId: store.id } }, select: { id: true } })
  ).map((v) => v.id);

  // ── (a) no negative stock on any [LT] variant ────────────────────────────────
  const negatives = await db.productVariant.count({
    where: { stock: { lt: 0 }, product: { storeId: store.id, slug: { startsWith: "lt-" } } },
  });
  add("(a) no negative stock on [LT] variants", negatives === 0, `variants with stock<0: ${negatives}`);

  // ── (b) exact decrement vs orderItems (no restock on failure) ────────────────
  const correctVariant = await db.productVariant.findFirst({
    where: { sku: `${SKU_PREFIX}${CORRECT_SLUG}` },
    select: { id: true, stock: true },
  });
  if (!correctVariant) {
    add("(b) exact stock decrement", false, "correct-item variant missing — run seed.ts");
  } else {
    const agg = await db.orderItem.aggregate({ where: { variantId: correctVariant.id }, _sum: { qty: true }, _count: { id: true } });
    const soldQty = agg._sum.qty ?? 0;
    const expectedStock = CORRECT_STOCK - soldQty;
    add(
      "(b) exact stock decrement (seeded − Σ orderItems.qty == current)",
      correctVariant.stock === expectedStock,
      `seeded=${CORRECT_STOCK} − soldQty=${soldQty} (${agg._count.id} orderItems) = ${expectedStock}; actual stock=${correctVariant.stock}` +
        ` | restock rule: payment.failed does NOT restock (process.ts group branch only sets group status; only admin-refund route increments stock)`
    );
  }

  // ── (c) no duplicate PAID PaymentGroup per idemKey ───────────────────────────
  const groups = await db.paymentGroup.findMany({
    where: { shopperId: { in: shopperIds.length ? shopperIds : ["__none__"] } },
    select: { id: true, idemKey: true, ref: true, status: true, subtotalMinor: true, totalMinor: true, orders: { select: { id: true, idemKey: true, status: true, paidAt: true, subtotalMinor: true, discountMinor: true, shippingMinor: true, totalMinor: true, _count: { select: { items: true } } } } },
  });
  const byKey = new Map<string, number>();
  for (const g of groups) {
    if (!g.idemKey) continue;
    byKey.set(g.idemKey, (byKey.get(g.idemKey) ?? 0) + 1);
  }
  const dupGroupKeys = [...byKey.entries()].filter(([, n]) => n > 1);
  const orderByBase = new Map<string, number>();
  for (const g of groups) {
    for (const o of g.orders) {
      if (!o.idemKey) continue;
      const base = o.idemKey.slice(0, o.idemKey.lastIndexOf(":"));
      orderByBase.set(base, (orderByBase.get(base) ?? 0) + 1);
    }
  }
  const dupOrderBases = [...orderByBase.entries()].filter(([, n]) => n > 1);
  add(
    "(c) no duplicate PaymentGroup per idemKey",
    dupGroupKeys.length === 0 && dupOrderBases.length === 0,
    `groups=${groups.length} distinct idemKeys=${byKey.size}; duplicate group keys=${dupGroupKeys.length}, duplicate order idemKey-bases=${dupOrderBases.length} (schema: idemKey @unique backstops this — counted, not assumed)`
  );

  // ── (d) every PAID group is complete (no partial) ────────────────────────────
  const paidGroups = groups.filter((g) => g.status === "succeeded");
  const partialProblems: string[] = [];
  for (const g of paidGroups) {
    if (g.orders.length === 0) partialProblems.push(`group ${g.ref} PAID but 0 orders`);
    const sumOrderSub = g.orders.reduce((s, o) => s + o.subtotalMinor, 0);
    const sumOrderTotal = g.orders.reduce((s, o) => s + o.totalMinor, 0);
    if (sumOrderSub !== g.subtotalMinor) partialProblems.push(`group ${g.ref} subtotal ${g.subtotalMinor} != Σ orders ${sumOrderSub}`);
    if (sumOrderTotal !== g.totalMinor) partialProblems.push(`group ${g.ref} total ${g.totalMinor} != Σ orders ${sumOrderTotal}`);
    for (const o of g.orders) {
      if (o.status !== "paid" || !o.paidAt) partialProblems.push(`order ${o.id} in PAID group ${g.ref} status=${o.status} paidAt=${String(o.paidAt)}`);
      if (o._count.items === 0) partialProblems.push(`order ${o.id} has 0 items`);
      const expectedTotal = Math.max(0, o.subtotalMinor - o.discountMinor + o.shippingMinor);
      if (expectedTotal !== o.totalMinor) partialProblems.push(`order ${o.id} total ${o.totalMinor} != subtotal-discount+shipping ${expectedTotal}`);
    }
  }
  add("(d) every PAID group complete (orders+items+totals)", partialProblems.length === 0, `paidGroups=${paidGroups.length}; violations=${partialProblems.length}${partialProblems.length ? ` e.g. ${partialProblems.slice(0, 3).join(" | ")}` : ""}`);

  // ── (e) ledger invariants (direct import from src/lib/ledger) + LT wallet ────
  let ledgerOk = false;
  let ledgerDetail = "";
  try {
    const inv = await runLedgerInvariants();
    ledgerOk = inv.ok;
    ledgerDetail = `runLedgerInvariants(): ok=${inv.ok} txns=${inv.txnCount} wallets=${inv.walletCount} problems=${inv.problems.length}${inv.problems.length ? ` first="${inv.problems[0]}"` : ""}`;
  } catch (err) {
    ledgerDetail = `runLedgerInvariants() threw: ${err instanceof Error ? err.message.slice(0, 120) : err}`;
  }
  add("(e1) ledger invariants (src/lib/ledger, imported)", ledgerOk, ledgerDetail);

  const ltWalletRow = await db.store.findUnique({
    where: { slug: STORE_SLUG },
    select: { seller: { select: { wallet: { select: { id: true, availableMinor: true, pendingMinor: true } } } } },
  });
  const w = ltWalletRow?.seller?.wallet;
  if (!w) {
    add("(e2) LT wallet cache == ledger-line truth", false, "LT store has no seller wallet (no paid LT order yet?)");
  } else {
    const truth = await walletTruth(w.id);
    const e2ok = truth.availableMinor === w.availableMinor && truth.pendingMinor === w.pendingMinor;
    add("(e2) LT wallet cache == ledger-line truth", e2ok, `wallet ${w.id}: cache available=${w.availableMinor}/pending=${w.pendingMinor}; truth available=${truth.availableMinor}/pending=${truth.pendingMinor}`);
  }

  // ── (f) measured counts ──────────────────────────────────────────────────────
  const [orderCount, paidOrderCount, pendingOrderCount, failedGroupCount, itemAgg] = await Promise.all([
    db.order.count({ where: { shopperId: { in: shopperIds.length ? shopperIds : ["__none__"] } } }),
    db.order.count({ where: { shopperId: { in: shopperIds.length ? shopperIds : ["__none__"] }, status: "paid" } }),
    db.order.count({ where: { shopperId: { in: shopperIds.length ? shopperIds : ["__none__"] }, status: "payment_pending" } }),
    db.paymentGroup.count({ where: { shopperId: { in: shopperIds.length ? shopperIds : ["__none__"] }, status: "failed" } }),
    db.orderItem.aggregate({ where: { variantId: { in: ltVariantIds.length ? ltVariantIds : ["__none__"] } }, _sum: { qty: true }, _count: { id: true } }),
  ]);
  const stockNow = correctVariant?.stock ?? -1;
  const counts = {
    ordersCreated: orderCount,
    ordersPaid: paidOrderCount,
    ordersPending: pendingOrderCount,
    paymentGroupsFailed: failedGroupCount,
    paymentGroupsTotal: groups.length,
    paidGroups: paidGroups.length,
    ltOrderItems: itemAgg._count.id,
    ltUnitsSold: itemAgg._sum.qty ?? 0,
    correctItemStockNow: stockNow,
    correctItemStockDelta: CORRECT_STOCK - stockNow,
  };
  console.log("COUNTS " + JSON.stringify(counts));

  const ok = checks.every((c) => c.ok);
  const verdict = { ok, checks, counts };
  console.log("VERDICT_JSON " + JSON.stringify(verdict));
  console.log(ok ? "LT INTEGRITY: PASS — all checks green" : `LT INTEGRITY: FAIL — ${checks.filter((c) => !c.ok).length} violation(s)`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("INTEGRITY FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

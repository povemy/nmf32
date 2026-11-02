// RX-PRV Phase 2.2 — Fault-injected rollback tests at transaction boundaries.
// A) INVENTORY boundary: 2-line cart, line 2 has zero stock mid-tx ⇒ 409 ⇒
//    line 1's decrement, orders, items, inventoryLogs, ledger MUST all roll back.
// B) LEDGER boundary: a DB trigger faults the T1 INSERT inside the Serializable
//    success tx ⇒ webhook 500 ⇒ order stays unpaid, wallet untouched, cart line
//    survives, webhook log left processed=false ⇒ after removing the fault the
//    redelivery converges exactly-once.
// Test data tagged [LT]; stock restored; trigger dropped in finally.
// @ts-nocheck
import { db } from "../../src/lib/db";
import { LT, makeLtVariant, ltShopperCookie, checkout, sendWebhook, restoreVariant, cleanupCarts, check, summary, pgClient } from "./lib";

const stamp = Date.now().toString(36);
const shopperEmail = `lt-rollback-${stamp}@lt.test`;
const results = { runId: stamp, startedAt: new Date().toISOString(), tests: [] as any[] };

const cookie = await ltShopperCookie(shopperEmail, "LT Rollback Tester");

// ── A) INVENTORY BOUNDARY ────────────────────────────────────────────────────
console.log("── A) inventory-boundary rollback (line 2 out of stock) ──");
const va = await makeLtVariant(`rbA-${stamp}`, 10);
const vb = await makeLtVariant(`rbB-${stamp}`, 0);
const preStockA = (await db.productVariant.findUnique({ where: { id: va.variantId } }))!.stock;
const preLogs = await db.inventoryLog.count({ where: { variantId: va.variantId } });
const preLedger = await db.ledgerTransaction.count();
const preOrdersAll = await db.order.count({ where: { idemKey: { startsWith: `rb-${stamp}` } } });

// two-line checkout under ONE idempotency key: line 1 has stock, line 2 is out
const rBoth = await fetch(`${process.env.LT_BASE ?? "http://127.0.0.1:3000"}/api/checkout/create`, { // Phase 3/Step 4: staging instance override
  method: "POST",
  headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": `rb-both-${stamp}` },
  body: JSON.stringify({
    items: [{ variantId: va.variantId, qty: 1 }, { variantId: vb.variantId, qty: 1 }],
    customer: { name: "LT Buyer", email: shopperEmail },
    shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
    provider: "fpx_toyyibpay",
  }),
});
const rBothBody = await rBoth.json();
const stockAAfter = (await db.productVariant.findUnique({ where: { id: va.variantId } }))!.stock;
const logsAfter = await db.inventoryLog.count({ where: { variantId: va.variantId } });
const ledgerAfter = await db.ledgerTransaction.count();
const ordersForShopper = (await db.order.count({ where: { idemKey: { startsWith: `rb-${stamp}` } } })) - preOrdersAll;

const tA = [
  check("A1: zero-stock line rejected 409 OUT_OF_STOCK", rBoth.status === 409 && rBothBody?.error?.code === "OUT_OF_STOCK", `${rBoth.status} ${rBothBody?.error?.code ?? ""}`),
  check("A2: line-1 stock unchanged (decrement rolled back)", stockAAfter === preStockA, `pre=${preStockA} after=${stockAAfter}`),
  check("A3: no inventoryLog written", logsAfter === preLogs, `pre=${preLogs} after=${logsAfter}`),
  check("A4: no ledger rows written", ledgerAfter === preLedger, `pre=${preLedger} after=${ledgerAfter}`),
  check("A5: no order rows persisted", ordersForShopper === 0, `count=${ordersForShopper}`),
];
results.tests.push({ test: "A_inventory_boundary_rollback", checks: tA, httpStatus: rBoth.status });

// ── B) LEDGER BOUNDARY (trigger fault injection inside the success tx) ──────
console.log("── B) ledger-boundary rollback (T1 insert faulted by trigger) ──");
const vb2 = await makeLtVariant(`rbC-${stamp}`, 5);
const preStockC = (await db.productVariant.findUnique({ where: { id: vb2.variantId } }))!.stock;
const rc = await checkout(cookie, vb2.variantId, `rb-c-${stamp}`, 1);
if (rc.status !== 201) { console.log("FATAL: setup checkout failed", rc.status, rc.body); process.exit(2); }
const refC = rc.body.data.paymentRef as string;
const grpC = await db.paymentGroup.findUnique({ where: { ref: refC }, include: { orders: true } });
const orderIdC = grpC!.orders[0].id;
// seed a REAL cart line for this variant so cart-clearing rollback is testable
// (checkout takes items in the request body; the cart is only cleared by the
// success webhook — selection-aware)
const ltShopperRow = await db.shopperUser.findUnique({ where: { email: shopperEmail } });
const ltCart = await db.cart.create({ data: { token: `lt-cart-${stamp}`, shopperId: ltShopperRow!.id } });
await db.cartItem.create({ data: { cartId: ltCart.id, variantId: vb2.variantId, qty: 1, selected: true } });
const preLedgerB = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${orderIdC}` } });
if (preLedgerB !== 0) { console.log("FATAL: T1 already present before webhook"); process.exit(2); }

const pg = await pgClient();
let faultedStatus = 0, faultedBody: any = {};
try {
  await pg.query(`
    CREATE OR REPLACE FUNCTION lt_fault_t1() RETURNS trigger AS $$
    BEGIN
      IF NEW."dedupKey" = 'order_paid:order:${orderIdC}' THEN
        RAISE EXCEPTION 'LT_FAULT_INJECTION ledger boundary';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;`);
  await pg.query(`DROP TRIGGER IF EXISTS lt_fault_t1_trg ON "LedgerTransaction";`);
  await pg.query(`CREATE TRIGGER lt_fault_t1_trg BEFORE INSERT ON "LedgerTransaction" FOR EACH ROW EXECUTE FUNCTION lt_fault_t1();`);

  const group = await db.paymentGroup.findUnique({ where: { ref: refC } });
  const t0 = performance.now();
  const wf = await sendWebhook(refC, "payment.succeeded", group!.totalMinor);
  faultedStatus = wf.status; faultedBody = wf.body;
  const faultMs = Math.round(performance.now() - t0);

  const orderAfter = await db.order.findUnique({ where: { id: orderIdC } });
  const t1Count = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${orderIdC}` } });
  const webhookLog = await db.paymentWebhookLog.findFirst({ where: { providerRef: refC, eventType: "payment.succeeded" }, orderBy: { createdAt: "desc" } });
  const cartItems = await db.cartItem.count({ where: { cartId: ltCart.id, variantId: vb2.variantId } });

  const tB1 = [
    check("B1: faulted webhook does NOT report success", faultedStatus !== 200, `status=${faultedStatus} ms=${faultMs}`),
    check("B2: order stays payment_pending (tx rolled back)", orderAfter?.status === "payment_pending", `status=${orderAfter?.status}`),
    check("B3: no T1 ledger posting", t1Count === 0, `t1=${t1Count}`),
    check("B4: webhook log left processed=false (retryable)", webhookLog?.processed === false, `processed=${webhookLog?.processed}`),
    check("B5: cart line survives (cart clearing rolled back)", cartItems === 1, `cartItems=${cartItems}`),
  ];
  results.tests.push({ test: "B_ledger_boundary_fault", checks: tB1, httpStatus: faultedStatus, faultMs });
} finally {
  await pg.query(`DROP TRIGGER IF EXISTS lt_fault_t1_trg ON "LedgerTransaction";`);
  await pg.query(`DROP FUNCTION IF EXISTS lt_fault_t1();`);
  await pg.end();
}
console.log("   fault trigger removed — redelivering");

// recovery: redeliver after the fault is removed → exactly-once convergence
const groupC = await db.paymentGroup.findUnique({ where: { ref: refC } });
const wr = await sendWebhook(refC, "payment.succeeded", groupC!.totalMinor);
const orderRec = await db.order.findUnique({ where: { id: orderIdC } });
const t1Rec = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${orderIdC}` } });
const logRec = await db.paymentWebhookLog.count({ where: { providerRef: refC, eventType: "payment.succeeded", processed: true } });
const cartRec = await db.cartItem.count({ where: { cartId: ltCart.id, variantId: vb2.variantId } });
const tB2 = [
  check("B6: redelivery after fault converges 200", wr.status === 200, `status=${wr.status} ${JSON.stringify(wr.body).slice(0, 120)}`),
  check("B7: order paid exactly once", orderRec?.status === "paid", `status=${orderRec?.status}`),
  check("B8: exactly one T1 posting", t1Rec === 1, `t1=${t1Rec}`),
  check("B9: success log marked processed", logRec === 1, `processedLogs=${logRec}`),
  check("B10: successful redelivery clears the cart line", cartRec === 0, `cartItems=${cartRec}`),
];
results.tests.push({ test: "B_ledger_recovery_redelivery", checks: tB2, httpStatus: wr.status });

// cleanup
await restoreVariant(va.variantId, 10); await restoreVariant(vb.variantId, 0); await restoreVariant(vb2.variantId, 5);await cleanupCarts([shopperEmail]);
console.log(`[cleanup] stocks restored; [LT] artifacts left tagged for audit: products rbA/rbB/rbC-${stamp}`);

results.finishedAt = new Date().toISOString();
console.log("\nRESULTS_JSON " + JSON.stringify(results));
process.exit(summary("fault-rollback"));

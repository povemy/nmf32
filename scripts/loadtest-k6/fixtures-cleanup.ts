// ============================================================================
// K6 FIXTURES CLEANUP — run AFTER a ladder run (DB-side box). Deletes ONLY
// [LT]-owned rows tied to THIS RUN_ID: the two fixture products, [LT] k6
// shopper carts. Orders/ledger/payment rows are NEVER deleted (audit trail) —
// they are [LT]-tagged and harmless. Restores nothing else.
// Run: RUN_ID=<same as setup> bun scripts/loadtest-k6/fixtures-cleanup.ts
// @ts-nocheck
import { db } from "../../src/lib/db";

const RUN_ID = process.env.RUN_ID;
if (!RUN_ID) throw new Error("RUN_ID env required (same value as fixtures-setup)");

// ownership guard: only [LT] K6 products created by this run
const products = await db.product.findMany({ where: { slug: { startsWith: `lt-k6-` }, title: { contains: RUN_ID } }, select: { id: true } });
const pids = products.map((p) => p.id);
if (pids.length) {
  await db.productVariant.deleteMany({ where: { productId: { in: pids } } });
  await db.inventoryLog.deleteMany({ where: { variant: { productId: { in: pids } } } });
  await db.product.deleteMany({ where: { id: { in: pids } } });
}

// [LT] k6 shopper carts only
const carts = await db.cart.findMany({ where: { shopper: { email: { startsWith: `lt-${RUN_ID}-` } } }, select: { id: true } });
if (carts.length) {
  await db.cartItem.deleteMany({ where: { cartId: { in: carts.map((c) => c.id) } } });
  await db.cart.deleteMany({ where: { id: { in: carts.map((c) => c.id) } } });
}

console.log(`cleanup done (runId=${RUN_ID}): products removed=${pids.length}, carts removed=${carts.length} — orders/ledger kept as [LT] audit trail`);
process.exit(0);

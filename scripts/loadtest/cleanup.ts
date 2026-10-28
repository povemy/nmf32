// ============================================================================
// loadtest/cleanup.ts — remove ONLY [LT]-owned load-test data.
// Deletes [LT]-scoped children first (FK-safe), refreshes the [LT] store
// wallet cache afterwards (ledger lines of removed orders are deleted, so the
// cached balance must be re-derived from ledger truth). Non-[LT] application
// records are never touched. Run: bun scripts/loadtest/cleanup.ts
// ============================================================================
import { db } from "../../src/lib/db";
import { refreshWalletCache } from "../../src/lib/ledger";

async function main() {
  const ltStore = await db.store.findUnique({ where: { slug: "lt-main-store" }, select: { id: true, sellerId: true } });
  if (!ltStore) throw new Error("[LT] Main Store missing");
  const ltShoppers = await db.shopperUser.findMany({ where: { email: { endsWith: "@lt.test", startsWith: "lt-" } }, select: { id: true } });
  const ltShopperIds = ltShoppers.map((s) => s.id);
  const qaShopper = await db.shopperUser.findUnique({ where: { email: "qa.shopper@nomofee.test" }, select: { id: true } });

  // [LT] orders = orders on the [LT] store OR placed by [LT] buyers
  const orders = await db.order.findMany({
    where: { OR: [{ storeId: ltStore.id }, { shopperId: { in: [...ltShopperIds, ...(qaShopper ? [] : [])] } }] },
    select: { id: true, paymentGroupId: true },
  });
  const orderIds = orders.map((o) => o.id);
  const groupIds = [...new Set(orders.map((o) => o.paymentGroupId).filter(Boolean))] as string[];

  // ledger txns scoped to [LT] orders (lines cascade)
  const ltTxns = await db.ledgerTransaction.findMany({
    where: { OR: [{ refType: "order", refId: { in: orderIds } }, { refType: "payment_group", refId: { in: groupIds } }] },
    select: { id: true },
  });

  // [LT] variants → their inventory logs
  const ltVariants = await db.productVariant.findMany({ where: { product: { storeId: ltStore.id } }, select: { id: true } });
  const ltVariantIds = ltVariants.map((v) => v.id);

  const del = async (n: string, fn: () => Promise<unknown>) => {
    const r = await fn();
    console.log(`  ${n}: ${JSON.stringify(r)}`);
  };

  console.log(`[LT] cleanup — orders: ${orderIds.length}, shoppers: ${ltShopperIds.length}, txns: ${ltTxns.length}`);
  const ltGroupRefs = groupIds.length > 0 ? (await db.paymentGroup.findMany({ where: { id: { in: groupIds } }, select: { ref: true } })).map((g) => g.ref) : [];
  await del("paymentWebhookLog (lt refs)", () => db.paymentWebhookLog.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { providerRef: { in: ltGroupRefs } }] } }));
  await del("ledgerLine (lt txns)", () => db.ledgerLine.deleteMany({ where: { OR: [{ txnId: { in: ltTxns.map((t) => t.id) } }, { refType: "order", refId: { in: orderIds } }] } }));
  await del("ledgerTransaction (lt)", () => db.ledgerTransaction.deleteMany({ where: { id: { in: ltTxns.map((t) => t.id) } } }));
  await del("shipmentEvent", () => db.shipmentEvent.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } }));
  await del("shipment", () => db.shipment.deleteMany({ where: { orderId: { in: orderIds } } }));
  await del("dispute", () => db.dispute.deleteMany({ where: { orderId: { in: orderIds } } }));
  await del("refund", () => db.refund.deleteMany({ where: { orderId: { in: orderIds } } }));
  await del("orderStatusHistory", () => db.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }));
  await del("orderItem", () => db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }));
  await del("inventoryLog (lt variants)", () => db.inventoryLog.deleteMany({ where: { variantId: { in: ltVariantIds } } }));
  await del("order", () => db.order.deleteMany({ where: { id: { in: orderIds } } }));
  await del("paymentGroup (lt)", () => db.paymentGroup.deleteMany({ where: { id: { in: groupIds } } }));
  await del("cartItem (lt shoppers)", () => db.cartItem.deleteMany({ where: { cart: { shopperId: { in: ltShopperIds } } } }));
  await del("cart (lt shoppers)", () => db.cart.deleteMany({ where: { shopperId: { in: ltShopperIds } } }));
  await del("session (lt shoppers)", () => db.session.deleteMany({ where: { userId: { in: ltShopperIds } } }));
  await del("shopperUser (lt)", () => db.shopperUser.deleteMany({ where: { id: { in: ltShopperIds } } }));
  await del("activityLog (lt orders)", () => db.activityLog.deleteMany({ where: { entityType: "order", entityId: { in: orderIds } } }));

  // wallet cache refresh for the [LT] seller wallet (its ledger lines changed)
  if (ltStore.sellerId) {
    const wallet = await db.wallet.findUnique({ where: { sellerId: ltStore.sellerId }, select: { id: true } });
    if (wallet) {
      await refreshWalletCache(wallet.id);
      console.log(`  wallet cache refreshed: ${wallet.id.slice(-8)}`);
    }
  }

  // verify: no [LT] orders/patches remain
  const remain = await db.order.count({ where: { storeId: ltStore.id } });
  console.log(remain === 0 ? "[LT] cleanup COMPLETE — store orderless" : `[LT] WARNING: ${remain} orders remain`);
  await db.$disconnect();
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });

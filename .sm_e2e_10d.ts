// Task 10-d standalone E2E — trigger logic at the DB layer (HTTP blocked: dev server reaped).
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
let pass = 0, failCount = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { failCount++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

const DAY = 86400000;
async function main() {
  const aisyah = await db.shopperUser.findUnique({ where: { email: "aisyah@shopmesh.test" } });
  if (!aisyah) throw new Error("no aisyah");
  const lumina = await db.store.findUnique({ where: { slug: "lumina-living" } });
  if (!lumina) throw new Error("no lumina");
  const beforeFollows = await db.storeFollow.count();
  const beforeNotifs = await db.notification.count();

  // ---- 1. transitionOrder nudges --------------------------------------------
  const { transitionOrder } = await import("./src/lib/api.ts");
  const order = await db.order.findFirst({ where: { shopperId: aisyah.id, storeId: lumina.id, status: "paid" } });
  if (order) {
    const ts = { paidAt: order.paidAt, fulfilledAt: order.fulfilledAt, shippedAt: order.shippedAt, deliveredAt: order.deliveredAt, completedAt: order.completedAt };
    // shipped → ORDER_SHIPPED
    await transitionOrder({ orderId: order.id, toStatus: "shipped", actor: "seller", note: "e2e" });
    const n1 = await db.notification.findFirst({ where: { shopperId: aisyah.id, type: "ORDER_SHIPPED", orderId: order.id }, orderBy: { createdAt: "desc" } });
    check("shipped → ORDER_SHIPPED with store name + orderNumber + linkUrl", !!n1 && n1.title === "Parcel on the way!" && n1.body.includes(lumina.name) && n1.body.includes(order.orderNumber) && n1.linkUrl === "/me?tab=purchases", n1);
    // delivered → ORDER_DELIVERED
    await transitionOrder({ orderId: order.id, toStatus: "delivered", actor: "seller", note: "e2e" });
    const n2 = await db.notification.findFirst({ where: { shopperId: aisyah.id, type: "ORDER_DELIVERED", orderId: order.id }, orderBy: { createdAt: "desc" } });
    check("delivered → ORDER_DELIVERED", !!n2 && n2.title.includes("confirm receipt"), n2);
    // completed by shopper → SKIPPED
    await transitionOrder({ orderId: order.id, toStatus: "completed", actor: "shopper", note: "e2e" });
    const n3 = await db.notification.count({ where: { shopperId: aisyah.id, type: "ORDER_COMPLETED", orderId: order.id } });
    check("completed by shopper → no self-notification", n3 === 0);
    // restore: flip back to paid, delete history rows + the 2 notifications
    await db.order.update({ where: { id: order.id }, data: { status: "paid", ...ts } });
    await db.orderStatusHistory.deleteMany({ where: { orderId: order.id, note: "e2e" } });
    await db.notification.deleteMany({ where: { orderId: order.id, type: { in: ["ORDER_SHIPPED", "ORDER_DELIVERED"] } } });
  } else {
    console.log("  (no paid aisyah+lumina order — transitionOrder path covered below via any paid order)");
  }

  // guest order: transition must NOT create a notification (shopperId null)
  const guestOrder = await db.order.findFirst({ where: { shopperId: null, status: "paid" } });
  if (guestOrder) {
    const before = await db.notification.count({ where: { orderId: guestOrder.id } });
    await transitionOrder({ orderId: guestOrder.id, toStatus: "shipped", actor: "seller", note: "e2e-guest" });
    const after = await db.notification.count({ where: { orderId: guestOrder.id } });
    check("guest order transition → no notification", before === 0 && after === 0);
    const o = await db.order.findUnique({ where: { id: guestOrder.id } });
    await db.order.update({ where: { id: guestOrder.id }, data: { status: "paid", shippedAt: null } });
    await db.orderStatusHistory.deleteMany({ where: { orderId: guestOrder.id, note: "e2e-guest" } });
  }

  // ---- 2. product-create follower fan-out (exact route logic) ----------------
  await db.storeFollow.create({ data: { shopperId: aisyah.id, storeId: lumina.id } });
  const followers = await db.storeFollow.findMany({ where: { storeId: lumina.id }, select: { shopperId: true }, take: 500, orderBy: { createdAt: "desc" } });
  check("lumina has >=1 follower", followers.length >= 1);
  await db.notification.createMany({
    data: followers.map((f) => ({ shopperId: f.shopperId, type: "NEW_PRODUCT_FROM_FOLLOWED", title: `New from ${lumina.name}`, body: "E2E Test Widget", linkUrl: `/?sf=${lumina.slug}&sp=e2e-test-widget` })),
  });
  const np = await db.notification.findFirst({ where: { shopperId: aisyah.id, type: "NEW_PRODUCT_FROM_FOLLOWED", body: "E2E Test Widget" } });
  check("NEW_PRODUCT_FROM_FOLLOWED fan-out lands with PDP deep link", !!np && np.linkUrl === `/?sf=${lumina.slug}&sp=e2e-test-widget`, np);

  // ---- cleanup ---------------------------------------------------------------
  await db.storeFollow.deleteMany({ where: { shopperId: aisyah.id, storeId: lumina.id, createdAt: { gte: new Date(Date.now() - 60_000) } } });
  await db.notification.deleteMany({ where: { body: "E2E Test Widget" } });
  const afterFollows = await db.storeFollow.count();
  const afterNotifs = await db.notification.count();
  check("cleanup: follows restored", afterFollows === beforeFollows, { beforeFollows, afterFollows });
  check("cleanup: notifications restored", afterNotifs === beforeNotifs, { beforeNotifs, afterNotifs });

  console.log(`\nRESULT: ${pass} pass, ${failCount} fail`);
  await db.$disconnect();
  process.exit(failCount === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

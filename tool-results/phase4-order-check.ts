import { db } from "../src/lib/db";
const order = await db.order.findUnique({ where: { orderNumber: "NM-103628" }, select: { id: true, paymentProvider: true } });
if (!order) { console.log("order not found"); process.exit(0); }
const items = await db.orderItem.findMany({ where: { orderId: order.id } });
console.log("provider:", order.paymentProvider, "| items:", items.length);
for (const it of items) {
  const keys = Object.keys(it).filter((k) => /commission|snapshot|flag|Json/i.test(k));
  console.log(it.title, "→", JSON.stringify(Object.fromEntries(keys.map((k) => [k, it[k as keyof typeof it]])), null, 0).slice(0, 400));
}
process.exit(0);

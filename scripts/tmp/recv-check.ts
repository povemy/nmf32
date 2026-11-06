import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const h = await db.orderStatusHistory.findMany({ where: { order: { orderNumber: "NM-100021" } }, orderBy: { createdAt: "asc" }, select: { toStatus: true, actor: true, note: true } });
  const receipts = h.filter(x => x.note === "Confirmed receipt by buyer");
  console.log(`history rows: ${h.length}, receipt-confirmation rows: ${receipts.length}`);
  const o = await db.order.findUnique({ where: { orderNumber: "NM-100021" }, select: { status: true, completedAt: true } });
  console.log(`final status: ${o!.status}, completedAt: ${o!.completedAt != null}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());

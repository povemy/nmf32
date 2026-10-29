import { db } from "../src/lib/db";
const allStores = await db.store.findMany({ where: { status: "live" }, select: { id: true, name: true, seller: { select: { id: true, email: true, commissionOverridePercent: true, holdDaysOverride: true, status: true } } } });
for (const s of allStores) {
  if (s.seller.status !== "active" || s.seller.commissionOverridePercent != null || s.seller.holdDaysOverride != null) continue;
  const rows = await db.commissionOverride.findMany({ where: { scope: "seller", sellerId: s.seller.id } });
  if (rows.length > 0) continue;
  const prods = await db.product.findMany({ where: { storeId: s.id, status: "active" }, select: { id: true, title: true, priceMinor: true, categoryId: true, category: { select: { commissionPercent: true } } }, take: 2 });
  if (prods.length > 0) {
    console.log("BASELINE-CANDIDATE:", JSON.stringify({ store: s.name, sellerId: s.seller.id, email: s.seller.email, product: prods[0] }));
  }
}
// also: any product in a category WITHOUT commissionPercent (for null-category simulate we can just omit categoryId)
process.exit(0);

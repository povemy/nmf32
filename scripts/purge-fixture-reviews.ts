// ONE-TIME data fix (review rewards work order §2):
//   1. Delete the 5 demo fixture reviews — verified origin prisma/seed.ts
//      L577-590 (shopperId IS NULL AND orderId IS NULL ⇒ cannot be verified
//      purchases; names Aina/Daniel/Farah/Jun/Melati match the seed source).
//      These were PUBLIC ("published") — exactly the "staging test fixtures
//      appearing as public reviews" the work order prohibits.
//   2. Recompute every product's ratingAvg/ratingCount from PUBLISHED reviews
//      only — 23 products carried fabricated aggregates with zero backing
//      reviews; after this they show an honest 0/0 empty state.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function recompute(productId: string) {
  const agg = await db.review.aggregate({
    where: { productId, status: "published" },
    _avg: { rating: true },
    _count: { rating: true },
  });
  const ratingAvg = Math.round((agg._avg.rating ?? 0) * 100) / 100;
  const ratingCount = agg._count.rating;
  await db.product.update({ where: { id: productId }, data: { ratingAvg, ratingCount } });
  return { ratingAvg, ratingCount };
}

async function main() {
  // --- 1. delete demo fixtures (scoped: no shopper, no order ⇒ not verified) ---
  const fixtures = await db.review.findMany({
    where: { shopperId: null, orderId: null },
    select: { id: true, customerName: true, status: true, rating: true },
  });
  console.log(`Demo fixture reviews found (shopperId+orderId NULL): ${fixtures.length}`);
  for (const f of fixtures) console.log(`  - ${f.customerName} ${f.rating}★ [${f.status}] ${f.id}`);
  if (fixtures.length > 0) {
    const res = await db.review.deleteMany({ where: { shopperId: null, orderId: null } });
    console.log(`Deleted: ${res.count}`);
  }

  // --- 2. recompute aggregates over published reviews only ---
  const products = await db.product.findMany({ select: { id: true, title: true, ratingAvg: true, ratingCount: true } });
  let changed = 0;
  const remaining = [];
  for (const p of products) {
    const { ratingAvg, ratingCount } = await recompute(p.id);
    if (ratingAvg !== p.ratingAvg || ratingCount !== p.ratingCount) {
      changed++;
      if (ratingCount > 0) remaining.push(`${p.title}: ${ratingAvg}★ / ${ratingCount}`);
    }
  }
  console.log(`Products total: ${products.length} | aggregates corrected: ${changed}`);
  console.log(`Products with REAL published-review aggregates now: ${remaining.length}`);
  for (const r of remaining) console.log(`  * ${r}`);

  const left = await db.review.count();
  console.log(`Reviews remaining in DB: ${left}`);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); }).finally(() => db.$disconnect());

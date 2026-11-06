// ============================================================================
// STAGING REVIEW FIXTURES — guarded seed/cleanup (review rewards work order §11).
// ============================================================================
// Creates a BALANCED synthetic review dataset (positive / average / negative)
// on REAL active NOMOFEE products so filters, sorting, distribution,
// aggregates and empty states can be exercised in staging.
//
// HARD RULES baked into the script:
//   • Synthetic reviews are CLEARLY IDENTIFIED: customerName "Staging Tester",
//     title prefixed "[SYNTHETIC]", body prefixed "SYNTHETIC STAGING FIXTURE".
//   • NO orderId is ever set — a synthetic review can never claim a verified
//     purchase (the PDP shows them WITHOUT the "Verified purchase" badge).
//   • NO shopperId and NO MembershipReward rows — synthetic reviews never
//     earn or hold rewards.
//   • Cleanup mode deletes exactly the marked rows and recomputes the
//     affected product aggregates, restoring the honest state.
//
// GUARDRAILS against running against production:
//   1. refuses to run without NOMOFEE_ALLOW_FIXTURES=1 in the environment;
//   2. refuses to run without an explicit --yes on the command line;
//   3. prints the database host it is about to touch and aborts if the URL
//      is missing/unparseable. Run it ONLY against an isolated staging target.
//
// Usage:
//   NOMOFEE_ALLOW_FIXTURES=1 bun scripts/staging/review-fixtures.ts --yes
//   NOMOFEE_ALLOW_FIXTURES=1 bun scripts/staging/review-fixtures.ts --yes --cleanup
// ============================================================================
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const MARKER_TITLE = "[SYNTHETIC]";
const MARKER_NAME = "Staging Tester";
const MARKER_BODY = "SYNTHETIC STAGING FIXTURE —";

// Balanced dataset: 5★ ×2, 4★ ×2, 3★, 2★, 1★ across real products.
const FIXTURES: { rating: number; title: string; body: string }[] = [
  {
    rating: 5,
    title: "Excellent quality",
    body: "Arrived well packed and feels premium. Exactly as described.",
  },
  {
    rating: 5,
    title: "Would buy again",
    body: "Fast delivery from the seller and the finish is lovely.",
  },
  {
    rating: 4,
    title: "Good, with small niggles",
    body: "Solid value overall; packaging could be a bit more protective.",
  },
  {
    rating: 4,
    title: "Recommended",
    body: "Does the job well. Slight delay in shipping but the item is genuine.",
  },
  {
    rating: 3,
    title: "Average for the price",
    body: "Works as expected, nothing more. Consider your options before buying.",
  },
  {
    rating: 2,
    title: "Below expectations",
    body: "Felt lighter than the photos suggested and one edge was rough.",
  },
  {
    rating: 1,
    title: "Not for me",
    body: "Arrived with a defect and the size runs small. Requested a refund.",
  },
];

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

function guard(): void {
  if (process.env.NOMOFEE_ALLOW_FIXTURES !== "1") {
    console.error("REFUSED: set NOMOFEE_ALLOW_FIXTURES=1 to acknowledge this is an isolated staging target.");
    process.exit(1);
  }
  if (!process.argv.includes("--yes")) {
    console.error("REFUSED: pass --yes to confirm the synthetic fixtures may be written.");
    process.exit(1);
  }
  const url = process.env.SUPABASE_DATABASE_URL ?? "";
  try {
    const host = new URL(url).host;
    console.log(`Target database host: ${host}`);
  } catch {
    console.error("REFUSED: SUPABASE_DATABASE_URL missing or unparseable.");
    process.exit(1);
  }
}

async function main() {
  guard();
  const cleanup = process.argv.includes("--cleanup");

  if (cleanup) {
    const marked = await db.review.findMany({
      where: { OR: [{ title: { startsWith: MARKER_TITLE } }, { customerName: { startsWith: MARKER_NAME } }] },
      select: { id: true, productId: true },
    });
    console.log(`Synthetic reviews found: ${marked.length}`);
    if (marked.length === 0) return;
    const res = await db.review.deleteMany({
      where: { OR: [{ title: { startsWith: MARKER_TITLE } }, { customerName: { startsWith: MARKER_NAME } }] },
    });
    const productIds = [...new Set(marked.map((m) => m.productId))];
    for (const pid of productIds) {
      const agg = await recompute(pid);
      console.log(`  recomputed ${pid}: ${agg.ratingAvg}★ / ${agg.ratingCount}`);
    }
    console.log(`Deleted ${res.count} synthetic reviews; ${productIds.length} product aggregates recomputed.`);
    return;
  }

  // Seed mode: real ACTIVE products from LIVE stores (never fixtures on
  // pending/draft products — the public listing must be able to show them).
  const products = await db.product.findMany({
    where: { status: "active", store: { status: "live" }, isFixture: false },
    select: { id: true, title: true },
    orderBy: { salesCount: "desc" },
    take: 4,
  });
  if (products.length === 0) {
    console.error("No active products found — nothing to attach fixtures to.");
    process.exit(1);
  }
  console.log(`Attaching ${FIXTURES.length} synthetic reviews across ${products.length} real products:`);

  const now = Date.now();
  let i = 0;
  for (const f of FIXTURES) {
    const p = products[i % products.length];
    await db.review.create({
      data: {
        productId: p.id,
        // Synthetic markers — see header rules. orderId/shopperId stay NULL.
        customerName: `${MARKER_NAME} ${i + 1}`,
        rating: f.rating,
        title: `${MARKER_TITLE} ${f.title}`,
        body: `${MARKER_BODY} ${f.body}`,
        status: "published",
        createdAt: new Date(now - (i + 1) * 36 * 3600 * 1000),
      },
    });
    console.log(`  ${f.rating}★ → ${p.title}`);
    i++;
  }

  for (const p of products) {
    const agg = await recompute(p.id);
    console.log(`  aggregate ${p.title}: ${agg.ratingAvg}★ / ${agg.ratingCount} published`);
  }
  console.log("Done. Remember: these rows are PUBLISHED in staging for filter/sort testing — run --cleanup to remove them.");
}

main().catch((e) => { console.error("ERR", e); process.exit(1); }).finally(() => db.$disconnect());

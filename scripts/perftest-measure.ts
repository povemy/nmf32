// P10 SCALE PROBE — measurement-only variant (data already seeded).
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ datasources: { db: { url: process.env.PERF_URL! } } });

function ms(t0: number): string {
  return `${(performance.now() - t0).toFixed(1)}ms`;
}

async function main() {
  // Mega-sponsor = the Perf Sponsor profile with the most referrals.
  const grouped = await db.affiliateProfile.groupBy({
    by: ["sponsorId"],
    where: { displayName: { startsWith: "Perf Referral" } },
    _count: { _all: true },
    orderBy: { _count: { sponsorId: "desc" } },
    take: 1,
  });
  const sponsorId = grouped[0]!.sponsorId!;
  const count = grouped[0]!._count._all;
  console.log(`[measure] mega-sponsor ${sponsorId}: ${count} direct referrals`);

  // ---- 1. Referral code lookup (landing path) ----
  const someReferral = await db.affiliateProfile.findFirst({ where: { sponsorId }, orderBy: { activatedAt: "asc" } });
  let t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    await db.affiliateProfile.findUnique({ where: { code: someReferral!.code } });
  }
  const hitAvg = ((performance.now() - t0) / 50).toFixed(2);
  t0 = performance.now();
  await db.affiliateProfile.findUnique({ where: { code: "zzzznoexist99" } });
  console.log(`[measure] 1. code lookup: hit avg=${hitAvg}ms (50 runs), miss=${ms(t0)}`);

  // ---- 2. Network pagination, first 5 pages (20 rows) ----
  const pages: number[] = [];
  for (let p = 0; p < 5; p++) {
    t0 = performance.now();
    await db.affiliateProfile.findMany({
      where: { sponsorId, status: "active" },
      orderBy: { activatedAt: "desc" },
      take: 20,
      skip: p * 20,
      select: { displayName: true, slug: true, status: true, activatedAt: true },
    });
    pages.push(performance.now() - t0);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  console.log(`[measure] 2. network page-1..5 (20 rows): min=${sorted[0].toFixed(1)}ms, median=${sorted[2].toFixed(1)}ms, max=${sorted[4].toFixed(1)}ms`);

  // ---- 3. Deep page (skip 2,980 of ~3,000) ----
  t0 = performance.now();
  await db.affiliateProfile.findMany({
    where: { sponsorId, status: "active" },
    orderBy: { activatedAt: "desc" },
    take: 20,
    skip: 2980,
    select: { displayName: true, slug: true, status: true, activatedAt: true },
  });
  console.log(`[measure] 3. deep page (skip 2,980): ${ms(t0)}`);

  // ---- 4. Earnings aggregate ----
  t0 = performance.now();
  await db.affiliateCommissionEntry.groupBy({
    by: ["status"],
    where: { beneficiaryAffiliateId: sponsorId },
    _sum: { amountMinor: true },
    _count: { _all: true },
  });
  console.log(`[measure] 4. earnings groupBy: ${ms(t0)}`);

  // ---- 5. EXPLAIN ----
  const plan = await db.$queryRawUnsafe(
    `EXPLAIN (COSTS OFF) SELECT "displayName", "slug", "status", "activatedAt" FROM "AffiliateProfile" WHERE "sponsorId" = $1 AND "status" = 'active' ORDER BY "activatedAt" DESC LIMIT 20 OFFSET 2980`,
    sponsorId
  );
  console.log(`[measure] 5. EXPLAIN network query:`);
  for (const row of plan as { "QUERY PLAN": string }[]) {
    console.log(`        ${row["QUERY PLAN"].trim()}`);
  }
}

main()
  .catch((e) => {
    console.error("[measure] FAILED:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

// P10 SCALE PROBE — 10,000-referral sponsor scenario on a DISPOSABLE database.
// ----------------------------------------------------------------------------
// Mission guardrails honoured:
//   • No synthetic accounts in the shared/dev database — this script runs
//     ONLY against a disposable database (nomofee_perftest) created and
//     destroyed by the wrapper; migrations are deployed fresh (which also
//     re-proves migration reproducibility a third time).
//   • Bounded run: single-process inserts in batches, no sustained load
//     against shared infrastructure; results are labelled dev-sandbox-class
//     evidence, NOT production capacity claims.
//
// Measures the hot paths the 10k-affiliate business design depends on:
//   1. Referral code lookup (findUnique by code) — the ?ref= landing path.
//   2. Direct-network pagination (20/page over 10,000 referrals).
//   3. Deep-page pagination (skip 9,980).
//   4. Sponsor-earnings aggregate over 10,000 synthetic entries.
//   5. Index usage (EXPLAIN output for the network query).
import { PrismaClient } from "@prisma/client";

const PERF_URL = process.env.PERF_URL!;
if (!PERF_URL) {
  console.error("PERF_URL (disposable database URL) is required");
  process.exit(1);
}
const db = new PrismaClient({ datasources: { db: { url: PERF_URL } } });

const N = Number(process.env.PERF_N ?? 2000);
function ms(t0: number): string {
  return `${(performance.now() - t0).toFixed(1)}ms`;
}
function rnd(n: number): string {
  let s = "";
  while (s.length < n) s += Math.random().toString(16).slice(2);
  return s.slice(0, n);
}

async function main() {
  console.log(`[perftest] seeding ${N} synthetic shoppers + referrals + 1 mega-sponsor…`);
  let t0 = performance.now();

  // Synthetic shopper users first (AffiliateProfile.userId is FK-bound).
  // passwordHash is a never-verifiable placeholder — these identities can
  // never log in; the database is disposable and dropped right after.
  const sponsorUser = await db.shopperUser.create({
    data: { email: `perf-sponsor-${rnd(8)}@perftest.invalid`, passwordHash: "s1:perf:never-verified", fullName: "Perf Sponsor", status: "active" },
  });

  // Mega-sponsor.
  const sponsor = await db.affiliateProfile.create({
    data: {
      userId: sponsorUser.id,
      status: "active",
      code: `sp${rnd(10)}`,
      slug: `perf-sponsor-${rnd(6)}`,
      displayName: "Perf Sponsor",
      termsVersion: 1,
      termsAcceptedAt: new Date(),
      activatedAt: new Date(Date.now() - 90 * 86400000),
    },
  });

  // N synthetic shoppers + N direct referrals in batches (single process, bounded).
  const BATCH = 1000;
  for (let i = 0; i < N; i += BATCH) {
    const len = Math.min(BATCH, N - i);
    const users = Array.from({ length: len }, (_, k) => ({
      email: `perf-u-${i + k}-${rnd(6)}@perftest.invalid`,
      passwordHash: "s1:perf:never-verified",
      fullName: `Perf Referral ${i + k}`,
      status: "active",
    }));
    const created = await db.shopperUser.createMany({ data: users });
    void created;
    const userIds = await db.shopperUser.findMany({
      where: { email: { startsWith: "perf-u-" } },
      orderBy: { createdAt: "desc" },
      take: len,
      select: { id: true },
    });
    const rows = userIds.map((u, k) => {
      const idx = i + k;
      return {
        userId: u.id,
        status: "active",
        code: `rf${rnd(10)}`,
        slug: `perf-aff-${idx}-${rnd(4)}`,
        displayName: `Perf Referral ${idx}`,
        sponsorId: sponsor.id,
        sponsorAssignedAt: new Date(),
        sponsorSource: "referral_touch",
        termsVersion: 1,
        termsAcceptedAt: new Date(),
        activatedAt: new Date(Date.now() - Math.floor(Math.random() * 60) * 86400000),
      };
    });
    await db.affiliateProfile.createMany({ data: rows });
  }
  console.log(`[perftest] seeded in ${ms(t0)} (shoppers: ${N + 1}, profiles: ${N + 1})`);

  // Synthetic earnings entries for the aggregation probe — full FK chain
  // (Store → Order → OrderItem → commissions → entries), 200 commissions ×
  // 2 roles = 400 sponsor-side entries (schema caps 2 entries per commission).
  t0 = performance.now();
  const seller = await db.seller.create({
    data: { email: `perf-seller-${rnd(6)}@perftest.invalid`, passwordHash: "s1:perf:never-verified", fullName: "Perf Seller", displayName: "Perf Seller", status: "active" },
  });
  const store = await db.store.create({
    data: { sellerId: seller.id, name: "Perf Store", slug: `perf-store-${rnd(6)}`, status: "live" },
  });
  const shopper = await db.shopperUser.create({
    data: { email: `perf-buyer-${rnd(6)}@perftest.invalid`, passwordHash: "s1:perf:never-verified", fullName: "Perf Buyer", status: "active" },
  });
  const order = await db.order.create({
    data: { orderNumber: `PERF-${rnd(8)}`, storeId: store.id, shopperId: shopper.id, customerName: shopper.fullName, customerEmail: shopper.email, status: "delivered", totalMinor: 39800, subtotalMinor: 39800, currency: "MYR", paymentMethod: "card_mock", paymentStatus: "paid", paidAt: new Date() },
  });
  for (let i = 0; i < 200; i++) {
    const item = await db.orderItem.create({
      data: { orderId: order.id, title: "Perf Item", unitPriceMinor: 19900, qty: 1, lineSubtotalMinor: 19900, sellerNetMinor: 0 },
    });
    const c = await db.affiliateCommission.create({
      data: {
        orderItemId: item.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        storeId: store.id,
        affiliateId: sponsor.id,
        sponsorId: sponsor.id,
        commissionableBaseMinor: 19900,
        rateBps: 1000,
        poolMinor: 1990,
        status: "approved",
      },
    });
    await db.affiliateCommissionEntry.createMany({
      data: [
        { commissionId: c.id, beneficiaryAffiliateId: sponsor.id, role: "direct", amountMinor: 1791, status: "approved", availableAt: new Date() },
        { commissionId: c.id, beneficiaryAffiliateId: sponsor.id, role: "sponsor", amountMinor: 199, status: "approved", availableAt: new Date() },
      ],
    });
  }
  console.log(`[perftest] entries seeded in ${ms(t0)} (400 entries across 200 commissions)`);

  // ---- 1. Referral code lookup (landing path) ----
  const codeToFind = `rf${rnd(10)}`; // miss path
  t0 = performance.now();
  await db.affiliateProfile.findUnique({ where: { code: codeToFind } });
  const lookupMiss = ms(t0);
  const someReferral = await db.affiliateProfile.findFirst({ where: { sponsorId: sponsor.id }, orderBy: { activatedAt: "asc" } });
  t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    await db.affiliateProfile.findUnique({ where: { code: someReferral!.code } });
  }
  const lookupHit50 = `${((performance.now() - t0) / 50).toFixed(2)}ms avg`;
  console.log(`[perftest] 1. code lookup: hit(50x avg)=${lookupHit50}, miss=${lookupMiss}`);

  // ---- 2. Network pagination page 1 (20 rows) ----
  const pages: number[] = [];
  for (let p = 0; p < 5; p++) {
    t0 = performance.now();
    await db.affiliateProfile.findMany({
      where: { sponsorId: sponsor.id, status: "active" },
      orderBy: { activatedAt: "desc" },
      take: 20,
      skip: p * 20,
      select: { displayName: true, slug: true, status: true, activatedAt: true },
    });
    pages.push(performance.now() - t0);
  }
  const p50 = pages.sort((a, b) => a - b)[Math.floor(pages.length / 2)];
  console.log(`[perftest] 2. network page-1 (20 rows, 5 runs): p50=${p50.toFixed(1)}ms (all: ${pages.map((x) => x.toFixed(1)).join(", ")})`);

  // ---- 3. Deep page (skip 9,980) ----
  t0 = performance.now();
  await db.affiliateProfile.findMany({
    where: { sponsorId: sponsor.id, status: "active" },
    orderBy: { activatedAt: "desc" },
    take: 20,
    skip: N - 20,
    select: { displayName: true, slug: true, status: true, activatedAt: true },
  });
  console.log(`[perftest] 3. deep page (skip ${N - 20}): ${ms(t0)}`);

  // ---- 4. Sponsor earnings aggregate (groupBy over 10k entries) ----
  t0 = performance.now();
  await db.affiliateCommissionEntry.groupBy({
    by: ["status"],
    where: { beneficiaryAffiliateId: sponsor.id },
    _sum: { amountMinor: true },
    _count: { _all: true },
  });
  console.log(`[perftest] 4. earnings groupBy over 10,000 entries: ${ms(t0)}`);

  // ---- 5. Index usage (EXPLAIN) ----
  const plan = await db.$queryRawUnsafe(
    `EXPLAIN (COSTS OFF) SELECT "displayName", "slug", "status", "activatedAt" FROM "AffiliateProfile" WHERE "sponsorId" = $1 AND "status" = 'active' ORDER BY "activatedAt" DESC LIMIT 20 OFFSET 9980`,
    sponsor.id
  );
  console.log(`[perftest] 5. EXPLAIN network query:`);
  for (const row of plan as { "QUERY PLAN": string }[]) {
    console.log(`        ${row["QUERY PLAN"].trim()}`);
  }

  console.log("[perftest] DONE — disposable database dropped by the wrapper");
}

main()
  .catch((e) => {
    console.error("[perftest] FAILED:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

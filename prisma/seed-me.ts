// ============================================================================
// seed-me.ts — demo data for the buyer dashboard (Me hub). Run: bun prisma/seed-me.ts
// Idempotent: upserts the platform voucher pool + the demo shopper's wallet,
// voucher wallet and activity feed. Safe to re-run at any time.
// ============================================================================
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const DEMO_SHOPPER_EMAIL = "aisyah@nomofee.test";
const DAY = 24 * 60 * 60 * 1000;

const VOUCHER_POOL = [
  { code: "MESH10",        title: "10% off marketplace-wide (max RM15)", kind: "discount",     percentOff: 10, maxDiscountMinor: 1500, minSpendMinor: 0,     days: 45 },
  { code: "RM5OFF",        title: "RM5 off your order",                  kind: "discount",     discountMinor: 500,     minSpendMinor: 3000,  days: 30 },
  { code: "FREESHIP",      title: "Free shipping, no min. spend",        kind: "freeshipping", discountMinor: 800,     minSpendMinor: 0,     days: 21 },
  { code: "HOME15",        title: "15% off Home & Living (max RM20)",    kind: "discount",     percentOff: 15, maxDiscountMinor: 2000, minSpendMinor: 5000,  days: 40 },
  { code: "BIGSAVE20",     title: "20% off orders above RM150",          kind: "discount",     percentOff: 20, maxDiscountMinor: 5000, minSpendMinor: 15000, days: 60 },
  { code: "COINSBACK",     title: "Earn 2x coins on your next order",    kind: "coinsback",    discountMinor: 0,       minSpendMinor: 0,     days: 30 },
  { code: "NEWBUY8",       title: "RM8 off for growing shoppers",        kind: "discount",     discountMinor: 800,     minSpendMinor: 6000,  days: 25 },
  { code: "MIDMONTH12",    title: "Mid-Month Madness — 12% off (max RM25)", kind: "discount",  percentOff: 12, maxDiscountMinor: 2500, minSpendMinor: 4000,  days: 18 },
];

async function main() {
  // ---- platform voucher pool -------------------------------------------------
  const pool: { id: string; code: string }[] = [];
  for (const v of VOUCHER_POOL) {
    const row = await db.voucher.upsert({
      where: { code: v.code },
      create: {
        code: v.code,
        title: v.title,
        kind: v.kind,
        discountMinor: v.discountMinor ?? 0,
        percentOff: v.percentOff ?? null,
        maxDiscountMinor: v.maxDiscountMinor ?? null,
        minSpendMinor: v.minSpendMinor,
        expiryAt: new Date(Date.now() + v.days * DAY),
        isActive: true,
      },
      update: { isActive: true },
      select: { id: true, code: true },
    });
    pool.push(row);
  }
  console.log(`voucher pool ready: ${pool.length}`);

  // ---- demo shopper -----------------------------------------------------------
  const shopper = await db.shopperUser.findUnique({ where: { email: DEMO_SHOPPER_EMAIL } });
  if (!shopper) {
    console.log(`shopper ${DEMO_SHOPPER_EMAIL} not found — wallet/vouchers/activity skipped`);
    await db.$disconnect();
    return;
  }

  await db.shopperUser.update({
    where: { id: shopper.id },
    data: { username: shopper.username ?? "aisyah", followingCount: Math.max(shopper.followingCount, 12), followerCount: Math.max(shopper.followerCount, 34) },
  });

  // Wallet — NomoPay Later limit RM6,652.12 like the reference dashboard, coins to show.
  await db.shopperWallet.upsert({
    where: { userId: shopper.id },
    create: {
      userId: shopper.id,
      balanceMinor: 12_840,        // RM128.40
      coinBalance: 1_250,
      payLaterLimitMinor: 665_212, // RM6,652.12
      payLaterUsedMinor: 0,
      checkInStreak: 3,             // streak warms up, cooldown clear so check-in works
      lastCheckInAt: null,
    },
    update: {
      balanceMinor: 12_840,
      payLaterLimitMinor: 665_212,
      // NOTE: lastCheckInAt intentionally NOT reset here — the daily check-in
      // cooldown must survive re-seeding.
    },
  });

  // Voucher wallet — most of the pool AVAILABLE, a couple already USED.
  let held = 0;
  for (const [i, v] of pool.entries()) {
    const status = i < pool.length - 2 ? "AVAILABLE" : "USED";
    const exists = await db.userVoucher.findUnique({
      where: { userId_voucherId: { userId: shopper.id, voucherId: v.id } },
    });
    if (!exists) {
      await db.userVoucher.create({
        data: { userId: shopper.id, voucherId: v.id, status, usedAt: status === "USED" ? new Date() : null },
      });
      held++;
    }
  }
  console.log(`voucher wallet: ${held} new claims`);

  // Demo purchases — attach a few existing demo orders (placed by guest/test
  // emails) to the demo shopper so the purchases hub has live buckets.
  // Only touches orders with shopperId=null (never rewrites claimed ones).
  const demoOrders = await db.order.findMany({
    where: { shopperId: null },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { id: true, orderNumber: true },
  });
  if (demoOrders.length > 0) {
    const res = await db.order.updateMany({
      where: { id: { in: demoOrders.map((o) => o.id) } },
      data: { shopperId: shopper.id },
    });
    console.log(`demo orders attached to ${DEMO_SHOPPER_EMAIL}: ${res.count} (${demoOrders.map((o) => o.orderNumber).join(", ")})`);
  }

  // Activity feed — LIKE/VIEW a handful of live products for Likes/Viewed pages.
  const products = await db.product.findMany({
    where: { status: "active", store: { status: "live" } },
    orderBy: { salesCount: "desc" },
    take: 6,
    select: { id: true },
  });
  let seeded = 0;
  for (const [i, p] of products.entries()) {
    const kind = i % 2 === 0 ? "LIKE" : "VIEWED";
    const exists = await db.userActivity.findUnique({
      where: { userId_productId_activityType: { userId: shopper.id, productId: p.id, activityType: kind } },
    });
    if (!exists) {
      await db.userActivity.create({
        data: { userId: shopper.id, productId: p.id, activityType: kind, createdAt: new Date(Date.now() - (i + 1) * 3 * 60 * 60 * 1000) },
      });
      seeded++;
    }
  }
  console.log(`activity seeded: ${seeded}`);

  await db.$disconnect();
  console.log("seed-me done");
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});

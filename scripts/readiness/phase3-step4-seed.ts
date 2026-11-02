// ============================================================================
// PHASE 3 / STEP 4 — MINIMAL STAGING SEED
// ----------------------------------------------------------------------------
// Seeds ONLY what the authorized Step 4 suites need into nomofee_staging
// (the empty, migration-verified staging schema):
//   • CommissionSetting singleton + Plan "free" (checkout/registration deps)
//   • 4 admin users (same dev fallback credentials as prisma/seed.ts — this
//     is the ISOLATED staging schema, no real accounts exist anywhere)
//   • 2 approved sellers/stores the suites hard-require:
//       bytebazaar  (byte@nomofee.io)  — wallet + holdDaysOverride 10
//       glow-theory (glow@nomofee.io)  — commission override 10%
//     plus 1 pending_review seller (approval-flow E2E target)
//   • 3 in-stock active products per store (race/E2E fixtures create their
//     own [LT] variants on top of the stores)
//   • qa.shopper@nomofee.test (reviews-e2e R2 fixture, seeded deliberately)
//   • Platform ledger accounts (BANK_MAIN / PAYOUT_CLEARING / REVENUE_* /
//     AFFILIATE_LIABILITY) via the app's own ensureAccount()
//
// FAIL-CLOSED: refuses to run unless the connection resolves nomofee_staging
// AND the schema is empty of Stores (never merges into a used schema, never
// touches public).
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
const rawUrl = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
const pinned = new URL(rawUrl).searchParams.get("schema");
if (pinned !== "nomofee_staging") {
  console.error(`[seed] REFUSED — URL pins schema=${pinned ?? "(none)"}, expected nomofee_staging`);
  process.exit(78);
}

const { db } = await import("../../src/lib/db");
const { hashPassword } = await import("../../src/lib/password");
const { ensureAccount, ACCOUNTS } = await import("../../src/lib/ledger");

const existingStores = await db.store.count();
if (existingStores > 0) {
  console.error(`[seed] REFUSED — nomofee_staging already has ${existingStores} stores (expected a clean slate)`);
  process.exit(78);
}

const out: Record<string, unknown> = { seededAt: new Date().toISOString(), target: "nomofee_staging" };
const t0 = performance.now();

// ── Commission settings + plan ───────────────────────────────────────────────
await db.commissionSetting.upsert({
  where: { id: 1 },
  create: {
    id: 1, defaultPercent: 8, appliesToShipping: false, basePriceRule: "paid_price",
    fixedFeeMinor: 0, minCommissionMinor: 0, payoutHoldDays: 7,
    holdReleaseRule: "days_after_paid", graceDaysAfterDelivered: 2,
  },
  update: {},
});
await db.plan.upsert({
  where: { code: "free" },
  create: { code: "free", name: "Free Forever", monthlyFeeMinor: 0, commissionPercent: 8, productLimit: 100, mediaLimitMb: 512, staffLimit: 2, isActive: true },
  update: {},
});
out.commissionSetting = "id=1 (8% default, 7 payout hold days)";
out.plan = "free";

// ── Categories (roots only — same rates as dev seed) ────────────────────────
const cats: [string, string, number][] = [
  ["electronics", "Electronics", 6], ["fashion", "Fashion", 10], ["home-living", "Home & Living", 8],
  ["beauty", "Beauty", 9], ["sports-outdoors", "Sports & Outdoors", 7], ["food-beverage", "Food & Beverage", 5],
  ["pet-supplies", "Pet Supplies", 6], ["toys-games", "Toys & Games", 7],
];
for (const [slug, name, pct] of cats) {
  await db.category.upsert({
    where: { slug },
    create: { slug, name, commissionPercent: pct },
    update: {},
  });
}
out.categories = cats.length;

// ── Admin users (isolated staging copies of the dev fallbacks) ──────────────
const admins: [string, string, string, string][] = [
  ["admin@nomofee.io", "Aisyah Rahman", "superadmin", "Admin123!"],
  ["ops@nomofee.io", "Wani Operations", "ops", "Ops12345!"],
  ["finance@nomofee.io", "Kumar Finance", "finance", "Finance123!"],
  ["moderator@nomofee.io", "Rina Moderator", "moderator", "Mod12345!"],
];
for (const [email, name, role, pw] of admins) {
  await db.adminUser.upsert({
    where: { email },
    create: { email, name, role, passwordHash: hashPassword(pw) },
    update: {},
  });
}
out.admins = admins.map(([e, , r]) => `${e} (${r})`);

// ── Sellers + stores + wallets ──────────────────────────────────────────────
type SellerSpec = {
  email: string; fullName: string; displayName: string; status: string; kyc: string;
  storeName: string; slug: string; storeStatus: string; holdOverride?: number; commissionOverride?: number;
  emailVerified?: boolean; affiliate?: boolean; products: [string, string, number, string][];
};
const sellers: SellerSpec[] = [
  {
    email: "byte@nomofee.io", fullName: "Adrian Byte", displayName: "Adrian", status: "active", kyc: "approved",
    storeName: "ByteBazaar", slug: "bytebazaar", storeStatus: "live", holdOverride: 10, emailVerified: true,
    affiliate: true,
    products: [
      ["Pulse ANC Earbuds", "pulse-anc-earbuds", 61, "electronics"],
      ["MK65 Tactile Keyboard", "mk65-tactile-keyboard", 18, "electronics"],
      ["USB-C Hub 8-in-1", "usb-c-hub-8in1", 40, "electronics"],
    ],
  },
  {
    email: "glow@nomofee.io", fullName: "Mira Glow", displayName: "Mira", status: "active", kyc: "approved",
    storeName: "Glow Theory", slug: "glow-theory", storeStatus: "live", commissionOverride: 10, affiliate: true,
    products: [
      ["Barrier Repair Serum", "barrier-repair-serum", 44, "beauty"],
      ["Gentle Gel Cleanser", "gentle-gel-cleanser", 66, "beauty"],
      ["Mineral SPF50", "mineral-spf50", 58, "beauty"],
    ],
  },
  {
    email: "pending@nomofee.io", fullName: "Pia Pending", displayName: "Pia", status: "pending_review", kyc: "pending",
    storeName: "Pending Pantry", slug: "pending-pantry", storeStatus: "draft",
    products: [
      ["Artisan Kaya Jam", "artisan-kaya-jam", 25, "food-beverage"],
    ],
  },
];
for (const s of sellers) {
  const seller = await db.seller.create({
    data: {
      email: s.email, passwordHash: hashPassword("Seller123!"), fullName: s.fullName, displayName: s.displayName,
      countryCode: "MY", phone: "60123456789", status: s.status, kycStatus: s.kyc,
      holdDaysOverride: s.holdOverride ?? null, commissionOverridePercent: s.commissionOverride ?? null,
      emailVerifiedAt: s.emailVerified ? new Date() : null,
      submittedAt: s.status === "pending_review" ? new Date() : new Date(),
      approvedAt: s.status === "active" ? new Date() : null,
    },
  });
  const store = await db.store.create({
    data: {
      sellerId: seller.id, name: s.storeName, slug: s.slug,
      tagline: `${s.storeName} — staging acceptance fixtures`,
      description: `${s.storeName} — curated goods shipped from Malaysia.`,
      status: s.storeStatus, supportEmail: s.email,
      affiliateOptIn: s.affiliate ?? false,
      affiliateDefaultRateBps: s.affiliate ? 500 : 0, // 5% when enrolled
    },
  });
  if (s.status === "active") {
    const wallet = await db.wallet.create({ data: { sellerId: seller.id } });
    await ensureAccount(ACCOUNTS.sellerPayable(wallet.id), wallet.id);
  }
  for (const [title, slug, stock, catSlug] of s.products) {
    const cat = await db.category.findUnique({ where: { slug: catSlug } });
    const product = await db.product.create({
      data: {
        storeId: store.id, title, slug, description: `${title} — staging fixture`,
        status: s.storeStatus === "live" ? "active" : "pending", priceMinor: 10000,
        categoryId: cat?.id ?? null,
        publishedAt: s.storeStatus === "live" ? new Date() : null,
        affiliateEnabled: s.affiliate ?? false,
      },
    });
    await db.productVariant.create({
      data: { productId: product.id, name: "std", stock, moq: 1, priceMinor: 10000, isActive: true, sku: `STG-${slug}` },
    });
  }
  console.log(`[seed] seller ${s.email} → store ${s.slug} (${s.storeStatus}) + ${s.products.length} products`);
}
out.sellers = sellers.map((s) => `${s.slug}:${s.storeStatus}`);

// ── qa.shopper fixture (reviews-e2e R2 expects exactly this account) ────────
await db.shopperUser.upsert({
  where: { email: "qa.shopper@nomofee.test" },
  create: { email: "qa.shopper@nomofee.test", passwordHash: hashPassword("Shopper123!"), fullName: "QA Shopper" },
  update: {},
});
out.qaShopper = "qa.shopper@nomofee.test / Shopper123!";

// ── Platform ledger accounts (via the app's own ensureAccount) ──────────────
for (const code of [
  ACCOUNTS.BANK_MAIN, ACCOUNTS.payoutClearing(), ACCOUNTS.revenueCommission(),
  ACCOUNTS.revenueAdjust(), ACCOUNTS.affiliateLiability(),
]) {
  await ensureAccount(code);
}
out.ledgerAccounts = 5;

// ── Counter for order numbers (checkout's nextOrderNumber upserts on demand,
//    but seeding the documented starting point keeps staging/dev parity) ─────
await db.counter.upsert({
  where: { key: "order_number" },
  create: { key: "order_number", value: 100001 },
  update: {},
});

out.durationMs = Math.round(performance.now() - t0);
out.counts = {
  stores: await db.store.count(), sellers: await db.seller.count(),
  products: await db.product.count(), admins: await db.adminUser.count(),
  wallets: await db.wallet.count(), categories: await db.category.count(),
  ledgerAccounts: await db.ledgerAccount.count(),
};
writeFileSync("docs/staging/evidence/phase3-step4-seed.json", JSON.stringify(out, null, 2));
console.log(`\n[seed] COMPLETE in ${out.durationMs}ms — ${JSON.stringify(out.counts)}`);
await db.$disconnect();

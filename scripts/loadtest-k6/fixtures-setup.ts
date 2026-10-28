// ============================================================================
// K6 FIXTURES SETUP — run on a machine with STAGING DB access (ops/CI box),
// BEFORE copying fixtures.json to the external load generator.
// Creates the [LT]-owned controlled dataset for the external ladder:
//   • flash-sale product + variant with controlled stock (default 2000)
//   • optional second store product for same-seller contention profiles
// Idempotent per RUN_ID; writes scripts/loadtest-k6/fixtures.json.
// Run: bun scripts/loadtest-k6/fixtures-setup.ts   (env: FLASH_STOCK, RUN_ID)
// @ts-nocheck
import { db } from "../../src/lib/db";
import { writeFileSync } from "node:fs";

const RUN_ID = process.env.RUN_ID ?? `k6-${Date.now().toString(36)}`;
const FLASH_STOCK = Number(process.env.FLASH_STOCK ?? 2000);

const store = await db.store.findUnique({ where: { slug: "bytebazaar" }, select: { id: true, slug: true } });
if (!store) throw new Error("bytebazaar store missing — run the staging seed first (bun prisma/seed.ts)");

const mk = async (tag: string, stock: number) => {
  const product = await db.product.create({
    data: {
      storeId: store.id,
      title: `[LT] K6 ${tag} ${RUN_ID}`,
      slug: `lt-k6-${tag}-${RUN_ID}`,
      description: "External load-test fixture (auto-cleaned)",
      status: "active",
      priceMinor: 1000,
    },
  });
  const variant = await db.productVariant.create({
    data: { productId: product.id, name: "std", stock, moq: 1, priceMinor: 1000, isActive: true },
  });
  return { productId: product.id, variantId: variant.id, priceMinor: 1000, stock };
};

const flash = await mk("flash", FLASH_STOCK);
const contended = await mk("contended", 500);

const fixtures = {
  runId: RUN_ID,
  createdAt: new Date().toISOString(),
  storeSlug: store.slug,
  flash: { ...flash, initialStock: FLASH_STOCK },
  contended: { ...contended, initialStock: 500 },
  note: "[LT]-owned fixtures; cleanup ONLY via fixtures-cleanup.ts (same RUN_ID)",
};
writeFileSync("scripts/loadtest-k6/fixtures.json", JSON.stringify(fixtures, null, 2));
console.log(`fixtures written → scripts/loadtest-k6/fixtures.json (runId=${RUN_ID}, flashStock=${FLASH_STOCK})`);
process.exit(0);

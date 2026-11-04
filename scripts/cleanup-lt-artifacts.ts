/**
 * Sandbox data hygiene — remove load-test artifacts from the marketplace DB.
 *
 * CONTEXT (desktop homepage revamp): load-test runs left ~5,000 products in
 * "[LT] *" stores (no images, RM10 prices). They dominate "New arrivals"
 * (latest 8), pollute search results and the category grid ("[LT] Catalog"),
 * which makes the data-driven homepage look broken.
 *
 * SAFETY ANALYSIS (verified against prisma/schema.prisma):
 *   • OrderItem keeps DENORMALIZED snapshot columns (title, prices, …) and its
 *     productId/variantId relations are OPTIONAL → Prisma SetNull on delete —
 *     historical orders keep rendering from their snapshots. No order rows are
 *     touched or deleted.
 *   • ProductImage / ProductVariant / Review / CollectionProduct /
 *     FeaturedSlot / CartItem cascade with the product (cart items belong to
 *     load-test carts).
 *   • ChatThread.product / ImportJobItem.product are OPTIONAL → SetNull.
 *   • AffiliateCollectionItem.product is REQUIRED (Restrict) → deleted FIRST
 *     (load-test affiliate collections are junk by definition).
 *   • "[LT] *" STORES/SELLERS CANNOT be deleted (Order.store is a required
 *     restrict relation — 159 load-test orders reference them). They are
 *     hidden from the homepage via the admin featured-stores curation instead.
 *
 * Idempotent: safe to re-run (second run is a no-op).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const LT_PREFIX = "[LT]";

async function main() {
  // Load-test products live in two shapes: inside "[LT] *" stores AND as
  // "[LT] …" titled smoke products created inside REAL stores (e.g. the RX
  // smoke suite runs against ByteBazaar). Match BOTH.
  const ltProducts = await db.product.findMany({
    where: {
      OR: [
        { store: { name: { startsWith: LT_PREFIX } } },
        { title: { startsWith: LT_PREFIX } },
      ],
    },
    select: { id: true },
  });
  const ltIds = ltProducts.map((p) => p.id);
  console.log(`[lt-cleanup] load-test products (store-name or title match): ${ltIds.length}`);

  if (ltIds.length > 0) {
    // 1) AffiliateCollectionItem (required FK → Restrict) must go first.
    const affItems = await db.affiliateCollectionItem.deleteMany({
      where: { productId: { in: ltIds } },
    });
    console.log(`[lt-cleanup] affiliate collection items removed: ${affItems.count}`);

    // 2) The products themselves (cascades: variants, images, reviews,
    //    featured slots, collection products, cart items; SetNull: order-item
    //    variant refs, chat threads, import-job items).
    const del = await db.product.deleteMany({ where: { id: { in: ltIds } } });
    console.log(`[lt-cleanup] products deleted: ${del.count}`);
  }

  // 3) Load-test categories (e.g. "[LT] Catalog") — empty after step 2.
  const ltCats = await db.category.deleteMany({ where: { name: { startsWith: LT_PREFIX } } });
  console.log(`[lt-cleanup] categories deleted: ${ltCats.count}`);

  // Summary of what intentionally REMAINS (FK-protected).
  const remainingLtStores = await db.store.count({ where: { name: { startsWith: LT_PREFIX } } });
  const ordersKept = await db.order.count({
    where: { store: { name: { startsWith: LT_PREFIX } } },
  });
  console.log(`[lt-cleanup] [LT] stores kept (order-history FK): ${remainingLtStores}`);
  console.log(`[lt-cleanup] orders kept (snapshots intact): ${ordersKept}`);
  console.log("[lt-cleanup] done — public caches self-heal within the 60 s TTL.");
}

main()
  .catch((e) => {
    console.error("[lt-cleanup] FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

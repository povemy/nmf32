// ============================================================================
// loadtest/seed.ts — ensure the ISOLATED [LT] load-test dataset (idempotent).
// Everything created here is [LT]-owned and removable by cleanup.ts:
//   - [LT] buyers lt-buyer-001..N@lt.test (ShopperUser rows)
//   - dedicated [LT] probe variants on [LT] Main Store with controlled stock
// Never touches non-[LT] application data. Run: bun scripts/loadtest/seed.ts
// ============================================================================
import { db } from "../../src/lib/db";
import { hashPassword } from "../../src/lib/password";

const BUYERS = Number(process.env.LT_BUYERS ?? 120);

async function ensureVariant(slug: string, title: string, stock: number): Promise<string> {
  const existing = await db.productVariant.findFirst({
    where: { product: { slug, store: { slug: "lt-main-store" } } },
    select: { id: true },
  });
  if (existing) {
    await db.productVariant.update({ where: { id: existing.id }, data: { stock, moq: 1, isActive: true } });
    await db.product.update({
      where: { id: (await db.productVariant.findUnique({ where: { id: existing.id }, select: { productId: true } }))!.productId },
      data: { status: "active" },
    });
    return existing.id;
  }
  const product = await db.product.create({
    data: {
      storeId: (await db.store.findUnique({ where: { slug: "lt-main-store" }, select: { id: true } }))!.id,
      title,
      slug,
      description: "[LT] load-test product — safe to delete",
      status: "active",
      priceMinor: 2500,
      publishedAt: new Date(),
    },
  });
  const variant = await db.productVariant.create({
    data: { productId: product.id, name: "Default", priceMinor: 2500, stock, moq: 1, isActive: true },
  });
  return variant.id;
}

async function main() {
  const store = await db.store.findUnique({ where: { slug: "lt-main-store" }, select: { id: true, status: true } });
  if (!store) throw new Error("[LT] Main Store missing — run the LT store seed first");
  if (store.status !== "live") await db.store.update({ where: { id: store.id }, data: { status: "live" } });

  // probe variants (controlled state, reset every seed)
  const storm = await ensureVariant("lt-perf-storm-item", "[LT] Perf Storm Item", 1_000_000);
  const lastUnit = await ensureVariant("lt-perf-last-unit", "[LT] Perf Last Unit", 1);
  const oversell = await ensureVariant("lt-perf-oversell-probe", "[LT] Perf Oversell Probe", 10);
  const multiA = await ensureVariant("lt-perf-multi-a", "[LT] Perf Multi A", 100_000);
  const multiB = await ensureVariant("lt-perf-multi-b", "[LT] Perf Multi B", 100_000);

  // buyers (ensure up to BUYERS)
  const hash = hashPassword("LtBuyer123!");
  const existing = await db.shopperUser.findMany({
    where: { email: { startsWith: "lt-buyer-", endsWith: "@lt.test" } },
    select: { id: true, email: true },
  });
  const have = new Set(existing.map((s) => s.email));
  const missing: { email: string }[] = [];
  for (let i = 1; i <= BUYERS; i++) {
    const email = `lt-buyer-${String(i).padStart(3, "0")}@lt.test`;
    if (!have.has(email)) missing.push({ email });
  }
  for (const m of missing) {
    await db.shopperUser.create({
      data: { email: m.email, fullName: `[LT] Buyer ${m.email}`, passwordHash: hash, status: "active" },
    });
  }
  console.log(`[LT] seed ok — buyers: ${existing.length}→${existing.length + missing.length}, storm=${storm.slice(-8)} lastUnit=${lastUnit.slice(-8)} oversell=${oversell.slice(-8)} multiA=${multiA.slice(-8)} multiB=${multiB.slice(-8)}`);
  console.log(JSON.stringify({ storm, lastUnit, oversell, multiA, multiB }));
  await db.$disconnect();
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });

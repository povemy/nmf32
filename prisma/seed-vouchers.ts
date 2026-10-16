// ============================================================================
// Task 10-b — DEMO VOUCHER SEEDER (idempotent).
// Run: bunx tsx prisma/seed-vouchers.ts
//
// Upserts 4 STORE-scope claimable vouchers against the seeded demo stores.
// Re-running is safe: existing rows are only repaired (inactive → reactivated,
// expired → expiry extended); claimedCount, holders and USED/EXPIRED
// UserVoucher rows are NEVER reset (quota accounting must stay truthful).
//
//   LUMINAFS   · freeshipping · Lumina Living · West Malaysia (peninsular)
//   LUMINA12   · 12% off capped RM 25 · Lumina Living
//   BYTE15     · 15% off capped RM 20 · ByteBazaar
//   GLOWRM10   · RM 10 off · Glow Theory
// ============================================================================
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const daysAhead = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

type SeedVoucher = {
  code: string;
  title: string;
  kind: "discount" | "freeshipping";
  storeSlug: string;
  discountMinor?: number;
  percentOff?: number;
  maxDiscountMinor?: number | null;
  minSpendMinor: number;
  quota: number | null;
  expiryDays: number;
};

const SEEDS: SeedVoucher[] = [
  {
    code: "LUMINAFS",
    title: "Free Shipping (West Malaysia) · Lumina Living",
    kind: "freeshipping",
    storeSlug: "lumina-living",
    minSpendMinor: 6000, // RM 60
    quota: 200,
    expiryDays: 60,
  },
  {
    code: "LUMINA12",
    title: "12% Off · capped RM 25 · Lumina Living",
    kind: "discount",
    storeSlug: "lumina-living",
    percentOff: 12,
    maxDiscountMinor: 2500, // RM 25 cap
    minSpendMinor: 8000, // RM 80
    quota: 200,
    expiryDays: 45,
  },
  {
    code: "BYTE15",
    title: "15% Off · capped RM 20 · ByteBazaar",
    kind: "discount",
    storeSlug: "bytebazaar",
    percentOff: 15,
    maxDiscountMinor: 2000, // RM 20 cap
    minSpendMinor: 10000, // RM 100
    quota: 150,
    expiryDays: 45,
  },
  {
    code: "GLOWRM10",
    title: "RM 10 Off · Glow Theory",
    kind: "discount",
    storeSlug: "glow-theory",
    discountMinor: 1000, // RM 10
    minSpendMinor: 5000, // RM 50
    quota: null, // unlimited pool
    expiryDays: 30,
  },
];

async function main() {
  const stores = await db.store.findMany({
    where: { slug: { in: [...new Set(SEEDS.map((s) => s.storeSlug))] } },
    select: { id: true, slug: true, name: true },
  });
  const bySlug = new Map(stores.map((s) => [s.slug, s]));

  let created = 0;
  let repaired = 0;
  for (const seed of SEEDS) {
    const store = bySlug.get(seed.storeSlug);
    if (!store) {
      console.warn(`[seed-vouchers] store "${seed.storeSlug}" not found — skipping ${seed.code}`);
      continue;
    }
    const base = {
      title: seed.title,
      kind: seed.kind,
      discountMinor: seed.kind === "discount" ? (seed.discountMinor ?? 0) : 0,
      percentOff: seed.kind === "discount" ? (seed.percentOff ?? null) : null,
      maxDiscountMinor: seed.kind === "discount" ? (seed.maxDiscountMinor ?? null) : null,
      minSpendMinor: seed.minSpendMinor,
      isActive: true,
      scope: "STORE",
      storeId: store.id,
      // FS vouchers are seller-funded → West-Malaysia-only by platform rule.
      regionLimit: seed.kind === "freeshipping" ? "peninsular" : null,
      quota: seed.quota,
    };
    const freshExpiry = daysAhead(seed.expiryDays);
    const existing = await db.voucher.findUnique({ where: { code: seed.code } });
    if (!existing) {
      await db.voucher.create({ data: { ...base, code: seed.code, expiryAt: freshExpiry } });
      created += 1;
      console.log(`[seed-vouchers] created ${seed.code} → ${store.name}`);
    } else {
      // Repair-only update: never touch claimedCount/holders; extend expiry
      // only when the stored one has already passed.
      const data: Record<string, unknown> = { ...base };
      if (existing.expiryAt.getTime() > Date.now()) delete data.expiryAt;
      else data.expiryAt = freshExpiry;
      const changed =
        existing.isActive !== base.isActive ||
        existing.storeId !== base.storeId ||
        existing.kind !== base.kind ||
        existing.title !== base.title ||
        existing.minSpendMinor !== base.minSpendMinor ||
        existing.regionLimit !== base.regionLimit ||
        existing.quota !== base.quota ||
        "expiryAt" in data;
      if (changed) {
        await db.voucher.update({ where: { code: seed.code }, data });
        repaired += 1;
        console.log(`[seed-vouchers] repaired ${seed.code}`);
      }
    }
  }
  console.log(`[seed-vouchers] done — created ${created}, repaired ${repaired}, total seeds ${SEEDS.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

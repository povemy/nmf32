// ensure-demo-accounts.ts — idempotent sandbox demo-account bootstrap (P12).
//
// Guarantees the DEVELOPMENT-ONLY login credential panel always lists accounts
// whose documented passwords actually work:
//   • Creates the shopper-side demo accounts if missing (buyer, affiliate).
//   • Resets passwords ONLY for these explicitly-identified sandbox demo
//     accounts when they drift (never admins/sellers — those are seed-managed;
//     if their seed fallback no longer verifies, the panel simply omits them).
//   • Ensures the demo affiliate profile exists (AffiliateProfile on the
//     demo shopper, terms v1, active).
//
// Run: bun scripts/ensure-demo-accounts.ts
// Safe to re-run any time (idempotent). Never touches genuine user accounts.
import { db } from "../src/lib/db";
import { hashPassword, verifyPassword, randomToken } from "../src/lib/password";

let created = 0;
let reset = 0;
let unchanged = 0;

async function ensureShopper(opts: {
  email: string;
  password: string;
  fullName: string;
  username?: string;
  note: string;
}): Promise<{ id: string; created: boolean }> {
  const existing = await db.shopperUser.findUnique({ where: { email: opts.email } });
  if (existing) {
    if (!verifyPassword(opts.password, existing.passwordHash)) {
      await db.shopperUser.update({
        where: { id: existing.id },
        data: { passwordHash: hashPassword(opts.password) },
      });
      reset++;
      console.log(`[ensure-demo] reset password: ${opts.email} (${opts.note})`);
    } else {
      unchanged++;
    }
    return { id: existing.id, created: false };
  }
  const created = await db.shopperUser.create({
    data: {
      email: opts.email,
      passwordHash: hashPassword(opts.password),
      fullName: opts.fullName,
      username: opts.username ?? null,
      status: "active",
    },
  });
  console.log(`[ensure-demo] created shopper: ${opts.email} (${opts.note})`);
  return { id: created.id, created: true };
}

// 1) Buyer demo — the decorated demo shopper (seed-me.ts decorates this
//    account with wallet/vouchers/activity when present).
const buyer = await ensureShopper({
  email: "aisyah@nomofee.test",
  password: "NOMOFEE123!",
  fullName: "Nur Aisyah",
  username: "aisyah",
  note: "buyer demo (wallet/vouchers decorated by prisma/seed-me.ts)",
});

// 2) Plain buyer demo (QA).
await ensureShopper({
  email: "qa.shopper@nomofee.test",
  password: "Shopper123!",
  fullName: "QA Shopper",
  note: "plain buyer demo",
});

// 3) Affiliate demo — shopper + AffiliateProfile ("Alpha Promotes").
const aff = await ensureShopper({
  email: "aff-alpha@verify.nomofee.io",
  password: "Verify123!",
  fullName: "Affiliate Alpha",
  note: "affiliate demo",
});

const existingProfile = await db.affiliateProfile.findUnique({ where: { userId: aff.id } });
if (!existingProfile) {
  const base = "alpha-promotes";
  let slug = base;
  for (let i = 0; i < 20; i++) {
    const clash = await db.affiliateProfile.findUnique({ where: { slug } });
    if (!clash) break;
    slug = `${base}-${randomToken(3).toLowerCase()}`;
  }
  await db.affiliateProfile.create({
    data: {
      userId: aff.id,
      status: "active",
      code: randomToken(12),
      slug,
      displayName: "Alpha Promotes",
      bio: "Sandbox demo affiliate (development credential panel).",
      termsVersion: 1,
      termsAcceptedAt: new Date(),
      activatedAt: new Date(),
      sponsorSource: "code_entry",
    },
  });
  created++;
  console.log(`[ensure-demo] created affiliate profile: aff-alpha@verify.nomofee.io → slug=${slug}`);
} else if (existingProfile.status === "terminated") {
  // Demo hygiene only — a terminated demo affiliate cannot be used to sign in
  // to the hub; reinstate it so the panel's credentials always work.
  await db.affiliateProfile.update({ where: { id: existingProfile.id }, data: { status: "active" } });
  reset++;
  console.log(`[ensure-demo] reinstated demo affiliate profile (was terminated)`);
} else {
  unchanged++;
}

// Seed-managed accounts (admins/sellers) are verified, never mutated here.
const seedManaged: { table: "adminUser" | "seller"; email: string; password: string }[] = [
  { table: "adminUser", email: "admin@nomofee.io", password: "Admin123!" },
  { table: "adminUser", email: "ops@nomofee.io", password: "Ops12345!" },
  { table: "adminUser", email: "finance@nomofee.io", password: "Finance123!" },
  { table: "adminUser", email: "moderator@nomofee.io", password: "Mod12345!" },
  { table: "seller", email: "lumina@nomofee.io", password: "Seller123!" },
  { table: "seller", email: "byte@nomofee.io", password: "Seller123!" },
  { table: "seller", email: "glow@nomofee.io", password: "Seller123!" },
  { table: "seller", email: "warung@nomofee.io", password: "Seller123!" },
  { table: "seller", email: "trail@nomofee.io", password: "Seller123!" },
];
let seedOk = 0;
let seedDrift = 0;
for (const acc of seedManaged) {
  const row =
    acc.table === "adminUser"
      ? await db.adminUser.findUnique({ where: { email: acc.email } })
      : await db.seller.findUnique({ where: { email: acc.email } });
  if (!row) {
    seedDrift++;
    console.log(`[ensure-demo] MISSING seed account: ${acc.email} (run prisma/seed.ts)`);
    continue;
  }
  if (!verifyPassword(acc.password, row.passwordHash)) {
    seedDrift++;
    console.log(`[ensure-demo] seed fallback no longer verifies (env override?): ${acc.email} — panel will omit it`);
    continue;
  }
  seedOk++;
}

console.log(
  `\n[ensure-demo] done — shopper-side: ${unchanged} verified, ${reset} reset, ${created} created; seed-managed: ${seedOk} verified, ${seedDrift} drift`
);
void buyer;

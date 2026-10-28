/**
 * LT: publish a minimal home page for the [LT] storefront so the k6 storefront
 * leg exercises GET /api/sf/lt-main-store with a real 200 (previously it 404'd
 * STORE_NOT_PUBLISHED — measured 27×404 in the smoke run). The published JSON
 * is COPIED from an existing live store's home page (content is irrelevant for
 * load testing; the route parses it server-side). Idempotent upsert; cleanup.ts
 * removes it together with the LT store.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const ltStore = await db.store.findUnique({ where: { slug: "lt-main-store" } });
  if (!ltStore) throw new Error("lt-main-store not found — run seed.ts first");

  const donor = await db.cmsPage.findFirst({
    where: { slug: "home", publishedJson: { not: null }, store: { status: "active", slug: { not: "lt-main-store" } } },
    orderBy: { updatedAt: "desc" },
  });
  const publishedJson = donor?.publishedJson ?? '{"sections":[{"type":"hero","props":{"title":"[LT] Main Store","subtitle":"Load-test storefront"}}],"version":1}';
  const source = donor ? `copied from store ${donor.storeId}` : "minimal fallback JSON";

  const existing = await db.cmsPage.findUnique({ where: { storeId_slug: { storeId: ltStore.id, slug: "home" } } });
  if (existing) {
    await db.cmsPage.update({
      where: { id: existing.id },
      data: { publishedJson: existing.publishedJson ?? publishedJson, publishedVersion: existing.publishedVersion || 1 },
    });
    console.log("[publish-lt-storefront] home page already existed — publishedJson ensured (idempotent)");
  } else {
    await db.cmsPage.create({
      data: {
        storeId: ltStore.id, slug: "home", title: "Home", pageType: "home",
        draftJson: publishedJson, publishedJson, draftVersion: 1, publishedVersion: 1,
      },
    });
    console.log(`[publish-lt-storefront] home page created (${source})`);
  }

  // Verify through the real route (evidence, not assumption).
  const res = await fetch("http://localhost:3000/api/sf/lt-main-store");
  console.log(`[publish-lt-storefront] GET /api/sf/lt-main-store → ${res.status} ${res.status === 200 ? "(storefront leg now 200)" : "(STILL FAILING — investigate)"}`);
}

main().finally(() => db.$disconnect());

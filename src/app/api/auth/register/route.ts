import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, slugify, logActivity, notify } from "@/lib/api";
// NOTE (p10-a fix): toJson lives in "@/lib/json" — importing it from "@/lib/sections"
// (which no longer exports it) broke compilation of this route (and wedged dev).
import { toJson } from "@/lib/json";
import { defaultHomeSections, defaultPageSections } from "@/lib/sections";
import { ensureWalletAccounts } from "@/lib/ledger";

// POST /api/auth/register — seller self-service signup (M02)
// Creates: seller (status=onboarding) + draft store w/ default template pages + wallet.
export const POST = handle(async (req: NextRequest) => {
  const body = (await req.json()) as {
    email?: string; password?: string; fullName?: string; displayName?: string;
    countryCode?: string; storeName?: string; storeSlug?: string; phone?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const fullName = (body.fullName ?? "").trim();
  const displayName = (body.displayName ?? "").trim() || fullName;
  const storeName = (body.storeName ?? "").trim() || `${displayName}'s Store`;

  if (!email.includes("@")) return fail(400, "VALIDATION", "A valid email is required");
  if (password.length < 8) return fail(400, "VALIDATION", "Password must be at least 8 characters");
  if (!fullName) return fail(400, "VALIDATION", "Full name is required");

  const exists = await db.seller.findUnique({ where: { email } });
  if (exists) return fail(409, "EMAIL_TAKEN", "An account with this email already exists");

  // unique slug
  let slug = slugify(body.storeSlug || storeName) || `store-${Date.now().toString(36)}`;
  let attempt = 0;
  while (await db.store.findUnique({ where: { slug } })) {
    attempt += 1;
    slug = `${slugify(body.storeSlug || storeName) || "store"}-${attempt}`;
    if (attempt > 50) {
      slug = `store-${Date.now().toString(36)}`;
      break;
    }
  }

  const result = await db.$transaction(async (tx) => {
    const seller = await tx.seller.create({
      data: {
        email,
        passwordHash: hashPassword(password),
        fullName,
        displayName,
        countryCode: body.countryCode ?? "MY",
        phone: body.phone ?? null,
        status: "onboarding",
      },
    });
    const store = await tx.store.create({
      data: {
        sellerId: seller.id,
        name: storeName,
        slug,
        tagline: "New on NOMOFEE",
        status: "draft",
      },
    });
    const wallet = await tx.wallet.create({ data: { sellerId: seller.id } });
    // default pages — a publishable store in <60s (PART 1 §1.5)
    const homeSections = defaultHomeSections(storeName, "New on NOMOFEE");
    await tx.cmsPage.create({
      data: {
        storeId: store.id,
        slug: "home",
        title: "Home",
        pageType: "home",
        draftJson: toJson({ sections: homeSections, version: 1 }),
        draftVersion: 1,
      },
    });
    for (const p of [
      { slug: "about", title: "About Us", pageType: "about" },
      { slug: "contact", title: "Contact", pageType: "contact" },
      { slug: "policies", title: "Policies", pageType: "policy" },
    ]) {
      await tx.cmsPage.create({
        data: {
          storeId: store.id,
          slug: p.slug,
          title: p.title,
          pageType: p.pageType,
          draftJson: toJson({ sections: defaultPageSections(p.pageType, storeName), version: 1 }),
          draftVersion: 1,
        },
      });
    }
    return { seller, store, wallet };
  });

  await ensureWalletAccounts(result.wallet.id);
  await logActivity({ actorType: "seller", actorId: result.seller.id, actorLabel: email, action: "seller.register", entityType: "store", entityId: result.store.id, meta: { slug } });
  await notify({ event: "seller.registered", channel: "email", recipient: "admin@nomofee.io", subject: "New seller registered" });
  const token = await createSession("seller", result.seller.id);

  return ok(
    {
      userType: "seller",
      seller: {
        id: result.seller.id, email, fullName, displayName, status: "onboarding",
        storeId: result.store.id, storeSlug: slug, storeName,
      },
      token,
    },
    { status: 201 }
  );
});

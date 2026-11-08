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
import { rateLimit } from "@/lib/rate-limit";
import { getEmailChannel } from "@/lib/email-provider";
import { issueEmailOtp, assertEmailOtpStorage } from "@/lib/guest-otp";
import type { RegisterBody, RegisterData } from "@/lib/types/api-contract";

// POST /api/auth/register — seller self-service signup (M02)
// Creates: seller (status=onboarding) + draft store w/ default template pages + wallet.
//
// PHASE 2.3 (C2.7): registration performs NO email verification — a fresh
// seller account with someone else's email must not read as trusted. It
// best-effort SENDS a verification code (when a provider is configured;
// delivery problems NEVER block registration — same contract as the shopper
// register route); the seller completes it via
// /api/auth/seller/email-verification/verify, which is the ONLY code path
// that writes Seller.emailVerifiedAt.
export const POST = handle(async (req: NextRequest) => {
  // F-12 remediation: account-creation throttle — 5 signups per minute per IP
  // (shared "auth-register" bucket with the shopper register route).
  rateLimit(req, "auth-register", 5);
  const body = (await req.json()) as RegisterBody;
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const fullName = (body.fullName ?? "").trim();
  const displayName = (body.displayName ?? "").trim() || fullName;
  const storeName = (body.storeName ?? "").trim() || `${displayName}'s Store`;

  if (!email.includes("@")) return fail(400, "VALIDATION", "A valid email is required");
  if (password.length < 8) return fail(400, "VALIDATION", "Password must be at least 8 characters");
  if (!fullName) return fail(400, "VALIDATION", "Full name is required");

  // PHASE 2.3 select hygiene: existence probes never default-select Seller
  // scalars — the un-migrated dev DB lacks emailVerifiedAt (migration
  // 20261107000000), and a default select would raise P2022.
  const exists = await db.seller.findUnique({ where: { email }, select: { id: true } });
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
      // PHASE 2.3 select hygiene: create() would otherwise RETURN all Seller
      // scalars (incl. the un-migrated emailVerifiedAt). Only .id is used.
      select: { id: true },
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

  // PHASE 2.3 (C2.7) — best-effort verification kickoff, mirroring the
  // shopper register route: send the first code through the configured
  // channel; a missing provider / unmigrated OTP storage / delivery failure
  // NEVER blocks registration (the seller can re-request from the console:
  // Dashboard → “Verify your email”, POST /api/auth/seller/email-verification/request).
  let emailVerificationSent = false;
  try {
    const channel = getEmailChannel();
    if (channel) {
      await assertEmailOtpStorage();
      const issued = await issueEmailOtp({
        purpose: "seller-email",
        subjectId: result.seller.id,
        deliver: (code) =>
          channel.send({
            to: email,
            subject: "Verify your NOMOFEE seller email address",
            textBody:
              `Welcome to NOMOFEE! Your seller email verification code is ${code}.\n\n` +
              `It expires in 10 minutes. Verifying your email confirms you control this address and helps our team review your store faster.\n` +
              `If you did not create this seller account, you can ignore this email.`,
            meta: { purpose: "seller-email", subjectId: result.seller.id },
          }),
      });
      emailVerificationSent = issued.issued;
    }
  } catch {
    // Fail-closed states are expected pre-configuration / pre-migration.
    emailVerificationSent = false;
  }

  const payload: RegisterData = {
    userType: "seller",
    seller: {
      id: result.seller.id, email, fullName, displayName, status: "onboarding",
      storeId: result.store.id, storeSlug: slug, storeName,
    },
    // A brand-new account is NEVER verified yet (honest default).
    emailVerified: false,
    emailVerificationSent,
    token,
  };
  return ok(payload, { status: 201 });
});

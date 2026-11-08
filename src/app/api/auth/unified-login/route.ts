import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyPasswordAsync, DUMMY_PASSWORD_HASH } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { getMfaEnrollment, createMfaChallenge } from "@/lib/mfa";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { claimGuestStateForShopper, mergeGuestCartForShopper } from "@/lib/shopper-merge";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import type { UnifiedLoginBody, UnifiedMfaData, UnifiedAdminData, UnifiedSellerData, UnifiedShopperData } from "@/lib/types/api-contract";

// POST /api/auth/unified-login { email, password, portal? }
// ---------------------------------------------------------------------------
// UNIFIED LOGIN (P11) — ONE canonical entry point for every NOMOFEE account
// type (buyer / seller / affiliate / administrator). The user never chooses a
// portal before entering credentials: the SERVER resolves the account's actual
// identity across the three account tables and mints the session for it.
//
// Security posture — IDENTICAL to the legacy per-portal routes, nothing weaker:
//   • Same shared "auth-login" rate-limit bucket (10/min/IP, F-12).
//   • Same scrypt password verification (verifyPassword + timingSafeEqual).
//   • Same DB-backed revocable sessions (createSession) and cookie flags.
//   • Same account-status gates: admin isActive, seller terminated/suspended
//     blocks, shopper status !== active blocks. Uniform INVALID_CREDENTIALS
//     responses — no account-existence oracles.
//   • Privileges are NEVER inferred from the request body/URL/client — the
//     `portal` field is only accepted to DISAMBIGUATE an email that verifiably
//     exists (with the correct password) in MORE than one account table; the
//     server re-verifies the password against that table before minting.
//   • RBAC/capability enforcement downstream is completely untouched: an
//     admin session obtained here passes exactly the same requireAdmin/
//     requireCap checks as one from /api/auth/login.
//
// Ambiguity: emails can legitimately exist in more than one account table
// (seller+shopper today; registration cross-checks are one-directional). When
// the same credentials verify against multiple tables the endpoint returns
// 409 ACCOUNT_TYPE_AMBIGUOUS (NO session) and the client offers a portal
// picker limited to the server-verified types.
//
// Affiliates: an affiliate IS a shopper (AffiliateProfile on ShopperUser) —
// unified login lands them in the shopper experience with the Affiliate Hub,
// exactly as before. The response carries isAffiliate so clients can surface
// the Earn destination.
//
// Legacy routes stay fully functional (deep links, API consumers).
export const POST = handle(async (req: NextRequest) => {
  rateLimit(req, "auth-login", 10);
  const body = (await req.json().catch(() => ({}))) as UnifiedLoginBody;
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const portal = body.portal === "admin" || body.portal === "seller" || body.portal === "shopper" ? body.portal : null;
  if (!email || !password) return fail(400, "VALIDATION", "Email and password are required");
  // Phase 1 (SEC-01): identity-keyed throttle — 20/hour per EMAIL on top of
  // the shared per-IP bucket (distributed brute-force still exhausts).
  rateLimitKey(email, "auth-login-email", 20, 3_600_000);

  // Probe all three account tables in parallel (server-side identity
  // establishment — never a client-supplied role).
  const [admin, seller, shopper] = await Promise.all([
    db.adminUser.findUnique({ where: { email } }),
    // PHASE 2.3 select hygiene (C2.7): explicit field list EXCLUDING the
    // un-migrated Seller.emailVerifiedAt (migration 20261107000000) — a default
    // select would raise P2022 and break seller login on the dev DB.
    db.seller.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true, fullName: true, displayName: true, status: true },
    }),
    db.shopperUser.findUnique({ where: { email } }),
  ]);

  // Phase 1 (SEC-01/SEC-04): password verification per candidate — ALWAYS
  // exactly three asynchronous scrypt verifications (DUMMY hash when the
  // table has no row), run sequentially to keep the libuv thread pool
  // unsaturated. Inactive/invalid accounts fail exactly like a wrong
  // password (uniform 401, no existence or timing leak).
  const adminPwOk = await verifyPasswordAsync(password, admin?.passwordHash ?? DUMMY_PASSWORD_HASH);
  const sellerPwOk = await verifyPasswordAsync(password, seller?.passwordHash ?? DUMMY_PASSWORD_HASH);
  const shopperPwOk = await verifyPasswordAsync(password, shopper?.passwordHash ?? DUMMY_PASSWORD_HASH);

  const candidates: { type: "admin" | "seller" | "shopper" }[] = [];
  if (admin && admin.isActive && adminPwOk) candidates.push({ type: "admin" });
  if (seller && sellerPwOk) candidates.push({ type: "seller" });
  if (shopper && shopperPwOk) candidates.push({ type: "shopper" });

  if (candidates.length === 0) {
    return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  // Disambiguation: honour an explicit portal ONLY when that type is among
  // the server-verified candidates. Anything else fails uniformly.
  let resolved: "admin" | "seller" | "shopper";
  if (portal) {
    if (!candidates.some((c) => c.type === portal)) {
      return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }
    resolved = portal;
  } else if (candidates.length > 1) {
    return fail(409, "ACCOUNT_TYPE_AMBIGUOUS", "This email signs in to more than one account type — choose which one to use", {
      types: candidates.map((c) => c.type),
    });
  } else {
    resolved = candidates[0].type;
  }

  if (resolved === "admin" && admin) {
    // Phase 1 (C4): confirmed MFA enrollment gates session minting — the
    // response carries the challenge instead of a token; the client completes
    // via /api/auth/mfa/verify. Enforced identically on the legacy route.
    const mfa = await getMfaEnrollment(admin.id);
    if (mfa && mfa.confirmedAt) {
      const challenge = await createMfaChallenge(admin.id);
      const payload: UnifiedMfaData = { mfaRequired: true, challenge: challenge.challenge, email: admin.email };
      return ok(payload);
    }
    await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    const token = await createSession("admin", admin.id);
    await logActivity({ actorType: "admin", actorId: admin.id, actorLabel: admin.email, action: "admin.login", meta: { via: "unified" } });
    const payload: UnifiedAdminData = { userType: "admin", admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }, token };
    return ok(payload);
  }

  if (resolved === "seller" && seller) {
    if (seller.status === "terminated") {
      return fail(403, "ACCOUNT_TERMINATED", "This account has been terminated");
    }
    if (seller.status === "suspended") {
      return fail(403, "ACCOUNT_SUSPENDED", "This account has been suspended. Contact platform support.");
    }
    const token = await createSession("seller", seller.id);
    await logActivity({ actorType: "seller", actorId: seller.id, actorLabel: seller.email, action: "seller.login", meta: { via: "unified" } });
    const store = await db.store.findUnique({ where: { sellerId: seller.id } });
    const payload: UnifiedSellerData = {
      userType: "seller",
      seller: {
        id: seller.id, email: seller.email, fullName: seller.fullName, displayName: seller.displayName,
        status: seller.status, storeId: store?.id ?? null, storeSlug: store?.slug ?? null, storeName: store?.name ?? null,
      },
      token,
    };
    return ok(payload);
  }

  // Shopper (buyers AND affiliates — the affiliate surface lives in the
  // shopper experience; AffiliateProfile gates the Earn hub, checked here
  // only to inform client routing, never for authorization).
  if (shopper) {
    if (shopper.status !== "active") {
      return fail(403, "ACCOUNT_SUSPENDED", "This account is not available right now");
    }
    await db.shopperUser.update({ where: { id: shopper.id }, data: { lastLoginAt: new Date() } });
    const token = await createSession("shopper", shopper.id);
    // FINAL CLOSURE §2: claiming runs through the email-ownership gate inside
    // claimGuestStateForShopper — unverified accounts claim nothing.
    const claimed = await claimGuestStateForShopper(shopper.id, shopper.email);
    const emailVerified = claimed.skipped !== "email-unverified";
    // PHASE 2.2 guest checkout restoration — fold the guest cart into the
    // account cart (best-effort; never fails login).
    const guestCartMerged = await mergeGuestCartForShopper(shopper.id);
    const affiliateProfile = await db.affiliateProfile.findUnique({
      where: { userId: shopper.id },
      select: { status: true },
    });
    await logActivity({ actorType: "shopper", actorId: shopper.id, actorLabel: shopper.email, action: "shopper.login", meta: { via: "unified", guestCartMerged: guestCartMerged.itemsMerged } });
    const payload: UnifiedShopperData = {
      userType: "shopper",
      shopper: { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone },
      isAffiliate: affiliateProfile != null && affiliateProfile.status !== "terminated",
      token,
      claimed,
      emailVerified,
      guestCartMerged: guestCartMerged.itemsMerged,
    };
    return ok(payload);
  }

  return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
});

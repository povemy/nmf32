import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { claimGuestStateForShopper } from "@/lib/shopper-merge";
import { rateLimit } from "@/lib/rate-limit";

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
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; portal?: "admin" | "seller" | "shopper" };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const portal = body.portal === "admin" || body.portal === "seller" || body.portal === "shopper" ? body.portal : null;
  if (!email || !password) return fail(400, "VALIDATION", "Email and password are required");

  // Probe all three account tables in parallel (server-side identity
  // establishment — never a client-supplied role).
  const [admin, seller, shopper] = await Promise.all([
    db.adminUser.findUnique({ where: { email } }),
    db.seller.findUnique({ where: { email } }),
    db.shopperUser.findUnique({ where: { email } }),
  ]);

  // Password verification per candidate. Inactive/invalid accounts fail
  // exactly like a wrong password (uniform 401, no existence leak).
  const candidates: { type: "admin" | "seller" | "shopper" }[] = [];
  if (admin && admin.isActive && verifyPassword(password, admin.passwordHash)) candidates.push({ type: "admin" });
  if (seller && verifyPassword(password, seller.passwordHash)) candidates.push({ type: "seller" });
  if (shopper && verifyPassword(password, shopper.passwordHash)) candidates.push({ type: "shopper" });

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
    await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    const token = await createSession("admin", admin.id);
    await logActivity({ actorType: "admin", actorId: admin.id, actorLabel: admin.email, action: "admin.login", meta: { via: "unified" } });
    return ok({ userType: "admin", admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }, token });
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
    return ok({
      userType: "seller",
      seller: {
        id: seller.id, email: seller.email, fullName: seller.fullName, displayName: seller.displayName,
        status: seller.status, storeId: store?.id ?? null, storeSlug: store?.slug ?? null, storeName: store?.name ?? null,
      },
      token,
    });
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
    const claimed = await claimGuestStateForShopper(shopper.id, shopper.email);
    const affiliateProfile = await db.affiliateProfile.findUnique({
      where: { userId: shopper.id },
      select: { status: true },
    });
    await logActivity({ actorType: "shopper", actorId: shopper.id, actorLabel: shopper.email, action: "shopper.login", meta: { via: "unified" } });
    return ok({
      userType: "shopper",
      shopper: { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone },
      isAffiliate: affiliateProfile != null && affiliateProfile.status !== "terminated",
      token,
      claimed,
    });
  }

  return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
});

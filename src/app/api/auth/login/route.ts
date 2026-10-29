import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/auth/login { email, password, portal: "admin" | "seller" }
export const POST = handle(async (req: NextRequest) => {
  // F-12 remediation: bounded brute-force throttle — 10 credential attempts
  // per minute per IP, shared with the shopper login route (one "auth-login"
  // bucket). Uniform 429 for every email — no account-existence signal.
  rateLimit(req, "auth-login", 10);
  const body = (await req.json()) as { email?: string; password?: string; portal?: "admin" | "seller" };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const portal = body.portal === "admin" ? "admin" : "seller";
  if (!email || !password) return fail(400, "VALIDATION", "Email and password are required");

  if (portal === "admin") {
    const admin = await db.adminUser.findUnique({ where: { email } });
    if (!admin || !admin.isActive || !verifyPassword(password, admin.passwordHash)) {
      return fail(401, "INVALID_CREDENTIALS", "Invalid admin credentials");
    }
    await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    const token = await createSession("admin", admin.id);
    await logActivity({ actorType: "admin", actorId: admin.id, actorLabel: admin.email, action: "admin.login" });
    // token: client stores it in localStorage and sends it as a Bearer header —
    // keeps the session alive where cookies are unavailable (cross-site iframes).
    return ok({ userType: "admin", admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }, token });
  }

  const seller = await db.seller.findUnique({ where: { email } });
  if (!seller || !verifyPassword(password, seller.passwordHash)) {
    return fail(401, "INVALID_CREDENTIALS", "Invalid seller credentials");
  }
  // F-02/F-24 remediation: ineligible statuses are blocked at the login gate
  // (documented policy: suspended/terminated ⇒ 403; a suspended seller must
  // not be able to mint a fresh session and resume API access). Rejected
  // sellers CAN sign in — the documented revision loop (fix issues →
  // resubmit via /api/store/onboarding) requires it; store-operation routes
  // still gate them through requireActiveSellerStore where appropriate.
  if (seller.status === "terminated") {
    return fail(403, "ACCOUNT_TERMINATED", "This account has been terminated");
  }
  if (seller.status === "suspended") {
    return fail(403, "ACCOUNT_SUSPENDED", "This account has been suspended. Contact platform support.");
  }
  const token = await createSession("seller", seller.id);
  await logActivity({ actorType: "seller", actorId: seller.id, actorLabel: seller.email, action: "seller.login" });
  const store = await db.store.findUnique({ where: { sellerId: seller.id } });
  return ok({
    userType: "seller",
    seller: {
      id: seller.id, email: seller.email, fullName: seller.fullName, displayName: seller.displayName,
      status: seller.status, storeId: store?.id ?? null, storeSlug: store?.slug ?? null, storeName: store?.name ?? null,
    },
    token,
  });
});

// Auth & sessions — DB-backed sessions (revocable) delivered via the
// "sm_session" cookie OR an "Authorization: Bearer <token>" header. The Bearer
// path keeps seller/admin portals working in cross-site iframes (preview panel)
// where SameSite cookies are dropped by the browser.
import { cookies, headers } from "next/headers";
import { db } from "./db";
import { randomToken } from "./password";
import { ApiError } from "./api";

export const SESSION_COOKIE = "sm_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AdminUserDTO = {
  id: string; email: string; name: string; role: string;
};

export type SellerUserDTO = {
  id: string; email: string; fullName: string; displayName: string;
  status: string; storeId: string | null; storeSlug: string | null; storeName: string | null;
};

export type ShopperUserDTO = {
  id: string; email: string; fullName: string; phone: string | null;
};

export type SessionContext = { userType: "admin" | "seller" | "shopper"; userId: string };

export async function createSession(userType: "admin" | "seller" | "shopper", userId: string): Promise<string> {
  const token = randomToken(32);
  await db.session.create({
    data: { token, userType, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // SameSite=None + Secure: survives cross-site iframe embeds. Chromium and
    // Firefox allow Secure cookies on http://localhost (trustworthy origin).
    sameSite: "none",
    secure: true,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { token } });
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionContext | null> {
  let token: string | null = null;
  // 1) Bearer token from the Authorization header (client localStorage bridge).
  try {
    const h = await headers();
    const auth = h.get("authorization");
    if (auth && auth.toLowerCase().startsWith("bearer ")) {
      const t = auth.slice(7).trim();
      if (/^[a-f0-9]{16,128}$/i.test(t)) token = t;
    }
  } catch {
    /* headers unavailable in this execution context — fall through to cookie */
  }
  // 2) Cookie fallback (top-level browsing).
  if (!token) {
    const store = await cookies();
    token = store.get(SESSION_COOKIE)?.value ?? null;
  }
  if (!token) return null;
  const s = await db.session.findUnique({ where: { token } });
  if (!s || s.expiresAt < new Date()) return null;
  const userType = s.userType as "admin" | "seller" | "shopper";
  return { userType, userId: s.userId };
}

export async function requireAdmin(): Promise<AdminUserDTO> {
  const sess = await getSession();
  if (!sess || sess.userType !== "admin") throw new ApiError(401, "UNAUTHORIZED", "Admin session required");
  const admin = await db.adminUser.findUnique({ where: { id: sess.userId } });
  if (!admin || !admin.isActive) throw new ApiError(401, "UNAUTHORIZED", "Admin not found");
  return { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
}

export async function requireAdminRole(roles: string[]): Promise<AdminUserDTO> {
  const admin = await requireAdmin();
  if (!roles.includes(admin.role)) throw new ApiError(403, "FORBIDDEN", `Requires role: ${roles.join(" | ")}`);
  return admin;
}

export async function requireSeller(): Promise<SellerUserDTO> {
  const sess = await getSession();
  if (!sess || sess.userType !== "seller") throw new ApiError(401, "UNAUTHORIZED", "Seller session required");
  const seller = await db.seller.findUnique({ where: { id: sess.userId }, include: { store: true } });
  if (!seller) throw new ApiError(401, "UNAUTHORIZED", "Seller not found");
  return {
    id: seller.id, email: seller.email, fullName: seller.fullName, displayName: seller.displayName,
    status: seller.status,
    storeId: seller.store?.id ?? null,
    storeSlug: seller.store?.slug ?? null,
    storeName: seller.store?.name ?? null,
  };
}

/** Seller with an active store (approved / live). */
export async function requireActiveSellerStore() {
  const me = await requireSeller();
  if (!me.storeId) throw new ApiError(400, "NO_STORE", "Store not created yet");
  const store = await db.store.findUnique({ where: { id: me.storeId } });
  if (!store) throw new ApiError(400, "NO_STORE", "Store not found");
  return { me, store };
}

/** Signed-in buyer (shopper) account. */
export async function requireShopper(): Promise<ShopperUserDTO> {
  const sess = await getSession();
  if (!sess || sess.userType !== "shopper") throw new ApiError(401, "UNAUTHORIZED", "Shopper login required");
  const shopper = await db.shopperUser.findUnique({ where: { id: sess.userId } });
  if (!shopper || shopper.status !== "active") throw new ApiError(401, "UNAUTHORIZED", "Shopper account unavailable");
  return { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone };
}

// RBAC capability matrix (PART 1 §1.2) — role checks for admin endpoints
export const ADMIN_CAPS: Record<string, string[]> = {
  "sellers.approve": ["superadmin", "ops"],
  "sellers.suspend": ["superadmin", "ops"],
  "products.moderate": ["superadmin", "ops", "moderator"],
  "commission.manage": ["superadmin", "finance"],
  "payouts.manage": ["superadmin", "finance"],
  "refunds.manage": ["superadmin", "ops", "finance"],
  "disputes.manage": ["superadmin", "ops", "finance"],
  "settings.manage": ["superadmin"],
  "impersonate": ["superadmin"],
  "logs.view": ["superadmin", "ops", "finance"],
  /** Permanent ActivityLog wipe — superadmin only, password re-verified. */
  "logs.purge": ["superadmin"],
  "campaigns.manage": ["superadmin", "ops"],
};

export async function requireCap(cap: keyof typeof ADMIN_CAPS): Promise<AdminUserDTO> {
  const admin = await requireAdmin();
  const allowed = ADMIN_CAPS[cap] ?? ["superadmin"];
  if (!allowed.includes(admin.role)) throw new ApiError(403, "FORBIDDEN", `Capability '${cap}' required`);
  return admin;
}

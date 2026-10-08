// Auth & sessions — cookie-backed sessions stored in DB (revocable).
// Surfaces: admin (admin_users) and seller (sellers). Shoppers are guests.
import { cookies } from "next/headers";
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

export type SessionContext = { userType: "admin" | "seller"; userId: string };

export async function createSession(userType: "admin" | "seller", userId: string): Promise<string> {
  const token = randomToken(32);
  await db.session.create({
    data: { token, userType, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
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
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await db.session.findUnique({ where: { token } });
  if (!s || s.expiresAt < new Date()) return null;
  return { userType: s.userType as "admin" | "seller", userId: s.userId };
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
};

export async function requireCap(cap: keyof typeof ADMIN_CAPS): Promise<AdminUserDTO> {
  const admin = await requireAdmin();
  const allowed = ADMIN_CAPS[cap] ?? ["superadmin"];
  if (!allowed.includes(admin.role)) throw new ApiError(403, "FORBIDDEN", `Capability '${cap}' required`);
  return admin;
}

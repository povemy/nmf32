// Auth & sessions — DB-backed sessions (revocable) delivered via the
// "sm_session" cookie OR an "Authorization: Bearer <token>" header. The Bearer
// path keeps seller/admin portals working in cross-site iframes (preview panel)
// where SameSite cookies are dropped by the browser.
import { cookies, headers } from "next/headers";
import { createHash } from "crypto";
import { db } from "./db";
import { randomToken } from "./password";
import { ApiError } from "./api";

export const SESSION_COOKIE = "sm_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// Phase 1 (C2 / F-4) — session tokens are stored HASHED at rest.
// ---------------------------------------------------------------------------
// The bearer/cookie value handed to the client is 64-hex random (256-bit);
// the Session.token column stores sha256(token) instead of the raw token, so
// a database/backup read can no longer replay live sessions. Lookup hashes
// the presented token first — same PK-indexed findUnique, same revocation and
// expiry semantics, same cookie flags.
//
// MIGRATION (20261101000000_phase1_session_token_hashing): one-time UPDATE
// that hashes existing rows in place. DEPLOY ORDER: run `prisma migrate
// deploy` BEFORE starting the new code. If the order is flipped, rows written
// by the new code would be double-hashed by the later migration — the outcome
// in EITHER wrong-order case is the same benign effect: every live session
// invalidates once and users simply sign in again. There is NO plaintext
// fallback lookup — that would defeat the objective.
// ============================================================================
const sha256Hex = (t: string) => createHash("sha256").update(t).digest("hex");
const hashSessionToken = sha256Hex;

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
    // C2: store sha256(token) — the raw value exists ONLY in the cookie/
    // Bearer response, never at rest.
    data: { token: hashSessionToken(token), userType, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
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
  // F-03 remediation: logout honours the Bearer bridge as well as the cookie —
  // the presented token (Authorization header OR cookie) is retired, and when
  // both exist (cookie + stale Bearer) BOTH session rows are deleted so a
  // logout can never leave a second live token behind.
  const tokens: string[] = [];
  try {
    const h = await headers();
    const auth = h.get("authorization");
    if (auth && auth.toLowerCase().startsWith("bearer ")) {
      const t = auth.slice(7).trim();
      if (/^[a-f0-9]{16,128}$/i.test(t)) tokens.push(t);
    }
  } catch {
    /* headers unavailable in this execution context — fall through to cookie */
  }
  const store = await cookies();
  const cookieToken = store.get(SESSION_COOKIE)?.value;
  if (cookieToken) tokens.push(cookieToken);
  for (const t of new Set(tokens)) {
    await db.session.deleteMany({ where: { token: hashSessionToken(t) } });
  }
  store.delete(SESSION_COOKIE);
}

/** F-02 remediation: revoke EVERY live session for a principal. Wired on admin
 * seller suspend / terminate / reject so an administrative action takes
 * effect immediately — a suspended seller's existing tokens 401 on their very
 * next request, and re-login is blocked at the login gate. Returns the number
 * of sessions revoked (audited). */
export async function revokeUserSessions(
  userType: "admin" | "seller" | "shopper",
  userId: string
): Promise<number> {
  const res = await db.session.deleteMany({ where: { userType, userId } });
  return res.count;
}

/** F-03 remediation: rotate the PRESENTED session (Bearer or cookie).
 * Delete-first — the old token dies before the new one is issued, so a stolen
 * token cannot survive a credential change. Returns the fresh token (login
 * JSON shape contract: { userType, <role>: {...}, token }) or null when no
 * session was presented (caller should 401 → sign-in again). */
export async function rotateSession(): Promise<string | null> {
  let presented: string | null = null;
  try {
    const h = await headers();
    const auth = h.get("authorization");
    if (auth && auth.toLowerCase().startsWith("bearer ")) {
      const t = auth.slice(7).trim();
      if (/^[a-f0-9]{16,128}$/i.test(t)) presented = t;
    }
  } catch {
    /* headers unavailable — fall through to cookie */
  }
  if (!presented) {
    const store = await cookies();
    presented = store.get(SESSION_COOKIE)?.value ?? null;
  }
  if (!presented) return null;

  const existing = await db.session.findUnique({ where: { token: hashSessionToken(presented) } });
  // Delete-first: even when the row is missing/expired the presented token is
  // treated as retired (idempotent), and no fresh session is minted for a
  // session that no longer exists.
  await db.session.deleteMany({ where: { token: hashSessionToken(presented) } });
  if (!existing || existing.expiresAt < new Date()) return null;

  const fresh = randomToken(32);
  await db.session.create({
    data: {
      token: hashSessionToken(fresh),
      userType: existing.userType,
      userId: existing.userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, fresh, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return fresh;
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
  // C2: hash before lookup — the stored value is sha256(raw).
  const s = await db.session.findUnique({ where: { token: hashSessionToken(token) } });
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

/** Seller with a store — the STORE-OPERATIONS tier, now enforcing account
 * status (F-02 remediation).
 *
 * Tier design (preserves the documented onboarding & approval process):
 *   • identity tier — requireSeller(): any status; only /api/auth/me and
 *     /api/store/onboarding use it (onboarding is separately status-gated to
 *     onboarding|rejected, its documented pre-approval loop).
 *   • THIS tier — every /api/store/** mutation route (56 routes): sellers
 *     whose account was administratively SUSPENDED or TERMINATED are blocked
 *     server-side (403), regardless of any client-side UI state. Onboarding-
 *     tier statuses (onboarding / pending_review / rejected) remain allowed —
 *     a rejected seller must still be able to revise their store and
 *     resubmit for review (POST /api/store/onboarding allows rejected). */
export async function requireActiveSellerStore() {
  const me = await requireSeller();
  if (me.status === "suspended") {
    throw new ApiError(403, "ACCOUNT_SUSPENDED", "This seller account is suspended — store operations are blocked.");
  }
  if (me.status === "terminated") {
    throw new ApiError(403, "ACCOUNT_TERMINATED", "This seller account is terminated — store operations are blocked.");
  }
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

// RBAC capability matrix (PART 1 §1.2) — role checks for admin endpoints.
// The matrix lives in lib/admin-caps.ts (PURE module) so client components
// (admin-shell nav gating) import the SAME source of truth — UI == API.
export { ADMIN_CAPS } from "./admin-caps";
import { ADMIN_CAPS as CAPS, roleHasAnyCap, type AdminCap } from "./admin-caps";

export async function requireCap(cap: AdminCap): Promise<AdminUserDTO> {
  const admin = await requireAdmin();
  const allowed = CAPS[cap] ?? ["superadmin"];
  if (!allowed.includes(admin.role)) throw new ApiError(403, "FORBIDDEN", `Capability '${cap}' required`);
  return admin;
}

/** Any-of capability gate (Phase 3 / F-26): grants access when the admin's
 * role holds ANY of the listed capabilities — e.g. the seller-detail profile
 * is needed by ops (seller management) AND finance (commission overrides),
 * while moderator is excluded from the KYC/bank/wallet PII it returns. */
export async function requireAnyCap(...caps: AdminCap[]): Promise<AdminUserDTO> {
  if (caps.length === 0) throw new ApiError(500, "CONFIG", "requireAnyCap requires at least one capability");
  const admin = await requireAdmin();
  if (!roleHasAnyCap(admin.role, ...caps)) {
    throw new ApiError(403, "FORBIDDEN", `Capability required: ${caps.join(" | ")}`);
  }
  return admin;
}

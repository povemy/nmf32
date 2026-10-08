import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, logActivity } from "@/lib/api";

// POST /api/auth/login { email, password, portal: "admin" | "seller" }
export const POST = handle(async (req: NextRequest) => {
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
    await createSession("admin", admin.id);
    await logActivity({ actorType: "admin", actorId: admin.id, actorLabel: admin.email, action: "admin.login" });
    return ok({ userType: "admin", admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
  }

  const seller = await db.seller.findUnique({ where: { email } });
  if (!seller || !verifyPassword(password, seller.passwordHash)) {
    return fail(401, "INVALID_CREDENTIALS", "Invalid seller credentials");
  }
  if (seller.status === "terminated") {
    return fail(403, "ACCOUNT_TERMINATED", "This account has been terminated");
  }
  await createSession("seller", seller.id);
  await logActivity({ actorType: "seller", actorId: seller.id, actorLabel: seller.email, action: "seller.login" });
  const store = await db.store.findUnique({ where: { sellerId: seller.id } });
  return ok({
    userType: "seller",
    seller: {
      id: seller.id, email: seller.email, fullName: seller.fullName, displayName: seller.displayName,
      status: seller.status, storeId: store?.id ?? null, storeSlug: store?.slug ?? null, storeName: store?.name ?? null,
    },
  });
});

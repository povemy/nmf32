import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { claimGuestStateForShopper } from "@/lib/shopper-merge";
import { readOwnerToken } from "../../../checkout/owner";

// POST /api/auth/shopper/register { fullName, email, password, phone? } — buyer signup.
// Guest addresses/orders from this device are claimed into the brand-new account.
export const POST = handle(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as {
    email?: string; password?: string; fullName?: string; phone?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const fullName = (body.fullName ?? "").trim();
  const phone = (body.phone ?? "").trim() || null;

  if (!email.includes("@")) return fail(400, "VALIDATION", "A valid email is required");
  if (password.length < 8) return fail(400, "VALIDATION", "Password must be at least 8 characters");
  if (!fullName) return fail(400, "VALIDATION", "Full name is required");

  const exists = await db.shopperUser.findUnique({ where: { email } });
  if (exists) return fail(409, "EMAIL_TAKEN", "An account with this email already exists");

  // A shopper email must not collide with seller/admin accounts (separate portals).
  const sellerClash = await db.seller.findUnique({ where: { email } });
  const adminClash = sellerClash ? null : await db.adminUser.findUnique({ where: { email } });
  if (sellerClash || adminClash) return fail(409, "EMAIL_TAKEN", "This email is already registered on SHOPMESH");

  const shopper = await db.shopperUser.create({
    data: { email, passwordHash: hashPassword(password), fullName, phone, lastLoginAt: new Date() },
  });

  const token = await createSession("shopper", shopper.id);
  const claimed = await claimGuestStateForShopper(shopper.id, shopper.email, await readOwnerToken());
  await logActivity({ actorType: "shopper", actorId: shopper.id, actorLabel: shopper.email, action: "shopper.register" });
  return ok({
    userType: "shopper",
    shopper: { id: shopper.id, email: shopper.email, fullName: shopper.fullName, phone: shopper.phone },
    token,
    claimed,
  });
});

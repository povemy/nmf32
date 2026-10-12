import { NextResponse } from "next/server";
import { getSession, requireAdmin, requireSeller, requireShopper } from "@/lib/auth";
import { handle, ok } from "@/lib/api";

export const GET = handle(async () => {
  const sess = await getSession();
  if (!sess) return ok({ userType: null });
  if (sess.userType === "admin") {
    const admin = await requireAdmin();
    return ok({ userType: "admin", admin });
  }
  if (sess.userType === "shopper") {
    const shopper = await requireShopper();
    return ok({ userType: "shopper", shopper });
  }
  const seller = await requireSeller();
  return ok({ userType: "seller", seller });
});

import { NextResponse } from "next/server";
import { getSession, requireAdminUngated, requireSeller, requireShopper } from "@/lib/auth";
import { handle, ok } from "@/lib/api";
import { mfaEnrollmentGate } from "@/lib/mfa";
import type { MeAnonymousData, MeAdminData, MeSellerData, MeShopperData } from "@/lib/types/api-contract";

export const GET = handle(async () => {
  const sess = await getSession();
  if (!sess) {
    const payload: MeAnonymousData = { userType: null };
    return ok(payload);
  }
  if (sess.userType === "admin") {
    // PHASE 2.1 (§5-B): ungated so a restricted (unenrolled privileged) admin
    // can still see their own state; the flag drives the admin-shell banner.
    const admin = await requireAdminUngated();
    const gate = await mfaEnrollmentGate(admin.role, admin.id);
    const payload: MeAdminData = { userType: "admin", admin, mfaEnrollmentRequired: gate.enrollmentRequired };
    return ok(payload);
  }
  if (sess.userType === "shopper") {
    const shopper = await requireShopper();
    const payload: MeShopperData = { userType: "shopper", shopper };
    return ok(payload);
  }
  const seller = await requireSeller();
  const payload: MeSellerData = { userType: "seller", seller };
  return ok(payload);
});

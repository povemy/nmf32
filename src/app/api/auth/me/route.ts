import { NextResponse } from "next/server";
import { getSession, requireAdminUngated, requireSeller, requireShopper } from "@/lib/auth";
import { handle, ok } from "@/lib/api";
import { mfaEnrollmentGate } from "@/lib/mfa";

export const GET = handle(async () => {
  const sess = await getSession();
  if (!sess) return ok({ userType: null });
  if (sess.userType === "admin") {
    // PHASE 2.1 (§5-B): ungated so a restricted (unenrolled privileged) admin
    // can still see their own state; the flag drives the admin-shell banner.
    const admin = await requireAdminUngated();
    const gate = await mfaEnrollmentGate(admin.role, admin.id);
    return ok({ userType: "admin", admin, mfaEnrollmentRequired: gate.enrollmentRequired });
  }
  if (sess.userType === "shopper") {
    const shopper = await requireShopper();
    return ok({ userType: "shopper", shopper });
  }
  const seller = await requireSeller();
  return ok({ userType: "seller", seller });
});

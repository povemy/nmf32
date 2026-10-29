"use client";

import { useApp } from "@/lib/app-store";
import { roleHasAnyCap, type AdminCap } from "@/lib/admin-caps";

/**
 * Client mirror of the server capability gate for the signed-in admin
 * (Phase 3 UI/API consistency). Views use `can(...)` to hide controls the
 * session's role cannot execute — the SERVER remains the enforcement
 * boundary (lib/auth.ts requireCap/requireAnyCap); this is UX consistency.
 */
export function useAdminCaps() {
  const me = useApp((s) => s.me);
  const role = me.loaded && me.admin ? me.admin.role : "";
  return {
    role,
    can: (...caps: AdminCap[]) => role !== "" && roleHasAnyCap(role, ...caps),
  };
}

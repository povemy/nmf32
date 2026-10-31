/**
 * Admin RBAC capability matrix — single source of truth (PART 1 §1.2).
 *
 * PURE module: no Prisma / server-only imports, so the SAME matrix is usable
 * from server guards (lib/auth.ts requireCap) and client components
 * (admin-shell navigation gating) — one matrix, one behavior, UI == API.
 *
 * Phase 3 note (F-26 remediation): `reports.export` is a matrix EXTENSION —
 * the audit flagged /api/admin/export (bulk CSV of customer emails + wallet
 * balances + full ledger) as a money/PII read under bare requireAdmin, and no
 * existing cap covered bulk data export. Tier matches the data class:
 * superadmin + finance (same tier as commission.manage / payouts.manage).
 */

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
  /** Bulk PII + money CSV export (/api/admin/export) — Phase 3 extension. */
  "reports.export": ["superadmin", "finance"],
  /** Affiliate programme operations — review/suspend affiliates, sponsor
   *  corrections (audited), commission hold/release, fraud review. */
  "affiliate.manage": ["superadmin", "ops"],
  /** Affiliate financial operations — payouts (approve/mark-paid/fail),
   *  reconciliation, financial exports. Same tier as payouts.manage. */
  "affiliate.finance": ["superadmin", "finance"],
  /** Review moderation queue (Task B1) — list + approve/reject verified-purchase
   *  product reviews. Same tier as products.moderate: this is content
   *  moderation, so the moderator role is included (no money/PII beyond the
   *  review author's own submission). */
  "reviews.moderate": ["superadmin", "ops", "moderator"],
};

export type AdminCap = keyof typeof ADMIN_CAPS;

/** Pure role check — the client mirror of the server's requireCap logic. */
export function roleHasCap(role: string, cap: AdminCap): boolean {
  const allowed = ADMIN_CAPS[cap] ?? ["superadmin"];
  return allowed.includes(role);
}

/** Pure any-of check — mirrors the server's requireAnyCap. */
export function roleHasAnyCap(role: string, ...caps: AdminCap[]): boolean {
  return caps.some((c) => roleHasCap(role, c));
}

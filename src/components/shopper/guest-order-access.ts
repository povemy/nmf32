// ============================================================================
// Guest order-access grant store (FINAL CLOSURE §1 — client side).
//
// Holds the short-lived (15-min) order-access grants issued by
// POST /api/orders/otp/verify — STRICTLY IN MEMORY (a module-level Map):
//   • NEVER localStorage / sessionStorage / cookies / IndexedDB — the
//     mandate requires grants to be "not persistently exposed to client-side
//     storage", and in-memory-only also means a page reload drops them
//     (re-verify through the email round-trip), which is exactly the
//     intended security posture.
//   • Lost on navigation away from the SPA too? No — module state survives
//     client-side route changes within the same page session; a full reload
//     clears it.
//   • Pruned on read (expired entries never authorize anything).
// ============================================================================

type GrantEntry = { grant: string; expiresAtMs: number };

const grants = new Map<string, GrantEntry>();

/** Store a freshly verified grant (called from the OTP verify response). */
export function rememberOrderGrant(orderNumber: string, grant: string, expiresAtMs: number): void {
  grants.set(orderNumber, { grant, expiresAtMs });
}

/** The live grant for an order, or null when absent/expired (pruned). */
export function orderGrant(orderNumber: string): string | null {
  const entry = grants.get(orderNumber);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    grants.delete(orderNumber);
    return null;
  }
  return entry.grant;
}

/** Authorization headers for a grant-held order fetch (undefined → none). */
export function orderGrantHeaders(orderNumber: string): Record<string, string> | undefined {
  const grant = orderGrant(orderNumber);
  return grant ? { Authorization: `Bearer ${grant}` } : undefined;
}

/** Drop a grant early (e.g. the server answered 401 — it expired
 *  server-side or was revoked by secret rotation). */
export function forgetOrderGrant(orderNumber: string): void {
  grants.delete(orderNumber);
}

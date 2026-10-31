"use client";
// ============================================================================
// Cross-cutting session signals (sign-out reliability fix).
//
// Problem this module solves: the three portals (seller / admin / shopper)
// each had their own logout wiring, and none of them reacted to a session
// dying underneath the UI (other-tab sign-out, admin revocation, expiry).
// A stale dashboard kept rendering "features & functions" that 401'd on use —
// looking exactly like a decorative sign-out.
//
// Signals:
//   • SESSION_EXPIRED_EVENT — any client API helper got a 401. app-root
//     listens and re-checks /api/auth/me (throttled). If the session is
//     really gone the portal auth gates take over immediately.
//   • SIGNED_OUT_EVENT — a sign-out just completed in THIS document. The
//     shopper shell (which stays mounted) resets to the market home.
// ============================================================================
import { SESSION_TOKEN_KEY } from "./session-client";

/** localStorage key holding the shopper surface's last view (shopper-shell). */
export const SHOPPER_VIEW_KEY = "sm_shopper_view";

export const SESSION_EXPIRED_EVENT = "nomofee:session-expired";
export const SIGNED_OUT_EVENT = "nomofee:signed-out";

let lastExpiredSignal = 0;
const EXPIRED_THROTTLE_MS = 3000;

/** Fire the session-expired signal (throttled — a dead session can 401 a
 *  whole dashboard of polling endpoints at once; one re-check is enough). */
export function signalSessionExpired(): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  if (now - lastExpiredSignal < EXPIRED_THROTTLE_MS) return;
  lastExpiredSignal = now;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/** Fire the signed-out signal — always dispatched (not throttled): each
 *  sign-out is a distinct, user-initiated event. */
export function signalSignedOut(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

/** True when a storage event represents the session token changing/removing
 *  (another tab signed in or out) — used by app-root to re-check identity. */
export function isSessionStorageEvent(e: StorageEvent): boolean {
  return e.key === null || e.key === SESSION_TOKEN_KEY;
}

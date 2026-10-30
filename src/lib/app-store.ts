"use client";
// App-wide client state: which surface is active + auth session.
import { create } from "zustand";
import { authHeaders, clearSessionToken, getSessionToken, webHeaders } from "./session-client";
import { clearMeHubCache, prefetchMeHub } from "./me-hub-cache";
import { SHOPPER_VIEW_KEY, signalSignedOut } from "./session-events";

export type Surface = "shopper" | "seller" | "admin";

export type AdminMe = { id: string; email: string; name: string; role: string };
export type SellerMe = { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string | null; storeSlug: string | null; storeName: string | null };
export type ShopperMe = { id: string; email: string; fullName: string; phone: string | null };

export type MeState =
  | { loaded: true; admin: AdminMe; seller: null; shopper: null }
  | { loaded: true; admin: null; seller: SellerMe; shopper: null }
  | { loaded: true; admin: null; seller: null; shopper: ShopperMe }
  | { loaded: true; admin: null; seller: null; shopper: null }
  | { loaded: false };

type AppState = {
  surface: Surface;
  activeStoreSlug: string | null;
  me: MeState;
  // shopper sign-in dialog (openable from Contact Seller, header, etc.)
  shopperAuthOpen: boolean;
  afterShopperAuth: (() => void) | null;
  setSurface: (s: Surface) => void;
  hydrateSurface: () => void;
  setActiveStoreSlug: (slug: string | null) => void;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;
  openShopperAuth: (after?: () => void) => void;
  closeShopperAuth: () => void;
};

export const useApp = create<AppState>((set, get) => ({
  // Always start as "shopper" so SSR/client markup match; localStorage is
  // applied after mount via hydrateSurface() (avoids hydration mismatch).
  surface: "shopper",
  activeStoreSlug: null,
  me: { loaded: false },
  shopperAuthOpen: false,
  afterShopperAuth: null,
  setSurface: (s) => {
    if (typeof window !== "undefined") window.localStorage.setItem("sm_surface", s);
    set({ surface: s });
  },
  hydrateSurface: () => {
    if (typeof window === "undefined") return;
    // A landing URL carrying a shopper deep link — `?sf=` storefront (sitemap,
    // SEO and CAMPAIGN tracking links) or a claim landing — always shows the
    // SHOPPER surface for this page load, regardless of the last-used portal.
    // Plain state (no persistence) so the next plain load still returns to the
    // user's preferred portal: a seller clicking their own campaign link sees
    // the storefront a customer would see, and the visit is attributed.
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has("sf") || params.has("claim_job")) {
        set({ surface: "shopper" });
        return;
      }
    } catch {
      /* ignore */
    }
    const s = window.localStorage.getItem("sm_surface");
    if (s === "seller" || s === "admin" || s === "shopper") set({ surface: s });
  },
  setActiveStoreSlug: (slug) => set({ activeStoreSlug: slug }),
  refreshMe: async () => {
    try {
      // Authorization header carries the session when cookies are unavailable
      // (e.g. cross-site iframe preview panels).
      const res = await fetch("/api/auth/me", { cache: "no-store", headers: authHeaders() });
      const body = await res.json();
      const data = body?.data;
      if (data?.userType === "admin") {
        set({ me: { loaded: true, admin: data.admin, seller: null, shopper: null } });
      } else if (data?.userType === "seller") {
        set({ me: { loaded: true, admin: null, seller: data.seller, shopper: null } });
      } else if (data?.userType === "shopper") {
        set({ me: { loaded: true, admin: null, seller: null, shopper: data.shopper } });
        // Task 34: warm the Me-hub cache the moment the shopper identity
        // lands (boot, sign-in, register) — the Me page banner then paints
        // from prefetched/persisted data instead of skeleton-while-fetching.
        prefetchMeHub(data.shopper.id);
      } else {
        set({ me: { loaded: true, admin: null, seller: null, shopper: null } });
      }
    } catch {
      set({ me: { loaded: true, admin: null, seller: null, shopper: null } });
    }
  },
  logout: async () => {
    // Sign-out reliability fix — TWO bugs lived here before:
    // 1) clearSessionToken() ran BEFORE the fetch, so authHeaders() was empty
    //    and the Bearer token was never sent to /api/auth/logout. In
    //    cookie-less contexts (cross-site iframe preview panels) the server
    //    had no token to destroy and the DB session row SURVIVED — sign-out
    //    looked decorative. Fix: capture the token first, present it to the
    //    logout endpoint, then clear local state.
    // 2) Any fetch failure propagated and skipped refreshMe + every caller's
    //    success toast — a network blip made the button do literally nothing.
    //    Fix: tolerate the failure; local identity is cleared regardless and
    //    refreshMe re-syncs the UI with what the server still believes.
    const token = getSessionToken();
    clearSessionToken();
    clearMeHubCache(); // Task 34: drop the persisted Me banner snapshot with the session
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        // Bearer (when captured) + the X-SM-Client origin-gate marker, so the
        // logout POST itself can never be CSRF-rejected behind rewriting proxies.
        headers: token ? { Authorization: `Bearer ${token}`, ...webHeaders() } : authHeaders(),
      });
    } catch {
      /* network failure — session may survive server-side until expiry, but
         this browser no longer holds a usable token (cleared above) and
         refreshMe below will confirm the signed-out UI state */
    }
    await get().refreshMe();

    // ---- redirect to the marketplace homepage (identical on ALL portals) ---
    // Clear the persisted shopper view + any store deep-link so the shopper
    // surface boots into the market home, then switch the surface itself.
    try {
      window.localStorage.removeItem(SHOPPER_VIEW_KEY);
    } catch {
      /* storage unavailable — fresh mount defaults to market home anyway */
    }
    set({ activeStoreSlug: null });
    if (get().surface !== "shopper") get().setSurface("shopper");
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    // Same-document signal: the shopper shell (already mounted when signing
    // out of a shopper session) resets its in-memory view to the home page.
    signalSignedOut();
  },
  openShopperAuth: (after) => set({ shopperAuthOpen: true, afterShopperAuth: after ?? null }),
  closeShopperAuth: () => set({ shopperAuthOpen: false, afterShopperAuth: null }),
}));

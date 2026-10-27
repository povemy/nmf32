"use client";
// App-wide client state: which surface is active + auth session.
import { create } from "zustand";
import { authHeaders, clearSessionToken } from "./session-client";
import { clearMeHubCache, prefetchMeHub } from "./me-hub-cache";

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
    clearSessionToken();
    clearMeHubCache(); // Task 34: drop the persisted Me banner snapshot with the session
    await fetch("/api/auth/logout", { method: "POST", headers: authHeaders() });
    await get().refreshMe();
  },
  openShopperAuth: (after) => set({ shopperAuthOpen: true, afterShopperAuth: after ?? null }),
  closeShopperAuth: () => set({ shopperAuthOpen: false, afterShopperAuth: null }),
}));

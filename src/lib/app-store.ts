"use client";
// App-wide client state: which surface is active + auth session.
import { create } from "zustand";

export type Surface = "shopper" | "seller" | "admin";

export type MeState =
  | { loaded: true; admin: null | { id: string; email: string; name: string; role: string } }
  | { loaded: true; admin: null; seller: null | { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string | null; storeSlug: string | null; storeName: string | null } }
  | { loaded: false };

type AppState = {
  surface: Surface;
  activeStoreSlug: string | null;
  me: MeState;
  setSurface: (s: Surface) => void;
  hydrateSurface: () => void;
  setActiveStoreSlug: (slug: string | null) => void;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;
};

export const useApp = create<AppState>((set, get) => ({
  // Always start as "shopper" so SSR/client markup match; localStorage is
  // applied after mount via hydrateSurface() (avoids hydration mismatch).
  surface: "shopper",
  activeStoreSlug: null,
  me: { loaded: false },
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
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const body = await res.json();
      const data = body?.data;
      if (data?.userType === "admin") {
        set({ me: { loaded: true, admin: data.admin } } as MeState);
      } else if (data?.userType === "seller") {
        set({ me: { loaded: true, admin: null, seller: data.seller } } as MeState);
      } else {
        set({ me: { loaded: true, admin: null, seller: null } } as MeState);
      }
    } catch {
      set({ me: { loaded: true, admin: null, seller: null } } as MeState);
    }
  },
  logout: async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    await get().refreshMe();
  },
}));

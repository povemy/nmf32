"use client";
// NOMOFEE single-route app shell — portal switcher across the three surfaces:
// Shopper (marketplace + storefronts), Seller (dashboard), Admin (command centre).
// In production these live on separate hosts (market/nomofee.io, seller.nomofee.io,
// admin.nomofee.io); in this sandbox they are surfaces on one route.
import { useEffect } from "react";
import { useApp } from "@/lib/app-store";
import ShopperShell from "@/components/shopper/shopper-shell";
import SellerShell from "@/components/seller/seller-shell";
import AdminShell from "@/components/admin/admin-shell";
import PortalFab from "@/components/portal-fab";
import { Toaster } from "@/components/ui/sonner";
import { Loader2 } from "lucide-react";
import { SESSION_EXPIRED_EVENT, isSessionStorageEvent } from "@/lib/session-events";

export default function AppRoot() {
  const surface = useApp((s) => s.surface);
  const refreshMe = useApp((s) => s.refreshMe);
  const hydrateSurface = useApp((s) => s.hydrateSurface);
  const me = useApp((s) => s.me);

  useEffect(() => {
    hydrateSurface();
    refreshMe();
  }, [hydrateSurface, refreshMe]);

  // ---- session liveness watchers (sign-out reliability fix) ----------------
  // A session can die underneath a mounted portal: another tab signs out, an
  // admin suspends/terminates the account (revokes every token), or the 7-day
  // TTL lapses. Without these listeners the portal kept rendering a fully
  // interactive dashboard whose every action 401'd — the "sign out must be
  // just a decoration" effect. Every signal converges on ONE cheap re-check
  // of /api/auth/me; when it reports signed-out the shell auth gates below
  // take over immediately (seller/admin surfaces drop to their login screens).
  useEffect(() => {
    let lastCheck = 0;
    const CHECK_FLOOR_MS = 2500; // debounce bursts (a dead session 401s many endpoints at once)
    const recheck = () => {
      const now = Date.now();
      if (now - lastCheck < CHECK_FLOOR_MS) return;
      lastCheck = now;
      void refreshMe();
    };
    const onStorage = (e: StorageEvent) => {
      if (isSessionStorageEvent(e)) recheck();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("storage", onStorage); // cross-tab sign-in / sign-out
    window.addEventListener(SESSION_EXPIRED_EVENT, recheck); // 401 from any API helper
    window.addEventListener("focus", recheck); // returning to a long-idle tab
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SESSION_EXPIRED_EVENT, recheck);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshMe]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* portal switcher (demo chrome) — single draggable floating button */}
      <PortalFab />

      {/* Global toast container — mounted ABOVE the surface switch so
          notifications survive portal changes (the "Signed out" toast used to
          vanish with the seller shell unmounting, and admin had no sonner
          container at all). */}
      <Toaster position="bottom-right" richColors closeButton />

      {!me.loaded ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Loading NOMOFEE…</p>
          </div>
        </div>
      ) : surface === "shopper" ? (
        <ShopperShell />
      ) : surface === "seller" ? (
        <SellerShell />
      ) : (
        <AdminShell />
      )}
    </div>
  );
}

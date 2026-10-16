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
import { Loader2 } from "lucide-react";

export default function AppRoot() {
  const surface = useApp((s) => s.surface);
  const refreshMe = useApp((s) => s.refreshMe);
  const hydrateSurface = useApp((s) => s.hydrateSurface);
  const me = useApp((s) => s.me);

  useEffect(() => {
    hydrateSurface();
    refreshMe();
  }, [hydrateSurface, refreshMe]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* portal switcher (demo chrome) — single draggable floating button */}
      <PortalFab />

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

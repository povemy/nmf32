"use client";
// SHOPMESH single-route app shell — portal switcher across the three surfaces:
// Shopper (marketplace + storefronts), Seller (dashboard), Admin (command centre).
// In production these live on separate hosts (market/shopmesh.io, seller.shopmesh.io,
// admin.shopmesh.io); in this sandbox they are surfaces on one route.
import { useEffect } from "react";
import { useApp } from "@/lib/app-store";
import ShopperShell from "@/components/shopper/shopper-shell";
import SellerShell from "@/components/seller/seller-shell";
import AdminShell from "@/components/admin/admin-shell";
import { Store, ShoppingBag, ShieldCheck, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SURFACES: { key: "shopper" | "seller" | "admin"; label: string; icon: typeof Store }[] = [
  { key: "shopper", label: "Market", icon: ShoppingBag },
  { key: "seller", label: "Seller", icon: Store },
  { key: "admin", label: "Admin", icon: ShieldCheck },
];

export default function AppRoot() {
  const surface = useApp((s) => s.surface);
  const setSurface = useApp((s) => s.setSurface);
  const refreshMe = useApp((s) => s.refreshMe);
  const hydrateSurface = useApp((s) => s.hydrateSurface);
  const me = useApp((s) => s.me);

  useEffect(() => {
    hydrateSurface();
    refreshMe();
  }, [hydrateSurface, refreshMe]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* portal switcher (demo chrome) */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] print:hidden">
        <div className="flex items-center gap-1 rounded-full border bg-background/95 shadow-lg backdrop-blur px-1.5 py-1.5">
          <span className="pl-2 pr-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground hidden sm:block">
            Portal
          </span>
          {SURFACES.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setSurface(key)}
              aria-label={`Switch to ${label} portal`}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors min-h-[32px]",
                surface === key ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {!me.loaded ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Loading SHOPMESH…</p>
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

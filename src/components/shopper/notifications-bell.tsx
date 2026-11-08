"use client";
// ============================================================================
// NotificationsBell (Task 10-d) — the smart-nudges bell + feed popover.
// Polls GET /api/me/notifications every 60s, refetches when the panel opens,
// marks items read via POST, and deep-links into the SPA using the shell's
// URL-ish scheme (/me?tab=purchases, /?sf={store}&sp={product}).
// Renders NOTHING for guests / seller / admin portals — caller decides, but
// we double-guard on the signed-in shopper state here too.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2, Package, Tag, Store, Truck, BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { fetchJson, postJson, fmtDateTime, type ShopperView } from "./ui-bits";
import type { MarkReadBody, MarkReadData, NotificationsData } from "@/lib/types/api-contract";

// ---------------------------------------------------------------------------
// Shapes — the feed rows are a legacy UI projection (client-enriched relative
// buckets, linkUrl/orderId flags) the current backend no longer emits; the
// contract's canonical row is MeNotification (see notification-bell.tsx).
// ---------------------------------------------------------------------------

type NotificationItemT = {
  id: string;
  type: string; // ORDER_SHIPPED | ORDER_DELIVERED | ORDER_COMPLETED | NEW_PRODUCT_FROM_FOLLOWED | VOUCHER_CLAIMED | SYSTEM
  title: string;
  body: string;
  linkUrl: string | null;
  orderId: string | null;
  readAt: string | null;
  createdAt: string;
  unread: boolean;
  rel: "now" | "m" | "h" | "d" | "date";
  relValue: number | null;
};

/** Retired flat panel shape this legacy bell still reads. The synced route
 *  now answers the contract's NotificationsData / MarkReadData envelopes, so
 *  these fields are absent on the wire and the `??` guards below keep the
 *  exact same (empty-feed / zero-badge) runtime as before. */
type LegacyPanelView = { items?: NotificationItemT[]; unreadCount?: number };

const TYPE_ICON: Record<string, typeof Truck> = {
  ORDER_SHIPPED: Truck,
  ORDER_DELIVERED: Package,
  ORDER_COMPLETED: CheckCircle2,
  NEW_PRODUCT_FROM_FOLLOWED: Store,
  VOUCHER_CLAIMED: Tag,
  SYSTEM: BellRing,
};

function relStamp(n: NotificationItemT): string {
  switch (n.rel) {
    case "now":
      return "Just now";
    case "m":
      return `${n.relValue}m ago`;
    case "h":
      return `${n.relValue}h ago`;
    case "d":
      return `${n.relValue}d ago`;
    default:
      return fmtDateTime(n.createdAt);
  }
}

/** Deep-link a notification into the SPA's internal view state machine.
 *  Recognised targets (written by the backend triggers):
 *   - /me?tab=purchases|vouchers|…  → Me hub sub-view
 *   - /?sf={store}&sp={product}     → PDP (or storefront without sp)
 *   - /?sf={store}                  → storefront
 *   - / (or unknown)                → marketplace home
 *  Returns false when nothing usable was parsed. */
export function navFromLink(link: string | null | undefined, nav: (v: ShopperView) => void): boolean {
  const raw = (link ?? "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw, "https://nomofee.internal");
    if (u.pathname === "/me") {
      const tab = u.searchParams.get("tab") ?? undefined;
      nav({ name: "me", tab });
      return true;
    }
    if (u.pathname === "/") {
      const sf = u.searchParams.get("sf");
      if (sf) {
        const sp = u.searchParams.get("sp");
        nav(sp ? { name: "pdp", slug: sf, pSlug: sp } : { name: "storefront", slug: sf });
        return true;
      }
      nav({ name: "market" });
      return true;
    }
  } catch {
    /* malformed link — fall through */
  }
  return false;
}

// ---------------------------------------------------------------------------

export default function NotificationsBell({ nav }: { nav: (v: ShopperView) => void }) {
  const me = useApp((s) => s.me);
  const signedIn = Boolean(me.loaded && me.shopper);

  const [items, setItems] = useState<NotificationItemT[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<NotificationsData>("/api/me/notifications");
      const legacy = d as unknown as LegacyPanelView;
      if (!aliveRef.current) return;
      setItems(legacy.items ?? []);
      setUnread(legacy.unreadCount ?? 0);
    } catch {
      /* silent — the bell is non-critical chrome */
    }
  }, []);

  // 60s light polling while signed in (+ instant reset on sign-out).
  useEffect(() => {
    aliveRef.current = true;
    if (!signedIn) {
      setItems(null);
      setUnread(0);
      return;
    }
    void load();
    const t = setInterval(() => void load(), 60000);
    return () => {
      aliveRef.current = false;
      clearInterval(t);
    };
  }, [signedIn, load]);

  // Opening the panel always refetches (fresh feed without waiting a tick).
  useEffect(() => {
    if (open && signedIn) void load();
  }, [open, signedIn, load]);

  const markRead = useCallback(
    async (ids: string[]) => {
      // optimistic — the badge drops immediately, server confirms after
      setUnread((u) => Math.max(0, u - ids.length));
      setItems((prev) => prev?.map((n) => (ids.includes(n.id) ? { ...n, unread: false, readAt: n.readAt ?? new Date().toISOString() } : n)) ?? prev);
      try {
        const body: MarkReadBody = { ids };
        const d = await postJson<MarkReadData>("/api/me/notifications", body);
        setUnread((d as unknown as LegacyPanelView).unreadCount ?? 0);
      } catch {
        void load();
      }
    },
    [load]
  );

  const markAllRead = useCallback(async () => {
    setMarkingAll(true);
    try {
      const body: MarkReadBody = { all: true };
      const d = await postJson<MarkReadData>("/api/me/notifications", body);
      const legacy = d as unknown as LegacyPanelView;
      setUnread(0);
      setItems((prev) => prev?.map((n) => ({ ...n, unread: false, readAt: n.readAt ?? new Date().toISOString() })) ?? prev);
      toast.success("All notifications marked read");
      if (typeof legacy.unreadCount === "number") setUnread(legacy.unreadCount);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not mark notifications read");
    } finally {
      setMarkingAll(false);
    }
  }, []);

  const onItemClick = useCallback(
    (n: NotificationItemT) => {
      if (n.unread) void markRead([n.id]);
      setOpen(false);
      // Navigate when we can; unknown/absent links fall back to purchases —
      // the most common destination (order nudges).
      if (!navFromLink(n.linkUrl, nav)) nav({ name: "me", tab: "purchases" });
    },
    [markRead, nav]
  );

  if (!signedIn) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
          className={cn(
            "relative inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 sm:px-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
            open && "text-teal-800 bg-teal-50"
          )}
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          <span className="hidden md:inline">Alerts</span>
          {unread > 0 ? (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-extrabold text-white shadow"
              aria-hidden="true"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[360px] max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <p className="text-sm font-bold tracking-tight">Notifications</p>
          {unread > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 min-h-[36px] px-2.5 text-xs font-semibold text-teal-700 hover:bg-teal-50"
              onClick={() => void markAllRead()}
              disabled={markingAll}
              aria-label="Mark all notifications read"
            >
              {markingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Mark all read
            </Button>
          ) : null}
        </div>

        {items === null ? (
          <div className="flex items-center justify-center py-10" role="status" aria-label="Loading notifications">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <div className="rounded-full bg-muted p-4">
              <Bell className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold">All caught up</p>
            <p className="text-xs text-muted-foreground">Order updates, new arrivals from stores you follow and voucher wins will land here.</p>
          </div>
        ) : (
          <ul role="list" aria-label="Notification feed" className="max-h-96 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:rgba(20,184,166,0.45)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/30">
            {items.map((n) => {
              const Icon = TYPE_ICON[n.type] ?? BellRing;
              return (
                <li key={n.id} role="listitem">
                  <button
                    type="button"
                    onClick={() => onItemClick(n)}
                    aria-label={`${n.title}. ${n.body}. ${n.unread ? "Unread" : "Read"}`}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors border-b last:border-b-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:bg-muted/60",
                      n.unread ? "bg-teal-50/50" : "opacity-70"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                        n.unread ? "bg-teal-100 text-teal-800" : "bg-muted text-muted-foreground"
                      )}
                      aria-hidden="true"
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className={cn("text-[13px] leading-snug", n.unread ? "font-bold text-foreground" : "font-medium text-foreground/90")}>
                          {n.title}
                        </span>
                        {n.unread ? (
                          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-600" aria-label="Unread" />
                        ) : null}
                      </span>
                      <span className={cn("mt-0.5 block text-xs leading-snug text-muted-foreground", n.unread && "text-foreground/75")}>
                        {n.body}
                      </span>
                      <span className="mt-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                        {relStamp(n)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

"use client";
// ============================================================================
// NotificationBell — self-contained bell + notifications panel (TASK 10-d UI).
//
// Designed to be mounted anywhere in the shopper chrome (Me hub profile header
// AND the global header — both use the same default export):
//   • unread badge from GET /api/me/notifications/unread (30s poll + on focus
//     / visibilitychange)
//   • panel list from GET /api/me/notifications?size=20 (loaded on open):
//     type icon, title, body, relative time, unread dot
//   • mark-all-read via POST /api/me/notifications {all:true}
//   • click-through: data.orderNumber → onOpenOrder(), data.slug → onOpenStore()
//     (the clicked item is marked read via {ids:[id]})
// Guest-safe: renders null until the shopper session is loaded+signed-in.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import {
  Bell,
  CheckCheck,
  Loader2,
  Megaphone,
  Package,
  PackageCheck,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-store";
import {
  ApiFail,
  dateShort,
  fetchEnvelope,
  fetchJson,
  postJson,
} from "./ui-bits";
import type { MarkReadBody, MarkReadData, MeNotification, NotificationsData, UnreadCountData } from "@/lib/types/api-contract";

// ---------------------------------------------------------------------------
// types — notification feed rows come straight from the contract
// (MeNotification.data is an open Record; order/slug deep-links are read out
// of it with runtime typeof guards in openItem below).
// ---------------------------------------------------------------------------

export type NotificationRowT = MeNotification;

export type NotificationBellProps = {
  /** Navigate to the order-status view for data.orderNumber notifications. */
  onOpenOrder?: (orderNumber: string) => void;
  /** Navigate to a storefront for data.slug notifications (promos). */
  onOpenStore?: (slug: string) => void;
  /** Trigger styling hook — Me hub passes white-on-gradient classes. */
  className?: string;
  /** Panel alignment relative to the trigger (global header → end). */
  align?: "start" | "center" | "end";
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return dateShort(iso);
}

function typeVisual(type: string): { Icon: typeof Bell; tone: string } {
  if (type === "order.shipped") return { Icon: Truck, tone: "bg-teal-100 text-teal-800" };
  if (type === "order.delivered") return { Icon: PackageCheck, tone: "bg-emerald-100 text-emerald-800" };
  if (type.startsWith("order.")) return { Icon: Package, tone: "bg-teal-100 text-teal-800" };
  if (type === "promo") return { Icon: Megaphone, tone: "bg-amber-100 text-amber-800" };
  return { Icon: Bell, tone: "bg-muted text-muted-foreground" };
}

const LIST_SCROLL =
  "max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent";

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export default function NotificationBell({ onOpenOrder, onOpenStore, className, align = "end" }: NotificationBellProps) {
  const authed = useApp((s) => s.me.loaded && Boolean(s.me.shopper));
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [rows, setRows] = useState<NotificationRowT[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  // ---- badge count: 30s poll + refresh on window focus / visibility -------
  const loadUnread = useCallback(async () => {
    if (!authed) return;
    try {
      const d = await fetchJson<UnreadCountData>("/api/me/notifications/unread");
      setUnread(d.unread ?? 0);
    } catch {
      /* offline / session dropped — keep the last badge */
    }
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    const tick = () => void loadUnread();
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    const iv = window.setInterval(tick, 30_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [authed, loadUnread]);

  // ---- panel list ----------------------------------------------------------
  const loadList = useCallback(async () => {
    if (!authed) return;
    setListLoading(true);
    try {
      const env = await fetchEnvelope<NotificationsData>("/api/me/notifications?size=20");
      setRows(env.data ?? []);
    } catch {
      setRows([]);
    } finally {
      setListLoading(false);
    }
  }, [authed]);

  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (v) {
      void loadList();
      void loadUnread();
    }
  };

  const markOne = async (id: string) => {
    try {
      const body: MarkReadBody = { ids: [id] };
      const res = await postJson<MarkReadData>("/api/me/notifications", body);
      setUnread(res.unread ?? 0);
      setRows((prev) => (prev ? prev.map((n) => (n.id === id ? { ...n, read: true } : n)) : prev));
    } catch {
      /* best-effort */
    }
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      const body: MarkReadBody = { all: true };
      const res = await postJson<MarkReadData>("/api/me/notifications", body);
      setUnread(res.unread ?? 0);
      setRows((prev) => (prev ? prev.map((n) => ({ ...n, read: true })) : prev));
    } catch (e) {
      toastFail(e, "Could not mark notifications read");
    } finally {
      setMarkingAll(false);
    }
  };

  const openItem = (n: NotificationRowT) => {
    const orderNumber = typeof n.data?.orderNumber === "string" ? n.data.orderNumber : null;
    const slug = typeof n.data?.slug === "string" ? n.data.slug : null;
    if (!n.read) void markOne(n.id);
    setOpen(false);
    if (orderNumber && onOpenOrder) {
      onOpenOrder(orderNumber);
      return;
    }
    if (slug && onOpenStore) {
      onOpenStore(slug);
    }
  };

  // Hooks above stay mounted; guests simply render nothing.
  if (!authed) return null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "relative flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-muted",
            className ?? "text-foreground hover:text-foreground"
          )}
        >
          <Bell className="h-4.5 w-4.5" aria-hidden="true" />
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
      <PopoverContent align={align} className="w-[calc(100vw-1.5rem)] max-w-sm rounded-2xl p-0 sm:w-96" role="dialog" aria-label="Notifications panel">
        {/* header */}
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-extrabold">Notifications</h2>
          {unread > 0 ? (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-extrabold text-amber-700 tabular-nums">
              {unread} new
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={markingAll || unread === 0}
            onClick={() => void markAllRead()}
            className="ml-auto h-8 min-h-[32px] gap-1 px-2 text-[11px] font-bold text-teal-700 hover:bg-teal-50 hover:text-teal-800"
            aria-label="Mark all notifications as read"
          >
            {markingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />}
            Mark all read
          </Button>
        </div>

        {/* list */}
        {rows === null && listLoading ? (
          <div className="space-y-3 p-4" aria-label="Loading notifications">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center" aria-label="No notifications">
            <span className="rounded-full bg-muted p-4">
              <Bell className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </span>
            <p className="text-sm font-semibold">No notifications yet</p>
            <p className="text-xs text-muted-foreground">Order updates, shipping milestones and deals will land here.</p>
          </div>
        ) : (
          <ul className={cn("divide-y", LIST_SCROLL)} aria-label="Notification list">
            {rows.map((n) => {
              const { Icon, tone } = typeVisual(n.type);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => openItem(n)}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60",
                      !n.read && "bg-teal-50/50"
                    )}
                    aria-label={`${n.title}${n.read ? "" : " — unread"}`}
                  >
                    <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", tone)} aria-hidden="true">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={cn("min-w-0 flex-1 truncate text-[13px] font-semibold", n.read ? "text-foreground" : "font-bold text-teal-900")}>
                          {n.title}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums" title={new Date(n.createdAt).toLocaleString("en-MY")}>
                          {relTime(n.createdAt)}
                        </span>
                      </span>
                      {n.body ? <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted-foreground">{n.body}</span> : null}
                    </span>
                    {!n.read ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-600" aria-hidden="true" /> : null}
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

function toastFail(e: unknown, fallback: string) {
  if (e instanceof ApiFail && e.message) console.warn(`[notification-bell] ${fallback}: ${e.message}`);
  else console.warn(`[notification-bell] ${fallback}`);
}

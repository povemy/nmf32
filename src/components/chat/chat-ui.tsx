"use client";
// ============================================================================
// Shared chat module (shopper inbox + seller inbox).
// Implements the messaging-hub redesign: ChatHeader (back button + "Chats"
// title + live search + All/Active filter pills), ChatListItem (avatar with
// initials fallback, right-aligned smart timestamps, last-message preview
// with ✓/✓✓ delivery ticks, unread badges), skeleton loaders, the desktop
// master-detail empty state, and the useChatHub socket hook that keeps both
// parties instantly in sync (thread rooms + per-user inbox rooms).
// ============================================================================

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { ArrowLeft, Check, CheckCheck, Loader2, MessagesSquare, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatThreadRow = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  contextType: string | null;
  orderNumber: string | null;
  subject: string | null;
  lastMessageAt: string;
  unreadCount: number;
  lastMessage: { body: string; senderType: string; createdAt: string; readAt: string | null } | null;
  /** Shopper-side rows carry the vendor's store slug (→ "view store" links). */
  storeSlug?: string | null;
};

export type ChatMsg = {
  id: string;
  threadId?: string;
  senderType: "shopper" | "seller";
  senderName: string;
  body: string;
  createdAt: string;
  readAt?: string | null;
  isAutoReply?: boolean;
};

export type ChatFilter = "all" | "active";

/** Which side the signed-in user is on — drives bubble alignment + ticks. */
export type ChatSide = "shopper" | "seller";

// ---------------------------------------------------------------------------
// Time + preview helpers
// ---------------------------------------------------------------------------

/** Right-aligned list timestamp: HH:MM today, "Yesterday", weekday within a
 *  week, then a short date. */
export function chatTimeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (t >= startOfToday - 86_400_000) return "Yesterday";
  if (t >= startOfToday - 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Instant client-side thread filtering for the All/Active pills + search.
 * Switching pills used to refetch the list from the server first — with the
 * remote Supabase round-trip that read as a blink ("it validates before it
 * shows"). Filtering the already-loaded snapshot costs nothing, always matches
 * what is on screen, and stays live: socket pushes + read receipts mutate the
 * same snapshot, and this runs on every render over it. The server keeps its
 * ?filter/?q params for API compatibility; the clients simply stop using them.
 */
export function filterChatThreads(rows: ChatThreadRow[], filter: ChatFilter, query: string): ChatThreadRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((t) => {
    if (filter === "active" && t.unreadCount <= 0) return false;
    if (!q) return true;
    return (
      t.displayName.toLowerCase().includes(q) ||
      (t.orderNumber ?? "").toLowerCase().includes(q) ||
      (t.subject ?? "").toLowerCase().includes(q) ||
      (t.lastMessage?.body ?? "").toLowerCase().includes(q)
    );
  });
}

/** Context chip under the title — what the conversation is about. */
export function contextChipLabel(row: { contextType: string | null; orderNumber: string | null }): string {
  if (row.contextType === "order" && row.orderNumber) return `🧾 order ${row.orderNumber}`;
  if (row.contextType === "product") return "🏷️ product enquiry";
  return "💬 direct message";
}

// ---------------------------------------------------------------------------
// Socket hook — live message / activity / read fan-out
// ---------------------------------------------------------------------------

export type ChatHubHandlers = {
  onMessage: (msg: ChatMsg) => void;
  onActivity?: (a: { threadId: string; at: string; preview: string | null; senderType: string | null }) => void;
  onRead?: (r: { threadId: string; readerType: string; at: string }) => void;
  /** Either party cleared the quoted product/order ("x" on the pinned card) —
   *  the conversation becomes a plain direct message for BOTH sides live. */
  onContext?: (c: { threadId: string; context: null }) => void;
};

/** One socket per messages view: joins the thread rooms + this user's private
 *  inbox room, re-joins automatically on reconnect, and re-joins when the
 *  room list grows (brand-new threads) WITHOUT tearing the socket down.
 *  Handlers are kept in a ref so the socket is created exactly ONCE per
 *  mounted view (re-creating on every state change used to drop pushes). */
export function useChatHub(input: {
  threadRooms: string[];
  userRoom: string | null;
  handlers: ChatHubHandlers;
}): void {
  const { threadRooms, userRoom, handlers } = input;
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef(handlers);
  const roomsRef = useRef({ threadRooms, userRoom });
  // Keep the latest handlers/rooms reachable from the socket's event
  // callbacks (registered once at mount) — updated in an effect, never
  // during render (react-hooks/refs).
  useEffect(() => {
    handlersRef.current = handlers;
    roomsRef.current = { threadRooms, userRoom };
  });
  const roomsKey = `${userRoom ?? ""}|${threadRooms.join(",")}`;

  useEffect(() => {
    const socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      // Long-lived preview tabs must NEVER give up: a hub restart (or a sleep /
      // network blip) can outlast a finite attempt budget, after which the tab
      // would silently stop receiving messages until a manual reload.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 10000,
    });
    socketRef.current = socket;

    const joinCurrentRooms = () => {
      const { threadRooms: tr, userRoom: ur } = roomsRef.current;
      const rooms = [...tr, ...(ur ? [ur] : [])];
      if (rooms.length) socket.emit("join", { rooms });
    };

    socket.on("connect", joinCurrentRooms);
    socket.on("chat:message", (msg: ChatMsg) => handlersRef.current.onMessage(msg));
    socket.on(
      "chat:activity",
      (a: { threadId: string; at: string; preview: string | null; senderType: string | null }) => handlersRef.current.onActivity?.(a)
    );
    socket.on("chat:read", (r: { threadId: string; readerType: string; at: string }) => handlersRef.current.onRead?.(r));
    socket.on("chat:context", (c: { threadId: string; context: null }) => handlersRef.current.onContext?.(c));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  // Re-join when the room set changes while connected (new threads appear,
  // user room resolves after identity loads) — joining is idempotent.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;
    const rooms = [...threadRooms, ...(userRoom ? [userRoom] : [])];
    if (rooms.length) socket.emit("join", { rooms });
  }, [roomsKey]);
}

// ---------------------------------------------------------------------------
// ChatHeader — back button + title + search + filter pills
// ---------------------------------------------------------------------------

export function ChatHeader(input: {
  onBack?: () => void;
  backLabel?: string;
  query: string;
  onQuery: (q: string) => void;
  filter: ChatFilter;
  onFilter: (f: ChatFilter) => void;
  searchPlaceholder?: string;
  activeCount?: number;
}) {
  return (
    <div className="space-y-3">
      <div className="flex min-h-[44px] items-center gap-2">
        {input.onBack ? (
          <button
            type="button"
            onClick={input.onBack}
            aria-label={input.backLabel ?? "Back"}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        ) : null}
        <h1 className="text-2xl font-extrabold tracking-tight">Chats</h1>
      </div>

      {/* search — 44px tall, icon inside */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={input.query}
          onChange={(e) => input.onQuery(e.target.value)}
          placeholder={input.searchPlaceholder ?? "Search"}
          aria-label="Search conversations"
          className="h-11 w-full rounded-xl border bg-card pl-10 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-teal-400 focus:ring-2 focus:ring-teal-100"
        />
      </div>

      {/* All / Active pills */}
      <div className="flex items-center gap-1.5" role="tablist" aria-label="Filter conversations">
        {(["all", "active"] as ChatFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={input.filter === f}
            onClick={() => input.onFilter(f)}
            className={cn(
              "flex min-h-[36px] items-center gap-1.5 rounded-full px-4 text-sm font-semibold capitalize transition-colors",
              input.filter === f ? "bg-teal-50 text-teal-800 ring-1 ring-teal-200 dark:bg-teal-950/40 dark:text-teal-200" : "text-muted-foreground hover:bg-muted"
            )}
          >
            {f}
            {f === "active" && (input.activeCount ?? 0) > 0 ? (
              <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-extrabold text-white">{input.activeCount}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context card clear ("x") — small round button pinned to the corner of the
// quoted product/order strip. Tapping it drops the quote so both parties can
// keep chatting casually; the other side's card disappears live via the
// `chat:context` hub event.
// ---------------------------------------------------------------------------

export function ContextClearButton({ onClear, disabled }: { onClear: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClear}
      disabled={disabled}
      aria-label="Remove the quoted order or product from this chat"
      title="Remove quote — keep chatting casually"
      className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full border bg-background/85 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:border-teal-300 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
    >
      <X className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Delivery ticks — single ✓ sent, double ✓✓ read (teal)
// ---------------------------------------------------------------------------

export function MessageTicks({ readAt, className, light }: { readAt?: string | null; className?: string; light?: boolean }) {
  if (readAt) {
    return <CheckCheck className={cn("h-3.5 w-3.5 text-teal-500", light && "text-teal-200", className)} aria-label="Read" />;
  }
  return (
    <span className={cn("inline-flex items-center", light ? "text-white/80" : "text-muted-foreground", className)} aria-label="Sent">
      <Check className="h-3.5 w-3.5" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// ChatListItem — thread row in the list
// ---------------------------------------------------------------------------

export function ChatListItem(input: {
  row: ChatThreadRow;
  active: boolean;
  mySide: ChatSide;
  onSelect: () => void;
}) {
  const { row, active, mySide, onSelect } = input;
  const mine = row.lastMessage && row.lastMessage.senderType === mySide;
  const showTicks = !!mine && !!row.lastMessage;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "w-full rounded-xl p-3 text-left transition-colors min-h-[64px]",
          active ? "bg-teal-50 ring-1 ring-teal-200 dark:bg-teal-950/40" : "hover:bg-muted"
        )}
        aria-label={`Conversation with ${row.displayName}${row.unreadCount > 0 ? `, ${row.unreadCount} unread messages` : ""}`}
        aria-current={active ? "true" : undefined}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-gradient text-xs font-extrabold text-white">
            {row.avatarUrl ? <img src={row.avatarUrl} alt="" className="h-full w-full object-cover" /> : row.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-bold">{row.displayName}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{chatTimeLabel(row.lastMessageAt)}</span>
            </span>
            {/* last-message preview + delivery ticks */}
            <span className="mt-0.5 flex items-center gap-1">
              {showTicks ? <MessageTicks readAt={row.lastMessage!.readAt} className="h-3 w-3 shrink-0" /> : null}
              <span className={cn("min-w-0 flex-1 truncate text-xs", row.unreadCount > 0 ? "font-semibold text-foreground" : "text-muted-foreground")}>
                {row.lastMessage ? row.lastMessage.body : "No messages yet"}
              </span>
              {row.unreadCount > 0 ? (
                <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-extrabold text-white shadow" aria-label={`${row.unreadCount} unread`}>
                  {row.unreadCount > 99 ? "99+" : row.unreadCount}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-[10px] font-medium text-teal-700 dark:text-teal-300">{contextChipLabel(row)}</span>
          </span>
        </div>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Skeletons + empty states
// ---------------------------------------------------------------------------

export function ChatListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-1" aria-hidden role="presentation">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 rounded-xl p-3">
          <span className="h-10 w-10 shrink-0 rounded-full bg-muted" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-1/2 rounded bg-muted" />
            <span className="block h-2.5 w-4/5 rounded bg-muted" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ChatMessagesSkeleton() {
  return (
    <div className="flex h-full flex-col justify-end space-y-3 p-4" aria-hidden role="presentation">
      {[70, 45, 60, 35].map((w, i) => (
        <div key={i} className={cn("flex", i % 2 ? "justify-end" : "justify-start")}>
          <span className="block h-9 animate-pulse rounded-2xl bg-muted" style={{ width: `${w}%` }} />
        </div>
      ))}
      <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Desktop master-detail empty state (right panel, no thread selected). */
export function ChatEmptyDetail() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <span className="flex h-20 w-20 items-center justify-center rounded-full bg-teal-50 ring-8 ring-teal-50/50 dark:bg-teal-950/40 dark:ring-teal-950/20">
        <MessagesSquare className="h-9 w-9 text-teal-600" />
      </span>
      <p className="text-base font-bold">Select a chat thread to start messaging</p>
      <p className="max-w-xs text-sm text-muted-foreground">Your conversations appear here in real time — pick one from the list, or start a new one from any product or order.</p>
    </div>
  );
}

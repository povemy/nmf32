"use client";
// ============================================================================
// Seller Messages — master-detail chat hub (shared chat module).
// • ChatHeader: back button + "Chats" + live search + All/Active pills.
// • Thread list: avatar/initials, smart timestamps, last-message preview with
//   ✓/✓✓ ticks, unread badges — instantly reordered by the socket.io hub.
// • Conversation: context bubble, ticks, quick-reply chips, 44px targets.
// • Live: thread rooms + this seller's user room (brand-new conversations
//   appear without a refresh).
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ChevronDown, Loader2, MessagesSquare, PackageSearch, Send, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SELLER_QUICK_REPLIES } from "@/lib/chat-quick-replies";
import { formatMinor } from "@/lib/money";
import { fmtDateTime } from "@/components/shopper/ui-bits";
import {
  CHAT_PAGE_SIZE,
  ChatHeader,
  ChatListItem,
  ChatListSkeleton,
  ChatMessagesSkeleton,
  ChatEmptyDetail,
  ContextClearButton,
  MessageTicks,
  filterChatThreads,
  useChatHub,
  type ChatThreadRow,
  type ChatMsg,
  type ChatFilter,
} from "@/components/chat/chat-ui";
import { apiGet, apiSend, EmptyState, type SellerNav } from "./ui-bits";
import type {
  ClearContextData,
  SellerReplyData,
  StoreChatThreadSummary,
  ThreadContextCard,
  ThreadMessagesData,
  ThreadReadData,
} from "@/lib/types/api-contract";

/** GET /api/store/chat/threads/[id]/messages payload as this hub consumes it:
 *  the contract types the message rows' senderType as a free string while the
 *  shared chat-ui module narrows it to "shopper" | "seller" for bubble
 *  alignment — so only `messages` is re-typed (rest is ThreadMessagesData). */
type ThreadMessagesView = Omit<ThreadMessagesData, "messages"> & { messages: ChatMsg[] };

/** Older keyset page of the same route (only hasMore + messages are read). */
type ChatMsgPage = Pick<ThreadMessagesView, "hasMore" | "messages">;

/** Conversation header bar state — the contract thread row narrowed to the
 *  fields the header renders. */
type ThreadHeaderView = Pick<ThreadMessagesData["thread"], "shopperName" | "shopperEmail" | "orderNumber" | "contextType" | "subject">;

export default function SellerMessages({ sellerId, onNavigate }: { sellerId?: string | null; onNavigate?: (n: SellerNav) => void } = {}) {
  const [threads, setThreads] = useState<ChatThreadRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadHeaderView | null>(null);
  const [context, setContext] = useState<ThreadContextCard | null>(null);
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  // Phase 2.4 (C2.x): bounded history — the GET returns the latest
  // CHAT_PAGE_SIZE messages + hasMore; "Load older messages" prepends the
  // next keyset page (?before=<oldest id>) without losing the scroll anchor.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const prependRestoreRef = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      // Fetch the FULL list once; the All/Active pills and search filter the
      // local snapshot instantly (filterChatThreads). Pill switches used to
      // refetch from the remote DB first — that was the blink. Socket pushes
      // + read receipts keep this snapshot live and authoritative.
      const d = await apiGet<StoreChatThreadSummary[]>("/api/store/chat/threads?size=100");
      const rows = d ?? [];
      setThreads(rows);
      return rows;
    } catch {
      setThreads([]);
      return [];
    }
  }, []);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const d = await apiGet<ThreadMessagesView>(`/api/store/chat/threads/${threadId}/messages?limit=${CHAT_PAGE_SIZE}`);
      setThread(d.thread);
      setContext(d.context ?? null);
      setMessages(d.messages);
      setHasOlder(d.hasMore === true);
    } catch {
      setMessages([]);
      setHasOlder(false);
      setContext(null);
    }
  }, []);

  /** Prepend the next older keyset page, pinning the viewport to the same
   *  content (scrollTop = newHeight − prevHeight) so loading history never
   *  jumps the seller to the bottom. */
  const loadOlder = useCallback(async () => {
    if (!activeId || !messages?.length || loadingOlder) return;
    setLoadingOlder(true);
    const prevHeight = scrollRef.current?.scrollHeight ?? 0;
    try {
      const d = await apiGet<ChatMsgPage>(
        `/api/store/chat/threads/${activeId}/messages?limit=${CHAT_PAGE_SIZE}&before=${encodeURIComponent(messages[0].id)}`
      );
      prependRestoreRef.current = prevHeight;
      setMessages((prev) => (prev ? [...d.messages.filter((n) => !prev.some((m) => m.id === n.id)), ...prev] : prev));
      setHasOlder(d.hasMore === true);
    } catch {
      toast.error("Could not load older messages");
    } finally {
      setLoadingOlder(false);
    }
  }, [activeId, messages, loadingOlder]);

  /** Debounced background list refresh — new threads + authoritative state. */
  const reloadThreadsSoon = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      void loadThreads();
      window.dispatchEvent(new Event("nomofee:chat-sync"));
    }, 250);
  }, [loadThreads]);

  /** Optimistic list patch: fresh preview, unread bump, moved to the top. */
  const patchRow = useCallback((threadId: string, body: string, senderType: string, at: string, isOpen: boolean) => {
    setThreads((prev) => {
      if (!prev) return prev;
      const idx = prev.findIndex((t) => t.id === threadId);
      if (idx === -1) return prev; // brand-new thread → the reload brings it in
      const row = prev[idx];
      const patched: ChatThreadRow = {
        ...row,
        lastMessageAt: at,
        unreadCount: senderType === "shopper" && !isOpen ? row.unreadCount + 1 : row.unreadCount,
        lastMessage: { body, senderType, createdAt: at, readAt: null },
      };
      return [patched, ...prev.filter((t) => t.id !== threadId)];
    });
  }, []);

  useEffect(() => {
    // List-first entry: no auto-open — auto-reading the newest thread would
    // instantly consume the unread badge the seller hasn't seen yet. Runs
    // ONCE: pill switches/search are pure client-side filtering now.
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (!activeId) return;
    setMessages(null);
    setContext(null);
    // the messages GET marks the thread read server-side — refresh the list so
    // the unread pill on the row (and the nav badge) drops immediately
    loadMessages(activeId).then(() => {
      void loadThreads();
      window.dispatchEvent(new Event("nomofee:chat-sync"));
    });
  }, [activeId, loadMessages, loadThreads]);

  /** Either party closed the quoted product/order → plain direct message.
   *  Optimistic locally, authoritative via the PATCH, mirrored live to the
   *  shopper through the `chat:context` hub event. */
  const clearContext = useCallback(async (threadId: string) => {
    setContext(null);
    setThread((prev) => (prev ? { ...prev, orderNumber: null, contextType: null, subject: null } : prev));
    setThreads((prev) => (prev ? prev.map((t) => (t.id === threadId ? { ...t, orderNumber: null, contextType: null, subject: null } : t)) : prev));
    try {
      await apiSend<ClearContextData>("PATCH", `/api/store/chat/threads/${threadId}/messages`, { action: "clearContext" });
    } catch {
      toast.error("Could not remove the quote — try again");
    }
  }, []);

  // live updates via the chat hub (thread rooms + seller user room)
  useChatHub({
    threadRooms: useMemo(() => (threads ?? []).map((t) => `thread:${t.id}`), [threads]),
    userRoom: sellerId ? `user:${sellerId}` : null,
    handlers: {
      onMessage: (msg) => {
        if (msg.threadId && msg.threadId === activeId) {
          setMessages((prev) => (prev && !prev.some((m) => m.id === msg.id) ? [...prev, msg] : prev));
          if (msg.senderType === "shopper") {
            // arrived while the conversation is open — clear the badge + stamp ✓✓
            void apiSend<ThreadReadData>("POST", `/api/store/chat/threads/${msg.threadId}/read`, {}).catch(() => {});
          }
          patchRow(msg.threadId, msg.body, msg.senderType, msg.createdAt, true);
        } else if (msg.threadId) {
          patchRow(msg.threadId, msg.body, msg.senderType, msg.createdAt, false);
        }
        reloadThreadsSoon();
      },
      onActivity: () => reloadThreadsSoon(), // brand-new conversation arrives live
      onContext: (c) => {
        if (c.threadId === activeId) {
          setContext(null);
          setThread((prev) => (prev ? { ...prev, orderNumber: null, contextType: null, subject: null } : prev));
        }
        setThreads((prev) => (prev ? prev.map((t) => (t.id === c.threadId ? { ...t, orderNumber: null, contextType: null, subject: null } : t)) : prev));
      },
      onRead: (r) => {
        if (r.readerType !== "shopper") return; // shopper read → my ticks flip ✓✓
        if (r.threadId === activeId) {
          setMessages((prev) => (prev ? prev.map((m) => (m.senderType === "seller" && !m.readAt ? { ...m, readAt: r.at } : m)) : prev));
        }
        setThreads((prev) =>
          prev
            ? prev.map((t) =>
                t.id === r.threadId && t.lastMessage && t.lastMessage.senderType === "seller" ? { ...t, lastMessage: { ...t.lastMessage, readAt: r.at } } : t
              )
            : prev
        );
      },
    },
  });

  useEffect(() => {
    // auto-scroll to latest — unless this render is an older-page PREPEND,
    // in which case the viewport is pinned to the same content instead
    const el = scrollRef.current;
    if (!el) return;
    if (prependRestoreRef.current != null) {
      el.scrollTop = el.scrollHeight - prependRestoreRef.current;
      prependRestoreRef.current = null;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const reply = async () => {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const msg = await apiSend<SellerReplyData>("POST", `/api/store/chat/threads/${activeId}/messages`, { body: text });
      // dedupe — the socket broadcast may have delivered this message already
      setMessages((prev) => (prev?.some((m) => m.id === msg.id) ? prev : prev ? [...prev, msg] : [msg]));
      setDraft("");
      patchRow(activeId, msg.body, msg.senderType, msg.createdAt, true);
      reloadThreadsSoon();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the reply");
    } finally {
      setSending(false);
    }
  };

  // Instant client-side filtering of the live snapshot — pills + search are
  // pure local compute (zero network), so switching feels immediate.
  const visibleThreads = useMemo(() => (threads ? filterChatThreads(threads, filter, query) : null), [threads, filter, query]);
  const activeTotal = useMemo(() => (threads ?? []).reduce((n, t) => n + (t.unreadCount > 0 ? 1 : 0), 0), [threads]);

  if (threads === null) return <RowsSkeleton5 />;

  return (
    <div className="space-y-4">
      {/* Task 34: min-w-0 on grid items — same narrow-viewport fix as the
          shopper inbox (grid items default to min-width:auto, letting the
          nowrap thread-preview min-content force the column past small
          screens). With min-w-0 the column shrinks and truncation engages. */}
      <div className="grid min-w-0 gap-4 md:grid-cols-[360px_1fr]">
        {/* master — header + search + pills + inbox list */}
        <aside className={cn("min-w-0 space-y-3", activeId && "hidden md:block")}>
          <ChatHeader
            onBack={() => onNavigate?.({ view: "dashboard" })}
            backLabel="Back to dashboard"
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            searchPlaceholder="Search chats"
            activeCount={activeTotal}
          />
          <div className="rounded-2xl border bg-card shadow-soft">
            {visibleThreads?.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {query.trim() || filter === "active"
                  ? "No conversations match — try a different search or filter."
                  : "When shoppers message you from a product or an order, their messages show up here."}
              </p>
            ) : (
              <ul
                className="space-y-1 overflow-y-auto p-2 max-h-96 md:max-h-[540px] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/25"
                aria-label="Chat threads"
              >
                {(visibleThreads ?? []).map((t) => (
                  <ChatListItem
                    key={t.id}
                    row={t}
                    active={activeId === t.id}
                    mySide="seller"
                    onSelect={() => {
                      setActiveId(t.id);
                      setThread({ shopperName: t.displayName, shopperEmail: "", orderNumber: t.orderNumber, contextType: t.contextType, subject: t.subject });
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* detail — conversation panel (mobile: full-screen slide-in) */}
        <section
          className={cn(
            "flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-soft md:flex",
            activeId ? "flex h-[72dvh] min-h-[440px]" : "hidden md:flex md:h-[600px]",
          )}
        >
          {activeId && thread ? (
            <motion.div
              key={activeId}
              initial={{ opacity: 0, x: 56 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 36 }}
              className="flex h-full min-h-0 flex-col"
            >
              <header className="flex items-center gap-2 border-b p-3">
                <button
                  type="button"
                  className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-muted md:hidden"
                  onClick={() => setActiveId(null)}
                  aria-label="Back to chats"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-xs font-extrabold text-white">
                  {thread.shopperName.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{thread.shopperName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {thread.contextType === "order" && thread.orderNumber
                      ? `Order ${thread.orderNumber} · `
                      : thread.contextType === "product"
                        ? "Product enquiry · "
                        : ""}
                    {thread.shopperEmail || thread.subject || "Direct message"}
                  </p>
                </div>
              </header>

              {/* quoted product / order — pinned directly under the shopper name
                  bar so both parties always see what this conversation is about
                  while the messages scroll underneath; "x" drops the quote so
                  the chat can continue casually */}
              {context ? (
                <div className="relative shrink-0 border-b bg-muted/30 px-3 py-2.5">
                  <SellerContextBubble onNavigate={onNavigate} context={context} />
                  <ContextClearButton onClear={() => activeId && void clearContext(activeId)} />
                </div>
              ) : null}

              <div
                ref={scrollRef}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/25"
              >
                {messages === null ? (
                  <ChatMessagesSkeleton />
                ) : (
                  <>
                    {hasOlder ? (
                      <div className="pb-1 text-center">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void loadOlder()}
                          disabled={loadingOlder}
                          className="min-h-[36px] rounded-full text-xs"
                          aria-label="Load older messages"
                        >
                          {loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          Load older messages
                        </Button>
                      </div>
                    ) : null}
                    {!context ? (
                      <p className="mx-auto w-fit rounded-full bg-muted/70 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                        💬 Direct message from this shopper
                      </p>
                    ) : null}
                    {messages.length === 0 ? (
                      <p className="pt-6 text-center text-sm text-muted-foreground">No messages yet.</p>
                    ) : (
                      messages.map((m) => (
                        <div key={m.id} className={cn("flex", m.senderType === "seller" ? "justify-end" : "justify-start")}>
                          <div
                            className={cn(
                              "max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm",
                              m.senderType === "seller" ? "bg-brand-gradient text-white rounded-br-md" : "bg-muted rounded-bl-md"
                            )}
                          >
                            <p className="whitespace-pre-wrap break-words">{m.body}</p>
                            <p className={cn("flex items-center justify-end gap-1 pt-1 text-[10px]", m.senderType === "seller" ? "text-white/70" : "text-muted-foreground")}>
                              {m.senderType === "shopper" ? `${m.senderName} · ` : ""}
                              {fmtDateTime(m.createdAt)}
                              {m.senderType === "seller" ? <MessageTicks readAt={m.readAt} light className="h-3 w-3" /> : null}
                            </p>
                          </div>
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>

              <footer className="border-t p-3">
                {/* quick replies — chips fill the composer, seller stays in control */}
                <div className="mb-2">
                  <button
                    type="button"
                    onClick={() => setShowQuickReplies((v) => !v)}
                    className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold text-teal-700 hover:bg-teal-50 transition-colors"
                    aria-expanded={showQuickReplies}
                  >
                    <Zap className="h-3 w-3" /> Quick replies
                    <ChevronDown className={cn("h-3 w-3 transition-transform", showQuickReplies && "rotate-180")} aria-hidden />
                  </button>
                  {showQuickReplies ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {SELLER_QUICK_REPLIES.map((qr) => (
                        <button
                          key={qr.label}
                          type="button"
                          onClick={() => setDraft((d) => (d.trim() ? `${d.trimEnd()} ${qr.text}` : qr.text))}
                          className="rounded-full bg-teal-50 px-3 py-1.5 text-[11px] font-medium text-teal-800 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
                          title={qr.text}
                        >
                          {qr.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void reply();
                      }
                    }}
                    rows={1}
                    placeholder="Type a reply… (Enter to send)"
                    aria-label="Reply"
                    className="min-h-[44px] min-w-0 flex-1 resize-none"
                  />
                  <Button onClick={reply} disabled={sending || !draft.trim()} className="min-h-[44px] gap-2 bg-brand-gradient-deep text-white hover:brightness-110" aria-label="Send reply">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span className="hidden sm:inline">Reply</span>
                  </Button>
                </div>
              </footer>
            </motion.div>
          ) : (
            <ChatEmptyDetail />
          )}
        </section>
      </div>
    </div>
  );
}

/** First-paint skeleton for the whole hub (list + detail). */
function RowsSkeleton5() {
  return (
    <div className="grid gap-4 md:grid-cols-[360px_1fr]">
      <Card>
        <CardContent className="p-2">
          <ChatListSkeleton rows={5} />
        </CardContent>
      </Card>
      <Card className="hidden md:block">
        <CardContent className="h-[420px] p-2" />
      </Card>
    </div>
  );
}

/** Seller-side context bubble: taps through to the order detail or the
 *  product editor the shopper is asking about. */
function SellerContextBubble({ onNavigate, context }: { onNavigate?: (n: SellerNav) => void; context: ThreadContextCard | null }) {
  // Rendered only when a product/order context exists — it is pinned under
  // the shopper name bar. Direct messages show their inline pill instead.
  if (!context) return null;

  if (context.kind === "product") {
    const go = () => onNavigate?.({ view: "products", productId: context.productId });
    return (
      <button
        type="button"
        onClick={go}
        disabled={!onNavigate}
        className="group mx-auto flex w-full max-w-xs items-center gap-3 rounded-2xl border bg-card p-2.5 text-left shadow-sm transition-colors hover:bg-accent/40"
        aria-label={`Open product: ${context.title}`}
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white shadow-inner">
          {context.image ? (
            <img src={context.image} alt="" className="h-full w-full object-cover" />
          ) : (
            <PackageSearch className="h-5 w-5 text-teal-600" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-teal-600">🏷️ Shopper asks about this product</span>
          <span className="block truncate text-sm font-bold text-foreground">{context.title}</span>
          <span className="block text-xs font-semibold text-teal-700">{formatMinor(context.priceMinor)}</span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-teal-600 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </button>
    );
  }

  const go = () => onNavigate?.({ view: "orders", orderId: context.orderId });
  return (
    <button
      type="button"
      onClick={go}
      disabled={!onNavigate}
      className="group mx-auto flex w-full max-w-xs items-center gap-3 rounded-2xl border bg-card p-2.5 text-left shadow-sm transition-colors hover:bg-accent/40"
      aria-label={`Open order ${context.orderNumber}`}
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white shadow-inner">
        {context.firstItemImage ? (
          <img src={context.firstItemImage} alt="" className="h-full w-full object-cover" />
        ) : (
          <PackageSearch className="h-5 w-5 text-amber-600" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-bold uppercase tracking-wider text-amber-600">🧾 Shopper asks about this order</span>
        <span className="block truncate text-sm font-bold text-foreground">{context.orderNumber}</span>
        <span className="block truncate text-xs font-semibold text-amber-700">
          {context.firstItemTitle ?? `${context.itemCount} item${context.itemCount === 1 ? "" : "s"}`} · {formatMinor(context.totalMinor)}
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-amber-600 transition-transform group-hover:translate-x-0.5" aria-hidden />
    </button>
  );
}

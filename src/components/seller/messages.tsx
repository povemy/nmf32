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
  ChatHeader,
  ChatListItem,
  ChatListSkeleton,
  ChatMessagesSkeleton,
  ChatEmptyDetail,
  MessageTicks,
  useChatHub,
  type ChatThreadRow,
  type ChatMsg,
  type ChatFilter,
} from "@/components/chat/chat-ui";
import { apiGet, apiSend, EmptyState, type SellerNav } from "./ui-bits";

/** The clickable "what is this chat about" bubble — product or order. */
type ThreadContextCard =
  | { kind: "product"; productId: string; title: string; slug: string; storeSlug: string; image: string | null; priceMinor: number; compareAtPriceMinor: number | null }
  | { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; itemCount: number; firstItemTitle: string | null; firstItemImage: string | null };

export default function SellerMessages({ sellerId, onNavigate }: { sellerId?: string | null; onNavigate?: (n: SellerNav) => void } = {}) {
  const [threads, setThreads] = useState<ChatThreadRow[] | null>(null);
  const [activeTotal, setActiveTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ shopperName: string; shopperEmail: string; orderNumber: string | null; contextType: string | null; subject: string | null } | null>(null);
  const [context, setContext] = useState<ThreadContextCard | null>(null);
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // debounce search input → API
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const loadThreads = useCallback(async () => {
    try {
      const params = new URLSearchParams({ size: "50" });
      if (debouncedQ) params.set("q", debouncedQ);
      if (filter === "active") params.set("filter", "active");
      const d = await apiGet<ChatThreadRow[]>(`/api/store/chat/threads?${params.toString()}`);
      const rows = d ?? [];
      setThreads(rows);
      setActiveTotal(filter === "active" ? rows.length : rows.reduce((n, t) => n + (t.unreadCount > 0 ? 1 : 0), 0));
      return rows;
    } catch {
      setThreads([]);
      return [];
    }
  }, [debouncedQ, filter]);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const d = await apiGet<{
        thread: { shopperName: string; shopperEmail: string; orderNumber: string | null; contextType: string | null; subject: string | null };
        context: ThreadContextCard | null;
        messages: ChatMsg[];
      }>(`/api/store/chat/threads/${threadId}/messages`);
      setThread(d.thread);
      setContext(d.context ?? null);
      setMessages(d.messages);
    } catch {
      setMessages([]);
      setContext(null);
    }
  }, []);

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
    // instantly consume the unread badge the seller hasn't seen yet.
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
            void apiSend("POST", `/api/store/chat/threads/${msg.threadId}/read`, {}).catch(() => {});
          }
          patchRow(msg.threadId, msg.body, msg.senderType, msg.createdAt, true);
        } else if (msg.threadId) {
          patchRow(msg.threadId, msg.body, msg.senderType, msg.createdAt, false);
        }
        reloadThreadsSoon();
      },
      onActivity: () => reloadThreadsSoon(), // brand-new conversation arrives live
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
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const reply = async () => {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const msg = await apiSend<ChatMsg>("POST", `/api/store/chat/threads/${activeId}/messages`, { body: text });
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

  if (threads === null) return <RowsSkeleton5 />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[360px_1fr]">
        {/* master — header + search + pills + inbox list */}
        <aside className={cn("space-y-3", activeId && "hidden md:block")}>
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
            {threads.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {debouncedQ || filter === "active"
                  ? "No conversations match — try a different search or filter."
                  : "When shoppers message you from a product or an order, their messages show up here."}
              </p>
            ) : (
              <ul
                className="space-y-1 overflow-y-auto p-2 max-h-96 md:max-h-[540px] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/25"
                aria-label="Chat threads"
              >
                {threads.map((t) => (
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
            "flex flex-col overflow-hidden rounded-2xl border bg-card shadow-soft md:flex",
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

              <div
                ref={scrollRef}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/25"
              >
                {messages === null ? (
                  <ChatMessagesSkeleton />
                ) : (
                  <>
                    {/* what the shopper is asking about — tap to jump there */}
                    <SellerContextBubble onNavigate={onNavigate} context={context} />
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
                    className="min-h-[44px] resize-none"
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
  if (!context) {
    return (
      <p className="mx-auto w-fit rounded-full bg-muted/70 px-3 py-1 text-[11px] font-medium text-muted-foreground">
        💬 Direct message from this shopper
      </p>
    );
  }

  if (context.kind === "product") {
    const go = () => onNavigate?.({ view: "products", productId: context.productId });
    return (
      <button
        type="button"
        onClick={go}
        disabled={!onNavigate}
        className="group mx-auto flex w-full max-w-xs items-center gap-3 rounded-2xl border-2 border-dashed border-teal-300 bg-teal-50/60 p-2.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-500 hover:shadow-md"
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
      className="group mx-auto flex w-full max-w-xs items-center gap-3 rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50/70 p-2.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-amber-500 hover:shadow-md"
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

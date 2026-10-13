"use client";
// Seller Messages — inbox of shopper conversations + reply composer.
// Live updates via the socket.io chat hub (rooms: thread:{id}).
// • Every conversation shows a clickable context bubble quoting the product
//   or order the shopper is asking about → tap to jump to that order/product.
// • Thread cards show an unread badge (no message preview).
// • Quick-reply chips (src/lib/chat-quick-replies.ts) fill the composer.
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ChevronDown, Loader2, MessagesSquare, PackageSearch, Send, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SELLER_QUICK_REPLIES } from "@/lib/chat-quick-replies";
import { formatMinor } from "@/lib/money";
import { fmtDateTime } from "@/components/shopper/ui-bits";
import { apiGet, apiSend, EmptyState, RowsSkeleton, type SellerNav } from "./ui-bits";

type SellerThread = {
  id: string;
  shopperName: string;
  shopperEmail: string;
  orderNumber: string | null;
  contextType: string | null;
  subject: string | null;
  lastMessageAt: string;
  unreadCount: number;
  lastMessage: { body: string; senderType: string; createdAt: string } | null;
};

type ChatMsg = { id: string; senderType: "shopper" | "seller"; senderName: string; body: string; createdAt: string };

/** The clickable "what is this chat about" bubble — product or order. */
type ThreadContextCard =
  | { kind: "product"; productId: string; title: string; slug: string; storeSlug: string; image: string | null; priceMinor: number; compareAtPriceMinor: number | null }
  | { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; itemCount: number; firstItemTitle: string | null; firstItemImage: string | null };

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function SellerMessages({ onNavigate }: { onNavigate?: (n: SellerNav) => void } = {}) {
  const [threads, setThreads] = useState<SellerThread[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ shopperName: string; shopperEmail: string; orderNumber: string | null; contextType: string | null; subject: string | null } | null>(null);
  const [context, setContext] = useState<ThreadContextCard | null>(null);
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try {
      const rows = await apiGet<SellerThread[]>("/api/store/chat/threads");
      setThreads(rows);
      return rows;
    } catch {
      setThreads([]);
      return [];
    }
  }, []);

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

  useEffect(() => {
    let alive = true;
    loadThreads().then((rows) => {
      if (alive && rows.length > 0) setActiveId((cur) => cur ?? rows[0].id);
    });
    return () => {
      alive = false;
    };
  }, [loadThreads]);

  useEffect(() => {
    if (!activeId) return;
    setMessages(null);
    setContext(null);
    loadMessages(activeId);
  }, [activeId, loadMessages]);

  // live updates from the chat hub
  useEffect(() => {
    const socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: 10000,
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      socket.emit("join", { rooms: (threads ?? []).map((t) => `thread:${t.id}`) });
    });
    socket.on("chat:message", (msg: ChatMsg & { threadId?: string }) => {
      if (msg.threadId && msg.threadId === activeId) {
        setMessages((prev) => (prev && !prev.some((m) => m.id === msg.id) ? [...prev, msg] : prev));
        if (msg.senderType === "shopper") {
          // the shopper's message is visible right now — clear the badge at once
          void apiSend("POST", `/api/store/chat/threads/${activeId}/read`, {}).catch(() => {});
        }
      }
      loadThreads();
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [threads, activeId, loadThreads]);

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
      loadThreads();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the reply");
    } finally {
      setSending(false);
    }
  };

  if (threads === null) return <RowsSkeleton rows={5} />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <MessagesSquare className="h-5 w-5 text-primary" /> Messages
        </h1>
        <p className="text-sm text-muted-foreground">
          Conversations with shoppers about your orders and products. New messages arrive in real time.
        </p>
      </div>

      {threads.length === 0 ? (
        <Card>
          <CardContent className="p-2">
            <EmptyState
              icon={<MessagesSquare className="h-8 w-8" />}
              title="No conversations yet"
              hint="When shoppers message you from a product or an order, their messages show up here."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-[300px_1fr]">
          <aside className={cn("rounded-2xl border bg-card p-2 shadow-soft", activeId && "hidden md:block")}>
            <ul className="space-y-1 max-h-[520px] overflow-y-auto">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(t.id);
                      setThread({ shopperName: t.shopperName, shopperEmail: t.shopperEmail, orderNumber: t.orderNumber, contextType: t.contextType, subject: t.subject });
                    }}
                    className={cn(
                      "w-full rounded-xl p-3 text-left transition-colors min-h-[60px]",
                      activeId === t.id ? "bg-teal-50 ring-1 ring-teal-200 dark:bg-teal-950/40" : "hover:bg-muted"
                    )}
                    aria-label={`Conversation with ${t.shopperName}${t.unreadCount > 0 ? `, ${t.unreadCount} unread messages` : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-[11px] font-extrabold text-white">
                        {t.shopperName.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.shopperName}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgoShort(t.lastMessageAt)}</span>
                      {t.unreadCount > 0 ? (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-extrabold text-white shadow" aria-label={`${t.unreadCount} unread`}>
                          {t.unreadCount > 99 ? "99+" : t.unreadCount}
                        </span>
                      ) : null}
                    </div>
                    <p className="flex items-center gap-1.5 truncate pt-1 pl-10 text-[11px] font-medium text-teal-700 dark:text-teal-300">
                      {t.contextType === "order" && t.orderNumber ? (
                        <>🧾 order {t.orderNumber}</>
                      ) : t.contextType === "product" ? (
                        <>🏷️ product enquiry</>
                      ) : (
                        <>💬 direct message</>
                      )}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className={cn("flex flex-col rounded-2xl border bg-card shadow-soft", !activeId && "hidden md:flex", "min-h-[420px] md:min-h-[520px]")}>
            {activeId && thread ? (
              <>
                <header className="flex items-center gap-2 border-b p-3">
                  <button
                    type="button"
                    className="md:hidden flex h-9 w-9 items-center justify-center rounded-lg hover:bg-muted"
                    onClick={() => setActiveId(null)}
                    aria-label="Back to inbox"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{thread.shopperName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {thread.contextType === "order" && thread.orderNumber
                        ? `Order ${thread.orderNumber} · `
                        : thread.contextType === "product"
                          ? "Product enquiry · "
                          : ""}
                      {thread.shopperEmail}
                    </p>
                  </div>
                </header>

                <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 max-h-80 md:max-h-[380px]">
                  {messages === null ? (
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
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
                              <p className={cn("pt-1 text-[10px]", m.senderType === "seller" ? "text-white/70" : "text-muted-foreground")}>
                                {m.senderType === "shopper" ? `${m.senderName} · ` : ""}
                                {fmtDateTime(m.createdAt)}
                              </p>
                            </div>
                          </div>
                        ))
                      )}
                    </>
                  )}
                </div>

                <footer className="border-t p-3">
                  {/* quick replies scaffold — chips fill the composer, seller stays in control */}
                  <div className="mb-2">
                    <button
                      type="button"
                      onClick={() => setShowQuickReplies((v) => !v)}
                      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold text-teal-700 hover:bg-teal-50 transition-colors"
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
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Pick a conversation to reply.
              </div>
            )}
          </section>
        </div>
      )}
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

"use client";
// Seller Messages — inbox of shopper conversations + reply composer.
// Live updates via the socket.io chat hub (rooms: thread:{id}).
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import { ArrowLeft, Loader2, MessagesSquare, PackageSearch, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/components/shopper/ui-bits";
import { apiGet, apiSend, EmptyState, RowsSkeleton } from "./ui-bits";

type SellerThread = {
  id: string;
  shopperName: string;
  shopperEmail: string;
  orderNumber: string | null;
  subject: string | null;
  lastMessageAt: string;
  lastMessage: { body: string; senderType: string; createdAt: string } | null;
};

type ChatMsg = { id: string; senderType: "shopper" | "seller"; senderName: string; body: string; createdAt: string };

export default function SellerMessages() {
  const [threads, setThreads] = useState<SellerThread[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ shopperName: string; shopperEmail: string; orderNumber: string | null; subject: string | null } | null>(null);
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
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
      const d = await apiGet<{ thread: { shopperName: string; shopperEmail: string; orderNumber: string | null; subject: string | null }; messages: ChatMsg[] }>(
        `/api/store/chat/threads/${threadId}/messages`
      );
      setThread(d.thread);
      setMessages(d.messages);
    } catch {
      setMessages([]);
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
        <p className="text-sm text-muted-foreground">Conversations with shoppers about your orders. New messages arrive in real time.</p>
      </div>

      {threads.length === 0 ? (
        <Card>
          <CardContent className="p-2">
            <EmptyState
              icon={<MessagesSquare className="h-8 w-8" />}
              title="No conversations yet"
              hint="When shoppers contact you from an order, their messages show up here."
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
                      setThread({ shopperName: t.shopperName, shopperEmail: t.shopperEmail, orderNumber: t.orderNumber, subject: t.subject });
                    }}
                    className={cn(
                      "w-full rounded-xl p-3 text-left transition-colors min-h-[60px]",
                      activeId === t.id ? "bg-teal-50 ring-1 ring-teal-200 dark:bg-teal-950/40" : "hover:bg-muted"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-[11px] font-extrabold text-white">
                        {t.shopperName.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.shopperName}</span>
                      {t.orderNumber ? <PackageSearch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={`About ${t.orderNumber}`} /> : null}
                    </div>
                    <p className="truncate pt-1 pl-10 text-xs text-muted-foreground">{t.lastMessage?.body ?? "New conversation"}</p>
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
                      {thread.orderNumber ? `Order ${thread.orderNumber} · ` : ""}
                      {thread.shopperEmail}
                    </p>
                  </div>
                </header>

                <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 max-h-80 md:max-h-[380px]">
                  {messages === null ? (
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : messages.length === 0 ? (
                    <p className="pt-10 text-center text-sm text-muted-foreground">No messages yet.</p>
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
                </div>

                <footer className="border-t p-3">
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

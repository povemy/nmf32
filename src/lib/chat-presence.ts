"use client";
// ============================================================================
// Chat presence — ONE refcounted socket per mounted surface, joined to the
// signed-in user's private inbox room (`user:{id}`).
//
// WHY THIS EXISTS: the per-view socket in chat-ui.tsx only lives while a
// messages view is mounted. Away from that page nothing was listening, so the
// Message/Chat tab badges depended on a 15-second poll and incoming messages
// felt silent ("no notification anymore"). This hook keeps a shell-level
// connection alive on EVERY view:
//   • new `chat:message` / `chat:activity` → the shell fires the
//     "nomofee:chat-sync" window event, so every unread-badge hook re-syncs
//     INSTANTLY (no polling latency, works on desktop header + mobile tabs),
//   • and raises a toast with the sender + preview — with a jump-in action —
//     whenever the user is somewhere other than the messages page.
// The hub is the same dumb broadcast service on :3003 (rooms are joined
// explicitly; no secrets travel over this socket).
// ============================================================================

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { getSessionToken } from "@/lib/session-client";

export type ChatPresenceMessage = {
  id: string;
  threadId?: string;
  senderType: string;
  senderName: string;
  body: string;
  createdAt: string;
  isAutoReply?: boolean;
};

export type ChatPresenceEvents = {
  onMessage?: (msg: ChatPresenceMessage) => void;
  onActivity?: (a: { threadId: string; at: string; preview: string | null; senderType: string | null }) => void;
  onRead?: (r: { threadId: string; readerType: string; at: string }) => void;
};

// Module-level singleton. Shopper/seller surfaces never coexist, but the hook
// must survive re-renders and StrictMode double-mounts without leaking
// sockets — acquire/release is refcounted, so the last consumer to unmount
// disconnects the shared connection.
let shared: Socket | null = null;
let holders = 0;

function acquire(): Socket {
  holders += 1;
  if (shared) return shared;
  // F-06 remediation: authenticated handshake — the hub validates the session
  // token against the authoritative app before authorizing any room join.
  shared = io("/?XTransformPort=3003", {
    transports: ["websocket", "polling"],
    auth: { token: getSessionToken() ?? "" },
    // Same resilience contract as useChatHub: long-lived preview tabs must
    // never give up — a hub restart or sleep can outlast a finite budget.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 10000,
  });
  return shared;
}

function release(): void {
  holders = Math.max(0, holders - 1);
  if (holders === 0 && shared) {
    shared.disconnect();
    shared = null;
  }
}

/**
 * Join `user:{userId}` on the shared socket and forward chat events to
 * `events`. Handlers are kept in a ref (updated every render) so the socket
 * is created exactly once per surface and handlers always see fresh state.
 * No-op while signed out (`userId` null) — join/leave follow sign-in state.
 */
export function useChatUserRoom(userId: string | null | undefined, events: ChatPresenceEvents): void {
  const eventsRef = useRef(events);
  const userIdRef = useRef(userId);
  // Keep the latest handlers/user reachable from callbacks registered once at
  // mount — updated in an effect, never during render.
  useEffect(() => {
    eventsRef.current = events;
    userIdRef.current = userId;
  });

  useEffect(() => {
    if (!userId) return;
    const socket = acquire();

    const join = () => socket.emit("join", { rooms: [`user:${userIdRef.current}`] });
    socket.on("connect", join);
    if (socket.connected) join();

    const onMessage = (m: ChatPresenceMessage) => eventsRef.current.onMessage?.(m);
    const onActivity = (a: { threadId: string; at: string; preview: string | null; senderType: string | null }) =>
      eventsRef.current.onActivity?.(a);
    const onRead = (r: { threadId: string; readerType: string; at: string }) => eventsRef.current.onRead?.(r);
    socket.on("chat:message", onMessage);
    socket.on("chat:activity", onActivity);
    socket.on("chat:read", onRead);

    return () => {
      socket.off("connect", join);
      socket.off("chat:message", onMessage);
      socket.off("chat:activity", onActivity);
      socket.off("chat:read", onRead);
      socket.emit("leave", { room: `user:${userIdRef.current}` });
      release();
    };
  }, [userId]);
}

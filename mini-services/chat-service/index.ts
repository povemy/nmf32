// SHOPMESH chat hub — socket.io broadcast mini service (port 3003).
// Persistence lives in the Next.js API routes; this service only relays
// events to rooms so shoppers & sellers see new messages instantly.
// Next API POSTs to /broadcast after saving a message.
//
// Room model:
//   thread:{threadId} — every open conversation (message fan-out to both parties)
//   user:{userId}     — per-user inbox feed (thread list refresh + NEW-thread push,
//                       so a seller sees a brand-new conversation without a reload)
//
// SPLIT-BRAIN GUARD: this process owns BOTH the public socket port (3003) and
// the internal relay port (3103). If either port is taken (a stale duplicate
// instance), the servers emit "error" and we EXIT immediately — a half-alive
// instance (relay without sockets, or sockets without relay) silently drops
// every message, which is exactly the "messages only arrive after refresh"
// bug a duplicate `bun --hot` process caused. Loud failure beats silent loss.
import { createServer } from "http";
import { Server } from "socket.io";

const httpServer = createServer();

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: "/",
  cors: {
    // Reflect the caller's Origin instead of "*": browser XHR/WebSocket
    // handshakes are credentialed, and wildcard ACAO is invalid with
    // credentials — every browser socket silently failed to connect while
    // non-browser clients (no Origin) worked. Reflection accepts all origins
    // (this hub carries no secrets; rooms are joined explicitly).
    origin: true,
    credentials: true,
    methods: ["GET", "POST"],
  },
  // Belt-and-braces: never reject a handshake at the engine level either.
  allowRequest: (_req, fn) => fn(null, true),
  pingTimeout: 60000,
  pingInterval: 25000,
});

function allowedRoom(r: unknown): r is string {
  return typeof r === "string" && (r.startsWith("thread:") || r.startsWith("user:"));
}

io.on("connection", (socket) => {
  console.log("[chat-hub] socket connected:", socket.id);
  // client subscribes to its conversation + user rooms
  socket.on("join", (data: { rooms?: string[]; room?: string }) => {
    const rooms = data.rooms ?? (data.room ? [data.room] : []);
    for (const r of rooms) {
      if (allowedRoom(r)) {
        socket.join(r);
        console.log("[chat-hub] joined:", r);
      }
    }
  });

  socket.on("leave", (data: { room: string }) => {
    if (allowedRoom(data?.room)) socket.leave(data.room);
  });

  socket.on("error", (err) => {
    console.error("[chat-hub] socket error:", err?.message ?? err);
  });
});

// Port conflicts must kill THIS process, not linger half-alive.
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`[chat-hub] FATAL public listener :3003 — ${err.code ?? err.message}. Exiting so the supervisor restarts a clean instance.`);
  process.exit(1);
});

// internal relay on a SEPARATE port — socket.io owns the public listener's
// request handler, so the Next API calls this relay instead of the main server.
const relay = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/broadcast") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // abuse guard
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as { room?: string; rooms?: string[]; event: string; payload: unknown };
        const rooms = (body.rooms ?? (body.room ? [body.room] : [])).filter(allowedRoom);
        if (rooms.length === 0 || typeof body.event !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad room/event" }));
          return;
        }
        for (const r of rooms) io.to(r).emit(body.event, body.payload);
        console.log("[chat-hub] broadcast to", rooms.join(","), body.event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad json" }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});
relay.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`[chat-hub] FATAL relay listener :3103 — ${err.code ?? err.message}. Exiting so the supervisor restarts a clean instance.`);
  process.exit(1);
});
relay.listen(3103, () => {
  console.log("[chat-hub] internal broadcast relay on port 3103");
});

const PORT = 3003;
httpServer.listen(PORT, () => {
  console.log(`[chat-hub] socket.io broadcast hub on port ${PORT}`);
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});

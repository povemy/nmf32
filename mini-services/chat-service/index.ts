// SHOPMESH chat hub — socket.io broadcast mini service (port 3003).
// Persistence lives in the Next.js API routes; this service only relays
// events to the room for a thread so shoppers & sellers see new messages
// instantly. Next API POSTs to /broadcast after saving a message.
import { createServer } from "http";
import { Server } from "socket.io";

const httpServer = createServer();

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: "/",
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

io.on("connection", (socket) => {
  console.log("[chat-hub] socket connected:", socket.id);
  // client subscribes to its conversation rooms
  socket.on("join", (data: { rooms?: string[]; room?: string }) => {
    const rooms = data.rooms ?? (data.room ? [data.room] : []);
    for (const r of rooms) {
      if (typeof r === "string" && r.startsWith("thread:")) { socket.join(r); console.log("[chat-hub] joined:", r); }
    }
  });

  socket.on("leave", (data: { room: string }) => {
    if (typeof data?.room === "string") socket.leave(data.room);
  });

  socket.on("error", (err) => {
    console.error("[chat-hub] socket error:", err?.message ?? err);
  });
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
        const { room, event, payload } = JSON.parse(raw) as { room: string; event: string; payload: unknown };
        if (typeof room === "string" && typeof event === "string" && room.startsWith("thread:")) {
          io.to(room).emit(event, payload);
          console.log("[chat-hub] broadcast to", room, event);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad room/event" }));
        }
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

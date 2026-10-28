import { io } from "socket.io-client";
const origin = process.argv[2] ?? "http://localhost:81";
const socket = io("http://localhost:81/?XTransformPort=3003", {
  transports: ["websocket", "polling"],
  extraHeaders: { Origin: origin } as Record<string, string>,
  timeout: 4000,
});
socket.on("connect", () => { console.log(`ORIGIN ${origin} → CONNECTED via`, socket.io.engine.transport.name); process.exit(0); });
socket.on("connect_error", (e) => { console.log(`ORIGIN ${origin} → ERROR:`, String(e).slice(0, 100)); process.exit(1); });
setTimeout(() => { console.log(`ORIGIN ${origin} → TIMEOUT`); process.exit(1); }, 5000);

import { io } from "socket.io-client";
const threadId = process.argv[2] ?? "cmvene69w0007rb3geijtha1y";
const socket = io("http://localhost:81/?XTransformPort=3003", { transports: ["websocket", "polling"], timeout: 5000 });
const room = `thread:${threadId}`;
socket.on("connect", () => {
  console.log("CONNECTED", socket.io.engine.transport.name);
  socket.emit("join", { rooms: [room] });
  setTimeout(() => {
    fetch("http://127.0.0.1:3103/broadcast", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rooms: [room], event: "probe:ping", payload: { t: Date.now() } }),
    }).then((r) => r.json()).then((j) => console.log("RELAY:", JSON.stringify(j))).catch((e) => console.log("RELAY_ERR", String(e)));
  }, 400);
});
socket.on("probe:ping", () => { console.log("ROOM_DELIVERY_OK"); process.exit(0); });
socket.on("connect_error", (e) => console.log("CONNECT_ERR", String(e).slice(0, 100)));
setTimeout(() => { console.log("ROOM_DELIVERY_FAIL"); process.exit(1); }, 6000);

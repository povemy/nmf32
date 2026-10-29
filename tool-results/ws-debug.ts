import { io } from "socket.io-client";
const BASE = "http://localhost:3000";
const j = (r: Response) => r.json().catch(() => ({}));
const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "lumina@nomofee.io", password: "Seller123!" }) });
const token = (await j(res))?.data?.token;
console.log("token:", token?.slice(0, 12), "…");

for (const transports of [["websocket"], ["polling"]] as const) {
  const sock = io("http://localhost:3003", { path: "/", transports: [...transports], auth: { token }, reconnection: false, timeout: 4000 });
  const result = await new Promise<string>((resolve) => {
    sock.on("connect_error", (e) => resolve(`connect_error: ${e.message}`));
    sock.on("connect", () => resolve("CONNECTED"));
    setTimeout(() => resolve("timeout"), 4500);
  });
  console.log(`transports=${transports.join("+")} → ${result}`);
  sock.disconnect();
}

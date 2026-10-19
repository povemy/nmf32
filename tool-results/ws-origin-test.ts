// Minimal WS handshake with and without Origin — isolates hub-side origin rejection
function probe(label: string, headers: Record<string, string>) {
  return new Promise<string>((resolve) => {
    const key = Buffer.from(Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).toString("base64");
    const req = fetch("http://localhost:81/?EIO=4&transport=websocket&XTransformPort=3003", {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", ...headers },
    }).then((r) => { r.body?.cancel().catch(() => {}); return `${label}: HTTP ${r.status}`; }).catch((e) => `${label}: ERR ${String(e).slice(0, 60)}`);
    resolve(req as unknown as Promise<string>);
  });
}
console.log(await probe("no-origin", {}));
console.log(await probe("origin-81", { Origin: "http://localhost:81" }));
console.log(await probe("origin-preview", { Origin: "https://some-external-preview.example" }));
process.exit(0);

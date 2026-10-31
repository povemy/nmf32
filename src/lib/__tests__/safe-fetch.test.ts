// B5 unit tests — safe-fetch SSRF guard (bun:test, NO database, NO external
// network: a loopback http server is spun up inside this file, and the guard's
// permissive-injection seam (safeFetchInternal opts) is used exactly as the
// task spec prescribes — the REAL predicate rejects 127.0.0.1, so loopback
// redirect-chain tests inject `isPublic: () => true`; redirect-target blocking
// with the REAL predicate is covered by the validateHop + metadata tests).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import http from "node:http";
import type { Socket } from "node:net";
import {
  isPublicIp,
  validateHop,
  guardedLookupFactory,
  safeFetchExternalImage,
  safeFetchInternal,
} from "../safe-fetch";
import type { DnsLookupFn } from "../safe-fetch";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server: http.Server;
let port = 0;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.on("error", () => undefined);
    const p = (req.url ?? "").split("?")[0];
    switch (p) {
      case "/img":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      case "/html":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<html><body>nope</body></html>");
      case "/fakejpg":
        // claims to be a JPEG but the body is HTML → magic-byte mismatch
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(Buffer.from("<html>not really a jpeg</html>"));
      case "/noreloc":
        res.writeHead(302, {});
        return res.end();
      case "/meta":
        // the F-06 regression scenario: public-looking hop redirects to the
        // cloud metadata endpoint
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      case "/chain3/a":
        res.writeHead(302, { location: "/chain3/b" });
        return res.end();
      case "/chain3/b":
        res.writeHead(302, { location: "/chain3/c" });
        return res.end();
      case "/chain3/c":
        res.writeHead(302, { location: "/img" });
        return res.end();
      case "/chain4/a":
        res.writeHead(302, { location: "/chain4/b" });
        return res.end();
      case "/chain4/b":
        res.writeHead(302, { location: "/chain4/c" });
        return res.end();
      case "/chain4/c":
        res.writeHead(302, { location: "/chain4/d" });
        return res.end();
      case "/chain4/d":
        res.writeHead(302, { location: "/img" });
        return res.end();
      case "/biglen": {
        // declared size is over the cap but the body trickles and the socket
        // only dies after 3s — a guard that (wrongly) READS the body stalls;
        // a header-only guard returns immediately.
        res.writeHead(200, { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) });
        res.write(png);
        setTimeout(() => res.destroy(), 3000);
        return;
      }
      case "/bigchunked": {
        // no content-length (chunked): only the post-read size check can catch it
        res.writeHead(200, { "content-type": "image/png" });
        const chunk = Buffer.alloc(1024 * 1024, 0x01);
        void (async () => {
          for (let i = 0; i < 6; i++) {
            if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r()));
          }
          res.end();
        })();
        return;
      }
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

// ---------------------------------------------------------------- isPublicIp

describe("isPublicIp", () => {
  test("public IPv4", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("1.1.1.1")).toBe(true);
    expect(isPublicIp("172.15.255.255")).toBe(true); // one below 172.16.0.0/12
    expect(isPublicIp("172.32.0.1")).toBe(true); // one above 172.16.0.0/12
    expect(isPublicIp("100.63.255.255")).toBe(true); // one below CGNAT 100.64.0.0/10
    expect(isPublicIp("100.128.0.1")).toBe(true); // one above CGNAT 100.64.0.0/10
  });

  test("private / metadata / reserved IPv4", () => {
    const bad = [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
    ];
    for (const ip of bad) expect(isPublicIp(ip)).toBe(false);
  });

  test("IPv6", () => {
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("::")).toBe(false);
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("fd12:3456::1")).toBe(false);
    expect(isPublicIp("2001:db8::1")).toBe(false);
    expect(isPublicIp("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicIp("::ffff:a00:1")).toBe(false); // IPv4-mapped, hex form (10.0.0.1)
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIp("64:ff9b::10.0.0.1")).toBe(false); // NAT64 → private v4
    expect(isPublicIp("::a00:1")).toBe(false); // IPv4-compatible → ::/8
    expect(isPublicIp("ff02::1")).toBe(false); // IPv6 multicast
    expect(isPublicIp("2606:4700::1111")).toBe(true);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true); // mapped public v4
    expect(isPublicIp("64:ff9b::8.8.8.8")).toBe(true); // NAT64 public v4
  });

  test("non-IP strings are not public", () => {
    expect(isPublicIp("example.com")).toBe(false);
    expect(isPublicIp("")).toBe(false);
    expect(isPublicIp("999.1.1.1")).toBe(false);
  });
});

// ---------------------------------------------------------------- validateHop

describe("validateHop", () => {
  test("non-http(s) schemes rejected", () => {
    const check = validateHop("javascript:alert(1)");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("SCHEME");
    expect(validateHop("file:///etc/passwd").ok).toBe(false);
    expect(validateHop("data:image/png;base64,AAAA").ok).toBe(false);
  });

  test("embedded credentials rejected", () => {
    const check = validateHop("http://user:pass@example.com/a.png");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("CREDENTIALS");
    expect(validateHop("http://user@example.com/a.png").ok).toBe(false);
  });

  test("private IP literals rejected (cloud metadata endpoint)", () => {
    const check = validateHop("http://169.254.169.254/latest/meta-data/");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("PRIVATE_HOST");
  });

  test("public IP literals accepted; arbitrary ports allowed", () => {
    expect(validateHop("http://8.8.8.8/x").ok).toBe(true);
    expect(validateHop("https://1.1.1.1:8443/x").ok).toBe(true);
    expect(validateHop("http://[2606:4700::1111]/x").ok).toBe(true);
  });

  test("garbage rejected", () => {
    const check = validateHop("not a url at all");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("INVALID_URL");
  });
});

// ---------------------------------------------------------- guardedLookup

describe("guardedLookupFactory (DNS pinning core)", () => {
  test("blocks resolutions containing a private address (all:true shape)", (done) => {
    const fake: DnsLookupFn = (_h, _o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]);
    guardedLookupFactory(fake)("evil.example", { all: true }, (err, addr) => {
      expect(err).toBeInstanceOf(Error);
      expect(err && err.code).toBe("EPRIVATEADDRESS");
      expect(addr).toBeUndefined();
      done();
    });
  });

  test("blocks when ANY address in a mixed resolution is private", (done) => {
    const fake: DnsLookupFn = (_h, _o, cb) =>
      cb(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]);
    guardedLookupFactory(fake)("mixed.example", { all: true }, (err) => {
      expect(err && err.code).toBe("EPRIVATEADDRESS");
      done();
    });
  });

  test("passes all-public resolutions through untouched", (done) => {
    const list = [{ address: "93.184.216.34", family: 4 }];
    const fake: DnsLookupFn = (_h, _o, cb) => cb(null, list);
    guardedLookupFactory(fake)("ok.example", { all: true }, (err, addr) => {
      expect(err).toBeNull();
      expect(addr).toBe(list);
      done();
    });
  });

  test("single-address shape: blocks private, passes public", (done) => {
    const bad: DnsLookupFn = (_h, _o, cb) => cb(null, "10.0.0.5", 4);
    guardedLookupFactory(bad)("x.example", {}, (err) => {
      expect(err && err.code).toBe("EPRIVATEADDRESS");
      const good: DnsLookupFn = (_h, _o, cb) => cb(null, "93.184.216.34", 4);
      guardedLookupFactory(good)("y.example", {}, (err2, addr, family) => {
        expect(err2).toBeNull();
        expect(addr).toBe("93.184.216.34");
        expect(family).toBe(4);
        done();
      });
    });
  });

  test("DNS errors pass through unchanged", (done) => {
    const dnsErr = new Error("getaddrinfo ENOTFOUND nope.example");
    const fake: DnsLookupFn = (_h, _o, cb) => cb(dnsErr);
    guardedLookupFactory(fake)("nope.example", { all: true }, (err) => {
      expect(err).toBe(dnsErr);
      done();
    });
  });
});

// ------------------------------------------- redirect loop + response rules

describe("safeFetchInternal — redirect loop & response validation", () => {
  const local = (path: string) => `http://127.0.0.1:${port}${path}`;

  test("3-hop redirect chain succeeds and returns the final body", async () => {
    const res = await safeFetchInternal(local("/chain3/a"), { isPublic: () => true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.contentType).toBe("image/png");
      expect(res.buffer.equals(png)).toBe(true);
    }
  });

  test("4 redirects are blocked by the hop cap", async () => {
    const res = await safeFetchInternal(local("/chain4/a"), { isPublic: () => true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("MAX_HOPS");
  });

  test("redirect to a private/metadata IP is blocked mid-chain (F-06)", async () => {
    const res = await safeFetchInternal(local("/meta"), { isPublic: (ip) => ip === "127.0.0.1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("PRIVATE_HOST");
  });

  test("redirect without a Location header is rejected", async () => {
    const res = await safeFetchInternal(local("/noreloc"), { isPublic: () => true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("REDIRECT_MISSING_LOCATION");
  });

  test("non-image content-type rejected", async () => {
    const res = await safeFetchInternal(local("/html"), { isPublic: () => true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("CONTENT_TYPE");
  });

  test("magic-byte mismatch rejected (image/jpeg header, HTML body)", async () => {
    const res = await safeFetchInternal(local("/fakejpg"), { isPublic: () => true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("CONTENT_TYPE");
  });

  test("declared content-length over the cap rejected WITHOUT reading the body", async () => {
    const started = Date.now();
    const res = await safeFetchInternal(local("/biglen"), { isPublic: () => true });
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("TOO_LARGE");
    // the socket only dies at 3s — a header-only rejection must come back fast
    expect(elapsed).toBeLessThan(2500);
  });

  test("chunked body over the cap rejected after read", async () => {
    const res = await safeFetchInternal(local("/bigchunked"), { isPublic: () => true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("TOO_LARGE");
  });

  test("non-2xx final status rejected", async () => {
    const res = await safeFetchInternal(local("/missing"), { isPublic: () => true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("HTTP_404");
  });
});

// ------------------------------------------------- per-hop DNS guard (rebind)

describe("safeFetchInternal — per-hop DNS guard (rebinding)", () => {
  test("hostname resolving (via injected lookup) to a private IP is blocked BEFORE fetching", async () => {
    const fake: DnsLookupFn = (_h, _o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]);
    const res = await safeFetchInternal("http://rebind.invalid/x.png", { lookup: fake });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("PRIVATE_HOST");
  });

  test("hostname resolving to a public IP proceeds (the fetch itself then fails on the real DNS)", async () => {
    const fake: DnsLookupFn = (_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]);
    const res = await safeFetchInternal("http://no-such-host.invalid/x.png", { lookup: fake, timeoutMs: 5000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.startsWith("NETWORK")).toBe(true);
  });
});

// ------------------------------------------------- public entry (real guards)

describe("safeFetchExternalImage (public entry, real predicate)", () => {
  test("cloud metadata endpoint is refused outright", async () => {
    const res = await safeFetchExternalImage("http://169.254.169.254/latest/meta-data/");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("PRIVATE_HOST");
  });

  test("javascript: scheme is refused", async () => {
    const res = await safeFetchExternalImage("javascript:alert(1)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("SCHEME");
  });

  test("embedded credentials are refused", async () => {
    const res = await safeFetchExternalImage("http://u:p@example.com/a.png");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("CREDENTIALS");
  });
});

// ============================================================================
// safe-fetch (B5 / F-06) — SSRF-hardened outbound fetch for external images.
//
// Replaces the old `fetch(parsed, { redirect: "follow" })` in the import image
// copier (the documented F-06 regression: a public host could 302 into
// http://169.254.169.254/ and the redirect was followed blindly).
//
// Guarantees, applied to the ORIGINAL URL and EVERY redirect hop:
//   1. scheme must be http/https (javascript:, file:, data:, … rejected);
//   2. no embedded userinfo (username:password@) — rejected;
//   3. IP literals must be public (full private/reserved/metadata range list,
//      both IPv4 and IPv6 incl. IPv4-mapped and NAT64 unmapping);
//   4. hostnames must resolve — dns.lookup with { all: true }, EVERY returned
//      address validated — to public IPs only, re-checked per hop;
//   5. redirects are followed MANUALLY, hard-capped at MAX_REDIRECT_HOPS (3);
//   6. per-hop AbortSignal timeout (10s) + 8s connect timeout on the Agent;
//   7. 5MB response cap (content-length header pre-checked BEFORE the body is
//      read, then the actual length re-verified after reading);
//   8. content-type whitelist (jpeg/png/webp/gif) + magic-byte sniffing.
//
// DNS pinning (rebinding/TOCTOU closure): fetches are issued through an undici
// Agent whose custom `lookup` validates EVERY resolved address BEFORE the
// socket is connected — the validation runs on the SAME resolution the
// connection uses, so a rebinding DNS answer cannot pass the pre-check and
// then connect to a private address.
//
// Runtime notes (verified empirically for this repo):
//   • Node runtime: undici is resolved at CALL time via createRequire with an
//     opaque module name (same technique as lib/rate-limit.ts — a literal
//     "undici" specifier would be constant-folded by Turbopack and the real
//     undici inlined into the server chunk). Under Node this yields the REAL
//     undici fetch + Agent and the pinned lookup is fully effective.
//     (Node's *global* fetch cannot take a foreign npm-undici Agent as
//     dispatcher — internal/webidl protocol mismatch — hence undici's own
//     fetch is used when available.)
//   • Bun runtime (this repo's dev + start scripts): Bun intercepts the
//     "undici" specifier with a built-in inert stub (the real undici v8 cannot
//     even initialise under Bun: webidl.util.markAsUncloneable), so the
//     dispatcher option is silently ignored and layer (4) — the per-hop
//     dns.lookup guard — is the active hostname defence there. Residual under
//     Bun only: the classic guard-then-resolve TOCTOU window (rebinding);
//     under Node the pinned Agent closes it. Both runtimes are strictly
//     stronger than the previous redirect:"follow" behaviour.
// ============================================================================
import dns from "node:dns";
import net from "node:net";
import { createRequire } from "node:module";
import type { LookupOptions } from "node:dns";

// ---------------------------------------------------------------- types

export type SafeFetchResult = { ok: true; buffer: Buffer; contentType: string } | { ok: false; reason: string };
export type HopCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** dns.lookup-compatible callback: accepts BOTH result shapes (single address
 *  and `{ all: true }` arrays) because undici/net may call either. The single
 *  shape may arrive as a bare string OR as a LookupAddress object. */
export type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family?: number }> | { address: string; family?: number },
  family?: number
) => void;

export type DnsLookupFn = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;

export type SafeFetchOpts = {
  /** Override the IP predicate (unit tests inject permissive/custom ones). */
  isPublic?: (ip: string) => boolean;
  /** Override the dns.lookup-style function used for the per-hop DNS guard. */
  lookup?: DnsLookupFn;
  /** Override the fetch implementation. */
  fetchImpl?: MinimalFetch;
  /** Response size cap in bytes (default 5MB). */
  maxBytes?: number;
  /** Per-hop overall timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Redirect cap (default 3). */
  maxHops?: number;
};

type MinimalResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: { cancel?: () => Promise<void> | void } | null;
};

type MinimalFetchInit = {
  redirect?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal | null;
  dispatcher?: unknown;
};

type MinimalFetch = (url: string, init: MinimalFetchInit) => Promise<MinimalResponse>;

type AgentCtor = new (opts: { connect: { lookup: DnsLookupFn; timeout: number } }) => unknown;

// ---------------------------------------------------------------- constants

export const MAX_REDIRECT_HOPS = 3;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_USER_AGENT = "SHOPMESH-Importer/1.0 (+https://shopmesh.local)";
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// ---------------------------------------------------------------- isPublicIp

/** [network, prefix bits] — every range the SSRF guard refuses for IPv4. */
const PRIVATE_V4: Array<[number, number]> = [
  [ip4("0.0.0.0"), 8], // "this" network
  [ip4("10.0.0.0"), 8], // RFC1918 private
  [ip4("100.64.0.0"), 10], // CGNAT shared address space
  [ip4("127.0.0.0"), 8], // loopback
  [ip4("169.254.0.0"), 16], // link-local + cloud metadata (169.254.169.254)
  [ip4("172.16.0.0"), 12], // RFC1918 private
  [ip4("192.0.0.0"), 24], // IETF protocol assignments
  [ip4("192.0.2.0"), 24], // TEST-NET-1 (documentation)
  [ip4("192.168.0.0"), 16], // RFC1918 private
  [ip4("198.18.0.0"), 15], // benchmarking
  [ip4("198.51.100.0"), 24], // TEST-NET-2 (documentation)
  [ip4("203.0.113.0"), 24], // TEST-NET-3 (documentation)
  [ip4("224.0.0.0"), 4], // multicast
  [ip4("240.0.0.0"), 4], // reserved (incl. 255.255.255.255 broadcast)
];

function ip4(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function v4ToLong(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((p) => p > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function longToDotted(long: number): string {
  return [((long >>> 24) & 255), ((long >>> 16) & 255), ((long >>> 8) & 255), (long & 255)].join(".");
}

function isPublicIpv4(ip: string): boolean {
  const long = v4ToLong(ip);
  if (long === null) return false;
  for (const [base, bits] of PRIVATE_V4) {
    const mask = (~0 << (32 - bits)) >>> 0;
    if ((long & mask) === (base & mask)) return false;
  }
  return true;
}

/** Expand any textual IPv6 form (incl. `::`, embedded dotted IPv4 tails like
 *  `::ffff:10.0.0.1`) into exactly 8 numeric hextets, or null if malformed. */
function expandIpv6(ip: string): number[] | null {
  let addr = ip;
  // 1) embedded dotted-IPv4 tail (last colon-separated group contains dots)
  const lastColon = addr.lastIndexOf(":");
  const tail = lastColon >= 0 ? addr.slice(lastColon + 1) : addr;
  if (tail.includes(".")) {
    const v4 = v4ToLong(tail);
    if (v4 === null) return null;
    const head = lastColon >= 0 ? addr.slice(0, lastColon + 1) : "";
    addr = `${head}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  // 2) split around "::" and zero-fill
  const dbl = addr.split("::");
  if (dbl.length > 2) return null;
  const parseGroup = (g: string): number | null => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : null);
  const groups: number[] = [];
  if (dbl.length === 2) {
    const left = dbl[0] ? dbl[0].split(":") : [];
    const right = dbl[1] ? dbl[1].split(":") : [];
    if (left.length + right.length > 7) return null;
    for (const g of left) {
      const v = parseGroup(g);
      if (v === null) return null;
      groups.push(v);
    }
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    for (let i = 0; i < fill; i++) groups.push(0);
    for (const g of right) {
      const v = parseGroup(g);
      if (v === null) return null;
      groups.push(v);
    }
  } else {
    const parts = addr.split(":");
    if (parts.length !== 8) return null;
    for (const g of parts) {
      const v = parseGroup(g);
      if (v === null) return null;
      groups.push(v);
    }
  }
  return groups.length === 8 ? groups : null;
}

function isPublicIpv6Groups(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  // IPv4-mapped ::ffff:0:0/96 — unmap and re-check the embedded IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicIpv4(longToDotted(((g6 << 16) | g7) >>> 0));
  }
  // NAT64 64:ff9b::/96 — unmap and re-check the embedded IPv4.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0) {
    return isPublicIpv4(longToDotted(((g6 << 16) | g7) >>> 0));
  }
  // Unique local addresses fc00::/7.
  if ((g0 & 0xfe00) === 0xfc00) return false;
  // Link-local fe80::/10.
  if ((g0 & 0xffc0) === 0xfe80) return false;
  // Multicast ff00::/8 (symmetry with the IPv4 224/4 rule — beyond the letter
  // of the task spec, but a multicast target must never be fetchable).
  if ((g0 & 0xff00) === 0xff00) return false;
  // Documentation range 2001:db8::/32.
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  // ::, ::1 and the rest of ::/8 (unspecified + IPv4-compatible forms). This
  // runs LAST so the mapped/NAT64 forms above get their unmap-and-recheck
  // treatment first.
  if ((g0 & 0xff00) === 0) return false;
  return true;
}

/**
 * Pure predicate: true only for globally-routable, non-reserved addresses.
 * Non-IP strings return false (safe default — callers only feed it literals
 * or dns.lookup results).
 */
export function isPublicIp(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  const family = net.isIP(value);
  if (family === 4) return isPublicIpv4(value);
  if (family === 6) {
    const groups = expandIpv6(value);
    return groups !== null && isPublicIpv6Groups(groups);
  }
  return false;
}

// ---------------------------------------------------------------- hop guard

/** Static per-hop URL validation: scheme, credentials, IP-literal ranges.
 *  Hostnames are NOT resolved here (the per-hop DNS guard + pinned Agent
 *  handle those) — this stays pure/synchronous so both the fetch loop and the
 *  unit tests can exercise it cheaply. */
export function validateHop(input: string | URL, isPublic: (ip: string) => boolean = isPublicIp): HopCheck {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    return { ok: false, reason: "INVALID_URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "SCHEME" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "CREDENTIALS" };
  // hostname is already lowercased and bracket-stripped for IPv6 literals
  const host = url.hostname;
  if (net.isIP(host) !== 0 && !isPublic(host)) return { ok: false, reason: "PRIVATE_HOST" };
  return { ok: true, url };
}

// ---------------------------------------------------------------- dns guard

function privateResolutionError(hostname: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `Blocked resolution of ${hostname} to a private/restricted address (SSRF guard)`
  );
  err.code = "EPRIVATEADDRESS";
  return err;
}

/**
 * Wrap a dns.lookup-style function so EVERY address it returns is validated
 * with `isPublic` before the result reaches the caller — a private/restricted
 * answer becomes a lookup error, which blocks the connection. This is the
 * pinned-lookup core: the same resolution the socket uses is the one that was
 * validated, closing the classic rebinding window (under runtimes that honour
 * the Agent dispatcher).
 */
export function guardedLookupFactory(realLookup: DnsLookupFn, isPublic: (ip: string) => boolean = isPublicIp): DnsLookupFn {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    realLookup(hostname, options, (err, addressOrAddresses, family) => {
      if (err) return callback(err);
      if (Array.isArray(addressOrAddresses)) {
        const list = addressOrAddresses;
        const addresses = list.map((entry) => (typeof entry === "string" ? entry : entry?.address));
        if (addresses.length === 0 || addresses.some((a) => typeof a !== "string" || !isPublic(a))) {
          return callback(privateResolutionError(hostname));
        }
        return callback(null, list, family);
      }
      const single = typeof addressOrAddresses === "string" ? addressOrAddresses : addressOrAddresses?.address;
      if (typeof single !== "string" || !isPublic(single)) {
        return callback(privateResolutionError(hostname));
      }
      return callback(null, single, family);
    });
  };
}

/** Per-hop hostname guard: resolve with { all: true } and require EVERY
 *  address to be public. DNS failures pass through (the fetch itself will
 *  surface them as NETWORK) — this guard only answers "is anything private". */
async function preResolveGuard(
  hostname: string,
  lookup: DnsLookupFn,
  isPublic: (ip: string) => boolean
): Promise<{ ok: boolean; reason?: string }> {
  let addresses: string[];
  try {
    addresses = await new Promise<string[]>((resolve, reject) => {
      lookup(hostname, { all: true, verbatim: true }, (err, addressOrAddresses) => {
        if (err) return reject(err);
        if (Array.isArray(addressOrAddresses)) {
          return resolve(addressOrAddresses.map((e) => (typeof e === "string" ? e : e?.address)));
        }
        const single = typeof addressOrAddresses === "string" ? addressOrAddresses : addressOrAddresses?.address;
        resolve(typeof single === "string" ? [single] : []);
      });
    });
  } catch {
    return { ok: true };
  }
  if (addresses.length === 0) return { ok: true };
  for (const a of addresses) {
    if (typeof a !== "string" || !isPublic(a)) return { ok: false, reason: "PRIVATE_HOST" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- dispatcher

/**
 * Resolve undici AT CALL TIME through a runtime-only require handle with an
 * opaque module name (identical technique to lib/rate-limit.ts): a literal
 * "undici" import would be constant-folded by Turbopack and the real undici
 * inlined into the server chunk — which cannot even initialise under the Bun
 * runtime. Under Node this returns the real { fetch, Agent }; under Bun the
 * runtime intercepts the specifier with an inert stub (fetch === Bun's native
 * fetch, Agent === no-op object), which is harmless as a dispatcher.
 */
let undiciModule: { fetch: MinimalFetch; Agent: AgentCtor } | null | undefined;

function loadUndici(): { fetch: MinimalFetch; Agent: AgentCtor } | null {
  if (undiciModule !== undefined) return undiciModule;
  undiciModule = null;
  try {
    const requireModule = createRequire(import.meta.url);
    const moduleName = Buffer.from("dW5kaWNp", "base64").toString("utf8");
    const mod = requireModule(moduleName) as { fetch?: unknown; Agent?: unknown } | null;
    if (mod && typeof mod.fetch === "function" && typeof mod.Agent === "function") {
      undiciModule = { fetch: mod.fetch as MinimalFetch, Agent: mod.Agent as AgentCtor };
    }
  } catch {
    // undici unavailable at runtime → global fetch without a dispatcher; the
    // static hop guard + per-hop DNS guard still enforce every check.
  }
  return undiciModule;
}

function defaultFetch(): MinimalFetch {
  const mod = loadUndici();
  if (mod) return mod.fetch;
  return globalThis.fetch as unknown as MinimalFetch;
}

const realDnsLookup = dns.lookup as unknown as DnsLookupFn;
const guardedDefaultLookup: DnsLookupFn = guardedLookupFactory(realDnsLookup);
let defaultAgent: unknown;

/** Pinned dispatcher: one lazily-built module-level Agent whose connect lookup
 *  is guardedDefaultLookup (connect timeout 8s). Only used on the production
 *  path (no injected test overrides). */
function pinnedDispatcher(): unknown {
  if (defaultAgent === undefined) {
    const mod = loadUndici();
    defaultAgent = null;
    if (mod) {
      try {
        defaultAgent = new mod.Agent({ connect: { lookup: guardedDefaultLookup, timeout: CONNECT_TIMEOUT_MS } });
      } catch {
        defaultAgent = null;
      }
    }
  }
  return defaultAgent;
}

// ---------------------------------------------------------------- sniffing

function sniffMatchesType(contentType: string, buf: Buffer): boolean {
  const head = (n: number) => buf.subarray(0, n).toString("latin1");
  switch (contentType) {
    case "image/jpeg":
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/png":
      return buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    case "image/gif":
      return buf.length >= 6 && (head(6) === "GIF87a" || head(6) === "GIF89a");
    case "image/webp":
      return buf.length >= 12 && head(4) === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
}

function drainlessCancel(res: MinimalResponse): void {
  try {
    const p = res.body?.cancel?.();
    if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => undefined);
  } catch {
    /* best-effort release */
  }
}

// ---------------------------------------------------------------- main loop

/**
 * SSRF-hardened fetch of an external image. Public entry point used by the
 * import runner's copyExternalImage. Returns the validated body on success or
 * a machine-readable `reason` on refusal — never throws.
 */
export async function safeFetchExternalImage(url: string, opts: SafeFetchOpts = {}): Promise<SafeFetchResult> {
  return safeFetchInternal(url, opts);
}

/**
 * Implementation core with injectable guards (unit tests substitute isPublic /
 * lookup / fetchImpl — the task spec's prescribed seam). Production callers go
 * through safeFetchExternalImage with no overrides.
 */
export async function safeFetchInternal(url: string, opts: SafeFetchOpts = {}): Promise<SafeFetchResult> {
  const isPublic = opts.isPublic ?? isPublicIp;
  const lookup = opts.lookup ?? realDnsLookup;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  // The pinned Agent embeds the DEFAULT guards — only engage it when no guard
  // overrides are injected (test paths run under Bun where the dispatcher is
  // inert anyway; see the file header).
  const usePinnedDispatcher = opts.isPublic === undefined && opts.lookup === undefined && opts.fetchImpl === undefined;

  let current: string = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    // 1) static per-hop validation (scheme / credentials / IP literals)
    const check = validateHop(current, isPublic);
    if (!check.ok) return { ok: false, reason: check.reason };
    const hopUrl = check.url;

    // 2) per-hop DNS guard for hostnames (IP literals need no resolution —
    //    step 1 already range-checked them). Under Node this duplicates the
    //    pinned Agent's connect-time check (cheap, OS-cached, and it is the
    //    authoritative guard under Bun where the dispatcher is inert).
    if (net.isIP(hopUrl.hostname) === 0) {
      const pre = await preResolveGuard(hopUrl.hostname, lookup, isPublic);
      if (!pre.ok) return { ok: false, reason: pre.reason ?? "PRIVATE_HOST" };
    }

    // 3) guarded single-hop fetch — redirects are NEVER auto-followed
    let res: MinimalResponse;
    try {
      const init: MinimalFetchInit = {
        redirect: "manual",
        headers: { "User-Agent": DEFAULT_USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (usePinnedDispatcher) {
        const dispatcher = pinnedDispatcher();
        if (dispatcher) init.dispatcher = dispatcher;
      }
      res = await fetchImpl(hopUrl.toString(), init);
    } catch (err) {
      return { ok: false, reason: `NETWORK: ${err instanceof Error ? err.message : String(err)}` };
    }

    // 4) manual redirect handling — the target is fully re-validated on the
    //    next loop iteration (scheme, credentials, DNS, everything)
    if (res.status >= 300 && res.status < 400) {
      drainlessCancel(res);
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, reason: "REDIRECT_MISSING_LOCATION" };
      if (hop === maxHops) return { ok: false, reason: "MAX_HOPS" };
      let next: URL;
      try {
        next = new URL(loc, hopUrl);
      } catch {
        return { ok: false, reason: "INVALID_REDIRECT" };
      }
      current = next.toString();
      continue;
    }

    if (!res.ok) {
      drainlessCancel(res);
      return { ok: false, reason: `HTTP_${res.status}` };
    }

    // 5) final-response validation
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) {
      drainlessCancel(res);
      return { ok: false, reason: "CONTENT_TYPE" };
    }
    const clHeader = res.headers.get("content-length");
    if (clHeader) {
      const declared = Number(clHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        drainlessCancel(res);
        return { ok: false, reason: "TOO_LARGE" };
      }
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return { ok: false, reason: `NETWORK: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (buf.length === 0) return { ok: false, reason: "EMPTY" };
    if (buf.length > maxBytes) return { ok: false, reason: "TOO_LARGE" };
    if (!sniffMatchesType(contentType, buf)) return { ok: false, reason: "CONTENT_TYPE" };
    return { ok: true, buffer: buf, contentType };
  }
  return { ok: false, reason: "MAX_HOPS" };
}

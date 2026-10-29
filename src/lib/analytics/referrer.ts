// Seller Insights — referrer classification (privacy-aware).
//
// Reads only the standard `Referer` request header. Stores the HOST (≤100 chars,
// lowercase) — never the full URL, so referrer query parameters (which can carry
// tokens/emails) are never persisted. Classification is a small heuristic host
// map; last-touch on the view event (documented: a channel did not necessarily
// CAUSE the sale). No fingerprinting, no cross-site tracking.
export type TrafficChannel = "direct" | "search" | "social" | "internal" | "other";

const SEARCH_HOSTS = [
  "google.com", "google.com.my", "google.my", "bing.com", "duckduckgo.com",
  "search.yahoo.com", "ecosia.org", "startpage.com", "search.brave.com", "mojeek.com",
];
const SOCIAL_HOSTS = [
  "facebook.com", "fb.com", "m.facebook.com", "instagram.com", "tiktok.com",
  "x.com", "twitter.com", "t.co", "pinterest.com", "youtube.com", "youtu.be",
  "reddit.com", "linkedin.com", "threads.net", "wa.me", "whatsapp.com",
];

/** True when `host` equals `base` or is a subdomain of it (`www.`, `m.`, …). */
function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function classifyHost(host: string): TrafficChannel {
  for (const h of SEARCH_HOSTS) if (hostMatches(host, h)) return "search";
  for (const h of SOCIAL_HOSTS) if (hostMatches(host, h)) return "social";
  return "other";
}

/**
 * Classify the request's referrer. `internal` = same host as the request itself
 * (site navigation), `direct` = no referrer header.
 */
export function classifyReferrer(req: Request): { referrerHost: string | null; channel: TrafficChannel } {
  const raw = req.headers.get("referer");
  if (!raw) return { referrerHost: null, channel: "direct" };
  try {
    const url = new URL(raw);
    const host = (url.hostname || "").toLowerCase().slice(0, 100);
    if (!host) return { referrerHost: null, channel: "direct" };
    const requestHost = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
    if (requestHost && (host === requestHost || host.endsWith(`.${requestHost}`))) {
      return { referrerHost: host, channel: "internal" };
    }
    return { referrerHost: host, channel: classifyHost(host) };
  } catch {
    return { referrerHost: null, channel: "direct" };
  }
}

// ============================================================================
// URL guard (Task D2) — scheme allowlist for seller/shopper-controlled URLs.
//
// Any URL that a user controls and that later lands in an href/src attribute
// must pass through here BEFORE it is persisted (save side) and — belt and
// braces — again when it is rendered (render side). The guard:
//
//   - allows ONLY http: and https: absolute URLs (kills javascript:, data:,
//     vbscript:, file:, and every other scheme);
//   - rejects embedded credentials (https://u:p@host/);
//   - caps raw length (default 500);
//   - optionally accepts site-relative paths ("/uploads/x.png") for fields
//     where internal paths are legitimate (product images, avatars, logos).
//     A relative value must start with EXACTLY ONE "/" — "//evil.com/x"
//     (protocol-relative) and "/\evil.com" (backslash smuggling) are rejected.
//
// Returns the normalized `url.toString()` (WHATWG parser) on success, null on
// anything else — callers decide reject-vs-null per their field semantics.
// ============================================================================

export type SanitizeUrlOptions = {
  /** Max raw (trimmed) length before parsing — default 500. */
  maxLength?: number;
  /** Accept site-relative paths ("/uploads/x.png"). Default false. */
  allowRelative?: boolean;
};

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Control chars or raw whitespace never belong in a stored URL value (header
 *  / attribute smuggling) — reject before any parser leniency can rescue it. */
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f]/;

/**
 * Sanitize an external URL. Returns the normalized URL string, or null when
 * the value is absent, malformed, too long, not http(s), or carries
 * credentials. See file header for the full contract.
 */
export function sanitizeExternalUrl(
  raw: string | null | undefined,
  opts?: SanitizeUrlOptions
): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.length > (opts?.maxLength ?? 500)) return null;
  if (UNSAFE_CHARS.test(trimmed)) return null;

  // Site-relative path branch: exactly one leading "/" (not "//", not "/\").
  if (opts?.allowRelative && trimmed.startsWith("/") && trimmed[1] !== "/" && trimmed[1] !== "\\") {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  // Embedded credentials (https://user:pass@host/) — never persist these.
  if (url.username || url.password) return null;
  return url.toString();
}

/** Boolean wrapper for render-side checks ("should this link render at all?"). */
export function isSafeExternalUrl(
  raw: string | null | undefined,
  opts?: SanitizeUrlOptions
): boolean {
  return sanitizeExternalUrl(raw, opts) != null;
}

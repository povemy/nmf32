// ============================================================================
// PHASE 2.1 (§9-B/C) — search-query normalization for PUBLIC cached routes.
//
// The search/suggest + product-listing caches key on the caller-supplied query
// string. Raw, unbounded input would let a scripted client mint unbounded
// cache cardinality (randomized-query cache flooding) and store meaningless
// entries for partial/whitespace junk. Every public search entry point now
// normalizes BEFORE the value touches a cache key:
//   • cap length (MAX_SEARCH_QUERY_CHARS; over-length → empty ⇒ unfiltered
//     listing response, never a cache entry keyed by a giant string)
//   • strip control characters
//   • trim + collapse internal whitespace runs to single spaces
// No lowercasing: search uses case-insensitive `contains` on the server and
// case is part of product titles (preserving it keeps relevance identical to
// the pre-change behaviour for legitimate queries).
// Pure module — no imports, safe for route handlers and tests.
// ============================================================================

export const MAX_SEARCH_QUERY_CHARS = 80;

/** Normalized search keyword ("" when empty/whitespace-only/over-length/junk). */
export function normalizeSearchQuery(raw: string | null | undefined): string {
  if (!raw) return "";
  // Whitespace-class control chars become spaces (word separators preserved);
  // all other control characters are stripped; cap length; collapse runs; trim.
  const cleaned = raw
    .replace(/[\t\n\r\f\v ]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_SEARCH_QUERY_CHARS)
    .trim()
    .replace(/\s+/g, " ");
  return cleaned;
}

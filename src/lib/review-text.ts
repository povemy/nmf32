// ============================================================================
// REVIEW TEXT GUARD — submission-time detection + display-time blanking.
// ============================================================================
// Backstory: a stored review containing
//   "<script>alert('xss')</script><img src=x onerror=alert(1)>"
// rendered as literal text on a product page. React escapes text nodes so
// nothing executed, but the payload itself is never legitimate review copy.
//
// Policy (buyer work order):
//   1. SUBMISSION — the API "orchestrator" detects markup/injection payloads
//      FIRST and rejects with 400 UNSAFE_CONTENT; the review dialog shows a
//      popup warning telling the buyer to submit plain text instead.
//   2. DISPLAY — defense-in-depth: any review that STILL contains a threat
//      pattern by the time it is rendered (seeded fixtures, legacy rows,
//      anything that bypassed the gate) is blanked by the system — exactly
//      "shown blank, auto-removed".
//
// This module is PURE (no db imports) so the SAME patterns run on the server
// routes and inside client render paths. Keep it dependency-free.
// ----------------------------------------------------------------------------

/** One named detection pattern. `name` is surfaced in the shopper-facing
 *  warning so the buyer knows exactly what to remove — never the raw match. */
const REVIEW_THREAT_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // <script> / </script> (any casing/spacing variance)
  { name: "script tags", re: /<\s*\/?\s*script/i },
  // inline event handlers: onerror=, onload=, onclick=, ontoggle= …
  // (\b keeps mid-word false positives like "concentration=" out)
  { name: "event handlers (e.g. onerror=)", re: /\bon[a-z]{3,24}\s*=/i },
  // script pseudo-URLs
  { name: "script URLs (javascript:)", re: /\b(javascript|vbscript|livescript|mocha)\s*:/i },
  { name: "data: HTML URLs", re: /data\s*:\s*[\w.+-]*\s*text\/html/i },
  // executable / framing / resource-injecting elements
  { name: "embedded frames or objects", re: /<\s*\/?\s*(iframe|object|embed|applet|frame|frameset)\b/i },
  // markup elements that carry URLs or override document behaviour
  { name: "HTML tags", re: /<\s*\/?\s*(img|svg|video|audio|source|form|base|meta|link|style|body|html|input|button|marquee|details)\b/i },
  // inline style injection (expression()/url(javascript:))
  { name: "script in styles", re: /expression\s*\(|url\s*\(\s*['"]?\s*(javascript|data\s*:\s*text\/html)/i },
  { name: "srcdoc payloads", re: /\bsrcdoc\s*=/i },
];

/** Detect a markup/injection threat in free review text.
 *  Returns a human-readable pattern name when one matches, else null.
 *  Never returns the matched text itself (no error-reflection). */
export function detectReviewThreat(text: string | null | undefined): string | null {
  if (text == null) return null;
  const s = String(text);
  if (s.length === 0) return null;
  for (const p of REVIEW_THREAT_PATTERNS) {
    if (p.re.test(s)) return p.name;
  }
  return null;
}

/** Check every free-text field of a review submission.
 *  Returns the FIRST offending field + pattern name, or null when clean. */
export function detectReviewSubmissionThreat(input: {
  title?: string | null;
  body?: string | null;
  customerName?: string | null;
}): { field: string; pattern: string } | null {
  const fields: Array<[string, string | null | undefined]> = [
    ["customerName", input.customerName],
    ["title", input.title],
    ["body", input.body],
  ];
  for (const [field, value] of fields) {
    const pattern = detectReviewThreat(value);
    if (pattern) return { field, pattern };
  }
  return null;
}

/** Display-time sanitizer (defense-in-depth): a stored text that still carries
 *  a threat pattern is BLANKED by the system — the review renders with an
 *  empty text slot instead of the payload. Returns null for "render nothing";
 *  safe text passes through untouched (React still HTML-escapes it). */
export function sanitizeReviewTextForDisplay(text: string | null | undefined): string | null {
  if (text == null) return null;
  if (detectReviewThreat(text)) return null; // auto-removed → blank review
  return text;
}

/** True when the field was non-empty but got blanked (drives the small
 *  "removed by the system" note on the shopper's own review management). */
export function wasReviewTextRemoved(text: string | null | undefined): boolean {
  return text != null && text.length > 0 && detectReviewThreat(text) != null;
}

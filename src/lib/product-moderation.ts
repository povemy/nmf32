// ============================================================================
// product-moderation.ts — shared keyword-flagging rules for product content
// (Phase 2.2, C1.4). One authoritative list used by BOTH the manual product
// creation path (/api/store/products) and the import runner — previously the
// import path skipped moderation entirely, letting "Replica Gun"-style titles
// import straight to `active`.
// ============================================================================

export const BANNED_KEYWORDS = ["replica", "fake", "gun", "drug"];

/** Substring keyword flags over arbitrary product text (title, description). */
export function matchFlags(text: string): string[] {
  const t = text.toLowerCase();
  return BANNED_KEYWORDS.filter((k) => t.includes(k));
}

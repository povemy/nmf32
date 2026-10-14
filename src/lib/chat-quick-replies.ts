// ============================================================================
// Chat quick replies (canned responses) — SCAFFOLD, Phase "chat-v2".
// ----------------------------------------------------------------------------
// The seller composer renders these as one-tap chips above the input box.
// Selecting a chip FILLS the draft (it does not auto-send) so the seller can
// tweak the text first — this matches Shopee/WhatsApp Business behaviour and
// keeps the seller in control.
//
// Later (needs product discussion): per-store custom templates, variable
// interpolation ({orderNumber}, {shopperName}), admin-managed global packs.
// The data model is intentionally plain so it can later move to a
// QuickReplyTemplate table without changing call-sites.
// ============================================================================

export type QuickReply = {
  label: string; // chip label, keep it ≤ 16 chars
  text: string; // inserted into the composer draft
};

/** Default starter pack shown to every seller. Dormant-free: fully functional. */
export const SELLER_QUICK_REPLIES: QuickReply[] = [
  { label: "Shipping time", text: "Hi! Thanks for your message — orders ship within 1–2 working days and tracking is emailed as soon as the parcel is picked up." },
  { label: "In stock", text: "Yes, that item is still in stock! You can order directly from the product page and I'll pack it right away." },
  { label: "Restocking", text: "That one is currently sold out — the next restock lands in about 1–2 weeks. I can ping you here the moment it's back." },
  { label: "COD?", text: "We currently accept FPX, Touch 'n Go, GrabPay and cards through the marketplace checkout. COD is not available yet, sorry!" },
  { label: "Order status", text: "Let me check your order status for you — one moment please 🙏" },
  { label: "Thanks + close", text: "Thanks for chatting! If there's anything else just reply here — happy to help. Have a great day!" },
];

// ============================================================================
// AUTO-REPLY — SCAFFOLD ONLY (deliberately dormant).
// ----------------------------------------------------------------------------
// HOW OTHER E-COMMERCE PLATFORMS DO IT (summary for the upcoming discussion):
// • Shopee — instant off-hours acknowledgement ("Seller may reply slowly"),
//   then optional keyword auto-answers per product (size chart, shipping).
// • WhatsApp Business — away message + greeting message + quick replies,
//   all per-business configurable with active-hour windows.
// • Lazada/Daraz — "auto-translation + canned response" combos scored by
//   response-time SLA badges (response rate % shown on the store).
// • Etsy — Info & FAQs auto-inserted when a buyer's question matches saved
//   FAQ keywords.
//
// PLANNED ASSEMBLY (not wired yet, needs discussion):
// 1. Trigger policy — reply when? (first shopper message of the thread /
//    outside seller active hours / seller idle > N minutes)
// 2. Content source — static ack (this scaffold) vs FAQ keyword matching vs
//    LLM-generated reply grounded on the store FAQ + product data.
// 3. Honesty guardrails — auto-replies MUST be labelled "Auto-reply" so the
//    shopper never mistakes them for a human answer.
// 4. Rate limiting — max 1 auto-reply per thread per hour to avoid spam.
//
// The call-site (shopper message POST route) already invokes
// `maybeAutoReply()` after every shopper message. With `enabled: false` it
// returns null and nothing is sent — flipping the flag (or wiring per-store
// settings later) activates the pipeline end-to-end.
// ============================================================================

export const AUTO_REPLY_CONFIG = {
  /** Master switch — DORMANT on purpose until the policy discussion happens. */
  enabled: false,
  /** Only auto-reply to the FIRST shopper message in a thread (when enabled). */
  onlyFirstMessage: true,
  /** Label prefixed to the generated message so shoppers know it's a bot. */
  label: "Auto-reply",
  /** The dormant starter acknowledgement. */
  fallbackText:
    "Hi! Thanks for your message — the seller will get back to you shortly. " +
    "Meanwhile you can check your order status from “My orders”.",
} as const;

export type AutoReplyInput = {
  threadId: string;
  shopperMessageCount: number; // how many messages the shopper already sent
  sellerMessageCount: number; // how many replies the seller already sent
};

/**
 * DORMANT auto-reply scaffold. Returns the message to post as the seller side,
 * or null when auto-reply is disabled / not applicable.
 * The calling route posts + broadcasts the returned message — the plumbing is
 * already connected, only the policy/config needs finalising.
 */
export function maybeAutoReply(input: AutoReplyInput): { body: string; isAutoReply: true } | null {
  if (!AUTO_REPLY_CONFIG.enabled) return null;
  if (AUTO_REPLY_CONFIG.onlyFirstMessage && (input.sellerMessageCount > 0 || input.shopperMessageCount > 1)) {
    return null;
  }
  return { body: `${AUTO_REPLY_CONFIG.label}: ${AUTO_REPLY_CONFIG.fallbackText}`, isAutoReply: true };
}

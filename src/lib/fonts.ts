// Curated font catalogue for seller-facing typography customization
// (product cards + any future text styling). Vendors pick from a friendly
// dropdown — never a raw CSS or JSON value. Each entry maps to a safe CSS
// font stack, and Google Fonts hosts the actual files (loaded on demand via
// fontLinkHref() — only the families a store actually uses get downloaded).
export type FontOption = {
  id: string;
  label: string;
  stack: string;
  googleFamily: string | null; // null = system font, no webfont download
  kind: "sans" | "serif" | "display" | "mono" | "handwriting";
};

export const FONT_OPTIONS: FontOption[] = [
  { id: "inter", label: "Inter (clean, modern)", stack: "'Inter', system-ui, sans-serif", googleFamily: "Inter", kind: "sans" },
  { id: "poppins", label: "Poppins (rounded, friendly)", stack: "'Poppins', system-ui, sans-serif", googleFamily: "Poppins", kind: "sans" },
  { id: "montserrat", label: "Montserrat (bold, geometric)", stack: "'Montserrat', system-ui, sans-serif", googleFamily: "Montserrat", kind: "sans" },
  { id: "raleway", label: "Raleway (elegant sans)", stack: "'Raleway', system-ui, sans-serif", googleFamily: "Raleway", kind: "sans" },
  { id: "nunito", label: "Nunito (soft, rounded)", stack: "'Nunito', system-ui, sans-serif", googleFamily: "Nunito", kind: "sans" },
  { id: "playfair", label: "Playfair Display (luxury serif)", stack: "'Playfair Display', Georgia, serif", googleFamily: "Playfair+Display", kind: "serif" },
  { id: "merriweather", label: "Merriweather (readable serif)", stack: "'Merriweather', Georgia, serif", googleFamily: "Merriweather", kind: "serif" },
  { id: "lora", label: "Lora (contemporary serif)", stack: "'Lora', Georgia, serif", googleFamily: "Lora", kind: "serif" },
  { id: "oswald", label: "Oswald (tall & condensed)", stack: "'Oswald', 'Arial Narrow', sans-serif", googleFamily: "Oswald", kind: "display" },
  { id: "bebas", label: "Bebas Neue (poster headlines)", stack: "'Bebas Neue', Impact, sans-serif", googleFamily: "Bebas+Neue", kind: "display" },
  { id: "roboto-mono", label: "Roboto Mono (techy, numeric)", stack: "'Roboto Mono', ui-monospace, monospace", googleFamily: "Roboto+Mono", kind: "mono" },
  { id: "system", label: "System default", stack: "system-ui, sans-serif", googleFamily: null, kind: "sans" },
];

const FONT_BY_ID = new Map(FONT_OPTIONS.map((f) => [f.id, f]));

/** Resolve a stored font id to a CSS stack — unknown ids fall back to Inter. */
export function fontStack(id: string | null | undefined): string {
  return FONT_BY_ID.get(id ?? "")?.stack ?? FONT_OPTIONS[0].stack;
}

export function fontLabel(id: string | null | undefined): string {
  return FONT_BY_ID.get(id ?? "")?.label ?? id ?? FONT_OPTIONS[0].label;
}

/** Google Fonts stylesheet URL covering exactly the given family ids. */
export function fontLinkHref(ids: (string | null | undefined)[]): string | null {
  const families = [...new Set(ids.filter(Boolean).map((id) => FONT_BY_ID.get(id!)?.googleFamily).filter((f): f is string => Boolean(f)))];
  if (families.length === 0) return null;
  return `https://fonts.googleapis.com/css2?family=${families.map((f) => `${f}:wght@400;600;700;800`).join("&family=")}&display=swap`;
}

// Card typography size + alignment vocabularies (shared by seller form,
// API validation and the shopper renderer).
export const CARD_FONT_SIZES = ["sm", "md", "lg"] as const;
export const CARD_ALIGNMENTS = ["left", "center", "right"] as const;

export type CardFontSize = (typeof CARD_FONT_SIZES)[number];
export type CardAlignment = (typeof CARD_ALIGNMENTS)[number];

/** px sizes per step — tuned for 2-col mobile grids up to 6-col desktop. */
export const NAME_SIZE_PX: Record<CardFontSize, number> = { sm: 12, md: 13.5, lg: 15 };
export const PRICE_SIZE_PX: Record<CardFontSize, number> = { sm: 13, md: 14.5, lg: 16.5 };

export function nameSizePx(size: string | null | undefined): number {
  return NAME_SIZE_PX[(size ?? "md") as CardFontSize] ?? NAME_SIZE_PX.md;
}
export function priceSizePx(size: string | null | undefined): number {
  return PRICE_SIZE_PX[(size ?? "md") as CardFontSize] ?? PRICE_SIZE_PX.md;
}

/** The shape shipped to shopper surfaces via /api/sf/* payloads. */
export type CardStyleTokens = {
  nameFont: string;
  nameSize: string;
  nameAlign: string;
  priceFont: string;
  priceSize: string;
  priceAlign: string;
};

export const DEFAULT_CARD_STYLE: CardStyleTokens = {
  nameFont: "inter",
  nameSize: "md",
  nameAlign: "left",
  priceFont: "inter",
  priceSize: "md",
  priceAlign: "left",
};

export function parseCardStyle(json: string | null | undefined): CardStyleTokens {
  if (!json) return { ...DEFAULT_CARD_STYLE };
  try {
    const raw = JSON.parse(json) as Partial<CardStyleTokens>;
    return {
      nameFont: typeof raw.nameFont === "string" ? raw.nameFont : DEFAULT_CARD_STYLE.nameFont,
      nameSize: CARD_FONT_SIZES.includes(raw.nameSize as CardFontSize) ? raw.nameSize! : DEFAULT_CARD_STYLE.nameSize,
      nameAlign: CARD_ALIGNMENTS.includes(raw.nameAlign as CardAlignment) ? raw.nameAlign! : DEFAULT_CARD_STYLE.nameAlign,
      priceFont: typeof raw.priceFont === "string" ? raw.priceFont : DEFAULT_CARD_STYLE.priceFont,
      priceSize: CARD_FONT_SIZES.includes(raw.priceSize as CardFontSize) ? raw.priceSize! : DEFAULT_CARD_STYLE.priceSize,
      priceAlign: CARD_ALIGNMENTS.includes(raw.priceAlign as CardAlignment) ? raw.priceAlign! : DEFAULT_CARD_STYLE.priceAlign,
    };
  } catch {
    return { ...DEFAULT_CARD_STYLE };
  }
}

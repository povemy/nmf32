// ============================================================================
// M04 PAGE BUILDER — section registry (PART 1 §1.5)
// Every store page = ordered list of typed sections {type, id, props}.
// Unknown section types render a fallback box, never 500.
// ============================================================================

export type SectionProps = Record<string, unknown>;

export type Section = {
  id: string;
  type: string;
  props: SectionProps;
};

export type PageDoc = {
  sections: Section[];
  version: number;
};

export type ThemeTokens = {
  primaryColor: string;
  accentColor: string;
  fontHeading: string;
  fontBody: string;
  radius: "none" | "sm" | "md" | "lg" | "full";
  buttonStyle: "solid" | "outline" | "pill";
};

export const DEFAULT_THEME: ThemeTokens = {
  primaryColor: "#0f766e", // teal-700 (avoid default blue/indigo)
  accentColor: "#f59e0b",
  fontHeading: "system-ui",
  fontBody: "system-ui",
  radius: "lg",
  buttonStyle: "solid",
};

export type ItemField = {
  key: string;
  label: string;
  type: "text" | "textarea";
  placeholder?: string;
};

export type SectionField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "image" | "color" | "switch" | "select" | "url" | "json" | "item_list";
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  // item_list only — renders one friendly card per list item instead of raw JSON
  itemFields?: ItemField[];
  itemTitleKey?: string; // shown as the collapsed card summary
  addLabel?: string; // e.g. "Add testimonial"
  addTemplate?: Record<string, unknown>; // object appended when adding a new item
};

export type SectionDef = {
  type: string;
  label: string;
  description: string;
  defaultProps: SectionProps;
  fields: SectionField[];
  category: "structure" | "content" | "commerce" | "social";
};

const LINKS_SAMPLE = [
  { label: "Home", url: "/" },
  { label: "About", url: "/p/about" },
  { label: "Contact", url: "/p/contact" },
];

export const SECTION_REGISTRY: SectionDef[] = [
  {
    type: "announcement_bar",
    label: "Announcement Bar",
    description: "Slim promo strip at the very top.",
    defaultProps: { text: "Free shipping for orders above RM 100", bgColor: "#0f766e", textColor: "#ffffff" },
    fields: [
      { key: "text", label: "Text", type: "text" },
      { key: "bgColor", label: "Background", type: "color" },
      { key: "textColor", label: "Text color", type: "color" },
    ],
    category: "structure",
  },
  {
    type: "header",
    label: "Header / Nav",
    description: "Store logo, menu and cart access.",
    defaultProps: { showSearch: true, sticky: true },
    fields: [
      { key: "showSearch", label: "Show search", type: "switch" },
      { key: "sticky", label: "Sticky on scroll", type: "switch" },
    ],
    category: "structure",
  },
  {
    type: "hero",
    label: "Hero",
    description: "Big banner with heading and call-to-action.",
    defaultProps: {
      heading: "Beautiful things for calm homes",
      subheading: "Handpicked decor & living essentials, delivered across Malaysia.",
      imageUrl: "/api/img/hero-living?w=1600&h=700&label=Hero",
      ctaLabel: "Shop now",
      ctaUrl: "#products",
      height: "md",
      overlayOpacity: 35,
    },
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "subheading", label: "Subheading", type: "textarea" },
      { key: "imageUrl", label: "Image URL", type: "image" },
      { key: "ctaLabel", label: "Button label", type: "text" },
      { key: "ctaUrl", label: "Button link", type: "url" },
      {
        key: "height", label: "Height", type: "select",
        options: [
          { value: "sm", label: "Small" },
          { value: "md", label: "Medium" },
          { value: "lg", label: "Full screen" },
        ],
      },
      { key: "overlayOpacity", label: "Overlay %", type: "number" },
    ],
    category: "content",
  },
  {
    type: "image_banner",
    label: "Image Banner",
    description: "Clickable promo banner image.",
    defaultProps: { imageUrl: "/api/img/promo?w=1400&h=320&label=Promo", linkUrl: "#products", height: 220 },
    fields: [
      { key: "imageUrl", label: "Image URL", type: "image" },
      { key: "linkUrl", label: "Link URL", type: "url" },
      { key: "height", label: "Height (px)", type: "number" },
    ],
    category: "content",
  },
  {
    type: "product_grid",
    label: "Product Grid",
    description: "Products from latest, featured or a collection.",
    defaultProps: { title: "Best Sellers", source: "latest", collectionSlug: "", limit: 8, columns: 4, showPrice: true, showViewAll: true },
    fields: [
      { key: "title", label: "Title", type: "text" },
      {
        key: "source", label: "Source", type: "select",
        options: [
          { value: "latest", label: "Latest products" },
          { value: "featured", label: "Featured" },
          { value: "collection", label: "Collection" },
        ],
      },
      { key: "collectionSlug", label: "Collection slug (if collection)", type: "text" },
      { key: "limit", label: "Max products", type: "number" },
      {
        key: "columns", label: "Columns", type: "select",
        options: [
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "4", label: "4" },
        ],
      },
      { key: "showPrice", label: "Show prices", type: "switch" },
      { key: "showViewAll", label: "View all button", type: "switch" },
    ],
    category: "commerce",
  },
  {
    type: "collection_list",
    label: "Collection List",
    description: "Cards linking to store collections.",
    defaultProps: { title: "Shop by Collection", limit: 4 },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "limit", label: "Max collections", type: "number" },
    ],
    category: "commerce",
  },
  {
    type: "rich_text",
    label: "Rich Text",
    description: "Heading + paragraph block.",
    defaultProps: {
      heading: "Our Story",
      body: "We started in a small studio in Kuala Lumpur with one belief: calm, functional objects make better days. Every piece in this store is chosen with intention.",
      align: "center",
    },
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "body", label: "Body", type: "textarea" },
      {
        key: "align", label: "Align", type: "select",
        options: [
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
        ],
      },
    ],
    category: "content",
  },
  {
    type: "image_with_text",
    label: "Image with Text",
    description: "Split layout: image beside text.",
    defaultProps: {
      imageUrl: "/api/img/studio?w=900&h=700&label=Studio",
      heading: "Made with intention",
      body: "Small batches, honest materials, and packaging you can recycle.",
      imageSide: "left",
      ctaLabel: "Learn more",
      ctaUrl: "#",
    },
    fields: [
      { key: "imageUrl", label: "Image URL", type: "image" },
      { key: "heading", label: "Heading", type: "text" },
      { key: "body", label: "Body", type: "textarea" },
      {
        key: "imageSide", label: "Image side", type: "select",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
      },
      { key: "ctaLabel", label: "Button label", type: "text" },
      { key: "ctaUrl", label: "Button link", type: "url" },
    ],
    category: "content",
  },
  {
    type: "testimonials",
    label: "Testimonials",
    description: "Customer quotes with 4 layout styles.",
    defaultProps: {
      title: "What customers say",
      style: "cards",
      items: [
        { quote: "Beautiful packaging and fast delivery. Will order again!", author: "Aina, Shah Alam" },
        { quote: "The ceramic set transformed my coffee corner.", author: "Daniel, Penang" },
      ],
    },
    fields: [
      { key: "title", label: "Title", type: "text" },
      {
        key: "style", label: "Design style", type: "select",
        options: [
          { value: "cards", label: "Cards — bordered quote grid" },
          { value: "minimal", label: "Minimal — clean centred quotes" },
          { value: "bubbles", label: "Bubbles — chat-style highlights" },
          { value: "featured", label: "Featured — big quote + grid" },
        ],
        help: "Pick how testimonials are displayed on your storefront.",
      },
      {
        key: "items", label: "Testimonials", type: "item_list",
        itemTitleKey: "quote",
        addLabel: "Add testimonial",
        addTemplate: { quote: "", author: "" },
        itemFields: [
          { key: "quote", label: "Quote", type: "textarea", placeholder: "What did the customer say?" },
          { key: "author", label: "Author", type: "text", placeholder: "Name, City" },
        ],
      },
    ],
    category: "content",
  },
  {
    type: "faq",
    label: "FAQ",
    description: "Accordion questions with per-item editing.",
    defaultProps: {
      title: "Frequently asked questions",
      items: [
        { q: "How long is shipping?", a: "Peninsular Malaysia 2-4 working days; East Malaysia 3-7." },
        { q: "What is your return policy?", a: "Returns accepted on unused items in original packaging — message us to arrange one." },
      ],
    },
    fields: [
      { key: "title", label: "Title", type: "text" },
      {
        key: "items", label: "Questions", type: "item_list",
        itemTitleKey: "q",
        addLabel: "Add question",
        addTemplate: { q: "", a: "" },
        itemFields: [
          { key: "q", label: "Question", type: "text", placeholder: "How long is shipping?" },
          { key: "a", label: "Answer", type: "textarea", placeholder: "Peninsular Malaysia 2-4 working days…" },
        ],
      },
    ],
    category: "content",
  },
  {
    type: "newsletter",
    label: "Newsletter",
    description: "Email capture block.",
    defaultProps: { heading: "Join the list", subtext: "Early access to drops and 10% off your first order.", buttonLabel: "Subscribe" },
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "subtext", label: "Subtext", type: "textarea" },
      { key: "buttonLabel", label: "Button label", type: "text" },
    ],
    category: "content",
  },
  {
    type: "countdown",
    label: "Countdown",
    description: "Urgency timer for a campaign.",
    defaultProps: { heading: "Raya Sale ends in", endsAt: "", style: "banner" },
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "endsAt", label: "Ends at (YYYY-MM-DDTHH:mm)", type: "text" },
      {
        key: "style", label: "Style", type: "select",
        options: [
          { value: "banner", label: "Banner" },
          { value: "minimal", label: "Minimal" },
        ],
      },
    ],
    category: "content",
  },
  {
    type: "whatsapp_floating",
    label: "WhatsApp Floating",
    description: "Floating chat button.",
    defaultProps: { phone: "60123456789", message: "Hi! I have a question about your store" },
    fields: [
      { key: "phone", label: "Phone (intl, no +)", type: "text" },
      { key: "message", label: "Prefilled message", type: "text" },
    ],
    category: "social",
  },
  {
    type: "footer",
    label: "Footer",
    description: "Store footer with links.",
    defaultProps: {
      aboutText: "Curated home & living goods. Ships from Kuala Lumpur.",
      links: LINKS_SAMPLE,
      showSocial: true,
      copyright: "© 2025 · All rights reserved",
    },
    fields: [
      { key: "aboutText", label: "About text", type: "textarea" },
      {
        key: "links", label: "Footer links", type: "item_list",
        itemTitleKey: "label",
        addLabel: "Add link",
        addTemplate: { label: "", url: "/" },
        itemFields: [
          { key: "label", label: "Link label", type: "text", placeholder: "Home" },
          { key: "url", label: "Link URL", type: "text", placeholder: "/" },
        ],
      },
      { key: "showSocial", label: "Show social icons", type: "switch" },
      { key: "copyright", label: "Copyright", type: "text" },
    ],
    category: "structure",
  },
  {
    type: "marketplace_strip",
    label: "Marketplace Strip",
    description: "Cross-sell strip from the marketplace (drives discovery).",
    defaultProps: { title: "More from the marketplace", limit: 6 },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "limit", label: "Max products", type: "number" },
    ],
    category: "commerce",
  },
];

export function sectionDef(type: string): SectionDef | undefined {
  return SECTION_REGISTRY.find((s) => s.type === type);
}

export function newSectionId(): string {
  return `sec_${Math.random().toString(36).slice(2, 10)}`;
}

export function createSection(type: string): Section | null {
  const def = sectionDef(type);
  if (!def) return null;
  return { id: newSectionId(), type, props: JSON.parse(JSON.stringify(def.defaultProps)) };
}

export function parsePageDoc(json: string | null | undefined): PageDoc {
  if (!json) return { sections: [], version: 0 };
  try {
    const doc = JSON.parse(json) as PageDoc;
    return { sections: Array.isArray(doc.sections) ? doc.sections : [], version: doc.version ?? 0 };
  } catch {
    return { sections: [], version: 0 };
  }
}

export function parseTheme(json: string | null | undefined): ThemeTokens {
  const t = json ? (JSON.parse(json) as Partial<ThemeTokens>) : {};
  return { ...DEFAULT_THEME, ...t };
}

/** Default home page template (fired <60s after signup per PART 1 §1.5). */
export function defaultHomeSections(storeName: string, tagline: string): Section[] {
  const mk = (type: string, overrides: SectionProps = {}): Section => {
    const base = createSection(type)!;
    return { ...base, props: { ...base.props, ...overrides } };
  };
  return [
    mk("announcement_bar", { text: `Welcome to ${storeName} — free shipping above RM 100` }),
    mk("header"),
    mk("hero", { heading: storeName, subheading: tagline || "Curated goods, shipped with care." }),
    mk("product_grid", { title: "Fresh arrivals", source: "latest", limit: 8, columns: 4 }),
    mk("image_with_text"),
    mk("testimonials"),
    mk("newsletter"),
    mk("footer"),
  ];
}

export function defaultPageSections(pageType: string, storeName: string): Section[] {
  const mk = (type: string, overrides: SectionProps = {}): Section => {
    const base = createSection(type)!;
    return { ...base, props: { ...base.props, ...overrides } };
  };
  switch (pageType) {
    case "home":
      return defaultHomeSections(storeName, "");
    case "about":
      return [
        mk("announcement_bar", { text: `Welcome to ${storeName}` }),
        mk("header"),
        mk("rich_text", { heading: `About ${storeName}` }),
        mk("footer"),
      ];
    case "contact":
      return [
        mk("announcement_bar", { text: `Get in touch with ${storeName}` }),
        mk("header"),
        mk("rich_text", { heading: "Contact us", body: "We usually reply within one business day." }),
        mk("whatsapp_floating"),
        mk("footer"),
      ];
    default:
      return [mk("announcement_bar"), mk("header"), mk("rich_text", { heading: pageType }), mk("footer")];
  }
}

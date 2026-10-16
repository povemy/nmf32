"use client";
// ============================================================================
// Shopper — STOREFRONT RENDERER (Task 2-e).
// Renders ANY published page doc: all 15 SECTION_REGISTRY types, themed via
// CSS variables from parseTheme(). Unknown types render a fallback box — never
// crash, never 500. Missing props fall back to the registry defaultProps.
// ============================================================================
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronRight,
  Search,
  ShoppingBag,
  Store as StoreIcon,
  ArrowRight,
  X,
  Instagram,
  Facebook,
  Twitter,
  Youtube,
  Music2,
  MessageCircle,
  AlertTriangle,
  UserCheck,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import {
  sectionDef,
  DEFAULT_THEME,
  type Section,
  type ThemeTokens,
} from "@/lib/sections";
import { cn } from "@/lib/utils";
import { setMeta } from "@/lib/seo";
import { useApp } from "@/lib/app-store";
import {
  fetchJson,
  fetchEnvelope,
  postJson,
  openProduct,
  EmptyState,
  ProductCard,
  type ProductCardT,
  type ShopperCtx,
} from "./ui-bits";

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export type SfStore = {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  description?: string | null;
  theme: ThemeTokens;
  whatsapp: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  social?: Record<string, string>;
  /** Task 10-d — follower count carried by /api/sf/[slug]. */
  followers?: number | null;
};

type SfHomePayload = { store: SfStore; page: { id: string; title: string; slug: string; sections: Section[]; publishedVersion: number } };
type SfPagePayload = { store: SfStore; page: { id: string; title: string; slug: string; pageType?: string }; sections: Section[] };

// ---------------------------------------------------------------------------
// Theme plumbing
// ---------------------------------------------------------------------------

const RADIUS_PX: Record<ThemeTokens["radius"], number> = { none: 0, sm: 2, md: 6, lg: 12, full: 9999 };

function themeVars(theme: ThemeTokens): React.CSSProperties {
  return {
    "--sf-primary": theme.primaryColor || DEFAULT_THEME.primaryColor,
    "--sf-accent": theme.accentColor || DEFAULT_THEME.accentColor,
    "--sf-radius": `${RADIUS_PX[theme.radius] ?? 12}px`,
    "--sf-font-heading": theme.fontHeading || "system-ui",
    "--sf-font-body": theme.fontBody || "system-ui",
  } as React.CSSProperties;
}

/** Store-themed button honoring the store's buttonStyle token. */
function SfButton({
  store,
  children,
  onClick,
  outline = false,
  small = false,
  className,
}: {
  store: SfStore;
  children: React.ReactNode;
  onClick?: () => void;
  outline?: boolean;
  small?: boolean;
  className?: string;
}) {
  const style = store.theme.buttonStyle ?? "solid";
  const pill = style === "pill";
  const base = cn(
    "inline-flex items-center justify-center gap-1.5 font-semibold transition-all min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    small ? "px-3.5 text-xs" : "px-5 py-2 text-sm",
    pill ? "rounded-full" : "rounded-[var(--sf-radius)]",
    className
  );
  if (outline || style === "outline") {
    return (
      <button type="button" onClick={onClick} className={cn(base, "border-2 bg-transparent hover:opacity-80")} style={{ borderColor: "var(--sf-primary)", color: "var(--sf-primary)" }}>
        {children}
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cn(base, "text-white shadow-sm hover:opacity-90")} style={{ backgroundColor: "var(--sf-primary)" }}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Link resolution for section CTAs / footer links
// ---------------------------------------------------------------------------

function resolveSfLink(url: string, store: SfStore, ctx: ShopperCtx) {
  const u = (url ?? "").trim();
  if (!u || u === "#") return;
  if (u.startsWith("#")) {
    const el = document.getElementById(u.slice(1));
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (u.startsWith("/p/")) {
    ctx.nav({ name: "store-page", slug: store.slug, pageSlug: u.slice(3) });
    return;
  }
  if (u === "/" || u === "/home") {
    ctx.nav({ name: "storefront", slug: store.slug });
    return;
  }
  ctx.nav({ name: "search", q: "" });
}

// ---------------------------------------------------------------------------
// Section renderer
// ---------------------------------------------------------------------------

type SfRenderCtx = {
  store: SfStore;
  nav: ShopperCtx;
  openCart: () => void;
  sfSearch: string;
  onSearch: (q: string) => void;
  productAnchorId: string | null;
};

function SectionRenderer({ sections, rctx }: { sections: Section[]; rctx: SfRenderCtx }) {
  const firstGridId = sections.find((s) => s.type === "product_grid")?.id ?? null;
  return (
    <>
      {sections.map((section) => {
        const def = sectionDef(section.type);
        const props = { ...(def?.defaultProps ?? {}), ...(section.props ?? {}) } as Record<string, unknown>;
        // give the first product grid a stable id for #products anchors
        const id = section.id === firstGridId ? rctx.productAnchorId || "products" : `sec-${section.id}`;
        return (
          <div key={section.id} id={id}>
            <SectionErrorBoundary type={section.type}>
              <SectionBody type={section.type} props={props} rctx={rctx} />
            </SectionErrorBoundary>
          </div>
        );
      })}
    </>
  );
}

/** A broken section must never take the whole storefront down. */
class SectionErrorBoundary extends React.Component<{ type: string; children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) return <UnsupportedSection type={this.props.type} />;
    return this.props.children;
  }
}

function SectionBody({ type, props, rctx }: { type: string; props: Record<string, unknown>; rctx: SfRenderCtx }) {
  switch (type) {
    case "announcement_bar":
      return <AnnouncementBar props={props} />;
    case "header":
      return <SfHeader props={props} rctx={rctx} />;
    case "hero":
      return <Hero props={props} rctx={rctx} />;
    case "image_banner":
      return <ImageBanner props={props} rctx={rctx} />;
    case "product_grid":
      return <ProductGridSection props={props} rctx={rctx} />;
    case "collection_list":
      // No public collections endpoint exists in this sandbox (only the
      // seller-scoped /api/store/collections) — hide gracefully per spec.
      return null;
    case "rich_text":
      return <RichText props={props} />;
    case "image_with_text":
      return <ImageWithText props={props} rctx={rctx} />;
    case "testimonials":
      return <Testimonials props={props} />;
    case "faq":
      return <FaqSection props={props} />;
    case "newsletter":
      return <NewsletterSection props={props} rctx={rctx} />;
    case "countdown":
      return <CountdownSection props={props} />;
    case "whatsapp_floating":
      return <WhatsAppFloating props={props} />;
    case "footer":
      return <SfFooter props={props} rctx={rctx} />;
    case "marketplace_strip":
      return <MarketplaceStrip props={props} rctx={rctx} />;
    default:
      return <UnsupportedSection type={type} />;
  }
}

function UnsupportedSection({ type }: { type: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="rounded-xl border-2 border-dashed border-muted-foreground/40 p-6 text-center text-sm text-muted-foreground">
        <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
        Unsupported section{type ? `: ${type}` : ""}
      </div>
    </div>
  );
}

function str(props: Record<string, unknown>, key: string, fallback = ""): string {
  const v = props[key];
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}
function num(props: Record<string, unknown>, key: string, fallback: number): number {
  const v = Number(props[key]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(props: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = props[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}
function list<T = Record<string, unknown>>(props: Record<string, unknown>, key: string): T[] {
  const v = props[key];
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// --- 1. announcement_bar -----------------------------------------------------

function AnnouncementBar({ props }: { props: Record<string, unknown> }) {
  const text = str(props, "text");
  if (!text) return null;
  return (
    <div className="px-4 py-2 text-center text-xs sm:text-sm font-medium" style={{ backgroundColor: str(props, "bgColor", "#0f766e"), color: str(props, "textColor", "#ffffff") }}>
      {text}
    </div>
  );
}

// --- 2. header ---------------------------------------------------------------

// ---------------------------------------------------------------------------
// Follow store (Task 10-d) — optimistic toggle against POST
// /api/stores/[slug]/follow; guests are prompted to sign in first via
// openShopperAuth and the toggle re-runs after auth succeeds.
// ---------------------------------------------------------------------------

function formatFollowers(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${n}`;
}

function FollowStoreButton({ store }: { store: SfStore }) {
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const shopper = me.loaded ? me.shopper : null;
  // null while unknown — the GET /follow call resolves it (guests keep the
  // followers count seeded from the /api/sf/[slug] payload).
  const [following, setFollowing] = useState<boolean | null>(null);
  const [followers, setFollowers] = useState<number | null>(store.followers ?? null);
  const [busy, setBusy] = useState(false);

  // Refetch follow state when the signed-in shopper changes (guest → 401 is
  // expected and keeps the sf payload followers count).
  useEffect(() => {
    let alive = true;
    fetchJson<{ following: boolean; followers: number }>(`/api/stores/${encodeURIComponent(store.slug)}/follow`)
      .then((d) => {
        if (!alive) return;
        setFollowing(d.following);
        setFollowers(d.followers);
      })
      .catch(() => {
        /* guest → 401 envelope; keep the sf payload followers count */
      });
    return () => {
      alive = false;
    };
  }, [store.slug, shopper]);

  async function toggleFollow() {
    if (busy) return;
    const next = !(following ?? false);
    // optimistic update, rolled back on failure
    setFollowing(next);
    setFollowers((n) => (n == null ? n : Math.max(0, n + (next ? 1 : -1))));
    setBusy(true);
    try {
      const d = await postJson<{ following: boolean; followers: number }>(
        `/api/stores/${encodeURIComponent(store.slug)}/follow`,
        {}
      );
      setFollowing(d.following);
      setFollowers(d.followers);
      toast.success(d.following ? `Following ${store.name}` : `Unfollowed ${store.name}`, {
        description: d.following ? "You'll get a nudge when this store posts something new." : undefined,
      });
    } catch (e) {
      setFollowing(!next);
      setFollowers((n) => (n == null ? n : Math.max(0, n + (next ? -1 : 1))));
      toast.error(e instanceof Error ? e.message : "Could not update follow");
    } finally {
      setBusy(false);
    }
  }

  function onFollowClick() {
    if (!shopper) {
      // not signed in → prompt sign-in/register first, then continue the toggle
      openShopperAuth(() => void toggleFollow());
      return;
    }
    void toggleFollow();
  }

  const known = following !== null;
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onFollowClick}
        disabled={busy || !known}
        aria-pressed={!!following}
        aria-label={
          following
            ? `Unfollow ${store.name}`
            : `Follow ${store.name}${followers != null ? ` (${formatFollowers(followers)} followers)` : ""}`
        }
        className={cn(
          "inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-[var(--sf-radius)] border-2 px-2.5 text-xs font-semibold transition-all disabled:opacity-60 sm:px-3",
          following ? "text-white shadow-sm hover:opacity-90" : "bg-transparent hover:opacity-80"
        )}
        style={
          following
            ? { backgroundColor: "var(--sf-primary)", borderColor: "var(--sf-primary)" }
            : { borderColor: "var(--sf-primary)", color: "var(--sf-primary)" }
        }
      >
        {following ? <UserCheck className="h-4 w-4" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
        <span className="hidden sm:inline">{following ? "Following" : "Follow"}</span>
      </button>
      {followers != null ? (
        <span className="hidden text-[11px] leading-tight text-muted-foreground md:inline" title={`${followers} followers`}>
          {formatFollowers(followers)} followers
        </span>
      ) : null}
    </div>
  );
}

function SfHeader({ props, rctx }: { props: Record<string, unknown>; rctx: SfRenderCtx }) {
  const { store, openCart, sfSearch, onSearch } = rctx;
  const nav = rctx.nav.nav; // ShopperCtx → nav function
  const sticky = bool(props, "sticky", true);
  const showSearch = bool(props, "showSearch", true);
  const [local, setLocal] = useState(sfSearch);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
  useEffect(() => setLocal(sfSearch), [sfSearch]);

  const onChange = (v: string) => {
    setLocal(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => onSearch(v), 300);
  };

  return (
    <header
      className={cn("z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80", sticky && "sticky top-0")}
      style={{ fontFamily: "var(--sf-font-heading)" }}
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <button type="button" onClick={() => nav({ name: "storefront", slug: store.slug })} className="flex min-h-[44px] items-center gap-2" aria-label={`${store.name} home`}>
          {store.logoUrl ? (
            <img src={store.logoUrl} alt={`${store.name} logo`} className="h-8 w-8 rounded object-cover" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded text-white" style={{ backgroundColor: "var(--sf-primary)" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="text-base font-extrabold tracking-tight">{store.name}</span>
        </button>

        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Store">
          {[
            { label: "Home", go: () => nav({ name: "storefront", slug: store.slug }) },
            { label: "About", go: () => nav({ name: "store-page", slug: store.slug, pageSlug: "about" }) },
            { label: "Contact", go: () => nav({ name: "store-page", slug: store.slug, pageSlug: "contact" }) },
          ].map((l) => (
            <button
              key={l.label}
              type="button"
              onClick={l.go}
              className="rounded px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground hover:bg-muted min-h-[44px]"
            >
              {l.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <FollowStoreButton store={store} />
          {showSearch ? (
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={local}
                onChange={(e) => onChange(e.target.value)}
                placeholder="Search this store…"
                className="w-40 lg:w-56 pl-8 pr-8 min-h-[44px] rounded-[var(--sf-radius)]"
                aria-label="Search products in this store"
              />
              {local ? (
                <button type="button" onClick={() => onChange("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={openCart}
            aria-label="Open cart"
            className="relative flex h-10 min-h-[44px] w-10 items-center justify-center rounded-[var(--sf-radius)] border transition-colors hover:bg-muted"
          >
            <ShoppingBag className="h-4.5 w-4.5" style={{ color: "var(--sf-primary)" }} />
          </button>
          <button
            type="button"
            onClick={() => nav({ name: "market" })}
            className="hidden sm:inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--sf-radius)] px-3 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to NOMOFEE marketplace"
          >
            <StoreIcon className="h-3.5 w-3.5" /> Marketplace
          </button>
        </div>
      </div>
      {showSearch ? (
        <div className="border-t bg-muted/40 px-4 py-2 sm:hidden">
          <div className="relative mx-auto max-w-7xl">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={local} onChange={(e) => onChange(e.target.value)} placeholder="Search this store…" className="pl-8 min-h-[44px] rounded-[var(--sf-radius)]" aria-label="Search products in this store" />
          </div>
        </div>
      ) : null}
    </header>
  );
}

// --- 3. hero -----------------------------------------------------------------

const HERO_H: Record<string, string> = { sm: "h-56", md: "h-80 sm:h-96", lg: "h-[80vh]" };

function Hero({ props, rctx }: { props: Record<string, unknown>; rctx: SfRenderCtx }) {
  const { store } = rctx;
  const heading = str(props, "heading", store.name);
  const sub = str(props, "subheading");
  const img = str(props, "imageUrl");
  const ctaLabel = str(props, "ctaLabel");
  const ctaUrl = str(props, "ctaUrl");
  const overlay = Math.min(100, Math.max(0, num(props, "overlayOpacity", 35))) / 100;

  return (
    <section className={cn("relative flex items-center justify-center overflow-hidden bg-muted", HERO_H[str(props, "height", "md")] ?? HERO_H.md)}>
      {img ? <img src={img} alt="" className="absolute inset-0 h-full w-full object-cover" /> : null}
      <div className="absolute inset-0" style={{ backgroundColor: `rgba(0,0,0,${overlay})` }} />
      <div className="relative z-10 mx-auto max-w-3xl px-6 text-center text-white" style={{ fontFamily: "var(--sf-font-heading)" }}>
        <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="text-3xl sm:text-5xl font-extrabold leading-tight drop-shadow">
          {heading}
        </motion.h1>
        {sub ? <p className="mt-3 text-sm sm:text-lg text-white/90 drop-shadow">{sub}</p> : null}
        {ctaLabel ? (
          <div className="mt-6">
            <SfButton store={store} onClick={() => resolveSfLink(ctaUrl, store, rctx.nav)}>{ctaLabel}</SfButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// --- 4. image_banner -----------------------------------------------------------

function ImageBanner({ props, rctx }: { props: Record<string, unknown>; rctx: SfRenderCtx }) {
  const { store } = rctx;
  const img = str(props, "imageUrl");
  if (!img) return null;
  const h = num(props, "height", 220);
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <button
        type="button"
        onClick={() => resolveSfLink(str(props, "linkUrl"), store, rctx.nav)}
        className="block w-full overflow-hidden rounded-[var(--sf-radius)] border"
        aria-label="Promotion banner"
      >
        <img src={img} alt="Promotion banner" loading="lazy" className="w-full object-cover transition-transform duration-300 hover:scale-[1.02]" style={{ height: `${Math.max(80, h)}px` }} />
      </button>
    </div>
  );
}

// --- 5. product_grid -----------------------------------------------------------

function ProductGridSection({ props, rctx }: { props: Record<string, unknown>; rctx: SfRenderCtx }) {
  const { store, sfSearch } = rctx;
  const nav = rctx.nav.nav; // ShopperCtx → nav function
  const source = str(props, "source", "latest");
  const collectionSlug = str(props, "collectionSlug");
  const limit = num(props, "limit", 8);
  const showPrice = bool(props, "showPrice", true);
  const showViewAll = bool(props, "showViewAll", true);
  const columns = String(num(props, "columns", 4));
  const [products, setProducts] = useState<ProductCardT[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setProducts(null);
    const params = new URLSearchParams({ source, limit: String(expanded ? 50 : limit) });
    if (collectionSlug) params.set("collection", collectionSlug);
    if (sfSearch.trim()) params.set("search", sfSearch.trim());
    fetchJson<ProductCardT[]>(`/api/sf/${encodeURIComponent(store.slug)}/products?${params.toString()}`)
      .then((d) => alive && setProducts(Array.isArray(d) ? d : []))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [store.slug, source, collectionSlug, limit, expanded, sfSearch]);

  const title = str(props, "title");
  const colClass =
    columns === "2" ? "grid-cols-2" : columns === "3" ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";

  return (
    <section className="mx-auto max-w-7xl px-4 py-10" style={{ fontFamily: "var(--sf-font-body)" }}>
      {(title || sfSearch) && (
        <div className="flex items-center justify-between gap-3 pb-5">
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight" style={{ fontFamily: "var(--sf-font-heading)" }}>
            {sfSearch.trim() ? `Results for “${sfSearch.trim()}”` : title}
          </h2>
          {showViewAll && products && products.length > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold transition-opacity hover:opacity-75"
              style={{ color: "var(--sf-primary)" }}
            >
              {expanded ? "Show less" : "View all"} <ArrowRight className={cn("h-4 w-4 transition-transform", expanded && "rotate-90")} />
            </button>
          ) : null}
        </div>
      )}
      {failed ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Products could not be loaded right now.</p>
      ) : products == null ? (
        <div className={cn("grid gap-3 sm:gap-4", colClass)}>
          {Array.from({ length: Math.min(8, limit) }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {sfSearch.trim() ? "No products match your search in this store." : "No products here yet — check back soon."}
        </div>
      ) : (
        <div className={cn("grid gap-3 sm:gap-4", colClass)}>
          {products.map((p) => (
            <ProductCard key={p.id} p={p} showStore={false} hidePrice={!showPrice} onOpen={(pp) => openProduct(rctx.nav, pp)} />
          ))}
        </div>
      )}
    </section>
  );
}

// --- 6. collection_list ----------------------------------------------------------
// Handled inline in SectionBody: no public collections endpoint exists in this
// sandbox, so the section hides gracefully (returns null) per the surface spec.

// --- 7. rich_text ---------------------------------------------------------------

function RichText({ props }: { props: Record<string, unknown> }) {
  const heading = str(props, "heading");
  const body = str(props, "body");
  const align = str(props, "align", "center");
  if (!heading && !body) return null;
  return (
    <section className={cn("mx-auto max-w-3xl px-6 py-12", align === "center" && "text-center")}>
      {heading ? (
        <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ fontFamily: "var(--sf-font-heading)" }}>
          {heading}
        </h2>
      ) : null}
      {body ? <p className="mt-4 whitespace-pre-line text-sm sm:text-base leading-relaxed text-muted-foreground">{body}</p> : null}
    </section>
  );
}

// --- 8. image_with_text -----------------------------------------------------------

function ImageWithText({ props, rctx }: { props: Record<string, unknown>; rctx: SfRenderCtx }) {
  const { store } = rctx;
  const img = str(props, "imageUrl");
  const heading = str(props, "heading");
  const body = str(props, "body");
  const imageLeft = str(props, "imageSide", "left") !== "right";
  const ctaLabel = str(props, "ctaLabel");
  const ctaUrl = str(props, "ctaUrl");
  if (!img && !heading && !body) return null;

  const text = (
    <div className="flex flex-col justify-center gap-3 p-6 sm:p-10" style={{ fontFamily: "var(--sf-font-body)" }}>
      {heading ? (
        <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight" style={{ fontFamily: "var(--sf-font-heading)" }}>
          {heading}
        </h2>
      ) : null}
      {body ? <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{body}</p> : null}
      {ctaLabel ? (
        <div className="pt-1">
          <SfButton store={store} small onClick={() => resolveSfLink(ctaUrl, store, rctx.nav)}>
            {ctaLabel}
          </SfButton>
        </div>
      ) : null}
    </div>
  );

  const image = img ? (
    <div className="min-h-48 overflow-hidden bg-muted">
      <img src={img} alt={heading || "Store image"} loading="lazy" className="h-full w-full object-cover" />
    </div>
  ) : null;

  return (
    <section className="mx-auto max-w-7xl px-4 py-6">
      <div className="grid overflow-hidden rounded-[var(--sf-radius)] border bg-card md:grid-cols-2">
        {imageLeft ? (
          <>
            <div className="order-1">{image}</div>
            <div className="order-2">{text}</div>
          </>
        ) : (
          <>
            <div className="order-2 md:order-1">{text}</div>
            <div className="order-1 md:order-2">{image}</div>
          </>
        )}
      </div>
    </section>
  );
}

// --- 9. testimonials ---------------------------------------------------------------

function Testimonials({ props }: { props: Record<string, unknown> }) {
  const items = list<{ quote?: string; author?: string }>(props, "items").filter((i) => i.quote);
  const title = str(props, "title");
  const style = str(props, "style", "cards");
  if (items.length === 0 && !title) return null;
  const heading = title ? (
    <h2 className="pb-6 text-center text-xl sm:text-2xl font-extrabold tracking-tight" style={{ fontFamily: "var(--sf-font-heading)" }}>
      {title}
    </h2>
  ) : null;

  // cards — bordered quote grid (original)
  if (style === "cards") {
    return (
      <section className="mx-auto max-w-7xl px-4 py-10">
        {heading}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((t, i) => (
            <figure key={i} className="rounded-[var(--sf-radius)] border bg-card p-5 shadow-sm">
              <div className="pb-2 text-2xl leading-none" style={{ color: "var(--sf-accent)" }}>
                “
              </div>
              <blockquote className="text-sm leading-relaxed">{t.quote}</blockquote>
              <figcaption className="pt-3 text-xs font-semibold text-muted-foreground">— {t.author ?? "Customer"}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    );
  }

  // minimal — clean centred stacked quotes, no borders
  if (style === "minimal") {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        {heading}
        <div className="space-y-8">
          {items.map((t, i) => (
            <figure key={i} className="text-center">
              <blockquote className="text-base leading-relaxed sm:text-lg">“{t.quote}”</blockquote>
              <figcaption className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t.author ?? "Customer"}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    );
  }

  // bubbles — chat-style rounded highlights with alternating tint
  if (style === "bubbles") {
    return (
      <section className="mx-auto max-w-4xl px-4 py-10">
        {heading}
        <div className="space-y-4">
          {items.map((t, i) => (
            <figure
              key={i}
              className={
                "max-w-[85%] rounded-2xl px-5 py-4 text-sm leading-relaxed shadow-sm " +
                (i % 2 === 0 ? "bg-primary/10" : "ml-auto bg-accent/15")
              }
            >
              <blockquote>{t.quote}</blockquote>
              <figcaption className="pt-1.5 text-xs font-semibold text-muted-foreground">{t.author ?? "Customer"}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    );
  }

  // featured — first quote as a big accent panel, remaining as small cards
  const [first, ...rest] = items;
  return (
    <section className="mx-auto max-w-7xl px-4 py-10">
      {heading}
      {first ? (
        <figure
          className="mb-4 rounded-[var(--sf-radius)] p-6 text-white shadow-sm sm:p-8"
          style={{ background: "linear-gradient(135deg, var(--sf-primary), color-mix(in srgb, var(--sf-primary) 70%, black))" }}
        >
          <blockquote className="text-base leading-relaxed sm:text-xl">“{first.quote}”</blockquote>
          <figcaption className="pt-3 text-xs font-semibold uppercase tracking-wide text-white/80">— {first.author ?? "Customer"}</figcaption>
        </figure>
      ) : null}
      {rest.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rest.map((t, i) => (
            <figure key={i} className="rounded-[var(--sf-radius)] border bg-card p-4">
              <blockquote className="text-sm leading-relaxed">{t.quote}</blockquote>
              <figcaption className="pt-2.5 text-xs font-semibold text-muted-foreground">— {t.author ?? "Customer"}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// --- 10. faq -------------------------------------------------------------------------

function FaqSection({ props }: { props: Record<string, unknown> }) {
  const items = list<{ q?: string; a?: string }>(props, "items").filter((i) => i.q);
  const title = str(props, "title");
  if (items.length === 0 && !title) return null;
  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      {title ? (
        <h2 className="pb-5 text-center text-xl sm:text-2xl font-extrabold tracking-tight" style={{ fontFamily: "var(--sf-font-heading)" }}>
          {title}
        </h2>
      ) : null}
      <Accordion type="single" collapsible className="w-full">
        {items.map((f, i) => (
          <AccordionItem key={i} value={`faq-${i}`}>
            <AccordionTrigger className="text-left text-sm sm:text-base font-semibold">{f.q}</AccordionTrigger>
            <AccordionContent className="text-sm text-muted-foreground">{f.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}

// --- 11. newsletter -------------------------------------------------------------------

function NewsletterSection({ props, rctx }: { props: Record<string, unknown>; rctx: SfRenderCtx }) {
  const { store } = rctx;
  const heading = str(props, "heading");
  const subtext = str(props, "subtext");
  const buttonLabel = str(props, "buttonLabel", "Subscribe");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function subscribe() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error("Please enter a valid email address");
      return;
    }
    setBusy(true);
    try {
      await postJson(`/api/sf/${encodeURIComponent(store.slug)}/newsletter`, { email: email.trim() });
      toast.success("You're on the list!", { description: `Thanks for subscribing to ${store.name}.` });
      setEmail("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Subscription failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="px-4 py-12" style={{ backgroundColor: "color-mix(in srgb, var(--sf-primary) 8%, transparent)" }}>
      <div className="mx-auto max-w-xl text-center">
        {heading ? (
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight" style={{ fontFamily: "var(--sf-font-heading)" }}>
            {heading}
          </h2>
        ) : null}
        {subtext ? <p className="mt-2 text-sm text-muted-foreground">{subtext}</p> : null}
        <form
          className="mt-5 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            subscribe();
          }}
        >
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Email address"
            className="min-h-[44px] rounded-[var(--sf-radius)]"
          />
          <Button type="submit" disabled={busy} className="min-h-[44px] text-white hover:opacity-90" style={{ backgroundColor: "var(--sf-primary)" }}>
            {busy ? "Subscribing…" : buttonLabel}
          </Button>
        </form>
      </div>
    </section>
  );
}

// --- 12. countdown ---------------------------------------------------------------------

function CountdownSection({ props }: { props: Record<string, unknown> }) {
  const heading = str(props, "heading");
  const endsRaw = str(props, "endsAt");
  const style = str(props, "style", "banner");
  const [now, setNow] = useState(() => Date.now());

  const endsAt = useMemo(() => {
    if (!endsRaw.trim()) return null;
    const d = new Date(endsRaw);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [endsRaw]);

  useEffect(() => {
    if (!endsAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endsAt]);

  // hide gracefully when empty or already past
  if (!endsAt || endsAt.getTime() <= now) return null;

  const diff = Math.max(0, endsAt.getTime() - now);
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  const cells: [number, string][] = [
    [d, "days"],
    [h, "hrs"],
    [m, "min"],
    [s, "sec"],
  ];

  if (style === "minimal") {
    return (
      <div className="mx-auto max-w-7xl px-4 py-4 text-center text-sm font-semibold" style={{ fontFamily: "var(--sf-font-heading)" }}>
        {heading ? <span className="mr-2">{heading}</span> : null}
        <span className="tabular-nums font-extrabold" style={{ color: "var(--sf-primary)" }}>
          {d}d {h}h {m}m {s}s
        </span>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 text-center text-white" style={{ backgroundColor: "var(--sf-primary)", fontFamily: "var(--sf-font-heading)" }}>
      {heading ? <p className="pb-3 text-sm font-bold uppercase tracking-widest">{heading}</p> : null}
      <div className="flex justify-center gap-3" role="timer" aria-label="Time remaining">
        {cells.map(([v, label]) => (
          <div key={label} className="rounded-lg bg-white/15 px-3 py-2 backdrop-blur min-w-[64px]">
            <div className="text-2xl font-extrabold tabular-nums">{String(v).padStart(2, "0")}</div>
            <div className="text-[10px] uppercase tracking-wider text-white/80">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- 13. whatsapp_floating ----------------------------------------------------------------

function WhatsAppFloating({ props }: { props: Record<string, unknown> }) {
  const phone = str(props, "phone").replace(/[^\d]/g, "");
  if (!phone) return null;
  const msg = str(props, "message", "Hi! I have a question");
  return (
    <a
      href={`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`}
      target="_blank"
      rel="noreferrer"
      aria-label="Chat on WhatsApp"
      className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 transition-transform hover:scale-105 active:scale-95"
    >
      <MessageCircle className="h-7 w-7" />
    </a>
  );
}

// --- 14. footer -----------------------------------------------------------------------------

const SOCIAL_ICONS: Record<string, typeof Instagram> = {
  instagram: Instagram,
  facebook: Facebook,
  twitter: Twitter,
  x: Twitter,
  youtube: Youtube,
  tiktok: Music2,
};

function SfFooter({ props, rctx }: { props: Record<string, unknown>; rctx: SfRenderCtx }) {
  const { store } = rctx;
  const nav = rctx.nav.nav; // ShopperCtx → nav function
  const aboutText = str(props, "aboutText");
  const links = list<{ label?: string; url?: string }>(props, "links");
  const showSocial = bool(props, "showSocial", true);
  const copyright = str(props, "copyright");
  const social = store.social ?? {};

  return (
    <footer className="mt-auto border-t bg-muted/40" style={{ fontFamily: "var(--sf-font-body)" }}>
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:grid-cols-3">
        <div className="space-y-2">
          <p className="text-base font-extrabold" style={{ fontFamily: "var(--sf-font-heading)", color: "var(--sf-primary)" }}>
            {store.name}
          </p>
          {aboutText ? <p className="text-sm leading-relaxed text-muted-foreground">{aboutText}</p> : null}
        </div>
        <nav aria-label="Store footer" className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Explore</p>
          <ul className="space-y-1.5">
            {links.map((l, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => resolveSfLink(l.url ?? "", store, rctx.nav)}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground min-h-[44px]"
                >
                  {l.label ?? `Link ${i + 1}`}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {showSocial && Object.keys(social).length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Follow</p>
            <div className="flex gap-2">
              {Object.entries(social).map(([k, url]) => {
                const Icon = SOCIAL_ICONS[k.toLowerCase()] ?? null;
                if (!Icon || !url) return null;
                return (
                  <a
                    key={k}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${store.name} on ${k}`}
                    className="flex h-10 w-10 items-center justify-center rounded-full border bg-background transition-colors hover:bg-muted"
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <div className="border-t px-4 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {copyright || `© ${new Date().getFullYear()} ${store.name}`}
          </span>
          <span>
            Powered by{" "}
            <button type="button" className="font-bold text-teal-700 hover:underline" onClick={() => nav({ name: "market" })}>
              SHOPMESH
            </button>
          </span>
        </div>
      </div>
    </footer>
  );
}

// --- 15. marketplace_strip --------------------------------------------------------------------

function MarketplaceStrip({ props, rctx }: { props: Record<string, unknown>; rctx: SfRenderCtx }) {
  const { store } = rctx;
  const nav = rctx.nav.nav; // ShopperCtx → nav function
  const title = str(props, "title");
  const limit = Math.min(12, Math.max(2, num(props, "limit", 6)));
  const [items, setItems] = useState<ProductCardT[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchEnvelopeProducts(limit).then((d) => alive && setItems(d)).catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [limit]);

  if (items != null && items.length === 0) return null;

  return (
    <section className="mx-auto max-w-7xl px-4 py-10">
      <div className="flex items-center justify-between gap-3 pb-5">
        <div>
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight" style={{ fontFamily: "var(--sf-font-heading)" }}>
            {title}
          </h2>
          <p className="text-xs text-muted-foreground">Hand-picked finds from other SHOPMESH stores</p>
        </div>
        <button
          type="button"
          onClick={() => nav({ name: "market" })}
          className="hidden sm:inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold transition-opacity hover:opacity-75"
          style={{ color: "var(--sf-primary)" }}
        >
          Visit marketplace <ArrowRight className="h-4 w-4" />
        </button>
      </div>
      {items == null ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {items.filter((p) => p.storeSlug !== store.slug).slice(0, limit).map((p) => (
            <ProductCard key={p.id} p={p} onOpen={(pp) => openProduct(rctx.nav, pp)} />
          ))}
        </div>
      )}
    </section>
  );
}

async function fetchEnvelopeProducts(limit: number): Promise<ProductCardT[]> {
  const { data } = await fetchEnvelope<ProductCardT[]>(`/api/market/products?limit=${limit}&sort=popular`);
  return Array.isArray(data) ? data : [];
}

// =============================================================================================
// Storefront view (home)
// =============================================================================================

function SfLoading() {
  return (
    <div className="flex-1">
      <div className="h-9 bg-muted animate-pulse" />
      <div className="h-14 border-b animate-pulse" />
      <div className="mx-auto max-w-7xl px-4 py-6">
        <Skeleton className="h-80 rounded-2xl" />
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 pt-8 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

function SfUnavailable({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <EmptyState
        icon={StoreIcon}
        title="Store not available"
        hint="This storefront doesn't exist or isn't published yet. Explore the marketplace meanwhile!"
        action={
          <Button onClick={onBack} className="bg-teal-700 hover:bg-teal-800">
            Browse marketplace
          </Button>
        }
      />
    </div>
  );
}

export default function StorefrontView({ ctx, slug }: { ctx: ShopperCtx; slug: string }) {
  const [data, setData] = useState<SfHomePayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sfSearch, setSfSearch] = useState("");

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setData(null);
    setNotFound(false);
    setSfSearch("");
    fetchJson<SfHomePayload>(`/api/sf/${encodeURIComponent(slug)}`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setNotFound(true));
    return () => {
      alive = false;
    };
  }, [slug]);

  // SEO: store meta from real records (Phase 9)
  useEffect(() => {
    if (!data) return;
    const { store } = data;
    setMeta(
      `${store.name} — Official Store`,
      store.tagline ?? store.description ?? null,
      `/?sf=${store.slug}`
    );
    return () => {
      setMeta("SHOPMESH — Multi-vendor Marketplace");
    };
  }, [data]);

  if (notFound) return <SfUnavailable onBack={() => ctx.nav({ name: "market" })} />;
  if (!data) return <SfLoading />;

  const { store, page } = data;
  const productAnchorId = page.sections.find((s) => s.type === "product_grid")?.id ?? "products";

  return (
    <StorefrontChrome store={store} title={page.title} ctx={ctx}>
      <SectionRenderer sections={page.sections} rctx={{ store, nav: ctx, openCart: ctx.openCart, sfSearch, onSearch: setSfSearch, productAnchorId }} />
    </StorefrontChrome>
  );
}

// =============================================================================================
// Store page view (about / contact / policies)
// =============================================================================================

export function StorePageView({ ctx, slug, pageSlug }: { ctx: ShopperCtx; slug: string; pageSlug: string }) {
  const [data, setData] = useState<SfPagePayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sfSearch, setSfSearch] = useState("");

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setData(null);
    setNotFound(false);
    fetchJson<SfPagePayload>(`/api/sf/${encodeURIComponent(slug)}/pages/${encodeURIComponent(pageSlug)}`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setNotFound(true));
    return () => {
      alive = false;
    };
  }, [slug, pageSlug]);

  if (notFound) {
    return (
      <SfUnavailable
        onBack={() => {
          // prefer returning to the storefront if the slug looks valid
          ctx.nav({ name: "storefront", slug });
        }}
      />
    );
  }
  if (!data) return <SfLoading />;

  const { store, page, sections } = data;
  const productAnchorId = sections.find((s) => s.type === "product_grid")?.id ?? "products";

  return (
    <StorefrontChrome store={store} title={page.title} ctx={ctx}>
      <SectionRenderer sections={sections} rctx={{ store, nav: ctx, openCart: ctx.openCart, sfSearch, onSearch: setSfSearch, productAnchorId }} />
    </StorefrontChrome>
  );
}

// =============================================================================================
// Shared chrome: theme variables + breadcrumb strip
// =============================================================================================

function StorefrontChrome({
  store,
  title,
  ctx,
  children,
}: {
  store: SfStore;
  title: string;
  ctx: ShopperCtx;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex-1 flex flex-col"
      style={{ ...themeVars(store.theme), colorScheme: "light" }}
      data-storefront={store.slug}
      aria-label={`${store.name} storefront`}
    >
      {/* subtle "inside a storefront" strip with quick way out */}
      <div className="bg-teal-950 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 py-1.5 text-[11px]">
          <span className="inline-flex items-center gap-1.5 font-semibold tracking-wide">
            SHOPMESH MARKETPLACE
            <ChevronRight className="h-3 w-3 opacity-60" />
            <span className="opacity-80">{title}</span>
          </span>
          <button type="button" onClick={() => ctx.nav({ name: "market" })} className="inline-flex min-h-[32px] items-center gap-1 font-semibold underline-offset-2 hover:underline">
            <StoreIcon className="h-3 w-3" /> All stores
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

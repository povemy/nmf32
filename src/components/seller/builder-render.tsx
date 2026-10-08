"use client";
// Task 2-d — builder-render: canvas previews for ALL 15 section types using the
// SAME prop contract as the storefront renderer (src/lib/sections.ts registry).
// Purely presentational: product grids show skeleton cards, not live data.
import type { Section, ThemeTokens } from "@/lib/sections";
import { cn } from "@/lib/utils";

type Props = { section: Section; theme: ThemeTokens; storeName: string };

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}
function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function px(radius: ThemeTokens["radius"]): string {
  switch (radius) {
    case "none": return "0px";
    case "sm": return "4px";
    case "md": return "10px";
    case "full": return "9999px";
    default: return "16px";
  }
}

function Cta({ label, theme, href = "#" }: { label: string; theme: ThemeTokens; href?: string }) {
  const isOutline = theme.buttonStyle === "outline";
  const isPill = theme.buttonStyle === "pill";
  return (
    <a
      href={href}
      onClick={(e) => e.preventDefault()}
      className={cn("inline-block px-5 py-2.5 text-sm font-semibold", isPill && "rounded-full")}
      style={{
        borderRadius: isPill ? undefined : px(theme.radius),
        backgroundColor: isOutline ? "transparent" : theme.primaryColor,
        color: isOutline ? theme.primaryColor : "#fff",
        border: isOutline ? `2px solid ${theme.primaryColor}` : "none",
      }}
    >
      {label}
    </a>
  );
}

function SkeletonCard({ radius }: { radius: ThemeTokens["radius"] }) {
  return (
    <div className="overflow-hidden border" style={{ borderRadius: px(radius) }}>
      <div className="aspect-square w-full bg-muted" />
      <div className="space-y-1.5 p-2.5">
        <div className="h-2.5 w-3/4 rounded bg-muted" />
        <div className="h-2.5 w-1/3 rounded bg-muted" />
      </div>
    </div>
  );
}

export function SectionPreview({ section, theme, storeName }: Props) {
  const p = section.props ?? {};
  const r = px(theme.radius);

  switch (section.type) {
    case "announcement_bar":
      return (
        <div className="px-4 py-2 text-center text-xs font-medium sm:text-sm" style={{ backgroundColor: str(p.bgColor, theme.primaryColor), color: str(p.textColor, "#ffffff") }}>
          {str(p.text, "Announcement")}
        </div>
      );

    case "header":
      return (
        <header className="flex items-center gap-3 border-b bg-white px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: theme.primaryColor }}>
            {storeName.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate text-sm font-bold">{storeName}</span>
          <nav className="ml-4 hidden gap-4 text-xs text-neutral-500 sm:flex">
            <span>Home</span><span>About</span><span>Contact</span>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {p.showSearch !== false ? (
              <span className="hidden rounded-full border px-3 py-1 text-xs text-neutral-400 sm:block">Search…</span>
            ) : null}
            <span className="relative">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6h15l-1.5 9h-12z" /><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /><path d="M6 6 5 3H2" /></svg>
            </span>
          </div>
        </header>
      );

    case "hero": {
      const h = str(p.height, "md");
      const height = h === "lg" ? 420 : h === "sm" ? 200 : 300;
      const overlay = Math.min(90, Math.max(0, num(p.overlayOpacity, 35))) / 100;
      return (
        <div className="relative flex flex-col items-center justify-center overflow-hidden text-center" style={{ height }}>
          <img src={str(p.imageUrl)} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-black" style={{ opacity: overlay }} />
          <div className="relative z-10 max-w-lg space-y-3 p-4 text-white">
            <h2 className="text-2xl font-bold sm:text-3xl">{str(p.heading, storeName)}</h2>
            <p className="text-sm text-white/85">{str(p.subheading)}</p>
            {p.ctaLabel ? <Cta label={str(p.ctaLabel, "Shop now")} theme={theme} href={str(p.ctaUrl)} /> : null}
          </div>
        </div>
      );
    }

    case "image_banner":
      return (
        <a href={str(p.linkUrl)} onClick={(e) => e.preventDefault()} className="block overflow-hidden">
          <img
            src={str(p.imageUrl)}
            alt="Promo banner"
            className="w-full object-cover"
            style={{ height: num(p.height, 220), borderRadius: 0 }}
          />
        </a>
      );

    case "product_grid": {
      const cols = Math.min(4, Math.max(2, num(p.columns, 4)));
      const limit = Math.min(12, Math.max(2, num(p.limit, 8)));
      return (
        <section className="space-y-4 bg-white px-4 py-8">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold">{str(p.title, "Products")}</h3>
            {p.showViewAll !== false ? (
              <span className="text-xs font-medium" style={{ color: theme.primaryColor }}>View all →</span>
            ) : null}
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: Math.min(limit, cols * 2) }).map((_, i) => (
              <SkeletonCard key={i} radius={theme.radius} />
            ))}
          </div>
          <p className="text-center text-xs text-neutral-400">
            {limit} products · source: {str(p.source, "latest")}{p.source === "collection" && p.collectionSlug ? ` (${str(p.collectionSlug)})` : ""}
            {p.showPrice === false ? " · prices hidden" : ""}
          </p>
        </section>
      );
    }

    case "collection_list": {
      const limit = Math.min(6, Math.max(2, num(p.limit, 4)));
      return (
        <section className="space-y-4 bg-white px-4 py-8">
          <h3 className="text-lg font-bold">{str(p.title, "Collections")}</h3>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(4, limit)}, minmax(0,1fr))` }}>
            {Array.from({ length: limit }).map((_, i) => (
              <div key={i} className="overflow-hidden border" style={{ borderRadius: r }}>
                <div className="aspect-[4/3] bg-muted" />
                <p className="p-2 text-xs font-medium">Collection {i + 1}</p>
              </div>
            ))}
          </div>
        </section>
      );
    }

    case "rich_text":
      return (
        <section className={cn("space-y-2.5 bg-white px-6 py-10", str(p.align, "center") === "center" ? "text-center" : "text-left")}>
          <h3 className="text-xl font-bold">{str(p.heading, "Heading")}</h3>
          <p className="mx-auto max-w-xl whitespace-pre-line text-sm leading-relaxed text-neutral-600">{str(p.body)}</p>
        </section>
      );

    case "image_with_text": {
      const side = str(p.imageSide, "left");
      const img = (
        <img src={str(p.imageUrl)} alt="" className="h-48 w-full object-cover sm:h-56" style={{ borderRadius: r }} />
      );
      const text = (
        <div className="space-y-2.5">
          <h3 className="text-lg font-bold">{str(p.heading)}</h3>
          <p className="text-sm leading-relaxed text-neutral-600">{str(p.body)}</p>
          {p.ctaLabel ? <Cta label={str(p.ctaLabel, "Learn more")} theme={theme} href={str(p.ctaUrl)} /> : null}
        </div>
      );
      return (
        <section className="grid items-center gap-5 bg-white px-4 py-8 sm:grid-cols-2">
          {side === "left" ? <>{img}{text}</> : <>{text}{img}</>}
        </section>
      );
    }

    case "testimonials": {
      const items = list<{ quote?: string; author?: string }>(p.items);
      return (
        <section className="space-y-4 bg-white px-4 py-8">
          <h3 className="text-center text-lg font-bold">{str(p.title, "Testimonials")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {items.length === 0 ? (
              <p className="col-span-2 text-center text-xs text-neutral-400">No testimonial items (edit the JSON list)</p>
            ) : (
              items.slice(0, 6).map((t, i) => (
                <blockquote key={i} className="border p-4 text-sm" style={{ borderRadius: r }}>
                  <p className="leading-relaxed">“{str(t.quote)}”</p>
                  <footer className="mt-2 text-xs text-neutral-500">— {str(t.author, "Customer")}</footer>
                </blockquote>
              ))
            )}
          </div>
        </section>
      );
    }

    case "faq": {
      const items = list<{ q?: string; a?: string }>(p.items);
      return (
        <section className="mx-auto max-w-xl space-y-4 bg-white px-4 py-8">
          <h3 className="text-center text-lg font-bold">{str(p.title, "FAQ")}</h3>
          <div className="divide-y rounded-lg border" style={{ borderRadius: r }}>
            {items.length === 0 ? (
              <p className="p-4 text-center text-xs text-neutral-400">No FAQ items (edit the JSON list)</p>
            ) : (
              items.slice(0, 8).map((f, i) => (
                <details key={i} className="group px-4 py-3">
                  <summary className="cursor-pointer list-none text-sm font-medium">
                    {str(f.q)} <span className="float-right text-neutral-400 group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-1.5 text-sm text-neutral-600">{str(f.a)}</p>
                </details>
              ))
            )}
          </div>
        </section>
      );
    }

    case "newsletter":
      return (
        <section className="mx-auto max-w-lg space-y-3 bg-white px-4 py-10 text-center">
          <h3 className="text-lg font-bold">{str(p.heading, "Join the list")}</h3>
          <p className="text-sm text-neutral-600">{str(p.subtext)}</p>
          <div className="flex gap-2">
            <span className="h-11 flex-1 rounded-lg border bg-muted/40 px-3 text-left text-sm leading-[2.7] text-neutral-400">you@email.com</span>
            <Cta label={str(p.buttonLabel, "Subscribe")} theme={theme} />
          </div>
        </section>
      );

    case "countdown": {
      const style = str(p.style, "banner");
      const boxes = ["12", "04", "38", "07"];
      return (
        <section
          className="px-4 py-6 text-center"
          style={{ backgroundColor: style === "banner" ? theme.primaryColor : "#ffffff", color: style === "banner" ? "#fff" : undefined }}
        >
          <h3 className={cn("text-base font-bold", style === "minimal" && "text-neutral-800")}>{str(p.heading, "Sale ends in")}</h3>
          <div className="mt-3 flex justify-center gap-2">
            {boxes.map((b, i) => (
              <span
                key={i}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-sm font-bold tabular-nums"
                style={{
                  backgroundColor: style === "banner" ? "rgba(255,255,255,.18)" : theme.primaryColor + "14",
                  color: style === "banner" ? "#fff" : theme.primaryColor,
                }}
              >
                {b}
              </span>
            ))}
          </div>
          <p className={cn("mt-2 text-[10px] uppercase tracking-widest", style === "banner" ? "text-white/70" : "text-neutral-400")}>
            days · hours · mins · secs{p.endsAt ? ` · ends ${str(p.endsAt)}` : ""}
          </p>
        </section>
      );
    }

    case "whatsapp_floating":
      return (
        <div className="flex items-center justify-end bg-neutral-50 px-4 py-6">
          <div className="flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-white shadow" style={{ backgroundColor: "#25d366" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5 14.2c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.6-2.6-1.1-4.3-3.8-4.4-4-.1-.2-1-1.4-1-2.6 0-1.2.6-1.8.9-2 .2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.4l.8 2c.1.2.1.4 0 .6l-.4.6c-.1.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.6-.1l.8-.9c.2-.3.4-.2.7-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.4Z"/></svg>
            WhatsApp
          </div>
        </div>
      );

    case "footer": {
      const links = list<{ label?: string; url?: string }>(p.links);
      return (
        <footer className="space-y-4 bg-neutral-900 px-4 py-8 text-neutral-300">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-sm font-bold text-white">{storeName}</p>
              <p className="text-xs leading-relaxed text-neutral-400">{str(p.aboutText)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Links</p>
              <ul className="mt-2 space-y-1.5 text-xs">
                {links.slice(0, 6).map((l, i) => (
                  <li key={i}><a href={str(l.url)} onClick={(e) => e.preventDefault()} className="hover:text-white">{str(l.label, "Link")}</a></li>
                ))}
              </ul>
            </div>
          </div>
          {p.showSocial !== false ? (
            <div className="flex gap-2">
              {["IG", "FB", "TT", "X"].map((s) => (
                <span key={s} className="flex h-7 w-7 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-300">
                  {s}
                </span>
              ))}
            </div>
          ) : null}
          <p className="border-t border-neutral-800 pt-3 text-[10px] text-neutral-500">{str(p.copyright, "© 2025")}</p>
        </footer>
      );
    }

    case "marketplace_strip": {
      const limit = Math.min(8, Math.max(2, num(p.limit, 6)));
      return (
        <section className="space-y-3 bg-white px-4 py-8">
          <h3 className="text-lg font-bold">{str(p.title, "More from the marketplace")}</h3>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {Array.from({ length: limit }).map((_, i) => (
              <div key={i} className="w-28 shrink-0 overflow-hidden border" style={{ borderRadius: r }}>
                <div className="aspect-square w-full bg-muted" />
                <div className="space-y-1 p-2">
                  <div className="h-2 w-3/4 rounded bg-muted" />
                  <div className="h-2 w-1/2 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
          <p className="text-center text-xs text-neutral-400">Cross-sell from other SHOPMESH stores — great for discovery</p>
        </section>
      );
    }

    default:
      return (
        <div className="rounded-xl border border-dashed bg-muted/40 p-6 text-center">
          <p className="text-sm font-medium">Unknown section “{section.type}”</p>
          <p className="text-xs text-muted-foreground">This type isn&apos;t in the registry — it will be skipped on the storefront.</p>
        </div>
      );
  }
}

"use client";
// ============================================================================
// Shopper — MARKET HOME (work order 14: data-driven section renderer) +
// SEARCH/CATEGORY/DEALS RESULTS (Task 2-e).
//
// The homepage renders sections in the ADMIN-CONTROLLED order (Setting
// home.section_order via /api/market/home sectionOrder); omitting a section
// hides it; "inline" entries consume the next live inline campaign. Every
// section auto-hides when it has no data — a dataless homepage still shows
// the hero (default branded slide) and quick access.
// ============================================================================
import { useEffect, useState } from "react";
import {
  ShoppingBag,
  Sparkles,
  Store,
  Flame,
  Headphones,
  Shirt,
  Lamp,
  Coffee,
  Dumbbell,
  PawPrint,
  Gamepad2,
  Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setMeta } from "@/lib/seo";
import {
  fetchJson,
  fetchEnvelope,
  openProduct,
  EmptyState,
  ProductCard,
  ProductGridSkeleton,
  type CategoryT,
  type ProductCardT,
  type ShopperCtx,
  type StoreCardT,
} from "./ui-bits";
import { fetchMarketHome } from "./market-home-client";
import type { HomePayload } from "./home/types";
import type { HomeSectionId } from "@/lib/home-layout";
import { HomeHero } from "./home/hero";
import { HomeQuickAccess } from "./home/quick-access";
import { HomeShowcase } from "./home/showcase";
import { HomeFlashDeals } from "./home/flash-deals";
import { HomeCategoryGrid } from "./home/category-grid";
import { HomeInline } from "./home/inline";
import { SectionShell } from "./home/section-shell";
import { HomeProductRail } from "./home/product-rail";

// ---------------------------------------------------------------------------
// Market home
// ---------------------------------------------------------------------------

const CATEGORY_ICONS: [RegExp, typeof Package][] = [
  [/electr|gadget/i, Headphones],
  [/fashion|cloth/i, Shirt],
  [/home|living|decor/i, Lamp],
  [/beauty|care|skin/i, Sparkles],
  [/sport|outdoor|camp/i, Dumbbell],
  [/food|beverage|coffee|snack/i, Coffee],
  [/pet/i, PawPrint],
  [/toy|game/i, Gamepad2],
];

export function categoryIcon(name: string): typeof Package {
  for (const [re, Icon] of CATEGORY_ICONS) if (re.test(name)) return Icon;
  return Package;
}

export default function MarketHome({ ctx }: { ctx: ShopperCtx }) {
  const [home, setHome] = useState<HomePayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMarketHome()
      .then((d) => alive && setHome(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <EmptyState
        title="Marketplace is warming up"
        hint="We couldn't reach the marketplace service. Please try again in a moment."
        action={
          <Button onClick={() => window.location.reload()} className="bg-brand-gradient-deep hover:brightness-110">
            Retry
          </Button>
        }
      />
    );
  }

  const order: HomeSectionId[] = home?.sectionOrder ?? ["hero"];

  // Hero + quick access carry their own containers; content sections share
  // one page-width container with consistent vertical rhythm.
  const WRAPPED = new Set<HomeSectionId>([
    "showcase",
    "flash_deals",
    "categories",
    "trending",
    "featured",
    "stores",
    "new_arrivals",
    "inline",
  ]);

  // Inline slots are assigned PURELY from position: the Nth "inline" entry in
  // the order consumes the Nth live inline campaign (priority order). No
  // render-phase mutation (react-hooks/immutability).
  const renderSection = (id: HomeSectionId, index: number): React.ReactNode => {
    switch (id) {
      case "hero":
        return <HomeHero slides={home?.hero ?? []} secondary={home?.heroSecondary ?? []} ctx={ctx} />;
      case "quick_access":
        return <HomeQuickAccess ctx={ctx} promoTiles={home?.promoTiles ?? []} />;
      case "showcase":
        return home && home.showcase.length > 0 ? <HomeShowcase cards={home.showcase} ctx={ctx} /> : null;
      case "flash_deals":
        return home && home.flashDeals.products.length > 0 ? (
          <HomeFlashDeals products={home.flashDeals.products} campaign={home.flashDeals.campaign} ctx={ctx} />
        ) : null;
      case "categories":
        return home ? <HomeCategoryGrid categories={home.categories} ctx={ctx} /> : <SectionSkeleton />;
      case "trending":
        return home && home.trending.length > 0 ? (
          <HomeSectionRail
            id="home-trending"
            title="Trending now"
            subtitle="What shoppers are actually buying — ranked by real sales"
            icon={<Flame className="h-5 w-5 text-rose-500" />}
            products={home.trending}
            ctx={ctx}
            viewAll={{ label: "View popular", onClick: () => ctx.nav({ name: "search", q: "", sort: "popular" }) }}
          />
        ) : null;
      case "featured":
        return home ? (
          <HomeSectionGrid
            title="Featured picks"
            subtitle="Hand-selected by the NOMOFEE team"
            icon={<Sparkles className="h-5 w-5 text-amber-500" />}
            products={home.featured}
            ctx={ctx}
          />
        ) : (
          <SectionSkeleton />
        );
      case "stores":
        return home ? <HomeStores stores={home.featuredStores} ctx={ctx} /> : <SectionSkeleton />;
      case "new_arrivals":
        return home ? (
          <HomeSectionGrid
            title="New arrivals"
            subtitle="Fresh from our sellers"
            icon={<ShoppingBag className="h-5 w-5 text-emerald-600" />}
            products={home.latest}
            ctx={ctx}
          />
        ) : (
          <SectionSkeleton />
        );
      case "inline": {
        // Nth inline slot → Nth live inline campaign (pure positional mapping).
        const slotIdx = order.slice(0, index).filter((x) => x === "inline").length;
        const mod = home?.inline[slotIdx] ?? null;
        return mod ? <HomeInline mod={mod} ctx={ctx} /> : null;
      }
      default:
        return null;
    }
  };

  return (
    <div className="flex-1">
      {order.map((id, i) => {
        const content = renderSection(id, i);
        if (content == null) return null;
        if (WRAPPED.has(id)) {
          return (
            <div key={`${id}-${i}`} className="mx-auto w-full max-w-7xl px-4 py-6">
              {content}
            </div>
          );
        }
        return (
          <div key={`${id}-${i}`} className={id === "quick_access" ? "pt-6" : undefined}>
            {content}
          </div>
        );
      })}
      <div className="pb-8" aria-hidden="true" />
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="h-5 w-40 rounded bg-muted animate-pulse" />
      <ProductGridSkeleton />
    </div>
  );
}

function HomeSectionGrid({
  title,
  subtitle,
  icon,
  products,
  ctx,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  products: ProductCardT[];
  ctx: ShopperCtx;
}) {
  return (
    <SectionShell title={title} subtitle={subtitle} icon={icon}>
      {products.length === 0 ? (
        <EmptyState title="Nothing here yet" hint="Check back soon — the marketplace grows every day." />
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {products.map((p) => (
            <ProductCard key={p.id} p={p} onOpen={(pp) => openProduct(ctx, pp)} />
          ))}
        </div>
      )}
    </SectionShell>
  );
}

function HomeSectionRail({
  id,
  title,
  subtitle,
  icon,
  products,
  ctx,
  viewAll,
}: {
  id?: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  products: ProductCardT[];
  ctx: ShopperCtx;
  viewAll: { label: string; onClick: () => void };
}) {
  return (
    <SectionShell id={id} title={title} subtitle={subtitle} icon={icon} viewAll={viewAll}>
      <HomeProductRail products={products} ctx={ctx} ariaLabel={title} />
    </SectionShell>
  );
}

function HomeStores({ stores, ctx }: { stores: StoreCardT[]; ctx: ShopperCtx }) {
  return (
    <SectionShell
      id="home-stores"
      title="Featured stores"
      subtitle="Shops our team hand-picked"
      icon={<Store className="h-5 w-5 text-teal-700" />}
    >
      {stores.length === 0 ? (
        <EmptyState title="No featured stores yet" hint="Check back soon — shops are being curated." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {chunkEvery(stores, 3).map((group, gi) => (
            <div key={gi} className="overflow-hidden rounded-xl border bg-card shadow-soft">
              <ul className="divide-y">
                {group.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => ctx.nav({ name: "storefront", slug: s.slug })}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60"
                      aria-label={`Visit ${s.name}`}
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                        {s.logoUrl ? (
                          <img src={s.logoUrl} alt={`${s.name} logo`} loading="lazy" className="h-full w-full object-cover" />
                        ) : (
                          <Store className="h-4 w-4 text-teal-700" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{s.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {s.productCount} product{s.productCount === 1 ? "" : "s"}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

// split a list into fixed-size groups (featured stores: 3 per card)
function chunkEvery<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Search / category / deals results
// ---------------------------------------------------------------------------

const SORTS = [
  // C2.2: "Best match" = server-side relevance ranking (tokenized score from
  // the shared search engine). Offered ONLY in search mode (meaningless for
  // plain category browsing) and the DEFAULT sort for a submitted search.
  { value: "relevance", label: "Best match" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "popular", label: "Popular" },
] as const;

type SortValue = (typeof SORTS)[number]["value"];

const PAGE_SIZE = 20;

export function ResultsView({
  ctx,
  mode,
}: {
  ctx: ShopperCtx;
  mode:
    | { kind: "search"; q: string; sort?: SortValue; deals?: boolean }
    | { kind: "category"; categorySlug: string; label?: string };
}) {
  // C2.2: a submitted search defaults to Best match (relevance); category
  // browsing keeps Newest. A sort provided by the view (quick-access
  // shortcuts: popular / new arrivals) seeds the initial ordering.
  const [sort, setSort] = useState<SortValue>(mode.kind === "search" ? (mode.sort ?? "relevance") : "newest");
  const [page, setPage] = useState(1);
  // completed-fetch state — loading is DERIVED (no sync setState in effects)
  const [done, setDone] = useState<{ key: string; items: ProductCardT[]; total: number }>({ key: "", items: [], total: 0 });
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  const search = mode.kind === "search" ? mode.q : "";
  const deals = mode.kind === "search" ? Boolean(mode.deals) : false;
  const category = mode.kind === "category" ? mode.categorySlug : "";
  const queryKey = `${search}|${category}|${sort}|${deals ? 1 : 0}`;
  const reqKey = `${queryKey}#${page}`;
  const loadingFirst = done.key === "" || done.key.split("#")[0] !== queryKey;
  const fetchingMore = !loadingFirst && done.key !== reqKey;

  // Phase 2.4 SEO: search/category results are client-rendered query state —
  // the URL stays "/", so one URL would serve endless content variants. Mark
  // them noindex for JS-executing crawlers (server-side, robots.ts disallows
  // /api/ and the sitemap lists only canonical storefront/product URLs) and
  // reset the default market meta on unmount.
  useEffect(() => {
    setMeta(mode.kind === "search" ? (deals ? "NOMOFEE — all deals" : "NOMOFEE — search results") : "NOMOFEE — category", null, undefined, true);
    return () => setMeta("NOMOFEE — Multi-vendor Marketplace");
  }, [mode.kind, search, category, deals]);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ sort, page: String(page), size: String(PAGE_SIZE), _r: String(retry) });
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    if (deals) params.set("onSale", "1");
    fetchEnvelope<ProductCardT[]>(`/api/market/products?${params.toString()}`)
      .then(({ data, meta }) => {
        if (!alive) return;
        const rows = Array.isArray(data) ? data : [];
        const total = meta?.total ?? rows.length;
        setDone((prev) =>
          page === 1
            ? { key: `${queryKey}#1`, items: rows, total }
            : { key: `${queryKey}#${page}`, items: [...prev.items, ...rows], total: total || prev.total }
        );
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [search, category, sort, page, retry, queryKey, deals]);

  if (failed) {
    return (
      <EmptyState
        title="Something went wrong"
        hint="We couldn't load these products. Please try again."
        action={
          <Button
            variant="outline"
            onClick={() => {
              setFailed(false);
              setRetry((r) => r + 1);
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  const title =
    mode.kind === "category"
      ? mode.label ?? "Category"
      : deals
        ? "All deals"
        : search
          ? `Results for “${search}”`
          : "All products";
  const items = done.items;
  const grandTotal = done.total;
  const hasMore = !loadingFirst && items.length < grandTotal;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 flex-1">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          <p className="text-xs text-muted-foreground">
            {loadingFirst ? "Loading…" : `${grandTotal} product${grandTotal === 1 ? "" : "s"} found`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(v) => {
            // C2.2: a new ordering must restart pagination — otherwise page N of
            // the new sort gets APPENDED to the old sort's items.
            setSort(v as SortValue);
            setPage(1);
          }}>
            <SelectTrigger className="w-[190px] min-h-[44px]" aria-label="Sort products">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {SORTS.filter((s) => s.value !== "relevance" || mode.kind === "search").map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loadingFirst ? (
        <ProductGridSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          title="No products found"
          hint={
            mode.kind === "search"
              ? deals
                ? "No products are on sale right now — check the homepage for current campaigns."
                : `Try a different keyword — or browse the categories from the menu.`
              : "This category has no active listings yet. Check back soon!"
          }
          action={
            <Button onClick={() => ctx.nav({ name: "market" })} className="bg-brand-gradient-deep hover:brightness-110">
              Back to market
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {items.map((p) => (
              <ProductCard key={p.id} p={p} onOpen={(pp) => openProduct(ctx, pp)} />
            ))}
          </div>
          {hasMore ? (
            <div className="flex justify-center pt-8">
              <Button
                variant="outline"
                size="lg"
                disabled={fetchingMore}
                onClick={() => setPage((p) => p + 1)}
                className="min-h-[44px] min-w-[180px] border-teal-700/40 text-teal-800 hover:bg-teal-50"
              >
                {fetchingMore ? "Loading…" : `Load more (${grandTotal - items.length} left)`}
              </Button>
            </div>
          ) : (
            items.length > PAGE_SIZE / 2 ? (
              <p className="pt-8 text-center text-xs text-muted-foreground">You’ve reached the end — {grandTotal} products shown.</p>
            ) : null
          )}
        </>
      )}
    </div>
  );
}

"use client";
// ============================================================================
// Shopper — MARKET HOME + SEARCH/CATEGORY RESULTS (Task 2-e).
// ============================================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ShoppingBag,
  ChevronRight,
  ChevronLeft,
  Store,
  Sparkles,
  Lamp,
  Headphones,
  Shirt,
  Coffee,
  Dumbbell,
  PawPrint,
  Gamepad2,
  Package,
  SlidersHorizontal,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
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

// ---------------------------------------------------------------------------
// Market home
// ---------------------------------------------------------------------------

type HomePayload = {
  banners: { id: string; title: string; imageUrl: string; linkUrl: string | null }[];
  categories: CategoryT[];
  featured: ProductCardT[];
  latest: ProductCardT[];
  topStores: StoreCardT[];
};

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
    fetchJson<HomePayload>("/api/market/home")
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

  return (
    <div className="flex-1">
      {home ? (
        <HeroCarousel banners={home.banners} ctx={ctx} />
      ) : (
        <div className="mx-auto max-w-7xl px-4 pt-4">
        <div className="h-40 sm:h-56 rounded-2xl bg-brand-gradient opacity-80 animate-pulse" />
        </div>
      )}

      <div className="mx-auto max-w-7xl px-4 pb-14 space-y-10">
        {/* category chips */}
        <section aria-label="Categories">
          <div className="flex gap-2.5 overflow-x-auto pb-2 sm:grid sm:grid-cols-4 lg:grid-cols-8 sm:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {(home?.categories ?? Array.from({ length: 8 })).map((c, i) => {
              if (!home || !c) return <CategoryChipSkeleton key={i} />;
              const cat = c as CategoryT;
              const Icon = categoryIcon(cat.name);
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => ctx.nav({ name: "category", categorySlug: cat.slug, label: cat.name })}
                  className="group flex min-w-[84px] flex-col items-center gap-2 rounded-xl border bg-card shadow-soft p-3 hover:border-teal-600/50 hover:shadow-md transition-all min-h-[44px]"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-teal-700 group-hover:bg-brand-gradient group-hover:text-white transition-all">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="text-[11px] font-medium leading-tight text-center line-clamp-2">{cat.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* featured */}
        <SectionBlock
          title="Featured picks"
          subtitle="Hand-selected by the SHOPMESH team"
          icon={<Sparkles className="h-5 w-5 text-amber-500" />}
        >
          {home ? (
            <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {home.featured.map((p) => (
                <ProductCard key={p.id} p={p} onOpen={(pp) => openProduct(ctx, pp)} />
              ))}
            </div>
          ) : (
            <ProductGridSkeleton />
          )}
        </SectionBlock>

        {/* top stores */}
        <SectionBlock title="Top stores" subtitle="Independent shops you'll love" icon={<Store className="h-5 w-5 text-teal-700" />}>
          {home ? (
            <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {home.topStores.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => ctx.nav({ name: "storefront", slug: s.slug })}
                  className="group overflow-hidden rounded-xl border bg-card shadow-soft text-left hover:shadow-md hover:border-teal-600/40 hover:-translate-y-0.5 transition-all"
                  aria-label={`Visit ${s.name}`}
                >
                  <div className="relative h-20 bg-brand-gradient overflow-hidden">
                    {s.bannerUrl ? (
                      <img src={s.bannerUrl} alt="" loading="lazy" className="h-full w-full object-cover opacity-80" />
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3 p-4 -mt-6">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm overflow-hidden">
                      {s.logoUrl ? (
                        <img src={s.logoUrl} alt={`${s.name} logo`} loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <Store className="h-5 w-5 text-teal-700" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{s.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.tagline ?? "Curated goods"}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-semibold text-teal-700">{s.productCount}</p>
                      <p className="text-[10px] text-muted-foreground">products</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-[120px] rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          )}
        </SectionBlock>

        {/* new arrivals */}
        <SectionBlock title="New arrivals" subtitle="Fresh from our sellers" icon={<ShoppingBag className="h-5 w-5 text-emerald-600" />}>
          {home ? (
            <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {home.latest.map((p) => (
                <ProductCard key={p.id} p={p} onOpen={(pp) => openProduct(ctx, pp)} />
              ))}
            </div>
          ) : (
            <ProductGridSkeleton />
          )}
        </SectionBlock>
      </div>
    </div>
  );
}

function SectionBlock({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="space-y-4"
    >
      <div className="flex items-center gap-2.5">
        {icon}
        <div>
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </motion.section>
  );
}

function CategoryChipSkeleton() {
  return (
    <div className="flex min-w-[84px] flex-col items-center gap-2 rounded-xl border bg-card p-3">
      <span className="h-10 w-10 rounded-full bg-muted animate-pulse" />
      <span className="h-3 w-12 rounded bg-muted animate-pulse" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero banner carousel (auto-advance 5s)
// ---------------------------------------------------------------------------

function HeroCarousel({
  banners,
  ctx,
}: {
  banners: HomePayload["banners"];
  ctx: ShopperCtx;
}) {
  const [idx, setIdx] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const n = banners.length;

  const go = useCallback(
    (next: number) => {
      if (n === 0) return;
      setIdx(((next % n) + n) % n);
    },
    [n]
  );

  useEffect(() => {
    if (n <= 1) return;
    timer.current = setInterval(() => setIdx((i) => (i + 1) % n), 5000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [n]);

  if (n === 0) return null;

  // Banner linkUrls are advisory in this sandbox — any banner taps into browse-all.
  const openBanner = () => ctx.nav({ name: "search", q: "" });

  return (
    <div className="mx-auto max-w-7xl px-4 pt-4">
      <div className="relative overflow-hidden rounded-2xl border bg-muted" aria-roledescription="carousel">
        <div className="relative h-40 sm:h-56 lg:h-64" aria-live="polite">
          {banners.map((b, i) => (
            <button
              key={b.id}
              type="button"
              onClick={() => openBanner()}
              aria-hidden={i !== idx}
              tabIndex={i === idx ? 0 : -1}
              className={cn(
                "absolute inset-0 w-full text-left transition-opacity duration-700",
                i === idx ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
              )}
            >
              <img src={b.imageUrl} alt={b.title} className="h-full w-full object-cover" />
              <span className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent" />
              <span className="absolute inset-0 flex flex-col justify-center gap-1.5 p-5 sm:p-8 max-w-lg">
                <span className="text-[11px] font-bold uppercase tracking-widest text-amber-300">SHOPMESH picks</span>
                <span className="text-lg sm:text-2xl font-extrabold text-white leading-snug drop-shadow">{b.title}</span>
                <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-white/95 px-3 py-1.5 text-xs font-semibold text-teal-800 shadow-sm">
                  Shop now <ChevronRight className="h-3.5 w-3.5" />
                </span>
              </span>
            </button>
          ))}
        </div>

        {n > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(idx - 1)}
              aria-label="Previous banner"
              className="absolute left-2 top-1/2 -translate-y-1/2 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-background/80 shadow hover:bg-background transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => go(idx + 1)}
              aria-label="Next banner"
              className="absolute right-2 top-1/2 -translate-y-1/2 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-background/80 shadow hover:bg-background transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5">
              {banners.map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => go(i)}
                  aria-label={`Go to banner ${i + 1}`}
                  className={cn("h-1.5 rounded-full transition-all", i === idx ? "w-6 bg-white" : "w-1.5 bg-white/60")}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search / category results
// ---------------------------------------------------------------------------

const SORTS = [
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
  mode: { kind: "search"; q: string } | { kind: "category"; categorySlug: string; label?: string };
}) {
  const [sort, setSort] = useState<SortValue>("newest");
  const [page, setPage] = useState(1);
  // completed-fetch state — loading is DERIVED (no sync setState in effects)
  const [done, setDone] = useState<{ key: string; items: ProductCardT[]; total: number }>({ key: "", items: [], total: 0 });
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  const search = mode.kind === "search" ? mode.q : "";
  const category = mode.kind === "category" ? mode.categorySlug : "";
  const queryKey = `${search}|${category}|${sort}`;
  const reqKey = `${queryKey}#${page}`;
  const loadingFirst = done.key === "" || done.key.split("#")[0] !== queryKey;
  const fetchingMore = !loadingFirst && done.key !== reqKey;

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ sort, page: String(page), size: String(PAGE_SIZE), _r: String(retry) });
    if (search) params.set("search", search);
    if (category) params.set("category", category);
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
  }, [search, category, sort, page, retry, queryKey]);

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

  const title = mode.kind === "search" ? (search ? `Results for “${search}”` : "All products") : mode.label ?? "Category";
  const items = done.items;
  const grandTotal = done.total;
  const hasMore = !loadingFirst && items.length < grandTotal;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 flex-1">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          <p className="text-xs text-muted-foreground">
            {loadingFirst ? "Loading…" : `${grandTotal} product${grandTotal === 1 ? "" : "s"} found`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          <Select value={sort} onValueChange={(v) => setSort(v as SortValue)}>
            <SelectTrigger className="w-[190px] min-h-[44px]" aria-label="Sort products">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
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
              ? `Try a different keyword — or browse the categories from the menu.`
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
                {fetchingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
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

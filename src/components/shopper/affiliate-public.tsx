"use client";
// ============================================================================
// Affiliate PUBLIC pages (Task 2-A) — the visitor-facing views powered by
// GET /api/affiliate/pub/showcase/[slug] + GET /api/affiliate/pub/collection/[slug].
//
// Framing contract (spec §3.E): these are clearly-labelled AFFILIATE
// RECOMMENDATION pages — "Curated by @name", never a seller storefront. Only
// public data renders (display name, bio, avatar, published collections).
//
// Attribution: product clicks navigate to the PDP. Money-grade touches are
// recorded by the server when the visitor lands via a promotional link
// (/?al={code} → POST /api/affiliate/track) — the shell fires that BEFORE
// opening these views and passes the linkCode down for context. Browsing via
// ?aff=/?affc= is attribution-free by design; nothing is faked.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Info, PackageOpen, ShieldCheck, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EmptyState, type ShopperCtx } from "./ui-bits";
import { affGet, money, type PubCollectionResT, type PubProductT, type PubShowcaseResT } from "./affiliate-shared";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function BackRow({ ctx, label }: { ctx: ShopperCtx; label: string }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="-ml-2 min-h-[44px] gap-1.5 text-xs font-semibold text-muted-foreground" onClick={() => ctx.back()}>
      <ArrowLeft className="h-4 w-4" aria-hidden /> {label}
    </Button>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-36 rounded-2xl" />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function AffiliateNotice({ name }: { name: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="note">
      <Badge variant="outline" className="gap-1 border-amber-200 bg-amber-50 font-semibold text-amber-800">
        <ShieldCheck className="h-3 w-3" aria-hidden /> Affiliate recommendations
      </Badge>
      <span className="text-[11px] text-muted-foreground">
        Curated by @{name} — a personal recommendation page, not a store.
      </span>
    </div>
  );
}

function PublicProductCard({ p, onOpen }: { p: PubProductT; onOpen: (p: PubProductT) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(p)}
      className="group overflow-hidden rounded-[10px] border bg-card text-left shadow-soft-card transition-all hover:-translate-y-0.5 hover:border-teal-600/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/50"
      aria-label={`${p.title} from ${p.storeName}, ${money(p.priceMinor)}`}
    >
      <div className="relative aspect-square overflow-hidden bg-muted">
        {p.image ? (
          <img src={p.image} alt={p.title} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Store className="h-8 w-8" aria-hidden />
          </div>
        )}
      </div>
      <div className="space-y-0.5 p-2.5">
        <h3 className="line-clamp-2 min-h-[2rem] text-xs leading-snug">{p.title}</h3>
        <div className="flex items-baseline justify-between gap-1">
          <span className="text-sm font-bold text-teal-700">{money(p.priceMinor)}</span>
          <span className="truncate text-[10px] text-muted-foreground">{p.storeName}</span>
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Public showcase (?aff={slug} / ?al={showcase-link})
// ---------------------------------------------------------------------------

export function AffiliateShowcaseView({ ctx, slug }: { ctx: ShopperCtx; slug: string; linkCode?: string }) {
  const [data, setData] = useState<PubShowcaseResT | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await affGet<PubShowcaseResT>(`/api/affiliate/pub/showcase/${encodeURIComponent(slug)}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load this page");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const openProduct = useCallback(
    (p: PubProductT) => ctx.nav({ name: "pdp", slug: p.storeSlug, pSlug: p.slug }),
    [ctx]
  );

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <BackRow ctx={ctx} label="Back" />
      {loading ? (
        <PageSkeleton />
      ) : err ? (
        <TabErrorBlock message={err} onRetry={() => void load()} />
      ) : !data?.found || !data.showcase ? (
        <EmptyState
          icon={PackageOpen}
          title="This showcase isn't available"
          hint="The page may have been paused, or the address is wrong. Nothing is hidden on purpose — affiliates control when their page is live."
          action={<BackRow ctx={ctx} label="Go back" />}
        />
      ) : (
        <div className="space-y-5 pt-2">
          {/* profile header */}
          <header className="relative overflow-hidden rounded-2xl border bg-card p-5 shadow-soft-card sm:p-7">
            <div className="absolute -right-14 -top-14 h-44 w-44 rounded-full bg-teal-100/60 blur-2xl" aria-hidden />
            <div className="relative flex flex-wrap items-center gap-4">
              <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-brand-gradient text-xl font-extrabold text-white shadow-glow-cyan-sm" aria-hidden>
                {data.showcase.avatarUrl ? (
                  <img src={data.showcase.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  (data.showcase.displayName || "?").slice(0, 1).toUpperCase()
                )}
              </span>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-extrabold tracking-tight text-slate-900 sm:text-2xl">
                  Curated by @{data.showcase.displayName}
                </h1>
                {data.showcase.bio ? <p className="pt-1 text-sm leading-snug text-slate-600">{data.showcase.bio}</p> : null}
                <div className="pt-2">
                  <AffiliateNotice name={data.showcase.displayName} />
                </div>
              </div>
            </div>
          </header>

          {/* collections */}
          {data.showcase.collections.length === 0 ? (
            <EmptyState icon={PackageOpen} title="Nothing published yet" hint="This affiliate hasn't published any collections yet — check back soon." />
          ) : (
            data.showcase.collections.map((c) => (
              <section key={c.id} className="rounded-2xl border bg-card p-4 shadow-soft-card sm:p-5" aria-labelledby={`sc-${c.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 pb-1">
                  <h2 id={`sc-${c.id}`} className="text-base font-extrabold text-slate-900">
                    {c.title}
                  </h2>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {c.products.length} item{c.products.length === 1 ? "" : "s"}
                  </span>
                </div>
                {c.description ? <p className="pb-3 text-xs leading-snug text-muted-foreground">{c.description}</p> : null}
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
                  {c.products.map((p) => (
                    <PublicProductCard key={p.productId} p={p} onOpen={openProduct} />
                  ))}
                </div>
              </section>
            ))
          )}

          <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] leading-snug text-slate-600">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Products are sold and fulfilled by their stores on NOMOFEE. The curator may earn a commission on eligible
            purchases made through their links — this never changes what you pay.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public collection (?affc={slug} / ?al={collection-link})
// ---------------------------------------------------------------------------

export function AffiliateCollectionView({ ctx, slug }: { ctx: ShopperCtx; slug: string; linkCode?: string }) {
  const [data, setData] = useState<PubCollectionResT | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await affGet<PubCollectionResT>(`/api/affiliate/pub/collection/${encodeURIComponent(slug)}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load this page");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const openProduct = useCallback(
    (p: PubProductT) => ctx.nav({ name: "pdp", slug: p.storeSlug, pSlug: p.slug }),
    [ctx]
  );

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
      <BackRow ctx={ctx} label="Back" />
      {loading ? (
        <PageSkeleton />
      ) : err ? (
        <TabErrorBlock message={err} onRetry={() => void load()} />
      ) : !data?.found || !data.collection ? (
        <EmptyState
          icon={PackageOpen}
          title="This collection isn't available"
          hint="It may be unpublished, archived, or the address is wrong."
          action={<BackRow ctx={ctx} label="Go back" />}
        />
      ) : (
        <div className="space-y-5 pt-2">
          <header className="relative overflow-hidden rounded-2xl border bg-card p-5 shadow-soft-card sm:p-7">
            <div className="absolute -right-14 -top-14 h-44 w-44 rounded-full bg-teal-100/60 blur-2xl" aria-hidden />
            <div className="relative space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-widest text-teal-700">Curated collection</p>
              <h1 className="text-xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{data.collection.title}</h1>
              {data.collection.description ? <p className="max-w-2xl text-sm leading-snug text-slate-600">{data.collection.description}</p> : null}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <span className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-brand-gradient text-xs font-extrabold text-white" aria-hidden>
                    {data.collection.curatorAvatar ? (
                      <img src={data.collection.curatorAvatar} alt="" className="h-full w-full object-cover" />
                    ) : (
                      (data.collection.curatedBy || "?").slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="text-sm font-bold text-slate-800">@{data.collection.curatedBy}</span>
                </span>
                <AffiliateNotice name={data.collection.curatedBy} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-[36px] gap-1 text-[11px]"
                  onClick={() => ctx.nav({ name: "aff-showcase", slug: data.collection!.curatorSlug })}
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> More from @{data.collection.curatedBy}
                </Button>
              </div>
            </div>
          </header>

          {data.collection.products.length === 0 ? (
            <EmptyState icon={PackageOpen} title="No products right now" hint="The curator has temporarily emptied this collection." />
          ) : (
            <section className="rounded-2xl border bg-card p-4 shadow-soft-card sm:p-5">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
                {data.collection.products.map((p) => (
                  <PublicProductCard key={p.productId} p={p} onOpen={openProduct} />
                ))}
              </div>
            </section>
          )}

          <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] leading-snug text-slate-600">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Products are sold and fulfilled by their stores on NOMOFEE. The curator may earn a commission on eligible
            purchases made through their links — this never changes what you pay.
          </p>
        </div>
      )}
    </div>
  );
}

// Local error block (keeps this file free of shared-hub imports beyond data).
function TabErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState
      title="Could not load this page"
      hint={message}
      action={
        <Button type="button" variant="outline" className={cn("min-h-[44px]")} onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

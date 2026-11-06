"use client";
// ============================================================================
// PDP makeover — content sections (Phases 2.3–2.7 & 5).
// Every number rendered here comes from the live PDP payload (server-
// authoritative pricing/stock/reviews) or the real checkout shipping card —
// nothing is fabricated: no invented original prices, no fake countdowns,
// no false urgency.
// TikTok Shop styling pass (buyer work order): crimson hero price + gradient
// discount badge, small heart + share actions in the title row, star-rating
// pill row — all riding the SAME real data.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Heart,
  Loader2,
  MessageCircle,
  Share2,
  ShieldCheck,
  Store,
  Truck,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dateShort, Stars, fetchJson, fetchEnvelope } from "../ui-bits";
import { useApp } from "@/lib/app-store";
import { formatMinor } from "@/lib/money";
import { PDP_SHIPPING_DISPLAY } from "@/lib/shipping-display";
import { cn } from "@/lib/utils";
import type { ShopperCtx } from "../ui-bits";
import { ReviewFormDialog } from "../review-form-dialog";
import type { PdpPayloadT } from "./types";

// ---------------------------------------------------------------------------
// 2.3 — price & promotion block (TikTok Shop reference: crimson hero price,
// gradient discount badge, struck original — all numbers server-real)
// ---------------------------------------------------------------------------
export function PdpPriceBlock({
  price,
  compareAt,
  off,
  moq,
}: {
  price: number;
  compareAt: number | null;
  off: number | null;
  moq: number;
}) {
  const savings = compareAt != null && compareAt > price ? compareAt - price : 0;
  return (
    <section aria-label="Price" className="rounded-2xl border border-neutral-200/80 bg-[#F8F8F8] p-4 dark:bg-muted/40">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {off && compareAt && compareAt > price ? (
          <span
            aria-hidden="true"
            className="mr-0.5 inline-flex items-baseline self-center rounded-lg bg-gradient-to-r from-rose-500 to-[#FE2C55] px-2 py-0.5 text-sm font-extrabold leading-none text-white shadow-sm"
          >
            -{off}%
          </span>
        ) : null}
        <span className="text-[30px] font-extrabold leading-none tracking-tight text-rose-600 md:text-4xl">{formatMinor(price)}</span>
        {compareAt && compareAt > price ? (
          <span className="text-sm text-muted-foreground line-through md:text-base">{formatMinor(compareAt)}</span>
        ) : null}
      </div>
      {savings > 0 ? (
        <p className="mt-1.5 text-xs font-semibold text-rose-600">
          You save {formatMinor(savings)}
          {off ? <span className="ml-1 font-normal text-muted-foreground">({off}% off this option)</span> : null}
        </p>
      ) : null}
      {moq > 1 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">Min. order {moq}</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2.4 — product identity & social proof (2-line clamp + expand).
// TikTok reference: the save (heart) + share actions sit in the TITLE ROW —
// small icons on the right — not over the photo. Both ride the EXISTING
// backend: like = /api/me/activity LIKE toggle (auth-gated with intent
// resume), share = Web Share API with clipboard fallback.
// ---------------------------------------------------------------------------
export function PdpIdentityBlock({
  title,
  categoryName,
  ratingAvg,
  ratingCount,
  salesCount,
  liked,
  onToggleLike,
  shareUrl,
  onOpenReviews,
}: {
  title: string;
  categoryName: string | null;
  ratingAvg: number;
  ratingCount: number;
  salesCount: number;
  liked: boolean;
  onToggleLike: () => void;
  /** Canonical deep link (/?sf=&sp=) used by the native share sheet. */
  shareUrl: string;
  onOpenReviews: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const onShare = async () => {
    const data = { title, url: shareUrl };
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share(data);
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Link copied", { description: "Share this product with anyone." });
    } catch {
      /* user dismissed the share sheet — not an error */
    }
  };

  return (
    <section aria-label="Product details" className="space-y-2 px-1">
      <div className="flex flex-wrap items-center gap-2">
        {categoryName ? <Badge variant="outline" className="border-teal-700/30 text-[11px] text-teal-800">{categoryName}</Badge> : null}
      </div>
      <div className="flex items-start gap-2">
        <h1
          className={cn("min-w-0 flex-1 cursor-pointer text-lg font-bold leading-snug tracking-tight md:text-xl", !expanded && "line-clamp-2")}
          onClick={() => setExpanded((e) => !e)}
          title="Tap to expand the full title"
        >
          {title}
        </h1>
        {/* small heart + share pair (buyer work order: TikTok save/bookmark
            position, right of the title, BELOW the photo — not on the image) */}
        <span className="flex shrink-0 items-center gap-1 pt-0.5">
          <button
            type="button"
            onClick={onToggleLike}
            aria-pressed={liked}
            aria-label={liked ? "Remove from My Likes" : "Save to My Likes"}
            className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-muted"
          >
            <Heart className={cn("h-4.5 w-4.5 transition-transform active:scale-90", liked ? "fill-rose-500 text-rose-500" : "text-muted-foreground")} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void onShare()}
            aria-label="Share this product"
            className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-muted"
          >
            <Share2 className="h-4.5 w-4.5 text-muted-foreground transition-transform active:scale-90" aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {ratingCount > 0 ? (
          <button type="button" onClick={onOpenReviews} className="inline-flex items-center gap-1.5 rounded hover:opacity-80" aria-label={`Rated ${ratingAvg.toFixed(1)} of 5 — see reviews`}>
            <Stars rating={ratingAvg} numeric={false} />
            <span className="font-bold">{ratingAvg.toFixed(1)}</span>
            <span className="text-muted-foreground underline-offset-2 hover:underline">({ratingCount.toLocaleString("en-MY")} reviews)</span>
          </button>
        ) : (
          <span className="text-muted-foreground">No reviews yet</span>
        )}
        {salesCount > 0 ? <span className="text-muted-foreground">| {salesCount.toLocaleString("en-MY")} sold</span> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2.7 — inline variant preview (opens the dedicated bottom sheet)
// ---------------------------------------------------------------------------
export function PdpVariantPreview({
  optionLabel,
  selectedValue,
  priceFrom,
  totalOptions,
  onOpen,
}: {
  optionLabel: string;
  selectedValue: string | null;
  priceFrom: number | null;
  totalOptions: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl border bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted/50"
      aria-haspopup="dialog"
      aria-label={selectedValue ? `Change selected option — currently ${selectedValue}` : "Select product options"}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">
          Select options
          <span className="ml-1.5 font-normal text-muted-foreground">
            · {totalOptions} available
          </span>
        </span>
        <span className="mt-0.5 block truncate text-sm text-muted-foreground">
          {selectedValue ? (
            <>
              <span className="font-medium text-foreground">{optionLabel}: {selectedValue}</span>
              {priceFrom != null ? <span className="ml-1.5 text-teal-700 font-semibold">{formatMinor(priceFrom)}</span> : null}
            </>
          ) : (
            <>
              {optionLabel}: <span className="italic">Not selected</span>
            </>
          )}
        </span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 2.6 — shipping / delivery & purchase confidence
// ---------------------------------------------------------------------------
export function PdpShippingBlock({ lineTotalMinor }: { lineTotalMinor: number }) {
  const t = PDP_SHIPPING_DISPLAY;
  const remaining = Math.max(0, t.freeShipThresholdMinor - lineTotalMinor);
  const pct = Math.min(100, Math.round((lineTotalMinor / t.freeShipThresholdMinor) * 100));
  return (
    <section aria-label="Delivery and buyer protection" className="space-y-3 rounded-2xl border bg-card p-4">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Truck className="h-4 w-4 text-teal-700" aria-hidden="true" /> Delivery
      </p>

      {remaining > 0 ? (
        <div className="space-y-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-muted">
            <div className="h-full rounded-full bg-brand-gradient transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            Add <span className="font-bold text-teal-700">{formatMinor(remaining)}</span> more for <span className="font-semibold">FREE Standard delivery</span>
          </p>
        </div>
      ) : (
        <p className="text-xs font-semibold text-emerald-600">FREE Standard delivery unlocked for this order</p>
      )}

      <ul className="space-y-1.5 text-sm">
        <li className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Standard · {t.standard.eta}</span>
          <span className="font-semibold">{lineTotalMinor >= t.freeShipThresholdMinor ? "FREE" : formatMinor(t.standard.amountMinor)}</span>
        </li>
        <li className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">
            Express · {t.express.eta}
            <span className="ml-1 text-[11px] text-amber-600">({t.express.note})</span>
          </span>
          <span className="font-semibold">{formatMinor(t.express.amountMinor)}</span>
        </li>
      </ul>
      <p className="text-[11px] text-muted-foreground">Final delivery cost is confirmed at checkout with your shipping address.</p>

      <div className="flex items-start gap-2 border-t pt-3 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
        {/* F-16 copy rule preserved: state the real guarantee without a time window. */}
        <span>Buyer protection — returns &amp; refunds supported on this marketplace.</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2.6 — seller / store confidence card
// ---------------------------------------------------------------------------
export function PdpSellerBlock({
  store,
  productTitle,
  onMessageSeller,
  chatBusy,
  ctx,
}: {
  store: PdpPayloadT["store"];
  productTitle: string;
  onMessageSeller: () => void;
  chatBusy: boolean;
  ctx: ShopperCtx;
}) {
  return (
    <section aria-label="Seller" className="rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-teal-50">
          {store.logoUrl ? (
            <img src={store.logoUrl} alt={`${store.name} logo`} className="h-full w-full object-cover" />
          ) : (
            <Store className="h-6 w-6 text-teal-700" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{store.name}</p>
          <p className="truncate text-xs text-muted-foreground">{store.tagline ?? "Independent seller"}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => ctx.nav({ name: "storefront", slug: store.slug })}
          className="h-9 shrink-0 border-teal-700/40 text-xs font-bold text-teal-800 hover:bg-teal-50"
        >
          Visit store
        </Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Button
          variant="outline"
          onClick={onMessageSeller}
          disabled={chatBusy}
          className="min-h-[44px] gap-2 border-teal-700/40 text-teal-800 hover:bg-teal-50"
          title="Ask the seller about this product — opens a chat quoting this item"
        >
          {chatBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
          Message seller
        </Button>
        {store.whatsapp ? (
          <a
            href={`https://wa.me/${store.whatsapp}?text=${encodeURIComponent(`Hi ${store.name}! I'm interested in "${productTitle}".`)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 min-h-[44px] items-center justify-center gap-2 rounded-md border border-emerald-600/40 px-4 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50"
          >
            <Zap className="h-4 w-4" aria-hidden="true" /> WhatsApp us
          </a>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 5.1 — description (collapsible, seller's real text)
// ---------------------------------------------------------------------------
export function PdpDescriptionBlock({ description }: { description: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!description) return null;
  const long = description.length > 400;
  return (
    <section aria-label="Product description" className="rounded-2xl border bg-card p-4">
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Product description</h2>
      <p className={cn("mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90", long && !expanded && "line-clamp-6")}>
        {description}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 inline-flex min-h-[36px] items-center gap-1 text-xs font-bold text-teal-700 hover:underline"
          aria-expanded={expanded}
        >
          {expanded ? "See less" : "See more"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 5.2 — reviews: average + REAL distribution (all published, server groupBy)
// + verified-buyer submission CTA + server-side filter / sort / pagination
// (rewards work order §6). The initial list rides the PDP payload (recent,
// take 20); any filter/sort/load-more goes through the REAL listing endpoint
// GET /api/sf/{store}/products/{product}/reviews — pending/rejected reviews
// can never appear here, and an empty product shows an honest empty state.
// ---------------------------------------------------------------------------
type EligibilityT =
  | { state: "anonymous" }
  | { state: "eligible" }
  | { state: "already_reviewed"; reviewStatus: string }
  | { state: "ineligible" };

export function PdpReviewsBlock({
  reviews,
  ratingAvg,
  ratingCount,
  ratingDist,
  storeName,
  storeSlug,
  productSlug,
  productTitle,
  productImage,
  sectionRef,
  onOpenAuth,
}: {
  reviews: PdpPayloadT["reviews"];
  ratingAvg: number;
  ratingCount: number;
  ratingDist: number[];
  storeName: string;
  storeSlug: string;
  productSlug: string;
  productTitle: string;
  productImage?: string | null;
  sectionRef?: React.RefObject<HTMLElement | null>;
  /** Opens the shopper auth sheet (anonymous visitors tapping "sign in to review"). */
  onOpenAuth: () => void;
}) {
  const maxBar = Math.max(1, ...ratingDist);

  // ---- filter / sort / pagination (server-backed) ---------------------------
  const [star, setStar] = useState<number | null>(null);
  const [sort, setSort] = useState<"recent" | "highest" | "lowest">("recent");
  // server mode engages on any filter/sort interaction or load-more
  const [serverItems, setServerItems] = useState<PdpPayloadT["reviews"] | null>(null);
  const [serverTotal, setServerTotal] = useState(0);
  const [serverPage, setServerPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE_SIZE = 20; // matches the PDP payload's embedded take — continuity

  // ---- verified-buyer eligibility probe (auth-varying → separate endpoint) --
  // Only fires for signed-in shoppers — anonymous visitors get the sign-in CTA
  // without a guaranteed-401 request.
  const meState = useApp((s) => s.me);
  const signedIn = Boolean(meState.loaded && meState.shopper);
  const [eligibility, setEligibility] = useState<EligibilityT>({ state: "anonymous" });
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setEligibility({ state: "anonymous" });
      return;
    }
    let alive = true;
    setEligibility({ state: "ineligible" }); // probe pending — no CTA flash
    fetchJson<{ eligible: boolean; reason: string; review?: { status: string } }>(
      `/api/sf/${encodeURIComponent(storeSlug)}/products/${encodeURIComponent(productSlug)}/reviews/eligibility`
    )
      .then((d) => {
        if (!alive) return;
        if (d.eligible) setEligibility({ state: "eligible" });
        else if (d.reason === "already_reviewed") setEligibility({ state: "already_reviewed", reviewStatus: d.review?.status ?? "pending" });
        else setEligibility({ state: "ineligible" });
      })
      .catch(() => {
        if (alive) setEligibility({ state: "ineligible" });
      });
    return () => {
      alive = false;
    };
  }, [signedIn, storeSlug, productSlug]);

  // NOTE: no reset-on-change effect here — changeFilter/changeSort manage
  // server mode directly with EXPLICIT params. An effect on [star, sort]
  // would race the fetch that immediately follows it (cleared list vs.
  // resolved fetch ordering), and reading `star`/`sort` inside a callback
  // captured one render earlier would filter with the PREVIOUS value
  // (stale-closure bug, caught in browser E2E). The fetch therefore takes
  // the intended filter/sort as ARGUMENTS, never from closure state.
  const fetchPage = useCallback(
    async (page: number, replace: boolean, fStar: number | null, fSort: "recent" | "highest" | "lowest") => {
      setLoadingMore(true);
      try {
        const params = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE), sort: fSort });
        if (fStar != null) params.set("star", String(fStar));
        const res = await fetchEnvelope<{ reviews: PdpPayloadT["reviews"] }>(
          `/api/sf/${encodeURIComponent(storeSlug)}/products/${encodeURIComponent(productSlug)}/reviews?${params.toString()}`
        );
        setServerTotal(res.meta?.total ?? 0);
        setServerItems((prev) => (replace || page === 1 ? res.data.reviews : [...(prev ?? []), ...res.data.reviews]));
        setServerPage(page);
      } catch {
        toast.error("Could not load reviews", { description: "Check your connection and try again." });
      } finally {
        setLoadingMore(false);
      }
    },
    [storeSlug, productSlug]
  );

  const serverMode = serverItems != null;
  const list = serverMode ? serverItems! : reviews;
  // Embedded total = ratingCount (published count) — same population the
  // endpoint counts with no filter + recent sort.
  const total = serverMode ? serverTotal : ratingCount;

  const changeFilter = (next: number | null) => {
    setStar(next);
    // any non-default combination requires the server list
    if (next != null || sort !== "recent") void fetchPage(1, true, next, sort);
    else setServerItems(null); // back to embedded default view
  };
  const changeSort = (next: "recent" | "highest" | "lowest") => {
    setSort(next);
    if (next !== "recent" || star != null) void fetchPage(1, true, star, next);
    else setServerItems(null);
  };
  const loadMore = () => {
    // from embedded mode, page 2 continues the same (recent, unfiltered) list
    void fetchPage(serverMode ? serverPage + 1 : 2, false, star, sort);
  };

  return (
    <section ref={sectionRef} aria-label="Customer reviews" className="scroll-mt-24 rounded-2xl border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b pb-4">
        <div className="flex items-center gap-3">
          <span className="text-3xl font-extrabold tracking-tight">{ratingCount > 0 ? ratingAvg.toFixed(1) : "—"}</span>
          <div>
            <Stars rating={ratingAvg} numeric={false} />
            <p className="mt-0.5 text-xs text-muted-foreground">{ratingCount.toLocaleString("en-MY")} review{ratingCount === 1 ? "" : "s"}</p>
          </div>
        </div>
        {/* distribution over ALL published reviews (ratingDist server groupBy) */}
        {ratingCount > 0 ? (
          <div className="min-w-[180px] flex-1 space-y-1">
            {[5, 4, 3, 2, 1].map((s) => {
              const count = ratingDist[s - 1] ?? 0;
              const pct = ratingCount > 0 ? Math.round((count / ratingCount) * 100) : 0;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => changeFilter(star === s ? null : s)}
                  aria-pressed={star === s}
                  aria-label={`Filter by ${s} star reviews — ${count} reviews, ${pct}%`}
                  className="flex w-full items-center gap-2 text-[11px] text-muted-foreground transition-opacity hover:opacity-80"
                >
                  <span className="w-3 text-right font-semibold">{s}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-muted">
                    <div
                      className={cn("h-full rounded-full", star === s ? "bg-teal-600" : "bg-amber-400")}
                      style={{ width: `${Math.round((count / maxBar) * 100)}%` }}
                    />
                  </div>
                  <span className="w-14 text-right tabular-nums">
                    {count} <span className="opacity-70">({pct}%)</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* toolbar: filter chips + sort + eligibility CTA */}
      <div className="flex flex-wrap items-center gap-2 border-b py-3">
        {[
          { v: null, label: "All" },
          { v: 5, label: "5★" },
          { v: 4, label: "4★" },
          { v: 3, label: "3★" },
          { v: 2, label: "2★" },
          { v: 1, label: "1★" },
        ].map((f) => (
          <button
            key={String(f.v)}
            type="button"
            onClick={() => changeFilter(f.v)}
            aria-pressed={star === f.v}
            className={cn(
              "min-h-[32px] rounded-full border px-3 text-xs font-bold transition-all",
              star === f.v
                ? "border-transparent bg-teal-700 text-white"
                : "border-slate-200 bg-card text-slate-500 hover:border-teal-300 hover:text-teal-800"
            )}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <label htmlFor="review-sort" className="sr-only">
            Sort reviews
          </label>
          <select
            id="review-sort"
            value={sort}
            onChange={(e) => changeSort(e.target.value as "recent" | "highest" | "lowest")}
            className="h-8 rounded-lg border bg-card px-2 text-xs font-semibold text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600"
          >
            <option value="recent">Most recent</option>
            <option value="highest">Highest rating</option>
            <option value="lowest">Lowest rating</option>
          </select>
        </div>
      </div>

      {/* verified-buyer CTA — server-decided state, never client-asserted */}
      <div className="py-3">
        {eligibility.state === "eligible" ? (
          <Button
            onClick={() => setFormOpen(true)}
            className="min-h-[44px] w-full bg-brand-gradient text-white hover:brightness-110 sm:w-auto"
            aria-label={`Write a review for ${productTitle}`}
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            Write a review — earn 5 points (≈ RM0.05)
          </Button>
        ) : eligibility.state === "already_reviewed" ? (
          <div className="flex items-center gap-2 rounded-lg bg-teal-50 px-3 py-2.5 text-xs font-semibold text-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
            <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
            {eligibility.reviewStatus === "published"
              ? "Your review is published — thank you!"
              : eligibility.reviewStatus === "rejected"
                ? "Your review was not approved for publication."
                : "Your review is pending approval — thank you!"}
          </div>
        ) : eligibility.state === "ineligible" ? null : (
          <button
            type="button"
            onClick={onOpenAuth}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-dashed border-teal-300 bg-teal-50/50 px-3 text-xs font-semibold text-teal-800 transition-colors hover:bg-teal-50 sm:w-auto dark:border-teal-800 dark:bg-teal-950/30 dark:text-teal-300"
          >
            <BadgeCheck className="h-4 w-4" aria-hidden="true" />
            Bought this? Sign in to review as a verified buyer
          </button>
        )}
      </div>

      {/* listing — honest empty state per filter */}
      {list.length === 0 ? (
        <p className="pt-2 text-sm text-muted-foreground">
          {star != null
            ? `No ${star}-star reviews yet.`
            : ratingCount === 0
              ? "No reviews yet. Be the first verified buyer to review this product."
              : "No reviews match this view yet."}
        </p>
      ) : (
        <ul className="space-y-4 pt-2">
          {list.map((r) => (
            <li key={r.id} className="space-y-1.5 border-b pb-4 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-50 text-xs font-bold text-teal-800">
                    {r.customerName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="text-sm font-semibold">{r.customerName}</span>
                  {r.orderId ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600" title="Review written after a confirmed purchase of this product">
                      <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      Verified purchase
                    </span>
                  ) : null}
                </div>
                <span className="text-xs text-muted-foreground">{dateShort(r.createdAt)}</span>
              </div>
              <Stars rating={r.rating} />
              {r.title ? <p className="text-sm font-medium">{r.title}</p> : null}
              {r.body ? <p className="whitespace-pre-line text-sm text-foreground/85">{r.body}</p> : null}
              {r.reply ? (
                <div className="rounded-lg border-l-2 border-teal-600 bg-muted/60 p-2.5 text-xs">
                  <span className="font-semibold text-teal-800">{storeName} replied:</span> {r.reply}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* server-side pagination — Load more while the page is short of total */}
      {list.length < total ? (
        <div className="flex justify-center pt-4">
          <Button variant="outline" disabled={loadingMore} onClick={loadMore} className="min-h-[44px]">
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Load more reviews ({total - list.length} more)
          </Button>
        </div>
      ) : null}

      {/* the REAL submission dialog (verified-purchase + reward server-side) */}
      <ReviewFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        storeSlug={storeSlug}
        productSlug={productSlug}
        productTitle={productTitle}
        productImage={productImage ?? null}
        onSubmitted={() => setEligibility({ state: "already_reviewed", reviewStatus: "pending" })}
      />
    </section>
  );
}

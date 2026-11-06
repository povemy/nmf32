"use client";
// ============================================================================
// PDP makeover — content sections (Phases 2.3–2.7 & 5).
// Every number rendered here comes from the live PDP payload (server-
// authoritative pricing/stock/reviews) or the real checkout shipping card —
// nothing is fabricated: no invented original prices, no fake countdowns,
// no false urgency.
// ============================================================================
import { useState } from "react";
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageCircle,
  ShieldCheck,
  Store,
  Truck,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dateShort, Stars } from "../ui-bits";
import { formatMinor } from "@/lib/money";
import { PDP_SHIPPING_DISPLAY } from "@/lib/shipping-display";
import { cn } from "@/lib/utils";
import type { ShopperCtx } from "../ui-bits";
import type { PdpPayloadT } from "./types";

// ---------------------------------------------------------------------------
// 2.3 — price & promotion block (visually prominent purchase-value section)
// ---------------------------------------------------------------------------
export function PdpPriceBlock({
  price,
  compareAt,
  off,
  salesCount,
  moq,
}: {
  price: number;
  compareAt: number | null;
  off: number | null;
  salesCount: number;
  moq: number;
}) {
  const savings = compareAt != null && compareAt > price ? compareAt - price : 0;
  return (
    <section aria-label="Price" className="rounded-2xl border border-neutral-200/80 bg-[#F8F8F8] p-4 dark:bg-muted/40">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-[26px] font-extrabold leading-none tracking-tight text-teal-700 md:text-3xl">{formatMinor(price)}</span>
        {compareAt && compareAt > price ? (
          <>
            <span className="text-sm text-muted-foreground line-through md:text-base">{formatMinor(compareAt)}</span>
            {off ? <Badge className="bg-[#FE2C55] text-[11px] font-extrabold hover:bg-[#FE2C55]">-{off}% OFF</Badge> : null}
          </>
        ) : null}
      </div>
      {savings > 0 ? (
        <p className="mt-1.5 text-xs font-semibold text-rose-600">
          You save {formatMinor(savings)}
          {off ? <span className="ml-1 font-normal text-muted-foreground">({off}% off this option)</span> : null}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {salesCount > 0 ? <span className="font-semibold text-foreground/80">{salesCount.toLocaleString("en-MY")} sold</span> : null}
        {moq > 1 ? <span>Min. order {moq}</span> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2.4 — product identity & social proof (2-line clamp + expand)
// ---------------------------------------------------------------------------
export function PdpIdentityBlock({
  title,
  categoryName,
  ratingAvg,
  ratingCount,
  salesCount,
  onOpenReviews,
}: {
  title: string;
  categoryName: string | null;
  ratingAvg: number;
  ratingCount: number;
  salesCount: number;
  onOpenReviews: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section aria-label="Product details" className="space-y-2 px-1">
      <div className="flex flex-wrap items-center gap-2">
        {categoryName ? <Badge variant="outline" className="border-teal-700/30 text-[11px] text-teal-800">{categoryName}</Badge> : null}
      </div>
      <h1
        className={cn("cursor-pointer text-lg font-bold leading-snug tracking-tight md:text-xl", !expanded && "line-clamp-2")}
        onClick={() => setExpanded((e) => !e)}
        title="Tap to expand the full title"
      >
        {title}
      </h1>
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
        {salesCount > 0 ? <span className="text-muted-foreground">· {salesCount.toLocaleString("en-MY")} sold</span> : null}
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
// ---------------------------------------------------------------------------
export function PdpReviewsBlock({
  reviews,
  ratingAvg,
  ratingCount,
  ratingDist,
  storeName,
  sectionRef,
}: {
  reviews: PdpPayloadT["reviews"];
  ratingAvg: number;
  ratingCount: number;
  ratingDist: number[];
  storeName: string;
  sectionRef?: React.RefObject<HTMLElement | null>;
}) {
  const maxBar = Math.max(1, ...ratingDist);
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
            {[5, 4, 3, 2, 1].map((star) => {
              const count = ratingDist[star - 1] ?? 0;
              return (
                <div key={star} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="w-3 text-right font-semibold">{star}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-muted">
                    <div className="h-full rounded-full bg-amber-400" style={{ width: `${Math.round((count / maxBar) * 100)}%` }} />
                  </div>
                  <span className="w-8 text-right tabular-nums">{count}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {reviews.length === 0 ? (
        <p className="pt-4 text-sm text-muted-foreground">No reviews yet — be the first after you purchase.</p>
      ) : (
        <ul className="space-y-4 pt-4">
          {reviews.map((r) => (
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
              {r.body ? <p className="text-sm text-foreground/85">{r.body}</p> : null}
              {r.reply ? (
                <div className="rounded-lg border-l-2 border-teal-600 bg-muted/60 p-2.5 text-xs">
                  <span className="font-semibold text-teal-800">{storeName} replied:</span> {r.reply}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

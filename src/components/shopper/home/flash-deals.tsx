"use client";
// ============================================================================
// HomeFlashDeals (work order 14 §5) — time-sensitive offers that are REAL:
// every product carries a genuine compare-at price ABOVE its selling price
// (verified server-side from the seller's own variant data — the homepage
// never invents a discount). The countdown ticks ONLY when a live campaign
// supplies a real end time; otherwise the section renders without a timer
// (never a fabricated countdown). "View all deals" opens the deals listing
// (search view with the on-sale filter).
//
// Desktop revamp (reference layout): the countdown renders as boxed
// dd/hh/mm/ss segments in dark tiles with colon separators — the reference's
// signature flash-sale timer. Colour stays in the NOMOFEE teal family.
// ============================================================================
import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionShell } from "./section-shell";
import { HomeProductRail } from "./product-rail";
import type { ProductCardT, ShopperCtx } from "../ui-bits";

function TimeBox({ value }: { value: string }) {
  return (
    <span
      className="inline-flex h-6 min-w-7 items-center justify-center rounded-md bg-teal-900 px-1 text-xs font-bold tabular-nums text-white shadow-sm"
      aria-hidden="true"
    >
      {value}
    </span>
  );
}

function Countdown({ endAt, name }: { endAt: string; name: string }) {
  const [remaining, setRemaining] = useState(() => endAtRemaingMs(endAt));

  useEffect(() => {
    const t = setInterval(() => setRemaining(endAtRemaingMs(endAt)), 1000);
    return () => clearInterval(t);
  }, [endAt]);

  if (remaining <= 0) return null;
  const totalSec = Math.floor(remaining / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  const colon = <span className="text-sm font-bold text-teal-900" aria-hidden="true">:</span>;

  return (
    <span
      className="inline-flex items-center gap-1.5"
      role="timer"
      aria-label={`${name} ends in ${d} days ${h} hours ${m} minutes ${s} seconds`}
    >
      <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Ends in</span>
      {d > 0 ? (
        <>
          <TimeBox value={p(d)} />
          {colon}
        </>
      ) : null}
      <TimeBox value={p(h)} />
      {colon}
      <TimeBox value={p(m)} />
      {colon}
      <TimeBox value={p(s)} />
    </span>
  );
}

function endAtRemaingMs(endAt: string): number {
  return new Date(endAt).getTime() - Date.now();
}

export function HomeFlashDeals({
  products,
  campaign,
  ctx,
}: {
  products: ProductCardT[];
  campaign: { name: string; endAt: string } | null;
  ctx: ShopperCtx;
}) {
  if (products.length === 0) return null;

  return (
    <SectionShell
      id="home-flash-deals"
      title="Flash deals"
      subtitle={
        campaign
          ? `${campaign.name} — limited-time offers while the campaign runs`
          : "Limited-time offers from our sellers"
      }
      icon={<Zap className="h-5 w-5 text-amber-500" />}
      viewAll={{ label: "View all deals", onClick: () => ctx.nav({ name: "search", q: "", deals: true }) }}
    >
      {campaign ? (
        <div className={cn("flex flex-wrap items-center gap-2 pb-1")}>
          <Countdown endAt={campaign.endAt} name={campaign.name} />
          <span className="text-[11px] text-muted-foreground">until the {campaign.name} campaign ends</span>
        </div>
      ) : null}
      {/* Desktop homepage work order: cards carry wishlist + add-to-cart
          quick actions (md+ only). MOBILE homepage work order 2 (reference
          layout): the same actions are surfaced on mobile too — flash-deal
          cards show the full-width Add-to-Cart pill + wishlist heart.
          Prices/discounts stay EXACTLY as the seller set them — the homepage
          never invents a promotion. */}
      <HomeProductRail products={products} ctx={ctx} ariaLabel="Flash deal products" quickActions mobileActions="full" />
    </SectionShell>
  );
}

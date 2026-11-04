"use client";
// ============================================================================
// HomeFlashDeals (work order 14 §5) — time-sensitive offers that are REAL:
// every product carries a genuine compare-at price ABOVE its selling price
// (verified server-side from the seller's own variant data — the homepage
// never invents a discount). The countdown ticks ONLY when a live campaign
// supplies a real end time; otherwise the section renders without a timer
// (never a fabricated countdown). "View all deals" opens the deals listing
// (search view with the on-sale filter).
// ============================================================================
import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { SectionShell } from "./section-shell";
import { HomeProductRail } from "./product-rail";
import type { ProductCardT, ShopperCtx } from "../ui-bits";

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

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800"
      aria-label={`${name} ends in ${d} days ${h} hours`}
    >
      <span aria-hidden="true">⏳</span>
      {d > 0 ? `${d}d ` : ""}
      {p(h)}:{p(m)}:{p(s)}
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
        <div className="flex items-center gap-2 pb-1">
          <Countdown endAt={campaign.endAt} name={campaign.name} />
          <span className="text-[11px] text-muted-foreground">until the {campaign.name} campaign ends</span>
        </div>
      ) : null}
      {/* Desktop homepage work order: cards carry wishlist + add-to-cart
          quick actions (md+ only). Prices/discounts stay EXACTLY as the
          seller set them — the homepage never invents a promotion. */}
      <HomeProductRail products={products} ctx={ctx} ariaLabel="Flash deal products" quickActions />
    </SectionShell>
  );
}

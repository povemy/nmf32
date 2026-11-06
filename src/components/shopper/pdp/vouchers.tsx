"use client";
// ============================================================================
// PDP makeover — voucher & promotional centre (Phase 2.5).
// Data: the REAL voucher system — GET /api/me/vouchers (wallet + claim
// centre) and POST /api/me/vouchers/claim. Only vouchers whose real scope
// matches this product's store (PLATFORM or this STORE) are shown; the
// strip highlights the BEST min-spend-eligible voucher and the sheet lists
// every state: claimable / already claimed / min-spend not met / expired /
// fully redeemed. All maths is advisory — checkout revalidates eligibility
// server-side at quote time (vouchers are applied there, never on the PDP).
// Guests see nothing (the voucher system is account-scoped) — no dead UI.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgePercent, Check, ChevronRight, Gift, Loader2, Ticket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson, postJson, dateShort } from "../ui-bits";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { pdpTrack } from "./analytics";
import type { PdpVoucherT, VoucherEligibility } from "./types";

export function PdpVoucherCentre({
  signedIn,
  storeSlug,
  subtotalMinor,
  onVoucherClaimed,
}: {
  signedIn: boolean;
  storeSlug: string;
  /** Live advisory total: selected-SKU price × quantity. */
  subtotalMinor: number;
  /** Fired after a successful claim (parent may refetch/celebrate). */
  onVoucherClaimed?: () => void;
}) {
  const [wallet, setWallet] = useState<PdpVoucherT[] | null>(null);
  const [center, setCenter] = useState<PdpVoucherT[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{ mine: PdpVoucherT[]; center: PdpVoucherT[] }>("/api/me/vouchers");
      setWallet(Array.isArray(d.mine) ? d.mine : []);
      setCenter(Array.isArray(d.center) ? d.center : []);
    } catch {
      setWallet([]);
      setCenter([]);
    }
  }, []);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  // Relevant = real scope match: platform-wide, or scoped to THIS store.
  const relevant = useMemo(() => {
    if (!signedIn || !wallet || !center) return [];
    const byId = new Map<string, PdpVoucherT & { held: boolean }>();
    for (const w of wallet) {
      if (w.status !== "AVAILABLE") continue; // USED / EXPIRED are not actionable
      byId.set(w.id, { ...w, held: true });
    }
    for (const c of center) {
      const existing = byId.get(c.id);
      if (existing) {
        byId.set(c.id, { ...existing, quotaRemaining: c.quotaRemaining, claimable: c.claimable, claimedByMe: c.claimedByMe ?? existing.held });
      } else {
        byId.set(c.id, { ...c, held: false });
      }
    }
    return [...byId.values()].filter((v) => v.scope !== "STORE" || v.store?.slug === storeSlug);
  }, [signedIn, wallet, center, storeSlug]);

  const rows = useMemo(() => relevant.map((v) => ({ v, e: eligibility(v, subtotalMinor) })), [relevant, subtotalMinor]);

  // The strip only appears when at least one APPLICABLE voucher exists
  // (min spend met) — a voucher the current order can't use is never
  // presented as applicable.
  const applicable = rows.filter((r) => !r.e.expired && !r.e.quotaExhausted && r.e.minSpendMet);
  const best = applicable.slice().sort((a, b) => b.e.estDiscountMinor - a.e.estDiscountMinor || (b.e.freeshipping ? 1 : 0) - (a.e.freeshipping ? 1 : 0))[0] ?? null;

  if (!signedIn || wallet === null) return null; // guests / loading: no dead UI
  if (relevant.length === 0) return null; // nothing real to show — hide

  const claim = async (v: PdpVoucherT & { held?: boolean }) => {
    if (claimingId) return; // repeated-click protection
    setClaimingId(v.id);
    try {
      await postJson("/api/me/vouchers/claim", { voucherId: v.id });
      pdpTrack("claim_voucher", {});
      toast.success("Voucher claimed", { description: `${v.title} — it applies at checkout when its conditions are met.` });
      await load();
      onVoucherClaimed?.();
    } catch (e) {
      pdpTrack("voucher_claim_failure", {});
      toast.error(e instanceof Error ? e.message : "Could not claim this voucher");
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <>
      {/* in-flow strip — best applicable voucher first (Phase 2.5) */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-teal-700/40 bg-teal-50/50 px-4 py-3 text-left transition-colors hover:bg-teal-50"
        aria-label={`Vouchers — ${relevant.length} available for this order`}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-700">
          <Ticket className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          {best ? (
            <>
              <span className="block text-sm font-bold text-teal-900">
                {best.e.freeshipping ? "Free delivery voucher" : `Save ${formatMinor(best.e.estDiscountMinor)}`}
                <span className="ml-1.5 font-medium text-teal-700/80">— {best.v.title}</span>
              </span>
              <span className="block text-xs text-muted-foreground">
                {best.v.minSpendMinor > 0 ? `Min. spend ${formatMinor(best.v.minSpendMinor)} · ` : ""}
                {best.held ? "In your wallet — applies at checkout" : "Claim & use at checkout"}
              </span>
            </>
          ) : (
            <span className="block text-sm font-bold text-teal-900">
              {rows.length} voucher{rows.length === 1 ? "" : "s"} for this order
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-xs font-bold text-teal-700">
          {rows.length} <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </span>
      </button>

      {/* dedicated voucher sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="mx-auto flex max-h-[82dvh] gap-0 rounded-t-3xl px-0 pb-0 sm:max-w-lg sm:rounded-t-3xl" aria-label="Vouchers">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Ticket className="h-4 w-4 text-teal-700" aria-hidden="true" /> Vouchers for this order
            </SheetTitle>
            <SheetDescription className="text-xs">
              Applied at checkout — eligibility is rechecked with your final cart total.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4 py-3">
            <ul className="space-y-2.5">
              {rows.map(({ v, e }) => {
                const held = v.held ?? v.claimedByMe;
                return (
                  <li key={v.id} className="rounded-xl border bg-card p-3.5">
                    <div className="flex items-start gap-3">
                      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", e.freeshipping ? "bg-amber-100 text-amber-700" : "bg-teal-100 text-teal-700")}>
                        {e.freeshipping ? <Gift className="h-4.5 w-4.5" aria-hidden="true" /> : <BadgePercent className="h-4.5 w-4.5" aria-hidden="true" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold leading-tight">{v.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {valueLine(v)} · code <span className="font-mono font-semibold">{v.code}</span>
                          {v.scope === "STORE" && v.store?.name ? ` · ${v.store.name}` : ""}
                        </p>
                        {/* real conditions, honestly stated */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          {v.minSpendMinor > 0 ? (
                            <span className={cn("inline-flex items-center gap-1", e.minSpendMet ? "text-emerald-600" : "text-amber-600")}>
                              {e.minSpendMet ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                              {e.minSpendMet
                                ? `Min. spend ${formatMinor(v.minSpendMinor)} — met`
                                : `Min. spend ${formatMinor(v.minSpendMinor)} — add ${formatMinor(v.minSpendMinor - subtotalMinor)} more`}
                            </span>
                          ) : null}
                          <span>Expires {dateShort(v.expiryAt)}</span>
                          {e.regionNote ? <span className="text-amber-600">{e.regionNote}</span> : null}
                          {v.quotaRemaining != null && v.quotaRemaining > 0 && v.quotaRemaining <= 10 ? <span>{v.quotaRemaining} left</span> : null}
                        </div>
                      </div>
                      <div className="shrink-0 self-center">
                        {held ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
                            <Check className="h-3.5 w-3.5" aria-hidden="true" /> Claimed
                          </span>
                        ) : e.expired ? (
                          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-bold text-muted-foreground">Expired</span>
                        ) : e.quotaExhausted ? (
                          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-bold text-muted-foreground">Fully redeemed</span>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => void claim(v)}
                            disabled={claimingId === v.id || v.claimable === false}
                            className="h-9 bg-teal-700 px-3 text-xs font-bold hover:bg-teal-800"
                          >
                            {claimingId === v.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Claim"}
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Real value line from the voucher's own numbers. */
function valueLine(v: PdpVoucherT): string {
  if (v.kind === "freeshipping") return "Free standard delivery";
  if (v.discountMinor > 0) return `${formatMinor(v.discountMinor)} off`;
  if (v.percentOff) return `${v.percentOff}% off${v.maxDiscountMinor ? ` up to ${formatMinor(v.maxDiscountMinor)}` : ""}`;
  return "Voucher";
}

/** Advisory eligibility vs the CURRENT PDP total (checkout revalidates). */
function eligibility(v: PdpVoucherT, subtotalMinor: number): VoucherEligibility {
  const now = Date.now();
  const expired = new Date(v.expiryAt).getTime() <= now;
  const quotaExhausted = v.quotaRemaining != null && v.quotaRemaining <= 0;
  const minSpendMet = subtotalMinor >= v.minSpendMinor;
  let est = 0;
  if (v.kind !== "freeshipping" && !expired) {
    if (v.discountMinor > 0) est = Math.min(v.discountMinor, subtotalMinor);
    else if (v.percentOff) {
      est = Math.floor((subtotalMinor * v.percentOff) / 100);
      if (v.maxDiscountMinor) est = Math.min(est, v.maxDiscountMinor);
      est = Math.min(est, subtotalMinor);
    }
  }
  return {
    claimable: !expired && !quotaExhausted && v.claimable !== false,
    expired,
    quotaExhausted,
    minSpendMet,
    estDiscountMinor: est,
    freeshipping: v.kind === "freeshipping",
    regionNote: v.regionLimit === "peninsular" ? "West Malaysia only" : null,
  };
}

/** Loading placeholder for the strip while the wallet fetches. */
export function VoucherStripSkeleton() {
  return <Skeleton className="h-16 w-full rounded-2xl" />;
}

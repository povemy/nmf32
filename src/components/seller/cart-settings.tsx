"use client";
// Seller Backend — "Cart Experience": Shopify-style cart drawer customization.
// Sellers configure layout, AOV boosters (free-shipping progress, upsells) and
// urgency (low stock, live viewers, reservation countdown) plus trust badges
// and their checkout button label — ALL through plain controls (switches,
// dropdowns, sliders, product pickers). No JSON is ever shown; the config is
// structured fields, saved to the backend as-is. A live drawer preview
// mirrors exactly what shoppers see.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  BadgePercent,
  Flame,
  Gift,
  Eye,
  Loader2,
  Save,
  ShoppingCart,
  Timer,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatMinor } from "@/lib/money";
import { apiGet, apiSend, MoneyInput } from "./ui-bits";

type CartConfig = {
  layout: string;
  showFreeShippingBar: boolean;
  freeShipThresholdMinor: number;
  upsellEnabled: boolean;
  upsellMode: string;
  upsellTitle: string;
  upsellLimit: number;
  urgencyStockEnabled: boolean;
  urgencyStockThreshold: number;
  urgencyViewersEnabled: boolean;
  urgencyViewersMin: number;
  urgencyViewersMax: number;
  urgencyCountdownEnabled: boolean;
  urgencyCountdownMinutes: number;
  showOrderNote: boolean;
  showDiscountHint: boolean;
  checkoutLabel: string;
  showContinueShopping: boolean;
  stickyCta: boolean;
  trustBadges: string[];
};

type ProductPick = { id: string; title: string; priceMinor: number; status: string };

const DEFAULTS: CartConfig = {
  layout: "standard",
  showFreeShippingBar: true,
  freeShipThresholdMinor: 10000,
  upsellEnabled: false,
  upsellMode: "auto",
  upsellTitle: "Frequently bought together",
  upsellLimit: 3,
  urgencyStockEnabled: false,
  urgencyStockThreshold: 5,
  urgencyViewersEnabled: false,
  urgencyViewersMin: 8,
  urgencyViewersMax: 28,
  urgencyCountdownEnabled: false,
  urgencyCountdownMinutes: 15,
  showOrderNote: false,
  showDiscountHint: true,
  checkoutLabel: "Checkout",
  showContinueShopping: true,
  stickyCta: true,
  trustBadges: [],
};

const TRUST_BADGES: { id: string; label: string; emoji: string }[] = [
  { id: "secure", label: "Secure checkout", emoji: "🛡️" },
  { id: "returns", label: "Easy returns", emoji: "↩️" },
  { id: "support", label: "Local support", emoji: "🎧" },
  { id: "shipping", label: "Fast shipping", emoji: "🚚" },
  { id: "cod", label: "COD available", emoji: "💵" },
  { id: "warranty", label: "Warranty", emoji: "✅" },
];

const LAYOUTS = [
  { id: "compact", label: "Compact", desc: "Lean drawer — items, subtotal, checkout. Fastest path to payment." },
  { id: "standard", label: "Standard", desc: "Balanced drawer with urgency + trust badges. Great default." },
  { id: "pro", label: "Pro (AOV)", desc: "Everything: upsell strip, free-shipping progress, urgency, order note." },
];

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border p-3.5">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

export default function SellerCartSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<CartConfig>({ ...DEFAULTS });
  const [thresholdText, setThresholdText] = useState("100.00");
  // manual upsell picks
  const [catalog, setCatalog] = useState<ProductPick[]>([]);
  const [picked, setPicked] = useState<ProductPick[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const set = (patch: Partial<CartConfig>) => setCfg((c) => ({ ...c, ...patch }));

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      apiGet<{ settings: Partial<CartConfig> | null; upsellPicked: ProductPick[] }>("/api/store/cart-settings"),
      apiGet<ProductPick[]>("/api/store/products?size=100"),
    ])
      .then(([s, rows]) => {
        if (!alive) return;
        if (s.settings) setCfg({ ...DEFAULTS, ...s.settings });
        setPicked(s.upsellPicked ?? []);
        setCatalog(
          (rows ?? []).map((r) => ({
            id: r.id,
            title: r.title,
            priceMinor: Number(r.priceMinor) || 0,
            status: String(r.status ?? "draft"),
          }))
        );
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not load cart settings"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // keep the RM threshold input in sync with the minor-unit value
  useEffect(() => {
    setThresholdText((cfg.freeShipThresholdMinor / 100).toFixed(2));
  }, [cfg.freeShipThresholdMinor]);

  const layoutSupports = (feature: "upsell" | "urgency" | "note") =>
    cfg.layout === "pro"
      ? true
      : cfg.layout === "standard"
        ? feature === "urgency"
        : false;

  const save = async () => {
    setSaving(true);
    try {
      await apiSend("PUT", "/api/store/cart-settings", {
        ...cfg,
        upsellProductIds: cfg.upsellMode === "manual" ? picked.map((p) => p.id) : [],
      });
      toast.success("Cart experience saved", { description: "Shoppers now see this cart drawer in your store." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const availableToPick = useMemo(
    () => catalog.filter((c) => !picked.some((p) => p.id === c.id)),
    [catalog, picked]
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShoppingCart className="h-5 w-5 text-primary" /> Cart experience
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Design the cart drawer shoppers see in your store — raise order value with free-shipping goals and upsells, add healthy urgency, and make your checkout button yours.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        {/* ------------------------------------------------ controls (left) */}
        <div className="space-y-5 xl:col-span-3">
          {/* layout */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">1 · Drawer layout</CardTitle>
              <CardDescription>The structure of the cart drawer that slides out after "Add to cart".</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                {LAYOUTS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => set({ layout: l.id })}
                    aria-pressed={cfg.layout === l.id}
                    className={
                      "rounded-xl border p-3 text-left transition-all " +
                      (cfg.layout === l.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-muted-foreground/40")
                    }
                  >
                    <p className="text-sm font-semibold">{l.label}</p>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{l.desc}</p>
                  </button>
                ))}
              </div>
              {cfg.layout === "compact" ? (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Compact keeps only the essentials — upsells, urgency, badges and the order note are switched off in this layout.
                </p>
              ) : null}
              {cfg.layout === "standard" ? (
                <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">
                  Standard adds urgency and trust badges. Switch to Pro to unlock the upsell strip and the order note.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* AOV */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <BadgePercent className="h-4 w-4 text-primary" /> 2 · Grow order value
              </CardTitle>
              <CardDescription>Nudge shoppers to add a little more every order.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Toggle
                label="Free-shipping progress bar"
                hint="Shows how much more to spend to unlock free shipping — the single best cart AOV booster."
                checked={cfg.showFreeShippingBar && layoutSupports("urgency")}
                onChange={(v) => set({ showFreeShippingBar: v })}
              />
              {cfg.showFreeShippingBar && layoutSupports("urgency") ? (
                <div className="ml-1 space-y-1.5 rounded-xl border bg-muted/30 p-3.5">
                  <Label htmlFor="ct-threshold" className="text-xs font-semibold">Free shipping unlocks at</Label>
                  <div className="max-w-48">
                    <MoneyInput
                      id="ct-threshold"
                      valueMinor={cfg.freeShipThresholdMinor}
                      onChangeMinor={(m) => set({ freeShipThresholdMinor: m })}
                      placeholder="100.00"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Applies to the whole cart. Most stores set RM 80–150 — above their average order.
                  </p>
                </div>
              ) : null}

              <Toggle
                label="Upsell products in cart"
                hint="Suggests more of your products right inside the drawer (Pro layout)."
                checked={cfg.upsellEnabled && layoutSupports("upsell")}
                onChange={(v) => set({ upsellEnabled: v })}
              />
              {cfg.upsellEnabled && layoutSupports("upsell") ? (
                <div className="ml-1 space-y-3 rounded-xl border bg-muted/30 p-3.5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Which products?</Label>
                      <Select value={cfg.upsellMode} onValueChange={(v) => set({ upsellMode: v })}>
                        <SelectTrigger aria-label="Upsell source"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Best sellers — automatic</SelectItem>
                          <SelectItem value="manual">Hand-pick products</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ct-upsell-limit">How many to show</Label>
                      <Select value={String(cfg.upsellLimit)} onValueChange={(v) => set({ upsellLimit: Number(v) })}>
                        <SelectTrigger id="ct-upsell-limit" aria-label="Upsell count"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[2, 3, 4, 5, 6].map((n) => (
                            <SelectItem key={n} value={String(n)}>{n} products</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {cfg.upsellMode === "manual" ? (
                    <div className="space-y-2">
                      <Label>Hand-picked products ({picked.length}/8)</Label>
                      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                        <PopoverTrigger asChild>
                          <Button variant="outline" size="sm" className="gap-1.5 min-h-[44px]">
                            Choose products… <Badge variant="secondary">{picked.length}</Badge>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80 p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search your products…" />
                            <CommandEmpty>No products found.</CommandEmpty>
                            <CommandGroup className="max-h-60 overflow-y-auto">
                              {availableToPick.map((p) => (
                                <CommandItem
                                  key={p.id}
                                  value={p.title}
                                  onSelect={() => {
                                    setPicked((cur) => (cur.length >= 8 ? cur : [...cur, p]));
                                    setPickerOpen(false);
                                  }}
                                >
                                  <span className="truncate">{p.title}</span>
                                  <span className="ml-auto text-xs text-muted-foreground">{formatMinor(p.priceMinor)}</span>
                                </CommandItem>
                              ))}
                              {availableToPick.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground">All products picked.</div>
                              ) : null}
                            </CommandGroup>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      {picked.length > 0 ? (
                        <ul className="space-y-1.5">
                          {picked.map((p) => (
                            <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
                              <span className="min-w-0 truncate">{p.title}</span>
                              <span className="flex shrink-0 items-center gap-2">
                                <span className="text-xs text-muted-foreground">{formatMinor(p.priceMinor)}</span>
                                <button
                                  type="button"
                                  onClick={() => setPicked((cur) => cur.filter((x) => x.id !== p.id))}
                                  className="text-muted-foreground transition-colors hover:text-rose-600"
                                  aria-label={`Remove ${p.title} from upsells`}
                                >
                                  ✕
                                </button>
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">No picks yet — the drawer falls back to your best sellers.</p>
                      )}
                    </div>
                  ) : null}
                  <div className="space-y-1.5">
                    <Label htmlFor="ct-upsell-title">Upsell section title</Label>
                    <Input
                      id="ct-upsell-title"
                      value={cfg.upsellTitle}
                      onChange={(e) => set({ upsellTitle: e.target.value })}
                      maxLength={60}
                      placeholder="Frequently bought together"
                    />
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* urgency */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <Flame className="h-4 w-4 text-primary" /> 3 · Urgency
              </CardTitle>
              <CardDescription>Gentle scarcity cues that help shoppers decide faster (Standard &amp; Pro layouts).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Toggle
                label="Low-stock warnings"
                hint="Tags items with “Only X left” when stock runs low."
                checked={cfg.urgencyStockEnabled && layoutSupports("urgency")}
                onChange={(v) => set({ urgencyStockEnabled: v })}
              />
              {cfg.urgencyStockEnabled && layoutSupports("urgency") ? (
                <div className="ml-1 space-y-2 rounded-xl border bg-muted/30 p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <Label className="text-xs font-semibold">Warn when stock is at or below</Label>
                    <span className="text-sm font-bold tabular-nums">{cfg.urgencyStockThreshold}</span>
                  </div>
                  <Slider
                    value={[cfg.urgencyStockThreshold]}
                    min={1}
                    max={20}
                    step={1}
                    onValueChange={([v]) => set({ urgencyStockThreshold: v })}
                    aria-label="Low stock threshold"
                  />
                </div>
              ) : null}

              <Toggle
                label="Live viewers indicator"
                hint="Shows how many people are browsing this store right now."
                checked={cfg.urgencyViewersEnabled && layoutSupports("urgency")}
                onChange={(v) => set({ urgencyViewersEnabled: v })}
              />
              {cfg.urgencyViewersEnabled && layoutSupports("urgency") ? (
                <div className="ml-1 space-y-3 rounded-xl border bg-muted/30 p-3.5">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-xs font-semibold">Range (people)</Label>
                      <span className="text-sm font-bold tabular-nums">{cfg.urgencyViewersMin}–{cfg.urgencyViewersMax}</span>
                    </div>
                    <Slider
                      value={[cfg.urgencyViewersMin, cfg.urgencyViewersMax]}
                      min={2}
                      max={100}
                      step={1}
                      onValueChange={([lo, hi]) => set({ urgencyViewersMin: Math.min(lo, hi), urgencyViewersMax: Math.max(lo, hi) })}
                      aria-label="Viewer range"
                    />
                  </div>
                </div>
              ) : null}

              <Toggle
                label="Cart reservation countdown"
                hint="A timer that reserves the drawer items for a few minutes — classic urgency driver."
                checked={cfg.urgencyCountdownEnabled && layoutSupports("urgency")}
                onChange={(v) => set({ urgencyCountdownEnabled: v })}
              />
              {cfg.urgencyCountdownEnabled && layoutSupports("urgency") ? (
                <div className="ml-1 space-y-2 rounded-xl border bg-muted/30 p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <Label className="text-xs font-semibold">Reserve for</Label>
                    <span className="text-sm font-bold tabular-nums">{cfg.urgencyCountdownMinutes} min</span>
                  </div>
                  <Slider
                    value={[cfg.urgencyCountdownMinutes]}
                    min={3}
                    max={60}
                    step={1}
                    onValueChange={([v]) => set({ urgencyCountdownMinutes: v })}
                    aria-label="Reservation minutes"
                  />
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* conversion extras */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">4 · Trust &amp; checkout</CardTitle>
              <CardDescription>Reassurance and the final call-to-action.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {cfg.layout !== "compact" ? (
                <div className="space-y-2">
                  <Label>Trust badges (choose any)</Label>
                  <div className="flex flex-wrap gap-2">
                    {TRUST_BADGES.map((b) => {
                      const on = cfg.trustBadges.includes(b.id);
                      return (
                        <button
                          key={b.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            set({ trustBadges: on ? cfg.trustBadges.filter((x) => x !== b.id) : [...cfg.trustBadges, b.id] })
                          }
                          className={
                            "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-all " +
                            (on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:border-muted-foreground/40")
                          }
                        >
                          <span aria-hidden>{b.emoji}</span> {b.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {cfg.layout === "pro" ? (
                <Toggle
                  label="Order note box"
                  hint="Let buyers add gift wrap / delivery instructions right in the cart."
                  checked={cfg.showOrderNote}
                  onChange={(v) => set({ showOrderNote: v })}
                />
              ) : null}

              <Toggle
                label="Mention vouchers at checkout"
                hint="A small line reminding buyers promo codes apply at checkout."
                checked={cfg.showDiscountHint}
                onChange={(v) => set({ showDiscountHint: v })}
              />
              <Toggle
                label="Show “Continue shopping” link"
                hint="Secondary action under the checkout button."
                checked={cfg.showContinueShopping}
                onChange={(v) => set({ showContinueShopping: v })}
              />
              <Toggle
                label="Pin checkout button (sticky)"
                hint="Keeps the checkout button always visible while scrolling the cart."
                checked={cfg.stickyCta}
                onChange={(v) => set({ stickyCta: v })}
              />
              <div className="space-y-1.5">
                <Label htmlFor="ct-label">Checkout button text</Label>
                <Input
                  id="ct-label"
                  value={cfg.checkoutLabel}
                  onChange={(e) => set({ checkoutLabel: e.target.value })}
                  maxLength={30}
                  placeholder="Checkout"
                />
                <p className="text-[11px] text-muted-foreground">Try “Checkout now — free gift inside” for a final push.</p>
              </div>
            </CardContent>
          </Card>

          <div className="sticky bottom-4 z-10">
            <Button onClick={save} disabled={saving} size="lg" className="w-full min-h-[48px] gap-2 shadow-lg">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save cart experience
            </Button>
          </div>
        </div>

        {/* ------------------------------------------------ live preview (right) */}
        <div className="xl:col-span-2">
          <div className="xl:sticky xl:top-4">
            <DrawerPreview cfg={cfg} picked={picked} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live preview

function DrawerPreview({ cfg, picked }: { cfg: CartConfig; picked: ProductPick[] }) {
  const supports = {
    upsell: cfg.layout === "pro",
    urgency: cfg.layout !== "compact",
    note: cfg.layout === "pro",
  };
  const showShip = cfg.showFreeShippingBar && supports.urgency && cfg.freeShipThresholdMinor > 0;
  const badges = cfg.trustBadges.slice(0, 6);

  return (
    <Card className="overflow-hidden py-0">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">Live preview</CardTitle>
        <CardDescription className="text-xs">Exactly what shoppers see after “Add to cart”.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="mx-auto flex h-[560px] w-full max-w-sm flex-col overflow-hidden border-l bg-background" role="img" aria-label="Cart drawer preview">
          {/* header */}
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <ShoppingCart className="h-4.5 w-4.5 text-teal-700" />
            <p className="text-sm font-semibold">Your cart</p>
            <span className="text-xs text-muted-foreground">(2 items)</span>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {supports.urgency && cfg.urgencyCountdownEnabled ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                <Timer className="h-3 w-3" /> Items reserved for {String(cfg.urgencyCountdownMinutes).padStart(2, "0")}:00
              </div>
            ) : null}
            {supports.urgency && cfg.urgencyViewersEnabled ? (
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-rose-600">
                <Eye className="h-3 w-3" /> {cfg.urgencyViewersMin} people are viewing this store's products right now
              </p>
            ) : null}
            {showShip ? (
              <div className="rounded-xl border p-3">
                <p className="text-[11px] font-semibold">
                  Spend <span className="font-extrabold">{formatMinor(Math.max(0, cfg.freeShipThresholdMinor - 6400))}</span> more for FREE shipping
                </p>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-teal-700" style={{ width: `${Math.min(100, Math.round((6400 / cfg.freeShipThresholdMinor) * 100))}%` }} />
                </div>
              </div>
            ) : null}

            {/* sample items — mirror the real drawer: selection checkbox,
                compact 20%-smaller card, 12px/500 product title */}
            {[
              { t: "Aria Ceramic Vase — Nordic Matte", v: "Color: White", p: 4900, low: supports.urgency && cfg.urgencyStockEnabled, sel: true },
              { t: "Terra Linen Table Runner", v: "Default", p: 1500, low: false, sel: true },
            ].map((it, i) => (
              <div key={i} className="flex items-start gap-2.5 rounded-xl border bg-card p-2">
                <Checkbox checked disabled aria-label="Included in checkout" className="mt-6 h-4 w-4 shrink-0" />
                <img src={`/api/img/preview-item-${i + 1}?w=200&h=200`} alt="" className="h-16 w-16 rounded-lg border object-cover" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-[12px] font-medium leading-tight">{it.t}</p>
                  <p className="text-[11px] leading-tight text-muted-foreground">{it.v}</p>
                  {it.low ? (
                    <p className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                      <Flame className="h-2.5 w-2.5" /> Only {cfg.urgencyStockThreshold} left in stock
                    </p>
                  ) : null}
                  <p className="text-[13px] font-bold text-teal-700">{formatMinor(it.p)}</p>
                </div>
              </div>
            ))}

            {supports.upsell && cfg.upsellEnabled ? (
              <div className="space-y-2 border-t pt-3">
                <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  <Gift className="h-3 w-3" /> {cfg.upsellTitle || "You may also like"}
                </p>
                <div className="flex gap-2 overflow-hidden">
                  {(picked.length > 0
                    ? picked.slice(0, cfg.upsellLimit).map((p) => ({ title: p.title, priceMinor: p.priceMinor }))
                    : [
                        { title: "Rattan Coasters (set of 4)", priceMinor: 1900 },
                        { title: "Beeswax Candle — Amber", priceMinor: 2400 },
                        { title: "Jute Gift Bag", priceMinor: 600 },
                      ]
                  ).map((u, i) => (
                    <div key={i} className="w-20 shrink-0 rounded-lg border bg-card p-1.5">
                      <img src={`/api/img/preview-upsell-${i + 1}?w=160&h=160`} alt="" className="aspect-square w-full rounded border object-cover" />
                      <p className="mt-1 line-clamp-2 text-[9px] leading-tight">{u.title}</p>
                      <p className="text-[10px] font-bold text-teal-700">{formatMinor(u.priceMinor)}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {supports.note && cfg.showOrderNote ? (
              <div className="space-y-1 border-t pt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Order note</p>
                <Textarea rows={2} placeholder="Gift wrap, delivery instructions…" className="text-xs" disabled />
              </div>
            ) : null}

            {supports.urgency && badges.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 border-t pt-3">
                {badges.map((id) => {
                  const meta = TRUST_BADGES.find((b) => b.id === id);
                  if (!meta) return null;
                  return (
                    <div key={id} className="flex flex-col items-center gap-1 rounded-lg border bg-muted/30 p-2 text-center">
                      <span aria-hidden className="text-sm">{meta.emoji}</span>
                      <span className="text-[9px] font-semibold leading-tight text-muted-foreground">{meta.label}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* CTA */}
          <div className={"border-t bg-background p-4" + (cfg.stickyCta ? "" : " opacity-90")}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="text-base font-extrabold text-teal-700">{formatMinor(6400)}</span>
            </div>
            {cfg.showDiscountHint ? (
              <p className="mt-1 text-[10px] text-muted-foreground">Voucher / promo codes can be applied at checkout.</p>
            ) : null}
            <div className="mt-2 rounded-lg bg-teal-700 py-2.5 text-center text-sm font-semibold text-white">
              {cfg.checkoutLabel || "Checkout"}
            </div>
            {cfg.showContinueShopping ? (
              <p className="mt-2 text-center text-[10px] font-semibold text-muted-foreground">Continue shopping</p>
            ) : null}
          </div>
        </div>
        <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">
          <Truck className="mr-1 inline h-3 w-3" />
          Real drawer uses your store theme color; numbers here are samples.
        </p>
      </CardContent>
    </Card>
  );
}

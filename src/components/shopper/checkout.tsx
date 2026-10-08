"use client";
// ============================================================================
// Shopper — CHECKOUT, MOCK PAYMENT, ORDER STATUS + LOOKUP (Task 2-e).
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  CreditCard,
  Landmark,
  Wallet,
  Smartphone,
  Tag,
  TicketPercent,
  Loader2,
  CheckCircle2,
  XCircle,
  Copy,
  PackageSearch,
  ShoppingBag,
  RotateCcw,
  MapPin,
  User,
  Truck,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  fetchJson,
  postJson,
  notifyCartUpdated,
  useCart,
  EmptyState,
  StatusBadge,
  StatusTimeline,
  type LookupResultT,
  type ShopperCtx,
} from "./ui-bits";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const MY_STATES = [
  "Johor", "Kedah", "Kelantan", "Kuala Lumpur", "Labuan", "Melaka", "Negeri Sembilan",
  "Pahang", "Penang", "Perak", "Perlis", "Putrajaya", "Sabah", "Sarawak", "Selangor", "Terengganu",
];

const PROVIDERS = [
  { id: "fpx_toyyibpay", label: "FPX Online Banking", icon: Landmark },
  { id: "tng", label: "Touch 'n Go eWallet", icon: Smartphone },
  { id: "grabpay", label: "GrabPay", icon: Wallet },
  { id: "card_stripe", label: "Card (Stripe MY)", icon: CreditCard },
];

const PROVIDER_LABEL: Record<string, string> = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.label]));

const SHIPPING = [
  { id: "standard", label: "Standard (2-4 working days)", fee: 800, note: "FREE above RM 100" },
  { id: "express", label: "Express (1-2 working days)", fee: 1500, note: "Flat rate" },
];

type QuoteT = {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  shippingRateId: string;
  coupon: { code: string; valid: boolean; discountMinor?: number; freeShip?: boolean; reason?: string };
  items: { title: string; variantLabel: string | null; qty: number; unitPriceMinor: number; lineTotalMinor: number }[];
};

const CONTACT_KEY = "sm_shopper_contact";
const EMAIL_KEY = "sm_shopper_email";

// =============================================================================================
// CHECKOUT VIEW
// =============================================================================================

export function CheckoutView({ ctx }: { ctx: ShopperCtx }) {
  const { cart, loading: cartLoading } = useCart();
  const items = cart?.items ?? [];

  // prefill contact from a previous checkout (read once at mount)
  const [saved] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(window.localStorage.getItem(CONTACT_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const [name, setName] = useState(() => saved.name ?? "");
  const [email, setEmail] = useState(() => saved.email ?? "");
  const [phone, setPhone] = useState(() => saved.phone ?? "");
  const [line1, setLine1] = useState(() => saved.line1 ?? "");
  const [city, setCity] = useState(() => saved.city ?? "");
  const [stateSel, setStateSel] = useState(() => saved.state ?? "Selangor");
  const [postcode, setPostcode] = useState(() => saved.postcode ?? "");
  const [note, setNote] = useState("");
  const [shippingRateId, setShippingRateId] = useState("standard");
  const [provider, setProvider] = useState("fpx_toyyibpay");
  const [couponInput, setCouponInput] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponErr, setCouponErr] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteT | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  const payloadItems = useMemo(
    () => items.map((i) => ({ variantId: i.variantId, qty: i.qty })),
    [items]
  );

  const refreshQuote = useCallback(
    async (code: string | null) => {
      if (payloadItems.length === 0) return;
      setQuoting(true);
      try {
        const q = await postJson<QuoteT>("/api/checkout/quote", {
          storeSlug: cart?.storeSlug,
          items: payloadItems,
          couponCode: code || undefined,
          shippingRateId,
        });
        setQuote(q);
      } catch {
        setQuote(null);
      } finally {
        setQuoting(false);
      }
    },
    [cart?.storeSlug, payloadItems, shippingRateId]
  );

  // auto-quote on items / shipping change (keeps applied coupon)
  useEffect(() => {
    refreshQuote(couponCode || null);
  }, [refreshQuote, couponCode]);

  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (!code) return;
    setCouponErr(null);
    setQuoting(true);
    try {
      const q = await postJson<QuoteT>("/api/checkout/quote", {
        storeSlug: cart?.storeSlug,
        items: payloadItems,
        couponCode: code,
        shippingRateId,
      });
      if (q.coupon?.valid) {
        setCouponCode(code);
        setQuote(q);
        toast.success(`Coupon ${code} applied`, {
          description: q.coupon.freeShip ? "Free shipping unlocked" : `You save ${formatMinor(q.coupon.discountMinor ?? 0)}`,
        });
      } else {
        setCouponCode("");
        setCouponErr(q.coupon?.reason ?? "Invalid coupon");
      }
    } catch (e) {
      setCouponErr(e instanceof Error ? e.message : "Could not validate coupon");
    } finally {
      setQuoting(false);
    }
  }

  const formValid =
    name.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    line1.trim().length > 0 &&
    city.trim().length > 0 &&
    postcode.trim().length > 0;

  async function placeOrder() {
    setTouched(true);
    if (!formValid || items.length === 0) return;
    setSubmitting(true);
    try {
      const res = await postJson<{ orderNumber: string; orderPaymentRef: string; totalMinor: number }>(
        "/api/checkout/create",
        {
          storeSlug: cart?.storeSlug,
          items: payloadItems,
          customer: { name: name.trim(), email: email.trim(), phone: phone.trim() || undefined },
          shippingAddress: { line1: line1.trim(), city: city.trim(), state: stateSel, postcode: postcode.trim() },
          couponCode: couponCode || undefined,
          provider,
          customerNote: note.trim() || undefined,
        },
        { "Idempotency-Key": crypto.randomUUID() }
      );
      window.localStorage.setItem(CONTACT_KEY, JSON.stringify({ name, email, phone, line1, city, state: stateSel, postcode }));
      window.localStorage.setItem(EMAIL_KEY, email.trim().toLowerCase());
      toast.success(`Order ${res.orderNumber} created`, { description: "Redirecting to secure payment…" });
      ctx.nav({ name: "pay", ref: res.orderPaymentRef });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Checkout failed — please try again");
    } finally {
      setSubmitting(false);
    }
  }

  if (cartLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 flex-1">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex-1">
        <EmptyState
          icon={ShoppingBag}
          title="Your cart is empty"
          hint="Add something lovely from the marketplace or a store first."
          action={
            <Button onClick={() => ctx.nav({ name: "market" })} className="bg-teal-700 hover:bg-teal-800">
              Start shopping
            </Button>
          }
        />
      </div>
    );
  }

  const total = quote?.totalMinor ?? items.reduce((s, i) => s + i.lineTotalMinor, 0);
  const freeShipProgress = Math.min(100, Math.round((items.reduce((s, i) => s + i.lineTotalMinor, 0) / 10000) * 100));

  const field = (label: string, node: React.ReactNode, error?: boolean) => (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-muted-foreground">{label}</Label>
      {node}
      {error ? <p className="text-xs text-rose-600">Required</p> : null}
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 flex-1">
      <h1 className="text-2xl font-extrabold tracking-tight">Checkout</h1>
      <p className="text-sm text-muted-foreground">
        Items from <span className="font-semibold text-teal-700">{cart?.storeName}</span> · one store per order
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        {/* left column */}
        <div className="lg:col-span-3 space-y-6">
          {/* contact */}
          <section className="rounded-xl border bg-card p-5 space-y-4" aria-labelledby="checkout-contact">
            <h2 id="checkout-contact" className="flex items-center gap-2 text-base font-bold">
              <User className="h-4 w-4 text-teal-700" /> Contact
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {field(
                "Full name *",
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Aina Binti Ahmad" className="min-h-[44px]" aria-required />
              )}
              {field(
                "Email *",
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="min-h-[44px]" aria-required />
              )}
              {field("Phone", <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="012-345 6789" className="min-h-[44px]" />)}
            </div>
          </section>

          {/* shipping address */}
          <section className="rounded-xl border bg-card p-5 space-y-4" aria-labelledby="checkout-address">
            <h2 id="checkout-address" className="flex items-center gap-2 text-base font-bold">
              <MapPin className="h-4 w-4 text-teal-700" /> Shipping address
            </h2>
            {field(
              "Street address *",
              <Textarea value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="42 Jalan Merdeka, Taman Setia" rows={2} className="min-h-[44px]" aria-required />
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              {field("City *", <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Kuala Lumpur" className="min-h-[44px]" aria-required />)}
              {field(
                "State *",
                <select
                  value={stateSel}
                  onChange={(e) => setStateSel(e.target.value)}
                  className="flex h-11 min-h-[44px] w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/40"
                  aria-label="State"
                >
                  {MY_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
              {field("Postcode *", <Input value={postcode} onChange={(e) => setPostcode(e.target.value)} inputMode="numeric" placeholder="43650" className="min-h-[44px]" aria-required />)}
            </div>
          </section>

          {/* shipping method */}
          <section className="rounded-xl border bg-card p-5 space-y-3" aria-labelledby="checkout-shipping">
            <h2 id="checkout-shipping" className="flex items-center gap-2 text-base font-bold">
              <Truck className="h-4 w-4 text-teal-700" /> Delivery
            </h2>
            <RadioGroup value={shippingRateId} onValueChange={setShippingRateId} className="gap-2">
              {SHIPPING.map((s) => {
                const free = s.id === "standard" && (quote?.subtotalMinor ?? 0) >= 10000;
                return (
                  <Label
                    key={s.id}
                    htmlFor={`ship-${s.id}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border p-3.5 transition-colors min-h-[44px]",
                      shippingRateId === s.id ? "border-teal-700 bg-teal-50/60" : "hover:bg-muted/50"
                    )}
                  >
                    <RadioGroupItem value={s.id} id={`ship-${s.id}`} />
                    <div className="flex-1">
                      <p className="text-sm font-semibold">{s.label}</p>
                      <p className="text-xs text-muted-foreground">{s.note}</p>
                    </div>
                    <span className="text-sm font-bold text-teal-700">{free ? "FREE" : formatMinor(s.fee)}</span>
                  </Label>
                );
              })}
            </RadioGroup>
            {quote && quote.shippingMinor === 0 && shippingRateId === "standard" ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs font-medium text-emerald-800">
                <ShieldCheck className="h-4 w-4" /> Free standard shipping applied (order above RM 100)
              </div>
            ) : (
              <div className="pt-1">
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${freeShipProgress}%` }} />
                </div>
                <p className="pt-1.5 text-xs text-muted-foreground">
                  {freeShipProgress >= 100 ? "You've unlocked FREE standard shipping!" : `${formatMinor(Math.max(0, 10000 - (quote?.subtotalMinor ?? 0)))} away from FREE standard shipping`}
                </p>
              </div>
            )}
          </section>

          {/* payment method */}
          <section className="rounded-xl border bg-card p-5 space-y-3" aria-labelledby="checkout-payment">
            <h2 id="checkout-payment" className="flex items-center gap-2 text-base font-bold">
              <CreditCard className="h-4 w-4 text-teal-700" /> Payment method
            </h2>
            <RadioGroup value={provider} onValueChange={setProvider} className="gap-2">
              {PROVIDERS.map((p) => (
                <Label
                  key={p.id}
                  htmlFor={`pay-${p.id}`}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border p-3.5 transition-colors min-h-[44px]",
                    provider === p.id ? "border-teal-700 bg-teal-50/60" : "hover:bg-muted/50"
                  )}
                >
                  <RadioGroupItem value={p.id} id={`pay-${p.id}`} />
                  <p.icon className="h-5 w-5 text-teal-700" />
                  <span className="text-sm font-semibold">{p.label}</span>
                </Label>
              ))}
            </RadioGroup>
          </section>
        </div>

        {/* right column — summary */}
        <aside className="lg:col-span-2">
          <div className="rounded-xl border bg-card p-5 space-y-4 lg:sticky lg:top-20">
            <h2 className="text-base font-bold">Order summary</h2>

            <ul className="space-y-3 max-h-64 overflow-y-auto pr-1">
              {items.map((i) => (
                <li key={i.id} className="flex gap-3">
                  <img src={i.imageUrl} alt={i.title} loading="lazy" className="h-14 w-14 rounded-lg border object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-tight line-clamp-2">{i.title}</p>
                    {i.variantLabel ? <p className="text-xs text-muted-foreground">{i.variantLabel}</p> : null}
                    <p className="text-xs text-muted-foreground">Qty {i.qty}</p>
                  </div>
                  <span className="text-sm font-semibold">{formatMinor(i.lineTotalMinor)}</span>
                </li>
              ))}
            </ul>

            {/* coupon */}
            <div className="space-y-1.5">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Tag className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    placeholder="Coupon code"
                    className="pl-8 min-h-[44px]"
                    aria-label="Coupon code"
                    onKeyDown={(e) => e.key === "Enter" && applyCoupon()}
                  />
                </div>
                <Button variant="outline" onClick={applyCoupon} disabled={quoting || !couponInput.trim()} className="min-h-[44px] border-teal-700/40 text-teal-800 hover:bg-teal-50">
                  {quoting ? <Loader2 className="h-4 w-4 animate-spin" /> : <TicketPercent className="h-4 w-4" />} Apply
                </Button>
              </div>
              {couponErr ? <p className="text-xs font-medium text-rose-600">{couponErr}</p> : null}
              {quote?.coupon?.valid ? (
                <p className="text-xs font-medium text-emerald-700">
                  {quote.coupon.code} applied {quote.coupon.freeShip ? "— free shipping" : `— ${formatMinor(quote.coupon.discountMinor ?? 0)} off`}
                </p>
              ) : null}
            </div>

            <Separator />

            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="font-semibold">{formatMinor(quote?.subtotalMinor ?? 0)}</dd>
              </div>
              {quote && quote.discountMinor > 0 ? (
                <div className="flex justify-between text-emerald-700">
                  <dt>Discount</dt>
                  <dd className="font-semibold">-{formatMinor(quote.discountMinor)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Shipping</dt>
                <dd className="font-semibold">{quote?.shippingMinor === 0 ? "FREE" : formatMinor(quote?.shippingMinor ?? 0)}</dd>
              </div>
              <Separator />
              <div className="flex justify-between text-base">
                <dt className="font-bold">Total</dt>
                <dd className="font-extrabold text-teal-700">{formatMinor(total)}</dd>
              </div>
            </dl>

            {/* note */}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to seller (optional)" rows={2} className="min-h-[44px] text-sm" />

            {touched && !formValid ? (
              <p className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-medium text-rose-700">
                Please fill in the required fields (name, email, address, city, postcode).
              </p>
            ) : null}

            <Button
              size="lg"
              onClick={placeOrder}
              disabled={submitting || quoting}
              className="w-full min-h-[48px] bg-teal-700 text-white hover:bg-teal-800"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {submitting ? "Creating order…" : `Pay ${formatMinor(total)}`}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">Sandbox demo — no real money moves.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

// =============================================================================================
// MOCK PAYMENT VIEW
// =============================================================================================

type PaymentT = {
  status: string;
  orderNumber: string;
  amountMinor: number;
  storeName: string;
  storeSlug: string;
  provider: string;
};

export function PayView({ ctx, paymentRef }: { ctx: ShopperCtx; paymentRef: string }) {
  const [payment, setPayment] = useState<PaymentT | null>(null);
  const [failed, setFailed] = useState(false);
  const [phase, setPhase] = useState<"awaiting" | "success" | "failure">("awaiting");
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(10 * 60);

  const load = useCallback(async () => {
    try {
      const p = await fetchJson<PaymentT>(`/api/checkout/payments/${encodeURIComponent(paymentRef)}`);
      setPayment(p);
      setFailed(false);
      if (p.status === "succeeded") {
        setPhase((ph) => (ph === "awaiting" ? "success" : ph));
      } else if (p.status === "failed") {
        setPhase((ph) => (ph === "awaiting" ? "failure" : ph));
      }
    } catch {
      setFailed(true);
    }
  }, [paymentRef]);

  // initial load + 3s polling for external status changes
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  // 10:00 countdown
  useEffect(() => {
    if (phase !== "awaiting") return;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const navToOrder = useCallback(
    (orderNumber: string) => ctx.nav({ name: "order-status", orderNumber }),
    [ctx]
  );

  // auto-redirect after success
  const orderNumber = payment?.orderNumber ?? "";
  useEffect(() => {
    if (phase !== "success") return;
    const t = setTimeout(() => navToOrder(orderNumber), 1600);
    return () => clearTimeout(t);
  }, [phase, orderNumber, navToOrder]);

  async function simulate(result: "succeeded" | "failed") {
    setBusy(true);
    try {
      await postJson<{ status: string; orderNumber: string }>(
        `/api/checkout/payments/${encodeURIComponent(paymentRef)}/simulate`,
        { result }
      );
      if (result === "succeeded") {
        // empty the guest cart — the order is placed
        try {
          const { cart } = await fetchJson<{ cart: { items: { id: string }[] } | null }>("/api/cart");
          for (const it of cart?.items ?? []) await fetchJson(`/api/cart/items/${it.id}`, { method: "DELETE" });
        } catch {
          /* best effort */
        }
        notifyCartUpdated();
        setPhase("success");
      } else {
        setPhase("failure");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Payment simulation failed");
    } finally {
      setBusy(false);
    }
  }

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="flex-1 flex items-start sm:items-center justify-center px-4 py-8 sm:py-12" style={{ background: "linear-gradient(180deg, #f0fdfa 0%, #ffffff 40%)" }}>
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="w-full max-w-md">
        <div className="overflow-hidden rounded-2xl border shadow-lg bg-card">
          {/* gateway chrome */}
          <div className="bg-teal-900 px-5 py-4 text-white">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm font-bold tracking-wide">
                <ShieldCheck className="h-4 w-4 text-emerald-300" /> SHOPMESH Secure Checkout
              </p>
              <span className="rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-teal-950">Demo</span>
            </div>
            <p className="pt-1 text-xs text-teal-100/80">256-bit encrypted · sandbox environment</p>
          </div>

          {failed ? (
            <div className="p-8 text-center space-y-3">
              <XCircle className="mx-auto h-10 w-10 text-rose-500" />
              <p className="font-semibold">Payment session not found</p>
              <p className="text-sm text-muted-foreground">This payment reference may have expired.</p>
              <Button variant="outline" onClick={() => ctx.nav({ name: "market" })}>Back to market</Button>
            </div>
          ) : !payment ? (
            <div className="p-8 space-y-4">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : phase === "success" ? (
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="p-8 text-center space-y-3">
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 16 }} className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
                <CheckCircle2 className="h-9 w-9 text-emerald-600" />
              </motion.div>
              <p className="text-lg font-extrabold">Payment successful!</p>
              <p className="text-sm text-muted-foreground">Order {payment.orderNumber} is confirmed.</p>
              <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Taking you to your order…</p>
            </motion.div>
          ) : phase === "failure" ? (
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="p-8 text-center space-y-3">
              <XCircle className="mx-auto h-12 w-12 text-rose-500" />
              <p className="text-lg font-extrabold">Payment failed</p>
              <p className="text-sm text-muted-foreground">No money was taken. You can retry the payment or head back to the store.</p>
              <div className="grid gap-2 pt-2">
                <Button onClick={() => setPhase("awaiting")} disabled={busy} className="min-h-[44px] bg-teal-700 hover:bg-teal-800 text-white">
                  <RotateCcw className="h-4 w-4" /> Retry payment
                </Button>
                <Button variant="outline" onClick={() => ctx.nav({ name: "storefront", slug: payment.storeSlug })} className="min-h-[44px]">
                  Back to store
                </Button>
              </div>
            </motion.div>
          ) : (
            <div className="p-6 sm:p-8 space-y-5">
              <div className="text-center space-y-1">
                <p className="text-xs uppercase tracking-widest text-muted-foreground">Amount to pay</p>
                <p className="text-4xl font-extrabold tabular-nums text-teal-800">{formatMinor(payment.amountMinor)}</p>
                <p className="text-sm text-muted-foreground">
                  to <span className="font-semibold text-foreground">{payment.storeName}</span>
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-muted/70 px-4 py-3 text-sm">
                <span className="text-muted-foreground">Method</span>
                <span className="font-semibold">{PROVIDER_LABEL[payment.provider] ?? payment.provider}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted/70 px-4 py-3 text-sm">
                <span className="text-muted-foreground">Order</span>
                <span className="font-mono font-semibold">{payment.orderNumber}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted/70 px-4 py-3 text-sm">
                <span className="text-muted-foreground">Session expires in</span>
                <span className={cn("font-mono font-bold tabular-nums", secondsLeft < 60 ? "text-rose-600" : "text-foreground")}>
                  {mm}:{ss}
                </span>
              </div>

              <Button
                size="lg"
                disabled={busy}
                onClick={() => simulate("succeeded")}
                className="w-full min-h-[48px] bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Landmark className="h-4 w-4" />}
                {busy ? "Processing…" : "Pay Now"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => simulate("failed")}
                className="w-full min-h-[40px] border-rose-300 text-rose-600 hover:bg-rose-50"
              >
                Simulate failure
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">Sandbox demo — no real money moves.</p>
            </div>
          )}
        </div>

        {payment && phase === "awaiting" ? (
          <button type="button" onClick={() => ctx.nav({ name: "storefront", slug: payment.storeSlug })} className="mx-auto mt-4 block text-xs text-muted-foreground underline-offset-2 hover:underline">
            Cancel and return to {payment.storeName}
          </button>
        ) : null}
      </motion.div>
    </div>
  );
}

// =============================================================================================
// ORDER STATUS + LOOKUP
// =============================================================================================

function OrderCard({ o, compact = false }: { o: LookupResultT; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const paid = !["payment_pending", "cancelled"].includes(o.status);

  function copy() {
    navigator.clipboard?.writeText(o.orderNumber).then(
      () => {
        setCopied(true);
        toast.success("Order number copied");
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error("Could not copy")
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className={cn("rounded-2xl border bg-card p-5 sm:p-6 space-y-5", compact && "shadow-sm")}>
      <div className="flex items-start gap-4">
        <motion.div
          initial={{ scale: 0, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 14 }}
          className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-full", paid ? "bg-emerald-100" : "bg-amber-100")}
        >
          {paid ? <CheckCircle2 className="h-7 w-7 text-emerald-600" /> : <PackageSearch className="h-7 w-7 text-amber-600" />}
        </motion.div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Order</p>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xl font-extrabold font-mono tracking-tight">{o.orderNumber}</p>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={copy} aria-label="Copy order number">
              {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {o.storeName} · placed {new Date(o.createdAt).toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short" })}
          </p>
          <div className="pt-2">
            <StatusBadge status={o.status} />
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Total</p>
          <p className="text-lg font-extrabold text-teal-700">{formatMinor(o.totalMinor)}</p>
        </div>
      </div>

      <Separator />

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="pb-3 text-sm font-bold uppercase tracking-wide text-muted-foreground">Items</h3>
          <ul className="space-y-2">
            {o.items.map((it, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {it.title} <span className="text-muted-foreground">× {it.qty}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="pb-3 text-sm font-bold uppercase tracking-wide text-muted-foreground">Progress</h3>
          <StatusTimeline history={o.history} current={o.status} />
        </div>
      </div>
    </motion.div>
  );
}

export function OrderStatusView({ ctx, orderNumber }: { ctx: ShopperCtx; orderNumber: string }) {
  const [email] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem(EMAIL_KEY) ?? "" : ""));
  const [data, setData] = useState<LookupResultT | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!email) return;
    let alive = true;
    fetchJson<LookupResultT>(`/api/orders/lookup?email=${encodeURIComponent(email)}&orderNumber=${encodeURIComponent(orderNumber)}`)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: Error) => {
        if (alive) setFailed(e.message);
      });
    return () => {
      alive = false;
    };
  }, [email, orderNumber]);

  if (!email) {
    return (
      <div className="flex-1">
        <EmptyState
          title="No checkout email found"
          hint="We couldn't find a recent checkout on this device. Use order lookup with your email and order number instead."
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => ctx.nav({ name: "lookup" })} className="min-h-[44px]">
                Order lookup
              </Button>
              <Button onClick={() => ctx.nav({ name: "market" })} className="min-h-[44px] bg-teal-700 hover:bg-teal-800">
                Continue shopping
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 flex-1">
      {failed ? (
        <EmptyState
          title="Couldn't load this order"
          hint={failed}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => ctx.nav({ name: "lookup" })}>Order lookup</Button>
              <Button onClick={() => ctx.nav({ name: "market" })} className="bg-teal-700 hover:bg-teal-800">Continue shopping</Button>
            </div>
          }
        />
      ) : !data ? (
        <div className="space-y-4">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-5">
          <OrderCard o={data} />
          <div className="flex justify-center gap-3">
            <Button onClick={() => ctx.nav({ name: "market" })} className="min-h-[44px] bg-teal-700 hover:bg-teal-800 text-white">
              Continue shopping
            </Button>
            <Button variant="outline" onClick={() => ctx.nav({ name: "lookup" })} className="min-h-[44px]">
              Track another order
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function LookupView({ ctx }: { ctx: ShopperCtx }) {
  const [email, setEmail] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem(EMAIL_KEY) ?? "" : ""));
  const [orderNumber, setOrderNumber] = useState("");
  const [result, setResult] = useState<LookupResultT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (!email.trim() || !orderNumber.trim()) {
      setError("Both email and order number are required.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await fetchJson<LookupResultT>(
        `/api/orders/lookup?email=${encodeURIComponent(email.trim())}&orderNumber=${encodeURIComponent(orderNumber.trim())}`
      );
      setResult(data);
      window.localStorage.setItem(EMAIL_KEY, email.trim().toLowerCase());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 flex-1">
      <div className="rounded-2xl border bg-card p-5 sm:p-6 space-y-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
            <PackageSearch className="h-5 w-5 text-teal-700" /> Track your order
          </h1>
          <p className="text-sm text-muted-foreground">Enter the email you checked out with and your order number (e.g. SM-100017).</p>
        </div>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="lk-email" className="text-xs font-semibold text-muted-foreground">Email</Label>
            <Input id="lk-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lk-num" className="text-xs font-semibold text-muted-foreground">Order number</Label>
            <Input id="lk-num" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="SM-100017" className="min-h-[44px] font-mono" />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy} className="w-full sm:w-auto min-h-[44px] bg-teal-700 hover:bg-teal-800 text-white">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageSearch className="h-4 w-4" />} Find my order
            </Button>
          </div>
        </form>
        {error ? (
          <p className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2.5 text-sm text-rose-700">
            {error.includes("No order") ? "We couldn't find an order with those details. Double-check the email and order number." : error}
          </p>
        ) : null}
      </div>

      {result ? (
        <div className="pt-5">
          <OrderCard o={result} compact />
        </div>
      ) : null}
    </div>
  );
}

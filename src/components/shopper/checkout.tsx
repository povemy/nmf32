"use client";
// ============================================================================
// Shopper — THREE-PHASE CHECKOUT (Information → Delivery → Payment), sandbox
// payment, order status, order history + lookup. All totals, delivery options
// and stock come from the server (/api/checkout/quote) — never from the client.
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
  Clock,
  Copy,
  MessagesSquare,
  ReceiptText,
  PackageSearch,
  ShoppingBag,
  RotateCcw,
  MapPin,
  Pencil,
  Trash2,
  Plus,
  Check,
  User,
  Truck,
  ShieldCheck,
  Star,
  LogIn,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/lib/app-store";
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
  patchJson,
  deleteJson,
  notifyCartUpdated,
  trackOrderRef,
  readOrderRefs,
  useCart,
  EmptyState,
  StatusBadge,
  StatusTimeline,
  ApiFail,
  dateShort,
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()\d\s-]{6,20}$/;
const POSTCODE_RE = /^\d{5}$/;

// ---------------------------------------------------------------------------
// checkout draft — one shared state for all three phases, persisted to
// sessionStorage so navigation away/back (and refreshes) never lose input.
// ---------------------------------------------------------------------------

type DraftT = {
  phase: 1 | 2 | 3;
  name: string;
  email: string;
  phone: string;
  addressId: string | null;
  shippingRateId: string;
  provider: string;
  couponCode: string;
  note: string;
  agreed: boolean;
  idemKey: string;
};

const DRAFT_KEY = "sm_checkout_draft";
const CONTACT_KEY = "sm_shopper_contact";
const EMAIL_KEY = "sm_shopper_email";

function makeIdemKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `idem_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

function loadDraft(): DraftT {
  const savedContact: Record<string, string> = (() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(window.localStorage.getItem(CONTACT_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  })();
  const base: DraftT = {
    phase: 1,
    name: savedContact.name ?? "",
    email: savedContact.email ?? "",
    phone: savedContact.phone ?? "",
    addressId: null,
    shippingRateId: "standard",
    provider: "fpx_toyyibpay",
    couponCode: "",
    note: "",
    agreed: false,
    idemKey: makeIdemKey(),
  };
  if (typeof window === "undefined") return base;
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? "{}") as Partial<DraftT>;
    return {
      ...base,
      ...raw,
      phase: raw.phase === 2 || raw.phase === 3 ? raw.phase : 1,
      idemKey: raw.idemKey || base.idemKey, // stable across retries → idempotent resubmits
    };
  } catch {
    return base;
  }
}

function persistDraft(d: DraftT) {
  if (typeof window !== "undefined") window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
}

function clearDraft() {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(DRAFT_KEY);
}

// ---------------------------------------------------------------------------
// server types
// ---------------------------------------------------------------------------

type ShippingOptionT = {
  id: string;
  label: string;
  eta: string;
  amountMinor: number;
  freeShipping: boolean;
  available: boolean;
  reason: string | null;
};

type QuoteT = {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  shippingRateId: string;
  coupon: { code: string; valid: boolean; discountMinor?: number; freeShip?: boolean; reason?: string };
  items: { title: string; variantLabel: string | null; qty: number; unitPriceMinor: number; lineTotalMinor: number; stock: number }[];
  shippingOptions?: ShippingOptionT[];
};

type AddressT = {
  id: string;
  label: string;
  name: string;
  phone: string | null;
  line1: string;
  city: string;
  state: string;
  postcode: string;
  isDefault: boolean;
};

// =============================================================================================
// PROGRESS STEPPER
// =============================================================================================

const STEPS = [
  { n: 1 as const, label: "Information", icon: User },
  { n: 2 as const, label: "Delivery", icon: Truck },
  { n: 3 as const, label: "Payment", icon: CreditCard },
];

function Stepper({ phase, onJump }: { phase: 1 | 2 | 3; onJump: (n: 1 | 2) => void }) {
  return (
    <ol className="flex min-w-0 items-center gap-2 overflow-hidden sm:gap-3" aria-label="Checkout progress">
      {STEPS.map((s, i) => {
        const done = phase > s.n;
        const current = phase === s.n;
        return (
          <li key={s.n} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none sm:gap-3">
            <button
              type="button"
              disabled={!done}
              onClick={() => done && onJump(s.n)}
              className="flex min-w-0 items-center gap-2 disabled:cursor-default"
              aria-current={current ? "step" : undefined}
              aria-label={`Step ${s.n}: ${s.label}${done ? " (completed — click to edit)" : ""}`}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors",
                  done && "border-transparent bg-brand-gradient text-white shadow-sm",
                  current && "border-teal-600 bg-teal-50 text-teal-700",
                  !done && !current && "border-muted-foreground/25 bg-card text-muted-foreground"
                )}
              >
                {done ? <Check className="h-4 w-4" aria-hidden="true" /> : s.n}
              </span>
              <span
                className={cn(
                  "truncate text-xs font-bold sm:text-sm",
                  current ? "text-teal-800" : done ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {s.label}
              </span>
            </button>
            {i < STEPS.length - 1 ? (
              <span className={cn("h-0.5 min-w-4 flex-1 rounded-full", phase > s.n ? "bg-brand-gradient" : "bg-border")} aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// =============================================================================================
// ADDRESS BOOK (guest device-scoped, persisted via /api/checkout/addresses)
// =============================================================================================

const emptyForm = { label: "Home", name: "", phone: "", line1: "", city: "", state: "Selangor", postcode: "", isDefault: false };

function AddressFormFields({
  form,
  setForm,
  errors,
}: {
  form: typeof emptyForm;
  setForm: (f: typeof emptyForm) => void;
  errors: Record<string, string | null>;
}) {
  const f = (label: string, node: React.ReactNode, err?: string | null, required = true) => (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-muted-foreground">{label}{required ? " *" : ""}</Label>
      {node}
      {err ? <p className="text-xs font-medium text-rose-600">{err}</p> : null}
    </div>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {f("Label", <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Home / Office" className="min-h-[44px]" required={false} />)}
      {f("Recipient name", <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Aina Binti Ahmad" className="min-h-[44px]" />, errors.name)}
      {f("Phone", <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="012-345 6789" className="min-h-[44px]" required={false} />, errors.phone)}
      {f("Postcode", <Input value={form.postcode} onChange={(e) => setForm({ ...form, postcode: e.target.value.replace(/\D/g, "").slice(0, 5) })} inputMode="numeric" placeholder="43650" className="min-h-[44px]" />, errors.postcode)}
      <div className="sm:col-span-2">
        {f("Street address", <Textarea value={form.line1} onChange={(e) => setForm({ ...form, line1: e.target.value })} placeholder="42 Jalan Merdeka, Taman Setia" rows={2} className="min-h-[44px]" />, errors.line1)}
      </div>
      {f("City", <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Kuala Lumpur" className="min-h-[44px]" />, errors.city)}
      {f(
        "State",
        <select
          value={form.state}
          onChange={(e) => setForm({ ...form, state: e.target.value })}
          className="flex h-11 min-h-[44px] w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/40"
          aria-label="State"
        >
          {MY_STATES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>,
        errors.state
      )}
    </div>
  );
}

function validateForm(form: typeof emptyForm): Record<string, string | null> {
  return {
    name: form.name.trim().length >= 2 ? null : "Recipient name is required",
    phone: !form.phone.trim() || PHONE_RE.test(form.phone.trim()) ? null : "Enter a valid phone number",
    line1: form.line1.trim() ? null : "Street address is required",
    city: form.city.trim() ? null : "City is required",
    state: form.state ? null : "State is required",
    postcode: POSTCODE_RE.test(form.postcode.trim()) ? null : "5-digit postcode required",
  };
}

// =============================================================================================
// CHECKOUT VIEW — three phases
// =============================================================================================

export function CheckoutView({ ctx }: { ctx: ShopperCtx }) {
  const { cart, loading: cartLoading, refresh: refreshCart } = useCart();
  const items = cart?.items ?? [];

  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const shopper = me.loaded ? me.shopper : null;

  const [draft, setDraft] = useState<DraftT>(loadDraft);
  useEffect(() => persistDraft(draft), [draft]);

  // Contact details come from the ACCOUNT (carts/checkout are account-scoped);
  // only fill blanks so the shopper can still override per-order (gifts etc.).
  useEffect(() => {
    if (!shopper) return;
    setDraft((d) => ({
      ...d,
      name: d.name.trim() || shopper.fullName,
      email: d.email.trim() || shopper.email,
      phone: d.phone.trim() || shopper.phone || "",
    }));
  }, [shopper]);

  const [addresses, setAddresses] = useState<AddressT[] | null>(null);
  const [addressesLoading, setAddressesLoading] = useState(true);
  const [formMode, setFormMode] = useState<null | { kind: "new" } | { kind: "edit"; address: AddressT }>(null);
  const [form, setForm] = useState(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string | null>>({});
  const [formBusy, setFormBusy] = useState(false);
  const [deleteArm, setDeleteArm] = useState<string | null>(null);

  const [quote, setQuote] = useState<QuoteT | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [couponInput, setCouponInput] = useState("");
  const [couponErr, setCouponErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const selectedAddr = useMemo(
    () => addresses?.find((a) => a.id === draft.addressId) ?? null,
    [addresses, draft.addressId]
  );

  // load the device address book once
  useEffect(() => {
    let alive = true;
    fetchJson<{ addresses: AddressT[] }>("/api/checkout/addresses")
      .then((d) => {
        if (!alive) return;
        setAddresses(d.addresses);
        setDraft((dft) => {
          if (dft.addressId && d.addresses.some((a) => a.id === dft.addressId)) return dft;
          const def = d.addresses.find((a) => a.isDefault) ?? d.addresses[0];
          return def ? { ...dft, addressId: def.id } : dft;
        });
      })
      .catch(() => alive && setAddresses([]))
      .finally(() => alive && setAddressesLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const payloadItems = useMemo(() => items.map((i) => ({ variantId: i.variantId, qty: i.qty })), [items]);
  const destState = selectedAddr?.state ?? null;

  const refreshQuote = useCallback(
    async (code: string, rateId: string, state: string | null) => {
      if (payloadItems.length === 0) return;
      setQuoting(true);
      try {
        const q = await postJson<QuoteT>("/api/checkout/quote", {
          storeSlug: cart?.storeSlug,
          items: payloadItems,
          couponCode: code || undefined,
          shippingRateId: rateId,
          state: state ?? undefined,
        });
        setQuote(q);
      } catch {
        setQuote(null);
      } finally {
        setQuoting(false);
      }
    },
    [cart?.storeSlug, payloadItems]
  );

  // auto-quote on cart / shipping / destination / coupon change
  useEffect(() => {
    refreshQuote(draft.couponCode, draft.shippingRateId, destState);
  }, [refreshQuote, draft.couponCode, draft.shippingRateId, destState]);

  // delivery option became invalid for this destination → fall back to Standard (server rule)
  useEffect(() => {
    if (!quote?.shippingOptions) return;
    const sel = quote.shippingOptions.find((o) => o.id === draft.shippingRateId);
    if (sel && !sel.available) {
      setDraft((d) => ({ ...d, shippingRateId: "standard" }));
      toast.error(sel.reason ?? "Selected delivery is unavailable — switched to Standard");
    }
  }, [quote, draft.shippingRateId]);

  const stockIssues = useMemo(
    () => (quote?.items ?? []).filter((i) => i.qty > i.stock),
    [quote]
  );

  // ------------------------------------------------------------- coupon
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
        shippingRateId: draft.shippingRateId,
        state: destState ?? undefined,
      });
      if (q.coupon?.valid) {
        setDraft((d) => ({ ...d, couponCode: code }));
        setQuote(q);
        toast.success(`Coupon ${code} applied`, {
          description: q.coupon.freeShip ? "Free shipping unlocked" : `You save ${formatMinor(q.coupon.discountMinor ?? 0)}`,
        });
      } else {
        setCouponErr(q.coupon?.reason ?? "Invalid coupon");
      }
    } catch (e) {
      setCouponErr(e instanceof Error ? e.message : "Could not validate coupon");
    } finally {
      setQuoting(false);
    }
  }

  function removeCoupon() {
    setDraft((d) => ({ ...d, couponCode: "" }));
    setCouponInput("");
    setCouponErr(null);
  }

  // ------------------------------------------------------------- address book ops
  async function saveAddress() {
    const errs = validateForm(form);
    setFormErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    setFormBusy(true);
    try {
      const payload = { ...form, name: form.name.trim(), line1: form.line1.trim(), city: form.city.trim(), postcode: form.postcode.trim() };
      const res =
        formMode?.kind === "edit"
          ? await patchJson<{ address: AddressT; addresses: AddressT[] }>(`/api/checkout/addresses/${formMode.address.id}`, payload)
          : await postJson<{ address: AddressT; addresses: AddressT[] }>("/api/checkout/addresses", payload);
      setAddresses(res.addresses);
      setDraft((d) => ({ ...d, addressId: res.address.id }));
      setFormMode(null);
      setForm(emptyForm);
      window.dispatchEvent(new Event("shopmesh:addresses-changed"));
      toast.success(formMode?.kind === "edit" ? "Address updated" : "Address saved", {
        description: `${res.address.line1}, ${res.address.city} ${res.address.postcode}`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save address");
    } finally {
      setFormBusy(false);
    }
  }

  async function removeAddress(id: string) {
    try {
      const res = await deleteJson<{ addresses: AddressT[] }>(`/api/checkout/addresses/${id}`);
      setAddresses(res.addresses);
      setDeleteArm(null);
      setDraft((d) => (d.addressId === id ? { ...d, addressId: res.addresses.find((a) => a.isDefault)?.id ?? res.addresses[0]?.id ?? null } : d));
      window.dispatchEvent(new Event("shopmesh:addresses-changed"));
      toast.success("Address removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove address");
    }
  }

  async function makeDefault(id: string) {
    try {
      const res = await patchJson<{ addresses: AddressT[] }>(`/api/checkout/addresses/${id}`, { isDefault: true });
      setAddresses(res.addresses);
      window.dispatchEvent(new Event("shopmesh:addresses-changed"));
      toast.success("Default address updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update address");
    }
  }

  // ------------------------------------------------------------- phase validation
  const contactErrors = {
    name: draft.name.trim().length >= 2 ? null : "Full name is required",
    email: EMAIL_RE.test(draft.email.trim()) ? null : "Enter a valid email address",
    phone: !draft.phone.trim() || PHONE_RE.test(draft.phone.trim()) ? null : "Enter a valid phone number",
  };
  const contactValid = !Object.values(contactErrors).some(Boolean);
  const addressPicked = !!selectedAddr;
  const phase1Valid = contactValid && addressPicked;

  function goToDelivery() {
    setTried(true);
    if (!phase1Valid) {
      if (!addressPicked) toast.error("Choose or save a delivery address first");
      return;
    }
    setTried(false);
    setDraft((d) => ({ ...d, phase: 2 }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goToPayment() {
    const sel = quote?.shippingOptions?.find((o) => o.id === draft.shippingRateId);
    if (sel && !sel.available) {
      toast.error(sel.reason ?? "Please pick an available delivery option");
      return;
    }
    setDraft((d) => ({ ...d, phase: 3 }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ------------------------------------------------------------- place order
  async function placeOrder() {
    if (submitting) return; // double-tap guard
    setTried(true);
    if (!quote || !selectedAddr || items.length === 0) return;
    if (stockIssues.length > 0) {
      toast.error("Some items exceed available stock — please update your cart");
      return;
    }
    if (!draft.agreed) {
      toast.error("Please accept the terms to place your order");
      return;
    }
    setSubmitting(true);
    try {
      const res = await postJson<{ orderNumber: string; orderPaymentRef: string; totalMinor: number }>(
        "/api/checkout/create",
        {
          storeSlug: cart?.storeSlug,
          items: payloadItems,
          customer: { name: draft.name.trim(), email: draft.email.trim(), phone: draft.phone.trim() || undefined },
          shippingAddress: {
            line1: selectedAddr.line1,
            city: selectedAddr.city,
            state: selectedAddr.state,
            postcode: selectedAddr.postcode,
          },
          couponCode: draft.couponCode || undefined,
          shippingRateId: draft.shippingRateId,
          provider: draft.provider,
          customerNote: draft.note.trim() || undefined,
        },
        { "Idempotency-Key": draft.idemKey } // stable per checkout session → safe retries
      );
      trackOrderRef(res.orderNumber, draft.email.trim().toLowerCase());
      try {
        window.localStorage.setItem(CONTACT_KEY, JSON.stringify({ name: draft.name, email: draft.email, phone: draft.phone }));
        window.localStorage.setItem(EMAIL_KEY, draft.email.trim().toLowerCase());
      } catch {
        /* storage full — non-critical */
      }
      clearDraft();
      toast.success(`Order ${res.orderNumber} created`, { description: "Redirecting to secure payment…" });
      ctx.nav({ name: "pay", ref: res.orderPaymentRef });
    } catch (e) {
      if (e instanceof ApiFail && e.code === "SHIPPING_UNAVAILABLE") {
        setDraft((d) => ({ ...d, phase: 2 }));
      }
      if (e instanceof ApiFail && e.code === "OUT_OF_STOCK") {
        refreshCart();
      }
      toast.error(e instanceof Error ? e.message : "Checkout failed — please try again");
    } finally {
      setSubmitting(false);
    }
  }

  // ------------------------------------------------------------- guards
  if (cartLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Skeleton className="mb-6 h-8 w-48" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
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
            <Button onClick={() => ctx.nav({ name: "market" })} className="bg-brand-gradient-deep hover:brightness-110">
              Start shopping
            </Button>
          }
        />
      </div>
    );
  }

  // Checkout is account-only — carts, addresses and orders all live on the account.
  if (!shopper) {
    return (
      <div className="flex-1">
        <EmptyState
          icon={LogIn}
          title="Sign in to check out"
          hint="Your cart, saved addresses and orders are tied to your SHOPMESH account so they follow you on every device."
          action={
            <Button
              onClick={() => openShopperAuth()}
              className="min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110 gap-2"
            >
              <LogIn className="h-4 w-4" /> Sign in or create account
            </Button>
          }
        />
      </div>
    );
  }

  const subtotal = quote?.subtotalMinor ?? items.reduce((s, i) => s + i.lineTotalMinor, 0);
  const freeShipProgress = Math.min(100, Math.round((subtotal / 10000) * 100));
  const field = (label: string, node: React.ReactNode, err?: string | null) => (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-muted-foreground">{label}</Label>
      {node}
      {err ? <p className="text-xs font-medium text-rose-600">{err}</p> : null}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <h1 className="text-2xl font-extrabold tracking-tight">Checkout</h1>
      <p className="text-sm text-muted-foreground">
        Items from <span className="font-semibold text-teal-700">{cart?.storeName}</span> · one store per order
      </p>

      <div className="mt-5 rounded-xl border bg-card p-4 shadow-soft sm:px-6">
        <Stepper phase={draft.phase} onJump={(n) => setDraft((d) => ({ ...d, phase: n }))} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        {/* left column — phases */}
        <div className="space-y-6 lg:col-span-3">
          {/* ============================ PHASE 1: INFORMATION ============================ */}
          {draft.phase === 1 ? (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="space-y-6">
              <section className="space-y-4 rounded-xl border bg-card p-5 shadow-soft" aria-labelledby="checkout-contact">
                <h2 id="checkout-contact" className="flex items-center gap-2 text-base font-bold">
                  <User className="h-4 w-4 text-teal-700" /> Contact
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {field("Full name *", <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Aina Binti Ahmad" className="min-h-[44px]" aria-required />, (tried || draft.name.length > 0) && contactErrors.name)}
                  {field("Email *", <Input type="email" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} placeholder="you@example.com" className="min-h-[44px]" aria-required />, (tried || draft.email.length > 0) && contactErrors.email)}
                  <div className="sm:col-span-2">
                    {field("Phone (optional)", <Input value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} placeholder="012-345 6789" className="min-h-[44px]" />, tried && contactErrors.phone)}
                  </div>
                </div>
              </section>

              <section className="space-y-4 rounded-xl border bg-card p-5 shadow-soft" aria-labelledby="checkout-addresses">
                <div className="flex items-center justify-between gap-2">
                  <h2 id="checkout-addresses" className="flex items-center gap-2 text-base font-bold">
                    <MapPin className="h-4 w-4 text-teal-700" /> Delivery address
                  </h2>
                  {!formMode ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-[40px] border-teal-700/40 text-teal-800 hover:bg-teal-50"
                      onClick={() => {
                        setForm(emptyForm);
                        setFormErrors({});
                        setFormMode({ kind: "new" });
                      }}
                    >
                      <Plus className="h-4 w-4" /> Add address
                    </Button>
                  ) : null}
                </div>

                {addressesLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-20 rounded-lg" />
                    <Skeleton className="h-20 rounded-lg" />
                  </div>
                ) : (addresses?.length ?? 0) === 0 && !formMode ? (
                  <p className="rounded-lg border border-dashed border-teal-700/25 bg-teal-50/50 px-4 py-6 text-center text-sm text-muted-foreground">
                    No saved addresses yet — add one to continue.
                  </p>
                ) : null}

                {addresses && addresses.length > 0 ? (
                  <RadioGroup
                    value={draft.addressId ?? ""}
                    onValueChange={(v) => setDraft((d) => ({ ...d, addressId: v }))}
                    className="gap-2"
                  >
                    {addresses.map((a) => (
                      <div
                        key={a.id}
                        className={cn(
                          "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border p-3.5 transition-colors",
                          draft.addressId === a.id ? "border-teal-600 bg-teal-50/60" : "hover:bg-muted/50"
                        )}
                      >
                        <RadioGroupItem value={a.id} id={`addr-${a.id}`} className="mt-1" />
                        <Label htmlFor={`addr-${a.id}`} className="min-w-0 flex-1 cursor-pointer space-y-0.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-teal-800">{a.label}</span>
                            {a.isDefault ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                                <Star className="h-3 w-3" /> Default
                              </span>
                            ) : null}
                            <span className="text-sm font-semibold">{a.name}</span>
                            {a.phone ? <span className="text-xs text-muted-foreground">· {a.phone}</span> : null}
                          </span>
                          <span className="block text-sm text-muted-foreground">
                            {a.line1}, {a.city}, {a.state} {a.postcode}
                          </span>
                        </Label>
                        <div className="flex w-full items-center gap-1 sm:ml-auto sm:w-auto">
                          {!a.isDefault ? (
                            <Button variant="ghost" size="sm" className="h-8 min-h-[36px] px-2 text-xs text-muted-foreground" onClick={() => makeDefault(a.id)} aria-label={`Set ${a.label} as default address`}>
                              Set default
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={`Edit ${a.label} address`}
                            onClick={() => {
                              setForm({
                                label: a.label,
                                name: a.name,
                                phone: a.phone ?? "",
                                line1: a.line1,
                                city: a.city,
                                state: a.state,
                                postcode: a.postcode,
                                isDefault: a.isDefault,
                              });
                              setFormErrors({});
                              setFormMode({ kind: "edit", address: a });
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {deleteArm === a.id ? (
                            <Button variant="ghost" size="sm" className="h-8 min-h-[36px] px-2 text-xs font-bold text-rose-600 hover:bg-rose-50" onClick={() => removeAddress(a.id)}>
                              Confirm
                            </Button>
                          ) : (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:bg-rose-50 hover:text-rose-600" aria-label={`Delete ${a.label} address`} onClick={() => setDeleteArm(a.id)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </RadioGroup>
                ) : null}

                {formMode ? (
                  <div className="space-y-3 rounded-lg border border-teal-700/25 bg-teal-50/40 p-4">
                    <p className="text-sm font-bold">{formMode.kind === "edit" ? "Edit address" : "New address"}</p>
                    <AddressFormFields form={form} setForm={setForm} errors={formErrors} />
                    <div className="flex items-center gap-2">
                      <input
                        id="addr-default"
                        type="checkbox"
                        checked={form.isDefault}
                        onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
                        className="h-4 w-4 rounded border-input accent-teal-700"
                      />
                      <Label htmlFor="addr-default" className="text-sm font-normal">Set as default address</Label>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button onClick={saveAddress} disabled={formBusy} className="min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110">
                        {formBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save address
                      </Button>
                      <Button variant="outline" onClick={() => { setFormMode(null); setFormErrors({}); }} className="min-h-[44px]">
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>

              {tried && !phase1Valid ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                  Please complete your contact details and choose a delivery address to continue.
                </p>
              ) : null}

              <Button size="lg" onClick={goToDelivery} className="w-full min-h-[48px] bg-brand-gradient-deep text-white hover:brightness-110 sm:w-auto sm:px-10">
                Continue to delivery
              </Button>
            </motion.div>
          ) : null}

          {/* ============================ PHASE 2: DELIVERY ============================ */}
          {draft.phase === 2 ? (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="space-y-6">
              {selectedAddr ? (
                <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-5 shadow-soft">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Deliver to</p>
                    <p className="pt-0.5 text-sm font-semibold">
                      {selectedAddr.name} · {selectedAddr.phone ?? draft.phone}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {selectedAddr.line1}, {selectedAddr.city}, {selectedAddr.state} {selectedAddr.postcode}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" className="min-h-[40px] border-teal-700/40 text-teal-800 hover:bg-teal-50" onClick={() => setDraft((d) => ({ ...d, phase: 1 }))}>
                    <Pencil className="h-3.5 w-3.5" /> Change
                  </Button>
                </div>
              ) : null}

              <section className="space-y-3 rounded-xl border bg-card p-5 shadow-soft" aria-labelledby="checkout-shipping">
                <h2 id="checkout-shipping" className="flex items-center gap-2 text-base font-bold">
                  <Truck className="h-4 w-4 text-teal-700" /> Delivery method
                </h2>

                {!quote?.shippingOptions ? (
                  <div className="space-y-2">
                    <Skeleton className="h-16 rounded-lg" />
                    <Skeleton className="h-16 rounded-lg" />
                  </div>
                ) : (
                  <RadioGroup
                    value={draft.shippingRateId}
                    onValueChange={(v) => setDraft((d) => ({ ...d, shippingRateId: v }))}
                    className="gap-2"
                  >
                    {quote.shippingOptions.map((s) => (
                      <Label
                        key={s.id}
                        htmlFor={`ship-${s.id}`}
                        className={cn(
                          "flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border p-3.5 transition-colors",
                          draft.shippingRateId === s.id ? "border-teal-600 bg-teal-50/60" : "hover:bg-muted/50",
                          !s.available && "cursor-not-allowed opacity-60"
                        )}
                        aria-disabled={!s.available}
                      >
                        <RadioGroupItem value={s.id} id={`ship-${s.id}`} disabled={!s.available} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold">{s.label}</p>
                          <p className="text-xs text-muted-foreground">{s.available ? s.eta : s.reason}</p>
                        </div>
                        <span className={cn("text-sm font-bold", s.freeShipping ? "text-emerald-700" : "text-teal-700")}>
                          {s.freeShipping ? "FREE" : formatMinor(s.amountMinor)}
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                )}

                {quote && quote.shippingMinor === 0 && quote.shippingOptions?.find((o) => o.id === draft.shippingRateId)?.id === "standard" ? (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">
                    <ShieldCheck className="h-4 w-4" /> Free standard shipping applied (order above RM 100)
                  </div>
                ) : (
                  <div className="pt-1">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand-gradient transition-all" style={{ width: `${freeShipProgress}%` }} />
                    </div>
                    <p className="pt-1.5 text-xs text-muted-foreground">
                      {freeShipProgress >= 100
                        ? "You've unlocked FREE standard shipping!"
                        : `${formatMinor(Math.max(0, 10000 - subtotal))} away from FREE standard shipping`}
                    </p>
                  </div>
                )}
              </section>

              <div className="flex flex-wrap gap-3">
                <Button variant="outline" size="lg" onClick={() => setDraft((d) => ({ ...d, phase: 1 }))} className="min-h-[48px]">
                  Back
                </Button>
                <Button size="lg" onClick={goToPayment} disabled={quoting} className="min-h-[48px] flex-1 bg-brand-gradient-deep text-white hover:brightness-110 sm:flex-none sm:px-10">
                  Continue to payment
                </Button>
              </div>
            </motion.div>
          ) : null}

          {/* ============================ PHASE 3: PAYMENT & REVIEW ============================ */}
          {draft.phase === 3 ? (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="space-y-6">
              {/* review blocks */}
              <div className="grid gap-3 sm:grid-cols-2">
                {selectedAddr ? (
                  <div className="rounded-xl border bg-card p-4 shadow-soft">
                    <div className="flex items-start justify-between gap-2">
                      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                        <MapPin className="h-3.5 w-3.5" /> Deliver to
                      </p>
                      <button type="button" onClick={() => setDraft((d) => ({ ...d, phase: 1 }))} className="text-xs font-semibold text-teal-700 underline-offset-2 hover:underline">
                        Edit
                      </button>
                    </div>
                    <p className="pt-1 text-sm font-semibold">{selectedAddr.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedAddr.line1}, {selectedAddr.city}, {selectedAddr.state} {selectedAddr.postcode}
                    </p>
                  </div>
                ) : null}
                <div className="rounded-xl border bg-card p-4 shadow-soft">
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                      <Truck className="h-3.5 w-3.5" /> Delivery
                    </p>
                    <button type="button" onClick={() => setDraft((d) => ({ ...d, phase: 2 }))} className="text-xs font-semibold text-teal-700 underline-offset-2 hover:underline">
                      Edit
                    </button>
                  </div>
                  {(() => {
                    const sel = quote?.shippingOptions?.find((o) => o.id === draft.shippingRateId);
                    return (
                      <>
                        <p className="pt-1 text-sm font-semibold">{sel?.label ?? "—"}</p>
                        <p className="text-sm text-muted-foreground">
                          {sel ? `${sel.eta} · ${sel.freeShipping ? "FREE" : formatMinor(sel.amountMinor)}` : "—"}
                        </p>
                      </>
                    );
                  })()}
                </div>
              </div>

              <section className="space-y-3 rounded-xl border bg-card p-5 shadow-soft" aria-labelledby="checkout-payment">
                <h2 id="checkout-payment" className="flex items-center gap-2 text-base font-bold">
                  <CreditCard className="h-4 w-4 text-teal-700" /> Payment method
                </h2>
                <RadioGroup value={draft.provider} onValueChange={(v) => setDraft((d) => ({ ...d, provider: v }))} className="gap-2">
                  {PROVIDERS.map((p) => (
                    <Label
                      key={p.id}
                      htmlFor={`pay-${p.id}`}
                      className={cn(
                        "flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border p-3.5 transition-colors",
                        draft.provider === p.id ? "border-teal-600 bg-teal-50/60" : "hover:bg-muted/50"
                      )}
                    >
                      <RadioGroupItem value={p.id} id={`pay-${p.id}`} />
                      <p.icon className="h-5 w-5 text-teal-700" />
                      <span className="text-sm font-semibold">{p.label}</span>
                    </Label>
                  ))}
                </RadioGroup>
                <p className="text-xs text-muted-foreground">
                  You&apos;ll confirm the payment on the secure SHOPMESH sandbox gateway — no real money moves.
                </p>
              </section>

              <Textarea value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} placeholder="Note to seller (optional)" rows={2} className="min-h-[44px] text-sm" />

              <div className="flex items-start gap-2.5 rounded-xl border bg-card p-4 shadow-soft">
                <input
                  id="terms"
                  type="checkbox"
                  checked={draft.agreed}
                  onChange={(e) => setDraft((d) => ({ ...d, agreed: e.target.checked }))}
                  className="mt-0.5 h-4 w-4 rounded border-input accent-teal-700"
                  aria-required
                />
                <Label htmlFor="terms" className="text-sm font-normal leading-snug">
                  I agree to the SHOPMESH Terms of Service and understand that paid orders can only be refunded through the
                  platform&apos;s dispute process.
                </Label>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button variant="outline" size="lg" onClick={() => setDraft((d) => ({ ...d, phase: 2 }))} className="min-h-[48px]">
                  Back
                </Button>
                <Button
                  size="lg"
                  onClick={placeOrder}
                  disabled={submitting || quoting || !quote || stockIssues.length > 0}
                  className="min-h-[48px] flex-1 bg-brand-gradient-deep text-white hover:brightness-110"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  {submitting ? "Creating order…" : `Pay ${formatMinor(quote?.totalMinor ?? 0)}`}
                </Button>
              </div>
            </motion.div>
          ) : null}
        </div>

        {/* right column — order summary (shared across phases) */}
        <aside className="lg:col-span-2">
          <div className="space-y-4 rounded-xl border bg-card p-5 shadow-soft lg:sticky lg:top-20">
            <h2 className="text-base font-bold">Order summary</h2>

            {stockIssues.length > 0 ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                {stockIssues.map((i) => (
                  <p key={i.title}>
                    Only {i.stock} left of “{i.title}” — you have {i.qty} in cart.
                  </p>
                ))}
                <button type="button" onClick={ctx.openCart} className="pt-1 font-bold underline underline-offset-2">
                  Update cart
                </button>
              </div>
            ) : null}

            <ul className="max-h-64 space-y-3 overflow-y-auto pr-1">
              {items.map((i) => (
                <li key={i.id} className="flex gap-3">
                  <img src={i.imageUrl} alt={i.title} loading="lazy" className="h-14 w-14 rounded-lg border object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-medium leading-tight">{i.title}</p>
                    {i.variantLabel ? <p className="text-xs text-muted-foreground">{i.variantLabel}</p> : null}
                    <p className="text-xs text-muted-foreground">Qty {i.qty}</p>
                  </div>
                  <span className="text-sm font-semibold">{formatMinor(i.lineTotalMinor)}</span>
                </li>
              ))}
            </ul>

            {/* coupon */}
            <div className="space-y-1.5">
              {draft.couponCode ? (
                <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">
                  <span>
                    {draft.couponCode} applied
                    {quote?.coupon?.valid && quote.coupon.freeShip ? " — free shipping" : quote?.coupon?.valid ? ` — ${formatMinor(quote.coupon.discountMinor ?? 0)} off` : ""}
                  </span>
                  <button type="button" onClick={removeCoupon} className="font-bold underline underline-offset-2" aria-label="Remove coupon">
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Tag className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={couponInput}
                        onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                        placeholder="Coupon code"
                        className="min-h-[44px] pl-8"
                        aria-label="Coupon code"
                        onKeyDown={(e) => e.key === "Enter" && applyCoupon()}
                      />
                    </div>
                    <Button variant="outline" onClick={applyCoupon} disabled={quoting || !couponInput.trim()} className="min-h-[44px] border-teal-700/40 text-teal-800 hover:bg-teal-50">
                      {quoting ? <Loader2 className="h-4 w-4 animate-spin" /> : <TicketPercent className="h-4 w-4" />} Apply
                    </Button>
                  </div>
                  {couponErr ? <p className="text-xs font-medium text-rose-600">{couponErr}</p> : null}
                </>
              )}
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
                <dd className="font-semibold">{quote ? (quote.shippingMinor === 0 ? "FREE" : formatMinor(quote.shippingMinor)) : "—"}</dd>
              </div>
              <Separator />
              <div className="flex justify-between text-base">
                <dt className="font-bold">Total</dt>
                <dd className="font-extrabold text-teal-700">{formatMinor(quote?.totalMinor ?? 0)}</dd>
              </div>
            </dl>

            {quoting ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Updating prices from server…</p> : null}
            <p className="text-center text-[11px] text-muted-foreground">Totals are recalculated server-side before payment.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

// =============================================================================================
// SANDBOX PAYMENT VIEW
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
  const [phase, setPhase] = useState<"awaiting" | "success" | "failure" | "expired">("awaiting");
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
        setPhase((ph) => (ph === "awaiting" || ph === "expired" ? "failure" : ph));
      } else if (p.status === "expired") {
        setPhase((ph) => (ph === "awaiting" ? "expired" : ph));
      }
    } catch {
      setFailed(true);
    }
  }, [paymentRef]);

  // initial load + 3s polling — status is always server-authoritative
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
    if (busy) return;
    setBusy(true);
    try {
      await postJson<{ status: string; orderNumber: string }>(
        `/api/checkout/payments/${encodeURIComponent(paymentRef)}/simulate`,
        { result }
      );
      if (result === "succeeded") {
        // cart is emptied server-side on verified success — just refresh the badge
        const email = typeof window !== "undefined" ? window.localStorage.getItem(EMAIL_KEY) ?? "" : "";
        if (orderNumber && email) trackOrderRef(orderNumber, email);
        notifyCartUpdated();
        setPhase("success");
      } else {
        setPhase("failure");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Payment failed — please try again");
      load();
    } finally {
      setBusy(false);
    }
  }

  // Retry = a new gateway attempt: re-open the failed session server-side first,
  // so the status poller sees "requires_payment" and stays consistent.
  async function retryPayment() {
    if (busy) return;
    setBusy(true);
    try {
      await postJson(`/api/checkout/payments/${encodeURIComponent(paymentRef)}/retry`, {});
      setPhase("awaiting");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restart this payment");
      await load();
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
          <div className="bg-brand-gradient-deep px-5 py-4 text-white">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm font-bold tracking-wide">
                <ShieldCheck className="h-4 w-4 text-emerald-300" /> SHOPMESH Secure Checkout
              </p>
              <span className="rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-teal-950">Sandbox</span>
            </div>
            <p className="pt-1 text-xs text-teal-100/80">256-bit encrypted · demo gateway — no real money moves</p>
          </div>

          {failed ? (
            <div className="space-y-3 p-8 text-center">
              <XCircle className="mx-auto h-10 w-10 text-rose-500" />
              <p className="font-semibold">Payment session not found</p>
              <p className="text-sm text-muted-foreground">This payment reference may have expired.</p>
              <Button variant="outline" onClick={() => ctx.nav({ name: "lookup" })}>Track your order</Button>
            </div>
          ) : !payment ? (
            <div className="space-y-4 p-8">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : phase === "success" ? (
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="space-y-3 p-8 text-center">
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 16 }} className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
                <CheckCircle2 className="h-9 w-9 text-emerald-600" />
              </motion.div>
              <p className="text-lg font-extrabold">Payment successful!</p>
              <p className="text-sm text-muted-foreground">Order {payment.orderNumber} is confirmed.</p>
              <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Taking you to your order…</p>
            </motion.div>
          ) : phase === "expired" ? (
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="space-y-3 p-8 text-center">
              <Clock className="mx-auto h-12 w-12 text-amber-500" />
              <p className="text-lg font-extrabold">Payment session expired</p>
              <p className="text-sm text-muted-foreground">No money was taken. Your order is still unpaid — start a new checkout to place it again.</p>
              <div className="grid gap-2 pt-2">
                <Button onClick={() => ctx.nav({ name: "checkout" })} disabled={busy} className="min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110">
                  <ShoppingBag className="h-4 w-4" /> New checkout
                </Button>
                <Button variant="outline" onClick={() => ctx.nav({ name: "storefront", slug: payment.storeSlug })} className="min-h-[44px]">
                  Back to store
                </Button>
              </div>
            </motion.div>
          ) : phase === "failure" ? (
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="space-y-3 p-8 text-center">
              <XCircle className="mx-auto h-12 w-12 text-rose-500" />
              <p className="text-lg font-extrabold">Payment failed</p>
              <p className="text-sm text-muted-foreground">No money was taken. You can retry the payment or head back to the store.</p>
              <div className="grid gap-2 pt-2">
                <Button onClick={retryPayment} disabled={busy} className="min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110">
                  <RotateCcw className="h-4 w-4" /> Retry payment
                </Button>
                <Button variant="outline" onClick={() => ctx.nav({ name: "storefront", slug: payment.storeSlug })} className="min-h-[44px]">
                  Back to store
                </Button>
              </div>
            </motion.div>
          ) : (
            <div className="space-y-5 p-6 sm:p-8">
              <div className="space-y-1 text-center">
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
                disabled={busy || secondsLeft <= 0}
                onClick={() => simulate("succeeded")}
                className="min-h-[48px] w-full bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Landmark className="h-4 w-4" />}
                {busy ? "Processing…" : "Pay Now"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => simulate("failed")}
                className="min-h-[40px] w-full border-rose-300 text-rose-600 hover:bg-rose-50"
              >
                Simulate declined payment
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">Sandbox gateway — result is verified server-side before the order is confirmed.</p>
            </div>
          )}
        </div>

        {payment && (phase === "awaiting" || phase === "failure") ? (
          <button
            type="button"
            onClick={() => ctx.nav({ name: "storefront", slug: payment.storeSlug })}
            className="mx-auto mt-4 block text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Cancel and return to {payment.storeName} — order {payment.orderNumber} stays unpaid
          </button>
        ) : null}
      </motion.div>
    </div>
  );
}

// =============================================================================================
// ORDER STATUS + HISTORY + LOOKUP
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
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className={cn("space-y-5 rounded-2xl border bg-card p-5 sm:p-6", compact && "shadow-sm")}>
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
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-xl font-extrabold tracking-tight">{o.orderNumber}</p>
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
  const [receiptEmail, setReceiptEmail] = useState(email);
  const [data, setData] = useState<LookupResultT | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);

  const downloadReceipt = async () => {
    if (receiptBusy || !receiptEmail || !data) return;
    setReceiptBusy(true);
    try {
      const res = await fetch(`/api/orders/receipt?email=${encodeURIComponent(receiptEmail)}&orderNumber=${encodeURIComponent(data.orderNumber)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? "Could not generate the receipt");
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `SHOPMESH-Receipt-${data.orderNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast.success("Receipt downloaded", { description: `PDF receipt for ${data.orderNumber} saved to your device.` });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not download the receipt");
    } finally {
      setReceiptBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    // 1) Guest path — email + order number lookup (unchanged).
    const guestLookup = email
      ? fetchJson<LookupResultT>(`/api/orders/lookup?email=${encodeURIComponent(email)}&orderNumber=${encodeURIComponent(orderNumber)}`)
      : Promise.reject(new Error("no-guest-email"));
    guestLookup
      .then((d) => {
        if (!alive) return;
        setData(d);
        trackOrderRef(d.orderNumber, email);
      })
      .catch(() => {
        // 2) Account path — signed-in buyer deep-linking from the Me hub;
        //    ownership enforced server-side by the session's shopperId.
        fetchJson<LookupResultT & { customerEmail?: string }>(`/api/me/orders/${encodeURIComponent(orderNumber)}`)
          .then((d) => {
            if (!alive) return;
            setData(d);
            if (d.customerEmail) {
              setReceiptEmail(d.customerEmail);
              trackOrderRef(d.orderNumber, d.customerEmail);
            }
          })
          .catch((e2: Error) => {
            if (alive) setFailed(e2.message === "no-guest-email" ? "" : e2.message);
          });
      });
    return () => {
      alive = false;
    };
  }, [email, orderNumber]);

  if (failed) {
    return (
      <div className="flex-1">
        <EmptyState
          title={failed ? "Couldn't load this order" : "No checkout email found"}
          hint={failed || "We couldn't find a recent checkout on this device, and this order isn't on your account. Use order lookup instead."}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => ctx.nav({ name: "lookup" })} className="min-h-[44px]">
                Order lookup
              </Button>
              <Button onClick={() => ctx.nav({ name: "market" })} className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110">
                Continue shopping
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      {!data ? (
        <div className="space-y-4">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-5">
          <OrderCard o={data} />
          <div className="flex flex-wrap justify-center gap-3">
            <Button onClick={() => ctx.nav({ name: "market" })} className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110">
              Continue shopping
            </Button>
            <Button
              variant="outline"
              onClick={downloadReceipt}
              disabled={receiptBusy || data.status === "payment_pending"}
              className="min-h-[44px] gap-2"
              title={data.status === "payment_pending" ? "Available once payment is confirmed" : "Download the PDF receipt for this order"}
            >
              {receiptBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ReceiptText className="h-4 w-4" />}
              Download receipt
            </Button>
            <ContactSellerButton ctx={ctx} orderNumber={data.orderNumber} storeSlug={data.storeSlug ?? null} storeName={data.storeName} />
            <Button variant="outline" onClick={() => ctx.nav({ name: "orders" })} className="min-h-[44px]">
              All my orders
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- contact seller (C3)

/** Contact-seller action on the payment-complete page: buyer logged in → open
 *  the chat space with this store (order context pre-filled); not logged in →
 *  ask to sign in / register first, then continue to the chat automatically. */
function ContactSellerButton({
  ctx,
  orderNumber,
  storeId,
  storeSlug,
  storeName,
}: {
  ctx: ShopperCtx;
  orderNumber: string;
  storeId?: string | null;
  storeSlug?: string | null;
  storeName: string;
}) {
  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const [busy, setBusy] = useState(false);
  const shopper = me.loaded ? me.shopper : null;

  const startThread = useCallback(async () => {
    setBusy(true);
    try {
      const res = await postJson<{ thread: { id: string } }>("/api/chat/threads", {
        ...(storeId ? { storeId } : { storeSlug }),
        orderNumber,
        message: `Hi ${storeName}! I'd like to ask about my order ${orderNumber}.`,
      });
      toast.success("Chat opened", { description: `You're now chatting with ${storeName}.` });
      ctx.nav({ name: "messages", threadId: res.thread.id });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the chat");
    } finally {
      setBusy(false);
    }
  }, [ctx, storeId, storeSlug, storeName, orderNumber]);

  const onClick = () => {
    if (!shopper) {
      // not logged in → require sign-in / register first, then continue to chat
      openShopperAuth(() => void startThread());
      return;
    }
    void startThread();
  };

  return (
    <Button variant="outline" onClick={onClick} disabled={busy} className="min-h-[44px] gap-2" title={`Chat with ${storeName} about this order`}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessagesSquare className="h-4 w-4" />}
      Contact seller
    </Button>
  );
}

// ---------------------------------------------------------------- order history

export function OrdersView({ ctx }: { ctx: ShopperCtx }) {
  const [refs] = useState(() => readOrderRefs().slice(0, 10));
  const [orders, setOrders] = useState<LookupResultT[]>([]);
  const [loading, setLoading] = useState(() => refs.length > 0);

  useEffect(() => {
    if (refs.length === 0) return;
    let alive = true;
    Promise.allSettled(
      refs.map((r) =>
        fetchJson<LookupResultT>(`/api/orders/lookup?email=${encodeURIComponent(r.email)}&orderNumber=${encodeURIComponent(r.orderNumber)}`)
      )
    ).then((results) => {
      if (!alive) return;
      setOrders(results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [refs]);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <div className="pb-5">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
          <PackageSearch className="h-6 w-6 text-teal-700" /> My orders
        </h1>
        <p className="text-sm text-muted-foreground">Orders placed from this device. Track any order by its number too.</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title="No orders yet"
          hint="Orders you place will show up here — ready to track from payment to delivery."
          action={
            <div className="flex gap-2">
              <Button onClick={() => ctx.nav({ name: "market" })} className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110">
                Start shopping
              </Button>
              <Button variant="outline" onClick={() => ctx.nav({ name: "lookup" })} className="min-h-[44px]">
                Track by order number
              </Button>
            </div>
          }
        />
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.orderNumber}>
              <button
                type="button"
                onClick={() => ctx.nav({ name: "order-status", orderNumber: o.orderNumber })}
                className="flex w-full items-center gap-4 rounded-2xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
                aria-label={`View order ${o.orderNumber}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm font-extrabold">{o.orderNumber}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {o.storeName} · {dateShort(o.createdAt)} · {o.items.length} item{o.items.length === 1 ? "" : "s"}
                  </p>
                  <div className="pt-1.5">
                    <StatusBadge status={o.status} />
                  </div>
                </div>
                <span className="text-base font-extrabold text-teal-700">{formatMinor(o.totalMinor)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-center gap-3 pt-6">
        <Button variant="outline" onClick={() => ctx.nav({ name: "lookup" })} className="min-h-[44px]">
          <PackageSearch className="h-4 w-4" /> Track by order number
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- lookup

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
      trackOrderRef(data.orderNumber, email.trim());
      window.localStorage.setItem(EMAIL_KEY, email.trim().toLowerCase());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <div className="space-y-4 rounded-2xl border bg-card p-5 shadow-soft sm:p-6">
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
            <Button type="submit" disabled={busy} className="min-h-[44px] w-full bg-brand-gradient-deep text-white hover:brightness-110 sm:w-auto">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageSearch className="h-4 w-4" />} Find my order
            </Button>
          </div>
        </form>
        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
            {error.includes("No order") ? "We couldn't find an order with those details. Double-check the email and order number." : error}
          </p>
        ) : null}
      </div>

      {result ? (
        <div className="pt-5">
          <OrderCard o={result} compact />
          <div className="flex justify-center pt-3">
            <Button
              variant="outline"
              onClick={() => ctx.nav({ name: "order-status", orderNumber: result.orderNumber })}
              className="min-h-[44px]"
              title="Open the full order view — with the PDF receipt and Contact seller"
            >
              View full order details
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

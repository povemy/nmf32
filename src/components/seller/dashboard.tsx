"use client";
// Task 2-d — SD-01 seller dashboard: period cards, low stock with inline restock,
// latest orders, pending actions with jump links.
import { useState } from "react";
import { toast } from "sonner";
import { apiGet, apiSend, CardsSkeleton, RowsSkeleton, StatCard, StatusChip, ageOf, formatMinor, runMutation, useApi, useSellerTerms, fmtCommissionPercent, holdAfterPayment, type SellerNav } from "./ui-bits";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type {
  InventoryAdjustData,
  SellerDashboardData,
  SellerEvVerifyData,
  SellerMeData,
} from "@/lib/types/api-contract";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BadgeDollarSign,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  Package,
  ReceiptText,
  ShieldCheck,
  Timer,
  TrendingUp,
  Undo2,
} from "lucide-react";

/** /api/auth/seller/email-verification/request result as the card reads it —
 *  the contract union (SellerEvDoneData | SellerEvSentData) flattened to the
 *  fields the flow gates on (only `alreadyVerified` is acted on). */
type SellerEvRequestView = { sent: boolean; alreadyVerified?: boolean; message?: string };

export default function SellerDashboard({ onNavigate }: { onNavigate: (n: SellerNav) => void }) {
  const { data, loading, error, refetch } = useApi<SellerDashboardData>("/api/store/dashboard");
  const { data: me, refetch: refetchMe } = useApi<SellerMeData>("/api/store/me");
  // ADDENDUM #8 — live platform terms (commission %, hold) from the admin
  // settings via /api/store/terms; shared module cache means one fetch / 60 s.
  const { terms } = useSellerTerms();

  const restock = async (variantId: string, title: string) => {
    const ok = await runMutation(
      () => apiSend<InventoryAdjustData>("POST", "/api/store/inventory/adjust", { variantId, delta: 10, reason: "restock" }),
      `Restocked +10 — ${title}`
    );
    if (ok) refetch();
  };

  if (error) {
    return (
      <Card className="border-rose-200/70">
        <CardContent className="p-6 text-sm text-rose-600">Failed to load dashboard: {error}</CardContent>
      </Card>
    );
  }

  if (loading || !data) {
    return (
      <div className="space-y-5">
        <CardsSkeleton count={3} />
        <RowsSkeleton rows={3} />
      </div>
    );
  }

  // ---- Pending actions (ADDENDUM #8) — each action gets its own large,
  // urgency-colored card so counts cannot be missed. Tiers:
  //   urgent (rose):  unfulfilled ≥ 5 · refunds ≥ 3
  //   warn   (amber): unfulfilled 1–4 · refunds 1–2 · products in review ≥ 1
  //   ok     (emerald): zero — "All clear"
  // Products-in-review never goes rose: it is an expected admin-side flow.
  type Urgency = "ok" | "warn" | "urgent";
  const URGENCY: Record<
    Urgency,
    { chip: string; number: string; bar: string; iconBg: string; badge: string; chipLabel: string; short: string }
  > = {
    ok: {
      chip: "border-emerald-200/70 bg-emerald-50 text-emerald-700",
      number: "text-emerald-600",
      bar: "bg-emerald-400",
      iconBg: "bg-emerald-50 text-emerald-600",
      badge: "border-emerald-200/70 bg-emerald-50 text-emerald-700",
      chipLabel: "All clear",
      short: "All caught up",
    },
    warn: {
      chip: "border-amber-200/70 bg-amber-50 text-amber-700",
      number: "text-amber-600",
      bar: "bg-amber-400",
      iconBg: "bg-amber-50 text-amber-600",
      badge: "border-amber-200/70 bg-amber-50 text-amber-700",
      chipLabel: "Action needed",
      short: "open",
    },
    urgent: {
      chip: "border-rose-200/70 bg-rose-50 text-rose-600",
      number: "text-rose-600",
      bar: "bg-rose-500",
      iconBg: "bg-rose-50 text-rose-600",
      badge: "border-rose-200/70 bg-rose-50 text-rose-600",
      chipLabel: "Urgent",
      short: "needs urgent action",
    },
  };

  const actionCards = [
    {
      key: "unfulfilled",
      label: "Orders to fulfill",
      count: data.pendingActions.unfulfilledPaidOrders,
      hint: "Paid orders waiting for packing & shipping",
      icon: Package,
      urgency: (data.pendingActions.unfulfilledPaidOrders >= 5 ? "urgent" : data.pendingActions.unfulfilledPaidOrders > 0 ? "warn" : "ok") as Urgency,
      go: () => onNavigate({ view: "orders", orderId: undefined }),
    },
    {
      key: "refunds",
      label: "Refund requests",
      count: data.pendingActions.openRefundRequests,
      hint: "Customers waiting on a refund decision",
      icon: Undo2,
      urgency: (data.pendingActions.openRefundRequests >= 3 ? "urgent" : data.pendingActions.openRefundRequests > 0 ? "warn" : "ok") as Urgency,
      go: () => onNavigate({ view: "orders", orderId: undefined }),
    },
    {
      key: "products",
      label: "Products in review",
      count: data.pendingActions.productsPendingReview,
      hint: "Awaiting moderation before going live",
      icon: ClipboardCheck,
      urgency: (data.pendingActions.productsPendingReview > 0 ? "warn" : "ok") as Urgency,
      go: () => onNavigate({ view: "products", productId: undefined }),
    },
  ];

  const totalOpen = actionCards.reduce((s, a) => s + a.count, 0);
  const maxUrgency: Urgency = actionCards.some((a) => a.urgency === "urgent")
    ? "urgent"
    : actionCards.some((a) => a.urgency === "warn")
      ? "warn"
      : "ok";

  // Live commission copy — effective default rate for THIS seller (seller
  // override ?? admin global), with fixed-fee / minimum noted when configured.
  const commissionSub = (() => {
    if (!terms) return "Syncing with platform settings…";
    const bits: string[] = [terms.commissionSource === "seller_override" ? "Your negotiated rate" : "Default rate"];
    if (terms.hasFixedFee) bits.push(`+ ${formatMinor(terms.fixedFeeMinor)} fixed fee/order`);
    if (terms.hasMinCommission) bits.push(`min ${formatMinor(terms.minCommissionMinor)}/order`);
    return `${bits.join(" · ")} — deducted at payment`;
  })();

  return (
    <div className="space-y-6">
      {/* PHASE 2.3 (C2.7) — honest email-verification card: shown ONLY while
          me.seller.emailVerified is false (server-derived from
          Seller.emailVerifiedAt; null/unmigrated storage = NOT verified). */}
      <SellerEmailVerificationCard verified={me?.seller.emailVerified ?? false} onVerified={() => void refetchMe()} />

      {/* period cards */}
      <section aria-label="Performance">
        <div className="grid gap-4 md:grid-cols-3">
          {(["today", "7d"] as const).map((k) => {
            const c = data.cards[k];
            const labels: Record<string, string> = { today: "Today", "7d": "Last 7 days" };
            const PeriodIcon = k === "today" ? Timer : TrendingUp;
            return (
              <Card key={k} className="gap-3 py-4">
                <CardHeader className="px-4 pb-0">
                  <CardTitle className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                      <PeriodIcon className="h-4 w-4" />
                    </span>
                    {labels[k]}
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-2 px-4">
                  <div className="rounded-lg bg-slate-50 px-2.5 py-2">
                    <p className="text-[11px] text-slate-400">Orders</p>
                    <p className="text-lg font-bold tabular-nums text-slate-900">{c.orders}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2.5 py-2">
                    <p className="text-[11px] text-slate-400">Revenue</p>
                    <p className="text-lg font-bold tabular-nums text-slate-900">{formatMinor(c.revenueMinor)}</p>
                  </div>
                  <div className="rounded-lg bg-amber-50/70 px-2.5 py-2">
                    <p className="text-[11px] text-slate-400">Commission</p>
                    <p className="text-sm font-bold tabular-nums text-amber-600">−{formatMinor(c.commissionMinor)}</p>
                  </div>
                  <div className="rounded-lg bg-emerald-50/70 px-2.5 py-2">
                    <p className="text-[11px] text-slate-400">Net to you</p>
                    <p className="text-sm font-bold tabular-nums text-emerald-600">{formatMinor(c.netMinor)}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {/* R2-UI — "Available e-wallet" replaces the "Last 30 days" card in the
              grid (the API still returns 30d data; the UI simply stops showing it). */}
          <button
            type="button"
            onClick={() => onNavigate({ view: "wallet" })}
            aria-label="Available e-wallet — open wallet"
            className="relative flex min-h-[125px] flex-col justify-between overflow-hidden rounded-xl bg-brand-gradient p-4 text-left text-white shadow-glow-cyan transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_32px_-8px_rgba(0,196,180,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span aria-hidden="true" className="pointer-events-none absolute -right-8 -bottom-8 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
            <span className="relative flex items-center justify-between gap-2">
              <span className="text-xs font-semibold tracking-wide text-teal-50/90">Available e-wallet</span>
              <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/20 transition-colors hover:bg-white/30">
                <ArrowUpRight className="h-3.5 w-3.5 text-white" />
              </span>
            </span>
            <span className="relative my-auto pt-1">
              <span className="block text-2xl font-extrabold tracking-tight tabular-nums lg:text-3xl">
                {formatMinor(data.wallet?.availableMinor ?? 0)}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-teal-50/90">
                <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                  {formatMinor(data.wallet?.pendingMinor ?? 0)} pending
                </span>
                <span className="text-[11px] font-medium text-teal-50/80">
                  released {terms ? holdAfterPayment(terms) : "after the clearing hold"}
                </span>
              </span>
            </span>
          </button>
        </div>
      </section>

      {/* pending actions — ADDENDUM #8: one large urgency-colored card per
          action (big count, color-coded severity) so nothing gets missed. */}
      <section aria-label="Pending actions">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <ClipboardList className="h-4 w-4 text-teal-600" /> Pending actions
          </h2>
          <Badge variant="outline" className={cn("border font-semibold", URGENCY[maxUrgency].badge)}>
            {totalOpen === 0 ? "All caught up" : `${totalOpen} open item${totalOpen === 1 ? "" : "s"}`}
          </Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {actionCards.map((a) => {
            const s = URGENCY[a.urgency];
            const Icon = a.icon;
            const display = a.count > 99 ? "99+" : String(a.count);
            return (
              <button
                key={a.key}
                type="button"
                onClick={a.go}
                aria-label={`${a.label}: ${display} — ${s.chipLabel}`}
                className="group relative flex min-h-[44px] flex-col gap-3 overflow-hidden rounded-xl border border-slate-200/80 bg-card p-5 text-left shadow-soft-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow-cyan-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
              >
                <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1 rounded-t-lg", s.bar)} />
                <span className="flex items-center justify-between gap-2">
                  <span className={cn("flex h-10 w-10 items-center justify-center rounded-lg", s.iconBg)}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <Badge variant="outline" className={cn("border font-semibold", s.chip)}>
                    {a.urgency === "ok" ? "All clear" : s.chipLabel}
                  </Badge>
                </span>
                <span>
                  <span className={cn("block text-4xl font-extrabold leading-none tabular-nums sm:text-5xl", s.number)}>
                    {display}
                  </span>
                  <span className="mt-2.5 flex items-center gap-1 text-sm font-medium text-slate-700">
                    {a.label}
                    <ArrowRight className="h-3.5 w-3.5 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">{a.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* low stock */}
        <section aria-label="Low stock">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
                <AlertTriangle className="h-4 w-4 text-amber-500" /> Low stock
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.lowStock.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">Everything is well stocked</p>
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {data.lowStock.map((v) => (
                    <li
                      key={v.id}
                      className="flex items-center gap-3 rounded-lg bg-slate-50 p-2.5 transition-colors hover:bg-teal-50/60"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200/70 bg-white text-teal-700">
                        <Boxes className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {v.productTitle}
                          {v.optionValue ? <span className="text-slate-400"> · {v.optionValue}</span> : null}
                        </p>
                        <p className="text-xs text-slate-400">
                          {v.sku ? `${v.sku} · ` : ""}threshold {v.lowStockThreshold}
                        </p>
                      </div>
                      <span
                        className={
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums " +
                          (v.stock === 0 ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700")
                        }
                      >
                        {v.stock} left
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 shrink-0 hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800"
                        onClick={() => restock(v.id, v.productTitle)}
                      >
                        +10
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* latest orders */}
        <section aria-label="Latest orders">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
                <ReceiptText className="h-4 w-4 text-teal-600" /> Latest orders
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-teal-700 hover:bg-teal-50 hover:text-teal-800"
                onClick={() => onNavigate({ view: "orders" })}
              >
                View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </CardHeader>
            <CardContent>
              {data.latestOrders.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">
                  No orders yet — share your storefront link to get the first sale!
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Order</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Customer</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Status</TableHead>
                        <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-slate-400">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.latestOrders.map((o) => (
                        <TableRow
                          key={o.id}
                          className="cursor-pointer hover:bg-teal-50/40"
                          onClick={() => onNavigate({ view: "orders", orderId: o.id })}
                        >
                          <TableCell>
                            <p className="font-semibold text-slate-900">{o.orderNumber}</p>
                            <p className="text-xs text-slate-400">{ageOf(o.createdAt)} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"}</p>
                          </TableCell>
                          <TableCell className="max-w-32 truncate">{o.customerName}</TableCell>
                          <TableCell><StatusChip status={o.status} /></TableCell>
                          <TableCell className="text-right font-semibold tabular-nums text-slate-900">{formatMinor(o.totalMinor)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>

      {/* quick stats strip */}
      <section aria-label="Quick summary" className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="All-time orders"
          value={String(me?.stats.ordersCount ?? "—")}
          sub={`${me?.stats.productCount ?? "—"} products in catalog`}
          icon={<Package className="h-4 w-4" />}
        />
        <StatCard
          label="Revenue (30d)"
          value={me ? formatMinor(me.stats.revenue30dMinor) : "—"}
          sub="Paid orders in the last 30 days"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          label="Platform commission"
          value={terms ? fmtCommissionPercent(terms.commissionPercent) : "—"}
          sub={commissionSub}
          icon={<BadgeDollarSign className="h-4 w-4" />}
        />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- email verification
// PHASE 2.3 (C2.7) — "Verify your email" card for the seller console.
// Mirrors the shopper me-hub card: request a 6-digit code to the session's
// OWN seller email, then verify it. The server does the gating
// (seller-email OTP, exactly-once consume, Seller.emailVerifiedAt); this
// card simply disappears once me.seller.emailVerified is true — it never
// renders a "verified" claim on its own.
function SellerEmailVerificationCard({ verified, onVerified }: { verified: boolean; onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (verified) return null;

  const sendCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiSend<SellerEvRequestView>(
        "POST",
        "/api/auth/seller/email-verification/request",
        {}
      );
      if (res.alreadyVerified) {
        onVerified();
        return;
      }
      setSent(true);
      setCode("");
      toast.success("Verification code sent", { description: "Check your inbox — the code expires in 10 minutes." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    const digits = code.replace(/[^0-9]/g, "");
    if (digits.length !== 6) {
      toast.error("Enter the 6-digit code from your email.");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiSend<SellerEvVerifyData>(
        "POST",
        "/api/auth/seller/email-verification/verify",
        { code: digits }
      );
      if (res.verified) {
        toast.success(res.alreadyVerified ? "Email already verified" : "Email verified", {
          description: "Your email ownership is confirmed — it shows as verified to the review team.",
        });
        setCode("");
        onVerified();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-teal-200 bg-teal-50/60 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-teal-900 dark:bg-teal-950/40"
      aria-labelledby="seller-email-verify-title"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <p id="seller-email-verify-title" className="flex items-center gap-1.5 text-sm font-bold text-slate-900 dark:text-slate-100">
            Verify your email address
            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] font-semibold text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
              Not verified yet
            </Badge>
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Confirming you control your email helps our team review your store faster. It takes one 6-digit code.
          </p>
        </div>
      </div>
      {sent ? (
        <div className="flex w-full max-w-sm items-center gap-2">
          <label htmlFor="seller-email-code" className="sr-only">
            6-digit verification code
          </label>
          <Input
            id="seller-email-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
            className="min-h-[44px] tracking-widest"
          />
          <Button onClick={() => void submitCode()} disabled={busy || code.length !== 6} className="min-h-[44px] gap-2">
            {busy ? "Verifying…" : <BadgeCheck className="h-4 w-4" aria-hidden="true" />}
            Verify
          </Button>
          <Button variant="ghost" onClick={() => void sendCode()} disabled={busy} className="min-h-[44px] text-xs">
            Resend
          </Button>
        </div>
      ) : (
        <Button onClick={() => void sendCode()} disabled={busy} className="min-h-[44px] gap-2">
          {busy ? "Sending…" : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
          Send code
        </Button>
      )}
    </section>
  );
}

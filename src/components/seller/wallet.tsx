"use client";
// Task 2-d — SD-06/07 Wallet & Payouts: balance cards (ledger truth), recent
// ledger lines, payout history, bank accounts with add dialog.
// Every recent-activity row is clickable and opens the individual activity
// page (txn context + related order/payout) — same pattern as Orders detail.
import { useState } from "react";
import {
  apiSend,
  EmptyState,
  MoneyInput,
  RowsSkeleton,
  StatCard,
  StatusChip,
  fmtCommissionPercent,
  fmtDate,
  fmtDateTime,
  formatMinor,
  holdAfterPayment,
  runMutation,
  useApi,
  useSellerTerms,
  type BankAccount,
  type SellerNav,
  type SellerWallet,
} from "./ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, ArrowRight, Banknote, Clock3, Coins, Landmark, PiggyBank, Plus, ReceiptText, ShieldCheck, Wallet2 } from "lucide-react";
import { cn } from "@/lib/utils";

type WalletData = {
  wallet: SellerWallet;
  recentLines: {
    id: string;
    txnId: string;
    direction: "credit" | "debit";
    amountMinor: number;
    availableAt: string | null;
    memo: string | null;
    createdAt: string;
    txn: { id: string; txnType: string; description: string | null; occurredAt: string };
  }[];
  payouts: {
    id: string;
    referenceNo: string;
    amountMinor: number;
    status: string;
    method: string;
    paidAt: string | null;
    failReason?: string | null; // seller-safe reason written by the fail/reject routes (see PayoutStatusChip note)
    createdAt: string;
  }[];
  minPayoutMinor?: number;
  openRequest?: { id: string; referenceNo: string; amountMinor: number; createdAt: string } | null;
};

const BANKS = ["Maybank", "CIMB", "Public Bank", "Bank Rakyat", "Hong Leong"];

// FIN-3b (3b.2) — seller-facing payout status labels. Display-only map: the
// API keeps returning the raw status strings (requested/processing/paid/…);
// every payout status on the wallet renders through PayoutStatusChip so the
// wording is consistent between the payout table, the open-request banner and
// the activity feed. "Paid" is only ever shown when the row's status is paid
// (paidAt set server-side by the mark-paid/PSP-confirmed transition).
const STATUS_LABELS: Record<string, string> = {
  requested: "Awaiting approval",
  processing: "Processing",
  paid: "Paid",
  failed: "Failed",
  rejected: "Rejected",
  returned: "Returned",
  reversed: "Reversed",
};

// Same tones the shared seller StatusChip assigns to these statuses (amber in
// progress, emerald paid, rose failed/rejected, muted for future/rare states).
const PAYOUT_CHIP_CLASS: Record<string, string> = {
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  processing: "bg-amber-100 text-amber-800 border-amber-200",
  paid: "bg-emerald-100 text-emerald-800 border-emerald-200",
  failed: "bg-rose-100 text-rose-800 border-rose-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
};

function PayoutStatusChip({ status, className }: { status: string; className?: string }) {
  const s = (status ?? "").toLowerCase();
  return (
    <Badge
      variant="outline"
      className={cn("border font-medium", PAYOUT_CHIP_CLASS[s] ?? "bg-muted text-muted-foreground border-border", className)}
    >
      {STATUS_LABELS[s] ?? s.replace(/_/g, " ")}
    </Badge>
  );
}

export default function SellerWallet({ focusActivityId, onNavigate }: { focusActivityId?: string; onNavigate?: (n: SellerNav) => void } = {}) {
  // Individual activity page (deep-linkable, same pattern as Orders detail)
  if (focusActivityId && onNavigate) {
    return <LedgerActivityDetail activityId={focusActivityId} onBack={() => onNavigate({ view: "wallet" })} onNavigate={onNavigate} />;
  }

  return <WalletOverview onNavigate={onNavigate} />;
}

function WalletOverview({ onNavigate }: { onNavigate?: (n: SellerNav) => void }) {
  const { data, loading, error, refetch } = useApi<WalletData>("/api/store/wallet");
  const { data: bankAccounts, refetch: refetchBanks } = useApi<BankAccount[]>("/api/store/bank-accounts");
  // ADDENDUM #8 — live platform terms (hold window + commission %) so admin
  // changes reflect here automatically (was hardcoded "7 days" / "8%").
  const { terms } = useSellerTerms();
  const [addOpen, setAddOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);

  const openActivity = (id: string) => onNavigate?.({ view: "wallet", activityId: id });

  if (loading) {
    return (
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <RowsSkeleton key={i} rows={1} />
          ))}
        </div>
        <RowsSkeleton rows={5} />
      </div>
    );
  }
  if (error || !data) {
    return <Card><CardContent className="p-6 text-sm text-rose-600">Could not load wallet{error ? `: ${error}` : ""}</CardContent></Card>;
  }

  const w = data.wallet;
  const minPayout = data.minPayoutMinor ?? 1000;
  const openRequest = data.openRequest ?? null;

  return (
    <div className="space-y-6">
      {/* payout request CTA + pending banner */}
      <section aria-label="Payout request" className="rounded-xl border bg-card p-4">
        {openRequest ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700">
              <Clock3 className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                Payout request {openRequest.referenceNo} · {formatMinor(openRequest.amountMinor)} — awaiting approval
              </p>
              <p className="text-xs text-muted-foreground">
                Requested {fmtDateTime(openRequest.createdAt)}. NOMOFEE finance reviews payout requests — the amount stays in your available balance until the transfer is initiated.
              </p>
            </div>
            <PayoutStatusChip status="requested" />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Banknote className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Ready to get paid?</p>
              <p className="text-xs text-muted-foreground">
                Request a payout of your available balance (min {formatMinor(minPayout)}). NOMOFEE reviews and transfers to your bank — usually within 1–3 working days.
              </p>
            </div>
            <Button
              className="min-h-[44px] gap-2"
              onClick={() => setRequestOpen(true)}
              disabled={w.availableMinor < minPayout || (bankAccounts ?? []).length === 0}
            >
              <Banknote className="h-4 w-4" />
              Request payout
            </Button>
          </div>
        )}
        {!openRequest && w.availableMinor < minPayout ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Available balance is below the {formatMinor(minPayout)} minimum — keep selling and request once you clear it.
          </p>
        ) : null}
        {!openRequest && (bankAccounts ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">Add a bank account below to enable payout requests.</p>
        ) : null}
        {/* R2-UI — deep-link to the grace-period release schedule (pending view). */}
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate({ view: "pending" })}
            className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            View release schedule <ArrowRight className="h-3 w-3" />
          </button>
        ) : null}
      </section>

      {/* balance cards */}
      <section aria-label="Balances" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Pending"
          value={formatMinor(w.pendingMinor)}
          sub={terms ? `Available ${holdAfterPayment(terms)} (hold)` : "Available after the clearing hold"}
          icon={<Clock3 className="h-4 w-4" />}
          tone="warn"
          onClick={onNavigate ? () => onNavigate({ view: "pending" }) : undefined}
        />
        <StatCard
          label="Available"
          value={formatMinor(w.availableMinor)}
          sub={w.availableMinor < 0 ? "Negative — check for refunds/adjustments" : "Ready for the next payout batch"}
          icon={<Wallet2 className="h-4 w-4" />}
          tone={w.availableMinor < 0 ? "bad" : undefined}
        />
        <StatCard label="Lifetime earned" value={formatMinor(w.lifetimeEarnedMinor)} sub="Gross seller net, all time" icon={<PiggyBank className="h-4 w-4" />} />
        <StatCard
          label="Commission paid"
          value={formatMinor(w.lifetimeCommissionMinor)}
          sub={terms ? `${fmtCommissionPercent(terms.commissionPercent)} platform fee, all time` : "Platform fee, all time"}
          icon={<Coins className="h-4 w-4" />}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ledger */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ReceiptText className="h-4 w-4 text-primary" /> Recent ledger activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentLines.length === 0 ? (
              <EmptyState title="No wallet activity yet" hint="When orders are paid you'll see credits here after the clearing hold." />
            ) : (
              <div className="max-h-96 overflow-y-auto overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Memo</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead aria-label="Open activity" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentLines.map((l) => (
                      <TableRow
                        key={l.id}
                        className="cursor-pointer transition-colors hover:bg-muted/50"
                        onClick={() => openActivity(l.id)}
                        aria-label={`View activity: ${l.memo ?? l.txn.description ?? l.txn.txnType}`}
                      >
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(l.createdAt)}</TableCell>
                        <TableCell className="max-w-64">
                          <p className="truncate text-sm font-medium group-hover:underline">{l.memo ?? l.txn.description ?? l.txn.txnType}</p>
                          {l.availableAt ? (
                            <p className="text-xs text-muted-foreground">Matures {fmtDate(l.availableAt)}</p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              "rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
                              (l.direction === "credit" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")
                            }
                          >
                            {l.direction}
                          </span>
                        </TableCell>
                        <TableCell
                          className={
                            "text-right tabular-nums " + (l.direction === "credit" ? "text-emerald-600" : "text-rose-600")
                          }
                        >
                          {l.direction === "credit" ? "+" : "−"}
                          {formatMinor(l.amountMinor)}
                        </TableCell>
                        <TableCell className="w-8 text-right text-muted-foreground">
                          <ArrowRight className="h-4 w-4" aria-hidden />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Double-entry ledger — every credit has a matching debit somewhere. Click any activity to see the full journal entry and the order, refund or payout behind it.
            </p>
          </CardContent>
        </Card>

        {/* bank accounts */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Landmark className="h-4 w-4 text-primary" /> Bank accounts
            </CardTitle>
            <Button variant="outline" size="sm" className="h-8 gap-1" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {(bankAccounts ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No bank account — add one to receive payouts.</p>
            ) : (
              (bankAccounts ?? []).map((a) => (
                <div key={a.id} className="rounded-xl border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{a.bankName}</p>
                    {a.verified ? <StatusChip status="verified" /> : <StatusChip status="pending" />}
                  </div>
                  <p className="text-xs text-muted-foreground">{a.holderName} · {a.accountNumberMasked}</p>
                  <p className="text-xs text-muted-foreground">Added {fmtDate(a.createdAt)}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* payouts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Payouts</CardTitle>
        </CardHeader>
        <CardContent>
          {data.payouts.length === 0 ? (
            <EmptyState title="No payouts yet" hint={`Payout batches run when your available balance clears the minimum (${formatMinor(minPayout)}).`} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Paid at</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.payouts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.referenceNo}</TableCell>
                      <TableCell className="capitalize">{p.method.replace(/_/g, " ")}</TableCell>
                      <TableCell>
                        <PayoutStatusChip status={p.status} />
                        {/* Failed rows surface the fail/reject-route reason (admin-entered,
                            seller-facing wording — e.g. "bank account closed"; the PSP path
                            writes provider-reported reasons). No stack traces or internal
                            error codes are ever written to this field, so it is safe to show. */}
                        {p.status === "failed" && p.failReason ? (
                          <p className="mt-1 max-w-48 truncate text-[11px] text-muted-foreground" title={p.failReason}>
                            {p.failReason}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinor(p.amountMinor)}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{p.paidAt ? fmtDateTime(p.paidAt) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddBankDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onDone={() => {
          refetchBanks();
          refetch();
        }}
      />

      {requestOpen ? (
        <RequestPayoutDialog
          open={requestOpen}
          onOpenChange={setRequestOpen}
          availableMinor={w.availableMinor}
          minPayoutMinor={minPayout}
          bankAccounts={bankAccounts ?? []}
          onDone={refetch}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- request payout dialog

function RequestPayoutDialog({
  open,
  onOpenChange,
  availableMinor,
  minPayoutMinor,
  bankAccounts,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  availableMinor: number;
  minPayoutMinor: number;
  bankAccounts: BankAccount[];
  onDone: () => void;
}) {
  // Fresh mount on open (parent conditionally renders it) — defaults to the
  // full available balance without a setState-in-effect.
  const [amountMinor, setAmountMinor] = useState<number | null>(availableMinor);
  const [busy, setBusy] = useState(false);

  const bank = bankAccounts.find((b) => b.verified) ?? bankAccounts[0] ?? null;
  const amount = amountMinor ?? 0;
  const valid = amount >= minPayoutMinor && amount <= availableMinor;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const ok = await runMutation(
      () => apiSend("POST", "/api/store/payouts", { amountMinor: amount }),
      "Payout request submitted — NOMOFEE finance will review it"
    );
    setBusy(false);
    if (ok) {
      onOpenChange(false);
      onDone();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Request a payout</DialogTitle>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="pr-amount">Amount *</Label>
            <MoneyInput id="pr-amount" valueMinor={amountMinor} onChangeMinor={setAmountMinor} placeholder="0.00" />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Min {formatMinor(minPayoutMinor)}</span>
              <button
                type="button"
                className="font-semibold text-teal-700 hover:underline"
                onClick={() => setAmountMinor(availableMinor)}
              >
                Use full balance ({formatMinor(availableMinor)})
              </button>
            </div>
          </div>
          <div className="rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="flex items-center gap-1.5 font-semibold text-foreground">
              <Landmark className="h-3.5 w-3.5" /> Paying to
            </p>
            {bank ? (
              <p className="mt-1">
                {bank.bankName} · {bank.holderName} · {bank.accountNumberMasked}
                {bank.verified ? " (verified)" : " (verification pending)"}
              </p>
            ) : (
              <p className="mt-1">No bank account on file — add one first.</p>
            )}
            <p className="mt-2">
              Your funds stay in the available balance while the request is reviewed. NOMOFEE transfers to this account once approved.
            </p>
          </div>
          <Button onClick={submit} disabled={busy || !valid || !bank} className="w-full min-h-[44px] gap-2">
            {busy ? <Wallet2 className="h-4 w-4 animate-pulse" /> : <Banknote className="h-4 w-4" />}
            Submit request
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- add bank dialog

function AddBankDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [holderName, setHolderName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const digits = accountNumber.replace(/\s+/g, "");
    if (!holderName.trim() || !bankName || digits.length < 4) {
      return runMutation(() => Promise.reject(new Error("Holder, bank and account number (min 4 digits) are required")), "");
    }
    setBusy(true);
    const ok = await runMutation(
      () => apiSend("POST", "/api/store/bank-accounts", { holderName: holderName.trim(), bankName, accountNumber }),
      "Bank account added — verification by admin pending"
    );
    setBusy(false);
    if (ok) {
      setHolderName("");
      setBankName("");
      setAccountNumber("");
      onOpenChange(false);
      onDone();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add bank account</DialogTitle>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="wa-holder">Account holder name *</Label>
            <Input id="wa-holder" value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="Lumina Living Sdn Bhd" />
          </div>
          <div className="space-y-1.5">
            <Label>Bank *</Label>
            <Select value={bankName} onValueChange={setBankName}>
              <SelectTrigger aria-label="Bank">
                <SelectValue placeholder="Select bank" />
              </SelectTrigger>
              <SelectContent>
                {BANKS.map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-acc">Account number *</Label>
            <Input
              id="wa-acc"
              inputMode="numeric"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9\s]/g, ""))}
              placeholder="1622 3810 5543"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Only the last 4 digits are stored in clear text. Admins verify accounts before payouts run.
          </p>
          <Button onClick={submit} disabled={busy} className="w-full min-h-[44px] gap-2">
            {busy ? <Wallet2 className="h-4 w-4 animate-pulse" /> : <Plus className="h-4 w-4" />} Add account
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- individual activity page

type ActivityDetail = {
  line: {
    id: string;
    accountCode: string;
    direction: "credit" | "debit";
    amountMinor: number;
    availableAt: string | null;
    memo: string | null;
    createdAt: string;
  };
  txn: {
    id: string;
    txnType: string;
    refType: string | null;
    refId: string | null;
    description: string | null;
    occurredAt: string;
  };
  walletAmountMinor: number;
  related:
    | { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; paidAt: string | null; itemCount: number }
    | { kind: "payout"; payoutId: string; referenceNo: string; status: string; method: string; amountMinor: number; paidAt: string | null }
    | { kind: "settlement"; reference: string }
    | { kind: "wallet_adjustment"; reference: string }
    | null;
  journal: {
    id: string;
    accountCode: string;
    direction: "credit" | "debit";
    amountMinor: number;
    availableAt: string | null;
    memo: string | null;
    isMine: boolean;
  }[];
};

const TXN_TYPE_LABEL: Record<string, string> = {
  order_paid: "Order payment received",
  gateway_settlement: "Gateway settlement",
  payout_initiated: "Payout initiated",
  payout_confirmed: "Payout confirmed",
  payout_failed: "Payout failed (reversed)",
  refund: "Refund issued",
  admin_adjustment: "Manual adjustment",
};

function LedgerActivityDetail({
  activityId,
  onBack,
  onNavigate,
}: {
  activityId: string;
  onBack: () => void;
  onNavigate: (n: SellerNav) => void;
}) {
  const { data, loading, error } = useApi<ActivityDetail>(`/api/store/wallet/activity/${activityId}`);
  // ADDENDUM #8 — live commission % for the order_paid explainer note.
  const { terms } = useSellerTerms();

  if (loading) return <RowsSkeleton rows={6} />;
  if (error || !data) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Back to wallet
        </Button>
        <Card><CardContent className="p-6 text-sm text-rose-600">Could not load activity{error ? `: ${error}` : ""}</CardContent></Card>
      </div>
    );
  }

  const { line, txn, walletAmountMinor, related, journal } = data;
  const myDirection = walletAmountMinor >= 0 ? "credit" : "debit";
  const walletAmount = Math.abs(walletAmountMinor);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Wallet
        </Button>
        <h2 className="text-lg font-semibold">{TXN_TYPE_LABEL[txn.txnType] ?? txn.txnType}</h2>
        <span
          className={
            "rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
            (myDirection === "credit" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")
          }
        >
          {myDirection} {formatMinor(walletAmount)}
        </span>
        <span className="text-xs text-muted-foreground">{fmtDateTime(txn.occurredAt)}</span>
      </div>

      {/* what is this activity about */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ReceiptText className="h-4 w-4 text-primary" /> Activity summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">{txn.description ?? line.memo ?? "—"}</p>
          <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-xs text-muted-foreground">Effect on your available balance</span>
              <p className={"font-semibold tabular-nums " + (myDirection === "credit" ? "text-emerald-600" : "text-rose-600")}>
                {myDirection === "credit" ? "+" : "−"}
                {formatMinor(walletAmount)}
              </p>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-xs text-muted-foreground">Clearing hold</span>
              <p className="font-medium">
                {line.availableAt ? `Matures ${fmtDate(line.availableAt)}` : "No hold — immediately available"}
              </p>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-xs text-muted-foreground">Recorded at</span>
              <p className="font-medium">{fmtDateTime(line.createdAt)}</p>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-xs text-muted-foreground">Journal reference</span>
              <p className="font-mono text-xs">{txn.id.slice(-8).toUpperCase()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* related business object — the "why" behind this activity */}
      {related ? (
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Banknote className="h-4 w-4 text-primary" /> What this activity belongs to
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {related.kind === "order" ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {txn.txnType === "refund" ? "Refund for order " : "Order "}
                    {related.orderNumber}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {related.itemCount} item{related.itemCount === 1 ? "" : "s"} · {formatMinor(related.totalMinor)} · placed {fmtDateTime(related.placedAt)}
                  </p>
                </div>
                <StatusChip status={related.status} />
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto gap-1.5"
                  onClick={() => onNavigate({ view: "orders", orderId: related.orderId })}
                >
                  View order <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : related.kind === "payout" ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Payout {related.referenceNo}</p>
                  <p className="text-xs text-muted-foreground">
                    {related.method.replace(/_/g, " ")} · {formatMinor(related.amountMinor)}
                    {related.paidAt ? ` · paid ${fmtDateTime(related.paidAt)}` : ""}
                  </p>
                </div>
                <PayoutStatusChip status={related.status} />
              </div>
            ) : related.kind === "settlement" ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Gateway settlement</p>
                  <p className="text-xs text-muted-foreground">Bank reference {related.reference} — money moved from the gateway to NOMOFEE's bank account.</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Manual wallet adjustment</p>
                  <p className="text-xs text-muted-foreground">Posted by a NOMOFEE admin against your wallet. See the journal below for the reason.</p>
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {txn.txnType === "refund"
                ? "This debit reduced your balance because the order was refunded to the shopper."
                : txn.txnType === "order_paid"
                  ? `This credit is the seller net from the order after the ${terms ? fmtCommissionPercent(terms.commissionPercent) : ""} platform commission and any clearing hold.`
                  : "Follow the journal entries below for the full money movement."}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* double-entry journal */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-primary" /> Journal entries (double-entry)
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Memo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {journal.map((j) => (
                <TableRow key={j.id} className={j.isMine ? "bg-teal-50/60 dark:bg-teal-950/30" : undefined}>
                  <TableCell className="max-w-52">
                    <p className="truncate font-mono text-xs">{j.accountCode}</p>
                    {j.isMine ? <p className="text-[11px] font-medium text-teal-700 dark:text-teal-300">Your wallet</p> : null}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
                        (j.direction === "credit" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")
                      }
                    >
                      {j.direction}
                    </span>
                  </TableCell>
                  <TableCell className={"text-right tabular-nums " + (j.direction === "credit" ? "text-emerald-600" : "text-rose-600")}>
                    {j.direction === "credit" ? "+" : "−"}
                    {formatMinor(j.amountMinor)}
                  </TableCell>
                  <TableCell className="max-w-56 text-xs text-muted-foreground">
                    <span className="line-clamp-2">{j.memo ?? "—"}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-3 text-xs text-muted-foreground">
            Every transaction balances: total debits = total credits. Highlighted rows are the legs on your wallet.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

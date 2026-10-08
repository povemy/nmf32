"use client";
// Task 2-d — SD-06/07 Wallet & Payouts: balance cards (ledger truth), recent
// ledger lines, payout history, bank accounts with add dialog.
import { useState } from "react";
import {
  apiSend,
  EmptyState,
  RowsSkeleton,
  StatCard,
  StatusChip,
  fmtDate,
  fmtDateTime,
  formatMinor,
  runMutation,
  useApi,
  type BankAccount,
  type SellerWallet,
} from "./ui-bits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Clock3, Coins, Landmark, PiggyBank, Plus, ReceiptText, Wallet2 } from "lucide-react";

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
    createdAt: string;
  }[];
};

const BANKS = ["Maybank", "CIMB", "Public Bank", "Bank Rakyat", "Hong Leong"];

export default function SellerWallet() {
  const { data, loading, error, refetch } = useApi<WalletData>("/api/store/wallet");
  const { data: bankAccounts, refetch: refetchBanks } = useApi<BankAccount[]>("/api/store/bank-accounts");
  const [addOpen, setAddOpen] = useState(false);

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

  return (
    <div className="space-y-6">
      {/* balance cards */}
      <section aria-label="Balances" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Pending"
          value={formatMinor(w.pendingMinor)}
          sub="Available 7 days after payment (hold)"
          icon={<Clock3 className="h-4 w-4" />}
          tone="warn"
        />
        <StatCard
          label="Available"
          value={formatMinor(w.availableMinor)}
          sub={w.availableMinor < 0 ? "Negative — check for refunds/adjustments" : "Ready for the next payout batch"}
          icon={<Wallet2 className="h-4 w-4" />}
          tone={w.availableMinor < 0 ? "bad" : undefined}
        />
        <StatCard label="Lifetime earned" value={formatMinor(w.lifetimeEarnedMinor)} sub="Gross seller net, all time" icon={<PiggyBank className="h-4 w-4" />} />
        <StatCard label="Commission paid" value={formatMinor(w.lifetimeCommissionMinor)} sub="8% platform fee, all time" icon={<Coins className="h-4 w-4" />} />
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
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentLines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(l.createdAt)}</TableCell>
                        <TableCell className="max-w-64">
                          <p className="truncate text-sm">{l.memo ?? l.txn.description ?? l.txn.txnType}</p>
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
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Double-entry ledger — every credit has a matching debit somewhere. This is the same data SHOPMESH admins audit.
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
            <EmptyState title="No payouts yet" hint="Payout batches run when your available balance clears the minimum (RM 50)." />
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
                      <TableCell><StatusChip status={p.status} /></TableCell>
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
    </div>
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

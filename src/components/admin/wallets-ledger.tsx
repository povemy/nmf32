"use client";
// FIN-05 Wallets + FIN-06 Ledger Explorer (transactions & accounts).
import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { apiSend, useApi } from "./use-api";
import { EmptyState, ErrorState, Money, PageHeader, StatusChip, TableSkeleton, TONE_CLASS, fmtDT, timeAgo } from "./ui-bits";

/* ---------------------------------------------------------------- FIN-05 */

type WalletRow = {
  id: string;
  sellerId: string;
  pendingMinor: number;
  availableMinor: number;
  lifetimeEarnedMinor: number;
  lifetimeCommissionMinor: number;
  seller?: { displayName: string; email: string } | null;
  sellerName?: string | null;
  store?: { name: string } | null;
  storeName?: string | null;
};

type LedgerTxn = {
  id: string;
  txnType: string;
  description?: string | null;
  occurredAt: string;
  lines: { id: string; accountCode: string; direction: string; amountMinor: number; availableAt?: string | null; memo?: string | null }[];
};

export function WalletsView() {
  const { data, error, loading, refetch } = useApi<WalletRow[]>("/api/admin/wallets");
  const rows = data ?? [];
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [adjustId, setAdjustId] = useState<string | null>(null);

  const active = rows.find((r) => r.id === drawerId) ?? null;
  const adjustTarget = rows.find((r) => r.id === adjustId) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader title="Wallets" description="Ledger-truth balances per seller (pending vs available)." />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={6} cols={5} />
            ) : rows.length === 0 ? (
              <EmptyState title="No wallets" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Seller</TableHead>
                    <TableHead className="hidden md:table-cell">Store</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Lifetime earned</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Commission</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((w) => (
                    <TableRow key={w.id} className="cursor-pointer" onClick={() => setDrawerId(w.id)}>
                      <TableCell>
                        <p className="font-medium">{w.seller?.displayName ?? w.sellerName ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">{w.seller?.email ?? ""}</p>
                      </TableCell>
                      <TableCell className="hidden text-sm md:table-cell">{w.store?.name ?? w.storeName ?? "—"}</TableCell>
                      <TableCell className="text-right"><Money minor={w.pendingMinor} muted /></TableCell>
                      <TableCell className="text-right">
                        <Money minor={w.availableMinor} bold className={cn(w.availableMinor < 0 && "text-red-600 dark:text-red-400")} />
                      </TableCell>
                      <TableCell className="hidden text-right lg:table-cell"><Money minor={w.lifetimeEarnedMinor} muted /></TableCell>
                      <TableCell className="hidden text-right lg:table-cell"><Money minor={w.lifetimeCommissionMinor} muted /></TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-[44px] sm:min-h-0"
                          onClick={() => setAdjustId(w.id)}
                        >
                          Adjust…
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* wallet drawer */}
      <Sheet open={drawerId !== null} onOpenChange={(o) => !o && setDrawerId(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md [scrollbar-width:thin]">
          {active ? (
            <>
              <SheetHeader>
                <SheetTitle>{active.seller?.displayName ?? active.sellerName ?? "Wallet"}</SheetTitle>
                <SheetDescription>
                  {active.store?.name ?? active.storeName ?? "—"} · ledger truth refreshed on write
                </SheetDescription>
              </SheetHeader>
              <div className="mt-2 grid grid-cols-2 gap-3 px-4">
                <MiniStat label="Pending" minor={active.pendingMinor} tone="amber" />
                <MiniStat label="Available" minor={active.availableMinor} tone={active.availableMinor < 0 ? "red" : "emerald"} />
                <MiniStat label="Lifetime earned" minor={active.lifetimeEarnedMinor} />
                <MiniStat label="Commission" minor={active.lifetimeCommissionMinor} />
              </div>
              <WalletActivity walletId={active.id} />
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <AdjustDialog
        wallet={adjustTarget}
        onClose={() => setAdjustId(null)}
        onDone={() => {
          setAdjustId(null);
          void refetch();
        }}
      />
    </div>
  );
}

function MiniStat({ label, minor, tone }: { label: string; minor: number; tone?: "amber" | "emerald" | "red" }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-sm font-semibold tabular-nums", tone === "amber" && "text-amber-700 dark:text-amber-400", tone === "emerald" && "text-emerald-700 dark:text-emerald-400", tone === "red" && "text-red-600 dark:text-red-400")}>
        {formatMinorSafe(minor)}
      </p>
    </div>
  );
}

import { formatMinor } from "@/lib/money";
function formatMinorSafe(v: number): string {
  return formatMinor(v);
}

function WalletActivity({ walletId }: { walletId: string }) {
  const { data, error, loading } = useApi<LedgerTxn[]>(`/api/admin/ledger/transactions?walletId=${encodeURIComponent(walletId)}`);
  const txns = data ?? [];
  return (
    <div className="mt-4 border-t px-4 py-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent ledger activity</p>
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : loading ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded bg-muted" />)}</div>
      ) : txns.length === 0 ? (
        <p className="text-xs text-muted-foreground">No transactions touching this wallet yet.</p>
      ) : (
        <ul className="space-y-2">
          {txns.slice(0, 12).map((t) => {
            const mine = t.lines.filter((l) => l.direction);
            const net = mine.reduce((s, l) => s + (l.direction === "credit" ? l.amountMinor : -l.amountMinor), 0);
            return (
              <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.description ?? t.txnType}</p>
                  <p className="text-[11px] text-muted-foreground">{t.txnType.replace(/_/g, " ")} · {timeAgo(t.occurredAt)}</p>
                </div>
                <Money minor={net} bold />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AdjustDialog({ wallet, onClose, onDone }: { wallet: WalletRow | null; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!wallet) return;
    setSaving(true);
    try {
      await apiSend(`/api/admin/wallets/${wallet.id}/adjust`, "POST", {
        amountMinor: toMinor(amount || "0"),
        direction,
        reason: reason.trim(),
      });
      toast.success("Wallet adjusted", { description: `${direction === "credit" ? "Credited" : "Debited"} ${formatMinor(toMinor(amount))} — ledger T6 posted.` });
      setAmount("");
      setReason("");
      onDone();
    } catch (e) {
      toast.error("Adjustment failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={wallet !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manual adjustment</DialogTitle>
          <DialogDescription>
            {wallet ? `${wallet.seller?.displayName ?? wallet.sellerName ?? "Wallet"} · posts an admin_adjustment ledger transaction.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Amount (RM)</Label>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Direction</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as typeof direction)}>
                <SelectTrigger className="min-h-[44px]" aria-label="Direction"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">Credit (add funds)</SelectItem>
                  <SelectItem value="debit">Debit (remove funds)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Reason (required, audited)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. goodwill compensation" className="min-h-[44px]" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="min-h-[44px] sm:min-h-0">Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || !reason.trim() || !amount} className="min-h-[44px] sm:min-h-0">
            {saving ? "Posting…" : "Post adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- FIN-06 */

const TXN_TONES: Record<string, string> = {
  order_paid: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
  gateway_settlement: "border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300",
  payout_initiated: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
  payout_confirmed: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
  payout_failed: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300",
  refund: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300",
  admin_adjustment: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300",
};

export function LedgerView() {
  const [tab, setTab] = useState("txns");

  return (
    <div className="space-y-4">
      <PageHeader title="Ledger Explorer" description="Double-entry transactions (M10) — every txn balances to zero." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto">
          <TabsTrigger value="txns" className="min-h-[44px]">Transactions</TabsTrigger>
          <TabsTrigger value="accounts" className="min-h-[44px]">Accounts</TabsTrigger>
        </TabsList>
        <TabsContent value="txns" className="mt-4"><LedgerTransactions /></TabsContent>
        <TabsContent value="accounts" className="mt-4"><LedgerAccounts /></TabsContent>
      </Tabs>
    </div>
  );
}

function LedgerTransactions() {
  const [type, setType] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [txns, setTxns] = useState<LedgerTxn[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const url = useMemo(() => {
    const sp = new URLSearchParams();
    if (type !== "all") sp.set("type", type);
    if (cursor) sp.set("cursor", cursor);
    return `/api/admin/ledger/transactions?${sp.toString()}`;
  }, [type, cursor]);

  useMemo(() => url, [url]); // stable debug anchor (kept intentionally minimal)
  void searchInput;
  void search;

  const load = async (append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { cache: "no-store" });
      const body = (await res.json()) as { data?: LedgerTxn[] };
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const rows = body.data ?? [];
      setTxns((prev) => (append ? [...prev, ...rows] : rows));
      const last = rows.length > 0 ? rows[rows.length - 1].id : null;
      setNextCursor(rows.length > 0 ? last : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load ledger");
    } finally {
      setLoading(false);
    }
  };

  useMemo(() => {
    void 0;
  }, []);
  // re-load when url changes
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  if (lastUrl !== url) {
    setLastUrl(url);
    void load(false);
  }

  const filtered = search ? txns.filter((t) => (t.description ?? "").toLowerCase().includes(search.toLowerCase()) || t.id.includes(search)) : txns;

  return (
    <Card className="py-0">
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select value={type} onValueChange={(v) => { setType(v); setCursor(null); }}>
            <SelectTrigger className="min-h-[44px] w-full sm:w-52" aria-label="Transaction type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {Object.keys(TXN_TONES).map((t) => (
                <SelectItem key={t} value={t} className="capitalize">{t.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <form
            className="relative flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(searchInput.trim());
            }}
          >
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Filter by description or id…" className="min-h-[44px] pl-9" aria-label="Search transactions" />
          </form>
        </div>

        <div className="mt-4 overflow-x-auto">
          {error ? (
            <ErrorState message={error} onRetry={() => void load(false)} />
          ) : loading ? (
            <TableSkeleton rows={6} cols={6} />
          ) : filtered.length === 0 ? (
            <EmptyState title="No transactions" hint="Post an order or payout to see ledger entries." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Txn</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="hidden md:table-cell">Description</TableHead>
                  <TableHead className="text-right">DR</TableHead>
                  <TableHead className="text-right">CR</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Occurred</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((t) => {
                  const dr = t.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
                  const cr = t.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
                  return (
                    <Fragment key={t.id}>
                      <TableRow className="cursor-pointer" onClick={() => setExpanded(expanded === t.id ? null : t.id)}>
                        <TableCell>{expanded === t.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                        <TableCell className="font-mono text-xs">{t.id.slice(0, 8)}…</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn("capitalize", TXN_TONES[t.txnType] ?? "")}>{t.txnType.replace(/_/g, " ")}</Badge>
                        </TableCell>
                        <TableCell className="hidden max-w-[260px] truncate md:table-cell">{t.description ?? "—"}</TableCell>
                        <TableCell className="text-right"><Money minor={dr} muted /></TableCell>
                        <TableCell className="text-right"><Money minor={cr} muted /></TableCell>
                        <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">{fmtDT(t.occurredAt)}</TableCell>
                      </TableRow>
                      {expanded === t.id ? (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/30 p-0">
                            <div className="p-3">
                              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Journal lines</p>
                              <div className="overflow-x-auto rounded-lg border">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Account</TableHead>
                                      <TableHead>Direction</TableHead>
                                      <TableHead className="text-right">Amount</TableHead>
                                      <TableHead className="hidden sm:table-cell">Available at</TableHead>
                                      <TableHead className="hidden md:table-cell">Memo</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {t.lines.map((l) => (
                                      <TableRow key={l.id}>
                                        <TableCell className="font-mono text-xs">{l.accountCode}</TableCell>
                                        <TableCell>
                                          <Badge variant="outline" className={cn("uppercase", l.direction === "debit" ? TONE_CLASS.slate : TONE_CLASS.teal)}>
                                            {l.direction === "debit" ? "DR" : "CR"}
                                          </Badge>
                                        </TableCell>
                                        <TableCell className="text-right"><Money minor={l.amountMinor} /></TableCell>
                                        <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{l.availableAt ? fmtDT(l.availableAt) : "immediate"}</TableCell>
                                        <TableCell className="hidden max-w-[220px] truncate text-xs text-muted-foreground md:table-cell">{l.memo ?? "—"}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        {nextCursor && !loading ? (
          <div className="mt-3 flex justify-center">
            <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => setCursor(nextCursor)}>
              Load older transactions
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LedgerAccounts() {
  const { data, error, loading, refetch } = useApi<LedgerAccountRow[]>("/api/admin/ledger/accounts");
  const rows = data ?? [];
  return (
    <Card className="py-0">
      <CardContent className="p-4">
        <div className="overflow-x-auto">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <TableSkeleton rows={6} cols={5} />
          ) : rows.length === 0 ? (
            <EmptyState title="No accounts" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Total debit</TableHead>
                  <TableHead className="text-right">Total credit</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Balance note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const dr = a.totalDebitMinor ?? a.totalDebit ?? a.debitMinor ?? 0;
                  const cr = a.totalCreditMinor ?? a.totalCredit ?? a.creditMinor ?? 0;
                  const debitNormal = a.type === "asset" || a.type === "expense";
                  const balance = debitNormal ? dr - cr : cr - dr;
                  return (
                    <TableRow key={a.code}>
                      <TableCell className="font-mono text-xs font-semibold">{a.code}</TableCell>
                      <TableCell className="font-medium">{a.name}</TableCell>
                      <TableCell><StatusChip status={a.type} className="capitalize" /></TableCell>
                      <TableCell className="text-right"><Money minor={dr} muted /></TableCell>
                      <TableCell className="text-right"><Money minor={cr} muted /></TableCell>
                      <TableCell className="hidden text-right text-xs text-muted-foreground md:table-cell">
                        {balance === 0 ? "settled" : `${debitNormal ? "DR" : "CR"} ${formatMinor(Math.abs(balance))}`}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type LedgerAccountRow = {
  code: string;
  name: string;
  type: string;
  totalDebitMinor?: number;
  totalCreditMinor?: number;
  totalDebit?: number;
  totalCredit?: number;
  debitMinor?: number;
  creditMinor?: number;
};

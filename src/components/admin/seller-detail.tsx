"use client";
// SEL-02 Seller Detail — overview, KYC docs, products, orders, wallet, bank, notes.
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatMinor } from "@/lib/money";
import { apiSend, useApi } from "./use-api";
import { useAdminCaps } from "./use-admin-caps";
import type { AdminNav } from "./nav";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  ReasonDialog,
  RiskChip,
  ScrollY,
  StatusChip,
  TableSkeleton,
  TypingConfirm,
  fmtDT,
  timeAgo,
} from "./ui-bits";

type KycDoc = { id: string; docType: string; fileName: string; status: string; rejectReason?: string | null; reviewedAt?: string | null };
type BankAcc = { id: string; holderName: string; bankName: string; accountNumberMasked: string; verified: boolean };
type Note = { id: string; author: string; body: string; createdAt: string };
type MiniProduct = { id: string; title: string; status: string; priceMinor: number };
type MiniOrder = { id: string; orderNumber: string; status: string; totalMinor: number; createdAt: string };

type SellerDetailBody = {
  seller: {
    id: string;
    email: string;
    fullName: string;
    displayName: string;
    status: string;
    riskTier: string;
    kycStatus: string;
    planCode: string;
    marketplaceOptIn: boolean;
    commissionOverridePercent: number | null;
    holdDaysOverride: number | null;
    rejectReason?: string | null;
    submittedAt?: string | null;
    approvedAt?: string | null;
    createdAt: string;
    // PHASE 2.3 (C2.7) — honest email-verification state. Absent/null =
    // NOT verified (the API surfaces exactly the Seller.emailVerifiedAt
    // column; nothing here may claim verification that did not occur).
    emailVerifiedAt?: string | null;
  };
  store?: { id: string; name: string; slug: string; status: string } | null;
  kycDocuments: KycDoc[];
  bankAccounts: BankAcc[];
  wallet?: { id: string; pendingMinor: number; availableMinor: number; lifetimeEarnedMinor: number; lifetimeCommissionMinor: number } | null;
  products?: MiniProduct[];
  orders?: MiniOrder[];
  notes?: Note[];
  gmv30dMinor?: number;
};

export function SellerDetailView({ nav, sellerId }: { nav: AdminNav; sellerId: string }) {
  const { can } = useAdminCaps();
  const { data, error, loading, refetch } = useApi<SellerDetailBody>(`/api/admin/sellers/${sellerId}`);
  const [busy, setBusy] = useState<string | null>(null);

  // dialogs
  const [confirm, setConfirm] = useState<"approve" | "activate" | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);

  // overview form
  const [risk, setRisk] = useState<string | null>(null);
  const [commPct, setCommPct] = useState<string>("");
  const [holdDays, setHoldDays] = useState<string>("");
  const [optIn, setOptIn] = useState<boolean | null>(null);

  const [noteBody, setNoteBody] = useState("");

  const seller = data?.seller;
  const store = data?.store;

  const act = async (key: string, path: string, body?: unknown, okMsg?: string) => {
    setBusy(key);
    try {
      await apiSend(path, "POST", body);
      toast.success(okMsg ?? "Done");
      void refetch();
      return true;
    } catch (e) {
      toast.error("Action failed", { description: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveOverview = async () => {
    if (!seller) return;
    setBusy("overview");
    try {
      // Phase 3 / F-09: commission-policy fields are server-gated to
      // commission.manage — sessions without the cap send opt-in only, so
      // the PATCH never carries fields the role cannot write.
      const body: Record<string, unknown> = {
        marketplaceOptIn: optIn ?? seller.marketplaceOptIn,
      };
      if (can("commission.manage")) {
        body.riskTier = risk ?? seller.riskTier;
        body.commissionOverridePercent = commPct === "" ? null : Number(commPct);
        body.holdDaysOverride = holdDays === "" ? null : Number(holdDays);
      }
      await apiSend(`/api/admin/sellers/${seller.id}`, "PATCH", body);
      toast.success("Seller updated", { description: "Changes audited server-side." });
      void refetch();
    } catch (e) {
      toast.error("Update failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <Card className="py-0"><CardContent className="p-4"><ErrorState message={error} onRetry={() => void refetch()} /></CardContent></Card>
    );
  }
  if (loading || !data || !seller) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <Card className="py-0"><CardContent className="p-4"><TableSkeleton rows={4} cols={4} /></CardContent></Card>
      </div>
    );
  }

  const status = seller.status;
  const wallet = data.wallet;
  const docs = data.kycDocuments ?? [];
  const banks = data.bankAccounts ?? [];
  const notes = [...(data.notes ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2 min-h-[44px] sm:min-h-0" onClick={() => nav.navigate("sellers")}>
        ← All sellers
      </Button>

      <PageHeader
        title={seller.displayName}
        description={`${store?.name ?? "No store"} · ${seller.email}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {can("sellers.approve") && (status === "pending_review" || status === "rejected") ? (
              <Button size="sm" className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700" disabled={busy !== null} onClick={() => setConfirm("approve")}>
                Approve
              </Button>
            ) : null}
            {can("sellers.approve") && status === "pending_review" ? (
              <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy !== null} onClick={() => setRejectOpen(true)}>
                Reject
              </Button>
            ) : null}
            {can("sellers.suspend") && status === "active" ? (
              <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy !== null} onClick={() => setSuspendOpen(true)}>
                Suspend
              </Button>
            ) : null}
            {can("sellers.suspend") && status === "suspended" ? (
              <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy !== null} onClick={() => setConfirm("activate")}>
                Activate
              </Button>
            ) : null}
            {can("sellers.suspend") && status !== "terminated" ? (
              <Button size="sm" variant="outline" className="min-h-[44px] border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:border-red-900 dark:hover:bg-red-950/40" disabled={busy !== null} onClick={() => setTerminateOpen(true)}>
                Terminate
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={status} />
        <RiskChip tier={seller.riskTier} />
        <Badge variant="outline" className="capitalize">{seller.kycStatus.replace(/_/g, " ")} kyc</Badge>
        {/* PHASE 2.3 (C2.7) — honest email-ownership state: the badge reads
            ONLY the server-provided emailVerifiedAt (null = NOT verified). */}
        {seller.emailVerifiedAt ? (
          <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300">
            email verified {fmtDT(seller.emailVerifiedAt)}
          </Badge>
        ) : (
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
            email unverified
          </Badge>
        )}
        <Badge variant="outline" className="capitalize">{seller.planCode} plan</Badge>
        <Badge variant="outline" className="capitalize">{seller.marketplaceOptIn ? "marketplace opt-in" : "marketplace off"}</Badge>
        {data.gmv30dMinor != null ? <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300">GMV 30d {formatMinor(data.gmv30dMinor)}</Badge> : null}
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="overview" className="min-h-[44px]">Overview</TabsTrigger>
          <TabsTrigger value="kyc" className="min-h-[44px]">KYC docs ({docs.length})</TabsTrigger>
          <TabsTrigger value="products" className="min-h-[44px]">Products</TabsTrigger>
          <TabsTrigger value="orders" className="min-h-[44px]">Orders</TabsTrigger>
          <TabsTrigger value="wallet" className="min-h-[44px]">Wallet</TabsTrigger>
          <TabsTrigger value="bank" className="min-h-[44px]">Bank ({banks.length})</TabsTrigger>
          <TabsTrigger value="notes" className="min-h-[44px]">Notes ({notes.length})</TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------- overview */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Commission & risk controls</CardTitle>
              <CardDescription>Overrides applied by the M09 engine before category/global defaults.</CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {can("commission.manage") ? (
                  <>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Risk tier</Label>
                      <Select value={risk ?? seller.riskTier} onValueChange={setRisk}>
                        <SelectTrigger className="min-h-[44px]" aria-label="Risk tier"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">low</SelectItem>
                          <SelectItem value="medium">medium</SelectItem>
                          <SelectItem value="high">high</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Commission override % (blank = inherit)</Label>
                      <Input
                        inputMode="decimal"
                        value={commPct}
                        onChange={(e) => setCommPct(e.target.value)}
                        placeholder={seller.commissionOverridePercent != null ? String(seller.commissionOverridePercent) : "inherit"}
                        className="min-h-[44px]"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Payout hold days override (blank = global)</Label>
                      <Input
                        inputMode="numeric"
                        value={holdDays}
                        onChange={(e) => setHoldDays(e.target.value)}
                        placeholder={seller.holdDaysOverride != null ? String(seller.holdDaysOverride) : "global default"}
                        className="min-h-[44px]"
                      />
                    </div>
                  </>
                ) : (
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-xs text-muted-foreground">Commission &amp; risk</Label>
                    <p className="text-sm text-muted-foreground">
                      Risk tier {seller.riskTier} · commission{" "}
                      {seller.commissionOverridePercent != null ? `${seller.commissionOverridePercent}% override` : "inherits defaults"} · hold{" "}
                      {seller.holdDaysOverride != null ? `${seller.holdDaysOverride}-day override` : "global default"}{" "}
                      — policy edits require the finance tier (commission.manage).
                    </p>
                  </div>
                )}
                <div className="flex items-end gap-3 pb-1">
                  <Switch
                    checked={optIn ?? seller.marketplaceOptIn}
                    onCheckedChange={setOptIn}
                    id="optin"
                    aria-label="Marketplace opt-in"
                  />
                  <Label htmlFor="optin" className="text-sm">Marketplace opt-in</Label>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <Button onClick={() => void saveOverview()} disabled={busy !== null} className="min-h-[44px]">
                  {busy === "overview" ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Lifecycle</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 p-4 pt-0 text-sm sm:grid-cols-3 sm:p-6 sm:pt-0">
              <div><p className="text-xs text-muted-foreground">Created</p><p>{fmtDT(seller.createdAt)}</p></div>
              <div><p className="text-xs text-muted-foreground">Submitted for review</p><p>{fmtDT(seller.submittedAt)}</p></div>
              <div><p className="text-xs text-muted-foreground">Approved</p><p>{fmtDT(seller.approvedAt)}</p></div>
              {seller.rejectReason ? <div className="sm:col-span-3"><p className="text-xs text-muted-foreground">Reject reason</p><p className="text-red-600 dark:text-red-400">{seller.rejectReason}</p></div> : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------- kyc docs */}
        <TabsContent value="kyc" className="mt-4">
          <Card className="py-0">
            <CardContent className="p-0">
              {docs.length === 0 ? (
                /* PHASE 2.3 KYC honesty: no document ingestion exists — rows
                   are metadata records created out-of-band; do not imply an
                   upload pipeline or document storage that is not there. */
                <EmptyState title="No KYC document records" hint="No document metadata on file for this seller yet." />
              ) : (
                <ScrollY>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Document</TableHead>
                        <TableHead className="hidden sm:table-cell">File</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden md:table-cell">Reviewed</TableHead>
                        <TableHead className="text-right">Decision</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {docs.map((d) => (
                        <KycDocRow key={d.id} doc={d} sellerId={seller.id} busy={busy !== null} onDone={() => void refetch()} />
                      ))}
                    </TableBody>
                  </Table>
                </ScrollY>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------- products */}
        <TabsContent value="products" className="mt-4">
          <Card className="py-0">
            <CardContent className="p-0">
              {(data.products ?? []).length === 0 ? (
                <EmptyState title="No products" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data.products ?? []).map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="max-w-[280px] truncate font-medium">{p.title}</TableCell>
                        <TableCell className="text-right"><Money minor={p.priceMinor} /></TableCell>
                        <TableCell><StatusChip status={p.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------- orders */}
        <TabsContent value="orders" className="mt-4">
          <Card className="py-0">
            <CardContent className="p-0">
              {(data.orders ?? []).length === 0 ? (
                <EmptyState title="No orders yet" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Placed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data.orders ?? []).map((o) => (
                      <TableRow key={o.id} className="cursor-pointer" onClick={() => nav.navigate("order-detail", { orderId: o.id })}>
                        <TableCell className="font-mono text-xs font-medium">{o.orderNumber}</TableCell>
                        <TableCell className="text-right"><Money minor={o.totalMinor} /></TableCell>
                        <TableCell><StatusChip status={o.status} /></TableCell>
                        <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">{timeAgo(o.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------- wallet */}
        <TabsContent value="wallet" className="mt-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <WalletCard label="Pending" minor={wallet?.pendingMinor} tone="amber" />
            <WalletCard label="Available" minor={wallet?.availableMinor} tone="emerald" />
            <WalletCard label="Lifetime earned" minor={wallet?.lifetimeEarnedMinor} />
            <WalletCard label="Lifetime commission" minor={wallet?.lifetimeCommissionMinor} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Balances are ledger truth (M10) refreshed on write. Manage adjustments in Finance → Wallets.
          </p>
        </TabsContent>

        {/* ------------------------------------------------- bank */}
        <TabsContent value="bank" className="mt-4">
          <Card className="py-0">
            <CardContent className="p-0">
              {banks.length === 0 ? (
                <EmptyState title="No bank accounts" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Holder</TableHead>
                      <TableHead>Bank</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead>Status</TableHead>
                      <BankActionHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {banks.map((b) => (
                      <BankRow key={b.id} acc={b} busy={busy !== null} onDone={() => void refetch()} />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------- notes */}
        <TabsContent value="notes" className="mt-4">
          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Internal notes</CardTitle>
              <CardDescription>Visible to admins only.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!noteBody.trim()) return;
                  const ok = await act("note", `/api/admin/sellers/${seller.id}/notes`, { body: noteBody.trim() }, "Note added");
                  if (ok) setNoteBody("");
                }}
              >
                <Textarea
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  placeholder="Add an internal note…"
                  rows={2}
                  className="flex-1 resize-none"
                />
                <Button type="submit" disabled={busy !== null || !noteBody.trim()} className="min-h-[44px]">
                  {busy === "note" ? "Adding…" : "Add note"}
                </Button>
              </form>
              <ScrollY className="max-h-[360px]">
                {notes.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No notes yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {notes.map((n) => (
                      <li key={n.id} className="rounded-lg border p-3">
                        <p className="text-sm">{n.body}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{n.author} · {fmtDT(n.createdAt)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollY>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* --------------------------------------------------- dialogs */}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "approve" ? "Approve seller?" : "Reactivate seller?"}
        description={confirm === "approve" ? "Seller becomes active, store goes live, KYC approved." : "Seller becomes active again and the store returns to live."}
        confirmLabel={confirm === "approve" ? "Approve" : "Activate"}
        loading={busy !== null}
        onConfirm={async () => {
          const ok = await act(confirm === "approve" ? "approve" : "activate", `/api/admin/sellers/${seller.id}/${confirm}`, undefined, confirm === "approve" ? "Seller approved" : "Seller activated");
          if (ok) setConfirm(null);
        }}
      />

      <ReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title="Reject seller"
        description="The seller will be marked rejected and notified with this reason."
        submitLabel="Reject seller"
        destructive
        loading={busy !== null}
        onSubmit={async (reason) => {
          const ok = await act("reject", `/api/admin/sellers/${seller.id}/reject`, { reason }, "Seller rejected");
          if (ok) setRejectOpen(false);
        }}
      />

      <ReasonDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title="Suspend seller"
        description="Store will be set to draft and selling disabled."
        submitLabel="Suspend"
        destructive
        loading={busy !== null}
        onSubmit={async (reason) => {
          const ok = await act("suspend", `/api/admin/sellers/${seller.id}/suspend`, { reason }, "Seller suspended");
          if (ok) setSuspendOpen(false);
        }}
      />

      <TypingConfirm
        open={terminateOpen}
        onOpenChange={setTerminateOpen}
        title="Terminate seller"
        description="Permanent action — the seller is banned from the platform."
        expected={seller.id}
        confirmLabel="Terminate"
        loading={busy !== null}
        onConfirm={async () => {
          const ok = await act("terminate", `/api/admin/sellers/${seller.id}/terminate`, { reason: "Terminated from admin command centre" }, "Seller terminated");
          if (ok) setTerminateOpen(false);
        }}
      />
    </div>
  );
}

function WalletCard({ label, minor, tone }: { label: string; minor?: number | null; tone?: "amber" | "emerald" }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-2 text-lg font-semibold tabular-nums ${tone === "emerald" ? "text-emerald-700 dark:text-emerald-400" : tone === "amber" ? "text-amber-700 dark:text-amber-400" : ""}`}>
        {formatMinor(minor ?? 0)}
      </p>
    </div>
  );
}

function BankActionHead() {
  return <TableHead className="text-right">Action</TableHead>;
}

function BankRow({ acc, busy, onDone }: { acc: BankAcc; busy: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const { can } = useAdminCaps();
  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{acc.holderName}</TableCell>
        <TableCell>{acc.bankName}</TableCell>
        <TableCell className="font-mono text-xs">{acc.accountNumberMasked}</TableCell>
        <TableCell>{acc.verified ? <StatusChip status="verified" /> : <StatusChip status="pending" />}</TableCell>
        <TableCell className="text-right">
          {!acc.verified ? (
            can("sellers.approve") ? (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={() => setOpen(true)}>
                  Reject
                </Button>
                <Button size="sm" className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700 sm:min-h-0" disabled={busy} onClick={() => void bankAction(acc.id, "verify", undefined, onDone)}>
                  Verify
                </Button>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">ops tier only</span>
            )
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>
      </TableRow>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title="Reject bank account"
        description="Seller will be asked to re-submit their bank details."
        submitLabel="Reject"
        destructive
        onSubmit={async (reason) => {
          const ok = await bankAction(acc.id, "reject", { reason }, () => {
            setOpen(false);
            onDone();
          });
          if (ok) setOpen(false);
        }}
      />
    </>
  );
}

async function bankAction(id: string, kind: "verify" | "reject", body: unknown, onDone: () => void): Promise<boolean> {
  try {
    await apiSend(`/api/admin/banks/${id}/${kind}`, "POST", body);
    toast.success(kind === "verify" ? "Bank account verified" : "Bank account rejected");
    onDone();
    return true;
  } catch (e) {
    toast.error("Action failed", { description: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

function KycDocRow({ doc, sellerId, busy, onDone }: { doc: KycDoc; sellerId: string; busy: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const { can } = useAdminCaps();
  const decide = async (decision: "approved" | "rejected", reason?: string) => {
    try {
      await apiSend(`/api/admin/sellers/${sellerId}/kyc/${doc.id}`, "POST", { decision, reason });
      toast.success(`Document ${decision}`);
      onDone();
      setOpen(false);
    } catch (e) {
      toast.error("Decision failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <>
      <TableRow>
        <TableCell className="font-medium capitalize">{doc.docType.replace(/_/g, " ")}</TableCell>
        <TableCell className="hidden max-w-[200px] truncate font-mono text-xs sm:table-cell">{doc.fileName}</TableCell>
        <TableCell><StatusChip status={doc.status} /></TableCell>
        <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{doc.reviewedAt ? fmtDT(doc.reviewedAt) : "—"}</TableCell>
        <TableCell className="text-right">
          {doc.status === "pending" ? (
            can("sellers.approve") ? (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={() => setOpen(true)}>
                  Reject
                </Button>
                <Button size="sm" className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700 sm:min-h-0" disabled={busy} onClick={() => void decide("approved")}>
                  Approve
                </Button>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">ops tier only</span>
            )
          ) : (
            <span className="text-xs text-muted-foreground">{doc.rejectReason ?? "—"}</span>
          )}
        </TableCell>
      </TableRow>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title={`Reject ${doc.docType.replace(/_/g, " ")}`}
        submitLabel="Reject document"
        destructive
        onSubmit={async (reason) => {
          await decide("rejected", reason);
          setOpen(false);
        }}
      />
    </>
  );
}

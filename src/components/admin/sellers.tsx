"use client";
// SEL-01 All Sellers list + SEL-03 KYC Queue.
import { useMemo, useState } from "react";
import { MoreHorizontal, Search, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { apiSend, useApi } from "./use-api";
import { useAdminCaps } from "./use-admin-caps";
import type { AdminNav } from "./nav";
import {
  Badge,
} from "@/components/ui/badge";
import {
  CardsSkeleton,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Pager,
  RiskChip,
  StatusChip,
  TableSkeleton,
  fmtDate,
  timeAgo,
} from "./ui-bits";

/* ------------------------------------------------------------------ types */

export type AdminSellerRow = {
  id: string;
  email: string;
  fullName: string;
  displayName: string;
  status: string;
  riskTier: string;
  commissionOverridePercent: number | null;
  kycStatus: string;
  planCode: string;
  submittedAt?: string | null;
  createdAt: string;
  store?: { name: string; slug: string; status: string } | null;
  storeName?: string | null;
  wallet?: { availableMinor: number; pendingMinor: number } | null;
  gmv30dMinor?: number;
};

/* --------------------------------------------------------------- SEL-01 */

const SELLER_STATUSES = ["onboarding", "pending_review", "active", "suspended", "rejected", "terminated"];

export function SellersView({ nav }: { nav: AdminNav }) {
  const { can } = useAdminCaps();
  const [status, setStatus] = useState("all");
  const [risk, setRisk] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(page), size: "20" });
    if (status !== "all") sp.set("status", status);
    if (risk !== "all") sp.set("riskTier", risk);
    if (search) sp.set("search", search);
    return `/api/admin/sellers?${sp.toString()}`;
  }, [status, risk, search, page]);

  const { data, meta, error, loading, refetch } = useApi<AdminSellerRow[]>(url);
  const rows = data ?? [];

  const [confirmAction, setConfirmAction] = useState<{ kind: "approve" | "suspend"; seller: AdminSellerRow } | null>(null);
  const [busy, setBusy] = useState(false);

  const runQuickAction = async () => {
    if (!confirmAction) return;
    setBusy(true);
    try {
      const path = `/api/admin/sellers/${confirmAction.seller.id}/${confirmAction.kind}`;
      await apiSend(path, "POST", confirmAction.kind === "suspend" ? { reason: "Suspended from sellers list" } : undefined);
      toast.success(`Seller ${confirmAction.kind === "approve" ? "approved" : "suspended"}`);
      setConfirmAction(null);
      void refetch();
    } catch (e) {
      toast.error("Action failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="All Sellers"
        description="Marketplace tenants, their stores, wallets and overrides."
      />

      <Card className="py-0">
        <CardContent className="p-4">
          {/* filters */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <form
              className="relative flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                setPage(1);
                setSearch(searchInput.trim());
              }}
            >
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search name, store or email…"
                className="min-h-[44px] pl-9"
                aria-label="Search sellers"
              />
            </form>
            <div className="flex gap-2">
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="min-h-[44px] w-full lg:w-44" aria-label="Filter by status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {SELLER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={risk}
                onValueChange={(v) => {
                  setRisk(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="min-h-[44px] w-full lg:w-36" aria-label="Filter by risk">
                  <SelectValue placeholder="Risk" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All risk</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* table */}
          <div className="mt-4 overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={7} />
            ) : rows.length === 0 ? (
              <EmptyState title="No sellers found" hint="Try clearing filters or search." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Seller / Store</TableHead>
                      <TableHead className="hidden md:table-cell">Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden sm:table-cell">Risk</TableHead>
                      <TableHead className="text-right">GMV 30d</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">Wallet avail.</TableHead>
                      <TableHead className="hidden lg:table-cell">Comm. override</TableHead>
                      <TableHead className="hidden xl:table-cell">Created</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((s) => (
                      <TableRow
                        key={s.id}
                        className={can("sellers.approve", "commission.manage") ? "cursor-pointer" : undefined}
                        onClick={
                          can("sellers.approve", "commission.manage")
                            ? () => nav.navigate("seller-detail", { sellerId: s.id })
                            : undefined
                        }
                      >
                        <TableCell>
                          <p className="font-medium">{s.displayName}</p>
                          <p className="text-xs text-muted-foreground">{s.store?.name ?? s.storeName ?? "—"}</p>
                        </TableCell>
                        <TableCell className="hidden max-w-[200px] truncate text-muted-foreground md:table-cell">{s.email}</TableCell>
                        <TableCell><StatusChip status={s.status} /></TableCell>
                        <TableCell className="hidden sm:table-cell"><RiskChip tier={s.riskTier} /></TableCell>
                        <TableCell className="text-right"><Money minor={s.gmv30dMinor} /></TableCell>
                        <TableCell className="hidden text-right lg:table-cell">
                          <Money minor={s.wallet?.availableMinor ?? 0} className={cn((s.wallet?.availableMinor ?? 0) < 0 && "font-semibold")} />
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {s.commissionOverridePercent != null ? (
                            <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300">
                              {s.commissionOverridePercent}%
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">inherit</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">{fmtDate(s.createdAt)}</TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {can("sellers.approve", "commission.manage") || can("sellers.suspend") ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${s.displayName}`}>
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {can("sellers.approve", "commission.manage") ? (
                                  <DropdownMenuItem onClick={() => nav.navigate("seller-detail", { sellerId: s.id })}>
                                    Open detail
                                  </DropdownMenuItem>
                                ) : null}
                                {can("sellers.approve") && (s.status === "pending_review" || s.status === "rejected") ? (
                                  <DropdownMenuItem onClick={() => setConfirmAction({ kind: "approve", seller: s })}>
                                    Approve seller
                                  </DropdownMenuItem>
                                ) : null}
                                {can("sellers.suspend") && s.status === "active" ? (
                                  <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => setConfirmAction({ kind: "suspend", seller: s })}>
                                    Suspend seller
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="px-1 pb-1">
                  <Pager
                    page={meta?.page ?? page}
                    size={meta?.size ?? 20}
                    total={meta?.total ?? rows.length}
                    onPrev={() => setPage((p) => Math.max(1, p - 1))}
                    onNext={() => setPage((p) => p + 1)}
                  />
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(o) => !o && setConfirmAction(null)}
        title={confirmAction?.kind === "approve" ? "Approve seller?" : "Suspend seller?"}
        description={
          confirmAction
            ? confirmAction.kind === "approve"
              ? `${confirmAction.seller.displayName} will become active and their store will go live.`
              : `${confirmAction.seller.displayName} will be suspended and their store set to draft.`
            : ""
        }
        confirmLabel={confirmAction?.kind === "approve" ? "Approve" : "Suspend"}
        destructive={confirmAction?.kind === "suspend"}
        loading={busy}
        onConfirm={() => void runQuickAction()}
      />
    </div>
  );
}

/* --------------------------------------------------------------- SEL-03 */

type KycCardSeller = {
  id: string;
  displayName: string;
  email: string;
  submittedAt?: string | null;
  createdAt?: string;
  store?: { name: string; productCount?: number } | null;
  storeName?: string | null;
  kycDocuments?: { id: string; docType: string; status: string; fileName: string }[];
  /** API shape (kyc-queue route returns `docs`) */
  docs?: { id: string; docType: string; status: string; fileName: string }[];
  docsApproved?: number;
  docsTotal?: number;
  bankAccounts?: { id: string; verified: boolean; bankName: string; accountNumberMasked: string }[];
  banks?: { id: string; verified: boolean; bankName: string; accountNumberMasked: string }[];
  products?: unknown[];
  productCount?: number;
};

export function KycQueueView({ nav }: { nav: AdminNav }) {
  const { data, error, loading, refetch } = useApi<KycCardSeller[]>("/api/admin/kyc-queue");
  const sellers = data ?? [];
  const [approving, setApproving] = useState<KycCardSeller | null>(null);
  const [busy, setBusy] = useState(false);

  const submitAgeHours = (s: KycCardSeller): number | null => {
    if (!s.submittedAt) return null;
    return Math.floor((Date.now() - new Date(s.submittedAt).getTime()) / 3600000);
  };

  const approve = async () => {
    if (!approving) return;
    setBusy(true);
    try {
      await apiSend(`/api/admin/sellers/${approving.id}/approve`, "POST");
      toast.success("Seller approved", { description: `${approving.displayName} is now active.` });
      setApproving(null);
      void refetch();
    } catch (e) {
      toast.error("Approve failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="KYC Queue"
        description="Sellers waiting for onboarding review (identity metadata, bank, catalog)."
        actions={
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => void refetch()} disabled={loading}>
            <UserCheck className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      {error ? (
        <Card className="py-0"><CardContent className="p-4"><ErrorState message={error} onRetry={() => void refetch()} /></CardContent></Card>
      ) : loading ? (
        <CardsSkeleton n={6} />
      ) : sellers.length === 0 ? (
        <Card className="py-0"><CardContent className="p-4"><EmptyState title="KYC queue is clear" hint="No sellers pending review right now." /></CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sellers.map((s) => {
            const hours = submitAgeHours(s);
            const late = hours !== null && hours > 48;
            const docs = s.kycDocuments ?? s.docs ?? [];
            const banks = s.bankAccounts ?? s.banks ?? [];
            const bankVerified = banks.some((b) => b.verified);
            const productCount = s.products?.length ?? s.productCount ?? s.store?.productCount ?? 0;
            return (
              <div
                key={s.id}
                className={cn(
                  "flex flex-col rounded-xl border bg-card p-4 shadow-sm",
                  late && "border-red-300 dark:border-red-900"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{s.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.store?.name ?? s.storeName ?? s.email}</p>
                  </div>
                  {hours !== null ? (
                    <Badge variant="outline" className={cn("shrink-0", late ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300" : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300")}>
                      {hours}h waiting
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">no submission date</Badge>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {docs.length === 0 ? (
                    // PHASE 2.3 KYC honesty: there is no document upload
                    // pipeline — these are metadata records, so the empty
                    // state must not imply uploads exist.
                    <span className="text-xs text-muted-foreground">No document records</span>
                  ) : (
                    docs.map((d) => (
                      <Badge key={d.id} variant="outline" className={cn("capitalize", d.status === "approved" ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300" : d.status === "rejected" ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300" : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300")}>
                        {d.docType.replace(/_/g, " ")}
                      </Badge>
                    ))
                  )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline" className={bankVerified ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300" : "border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"}>
                    bank {bankVerified ? "verified" : "unverified"}
                  </Badge>
                  <Badge variant="outline">{productCount} product{productCount === 1 ? "" : "s"}</Badge>
                  <span>submitted {timeAgo(s.submittedAt)}</span>
                </div>

                <div className="mt-4 flex gap-2">
                  <Button size="sm" className="min-h-[44px] flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => setApproving(s)}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" className="min-h-[44px] flex-1" onClick={() => nav.navigate("seller-detail", { sellerId: s.id })}>
                    Open detail
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={approving !== null}
        onOpenChange={(o) => !o && setApproving(null)}
        title="Approve seller?"
        description={approving ? `${approving.displayName} will become active, their store set live and KYC approved.` : ""}
        confirmLabel="Approve seller"
        loading={busy}
        onConfirm={() => void approve()}
      />
    </div>
  );
}

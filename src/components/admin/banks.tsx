"use client";
// FIN-08 Bank Verification — unverified queue with holder/store name match hint,
// verify / reject actions, and the verified accounts list below.
import { useState } from "react";
import { toast } from "sonner";
import { BadgeCheck, CheckCircle2, Landmark, ShieldQuestion, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiSend, useApi } from "./use-api";
import { useAdminCaps } from "./use-admin-caps";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  StatusChip,
  TableSkeleton,
  fmtDT,
} from "./ui-bits";
import { cn } from "@/lib/utils";

type BankRow = {
  id: string;
  holderName: string;
  bankName: string;
  accountNumberMasked: string;
  verified: boolean;
  verifiedAt?: string | null;
  createdAt?: string;
  sellerId?: string;
  sellerLegalName?: string;
  sellerEmail?: string;
  sellerStatus?: string;
  storeName?: string | null;
};

/** Heuristic holder↔store similarity: shared normalised tokens (≥1, or all when single-token). */
function nameMatches(holder: string | null | undefined, store: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  const h = norm(holder);
  const s = norm(store);
  if (h.length === 0 || s.length === 0) return false;
  const overlap = h.filter((t) => s.some((st) => st === t || st.includes(t) || t.includes(st))).length;
  const smaller = Math.min(h.length, s.length);
  return overlap >= Math.min(2, smaller) || (smaller === 1 && overlap === 1);
}

export function BanksView() {
  const { can } = useAdminCaps();
  const queue = useApi<BankRow[]>("/api/admin/banks?verified=false");
  const verified = useApi<BankRow[]>("/api/admin/banks?verified=true");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<BankRow | null>(null);
  const [verifyTarget, setVerifyTarget] = useState<BankRow | null>(null);

  const act = async (b: BankRow, kind: "verify" | "reject") => {
    setBusyId(b.id);
    try {
      await apiSend(`/api/admin/banks/${b.id}/${kind}`, "POST");
      toast.success(kind === "verify" ? "Bank account verified" : "Bank account rejected", {
        description: `${b.bankName} ${b.accountNumberMasked} · ${b.storeName ?? b.sellerLegalName ?? ""}`,
      });
      setVerifyTarget(null);
      setRejectTarget(null);
      void queue.refetch();
      void verified.refetch();
    } catch (e) {
      toast.error(`Could not ${kind} account`, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  };

  const queueRows = queue.data ?? [];
  const verifiedRows = verified.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bank Verification"
        description="Payout bank accounts submitted by sellers. Compare the holder name against the store before approving."
      />

      {/* verification queue */}
      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldQuestion className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            Verification queue ({queueRows.length})
          </CardTitle>
          <CardDescription>Unverified accounts awaiting an ops decision.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {queue.error ? (
            <ErrorState message={queue.error} onRetry={() => void queue.refetch()} />
          ) : queue.loading ? (
            <TableSkeleton rows={3} cols={6} />
          ) : queueRows.length === 0 ? (
            <EmptyState title="Queue is clear" hint="No bank accounts waiting for verification." />
          ) : (
            <div className="space-y-3">
              {queueRows.map((b) => {
                const match = nameMatches(b.holderName, b.storeName);
                return (
                  <div
                    key={b.id}
                    className="flex flex-col gap-3 rounded-xl border p-4 lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{b.holderName}</p>
                        <Badge
                          variant="outline"
                          className={cn(
                            match
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
                              : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
                          )}
                        >
                          {match ? "holder name match" : "check holder name"}
                        </Badge>
                        <StatusChip status={b.sellerStatus} />
                      </div>
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Landmark className="h-3.5 w-3.5 shrink-0" />
                        {b.bankName} · <span className="font-mono">{b.accountNumberMasked}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Seller {b.sellerLegalName ?? "—"} ({b.sellerEmail ?? "—"}) · Store {b.storeName ?? "—"} · added {fmtDT(b.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {can("sellers.approve") ? (
                        <>
                          <Button
                            size="sm"
                            className="min-h-[44px] flex-1 bg-emerald-600 hover:bg-emerald-700 lg:flex-none"
                            disabled={busyId !== null}
                            onClick={() => setVerifyTarget(b)}
                          >
                            <BadgeCheck className="h-4 w-4" /> Verify
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="min-h-[44px] flex-1 border-red-200 text-red-600 hover:bg-red-50 lg:flex-none dark:border-red-900 dark:hover:bg-red-950/40"
                            disabled={busyId !== null}
                            onClick={() => setRejectTarget(b)}
                          >
                            <XCircle className="h-4 w-4" /> Reject
                          </Button>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground lg:px-2">Read-only — verification requires the ops tier.</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* verified list */}
      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            Verified accounts ({verifiedRows.length})
          </CardTitle>
          <CardDescription>Accounts cleared for payouts.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {verified.error ? (
              <ErrorState message={verified.error} onRetry={() => void verified.refetch()} />
            ) : verified.loading ? (
              <TableSkeleton rows={3} cols={5} />
            ) : verifiedRows.length === 0 ? (
              <EmptyState title="Nothing verified yet" hint="Approve accounts from the queue above." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Holder</TableHead>
                    <TableHead className="hidden sm:table-cell">Bank · Number</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead className="hidden md:table-cell">Verified at</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {verifiedRows.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell>
                        <p className="font-medium">{b.holderName}</p>
                        <p className="text-xs text-muted-foreground">{b.sellerEmail ?? ""}</p>
                      </TableCell>
                      <TableCell className="hidden text-sm sm:table-cell">
                        {b.bankName} · <span className="font-mono">{b.accountNumberMasked}</span>
                      </TableCell>
                      <TableCell className="text-sm">{b.storeName ?? "—"}</TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{fmtDT(b.verifiedAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-0 dark:hover:bg-red-950/40"
                          disabled={busyId !== null}
                          onClick={() => setRejectTarget(b)}
                        >
                          Un-verify
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

      <ConfirmDialog
        open={verifyTarget !== null}
        onOpenChange={(o) => !o && setVerifyTarget(null)}
        title="Verify bank account?"
        description={
          verifyTarget
            ? `${verifyTarget.holderName} · ${verifyTarget.bankName} ${verifyTarget.accountNumberMasked} will be marked verified and becomes payout-eligible.`
            : ""
        }
        confirmLabel="Verify account"
        loading={busyId !== null}
        onConfirm={() => verifyTarget && void act(verifyTarget, "verify")}
      />

      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title={rejectTarget?.verified ? "Un-verify bank account?" : "Reject bank account?"}
        description={
          rejectTarget
            ? `${rejectTarget.holderName} · ${rejectTarget.bankName} ${rejectTarget.accountNumberMasked} will be marked unverified.`
            : ""
        }
        confirmLabel="Confirm"
        destructive
        loading={busyId !== null}
        onConfirm={() => rejectTarget && void act(rejectTarget, "reject")}
      />
    </div>
  );
}

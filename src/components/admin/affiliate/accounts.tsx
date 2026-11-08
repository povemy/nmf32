"use client";
// AFF-02 — Affiliate Accounts: searchable/status-filterable review list plus
// a detail sheet (profile, sponsor lineage, balances, recent commissions &
// payouts) with the audited status actions (suspend/reinstate/terminate) and
// the sponsor-correction form. Data: GET /api/admin/affiliate/accounts and
// GET …/accounts/[id] (cap: affiliate.manage).
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowRightLeft, Search, UserCheck, UserMinus, UserX, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AdminNav } from "../nav";
import { useAdminCaps } from "../use-admin-caps";
import { apiSend, useApi } from "../use-api";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Pager,
  ReasonDialog,
  StatusChip,
  TableSkeleton,
  fmtDate,
  fmtDT,
} from "../ui-bits";
import type {
  AdminAffAccountDetailData,
  AdminAffAccountProfile,
  AdminAffAccountsData,
  AdminAffSponsorBody,
  AdminAffSponsorData,
  AdminAffStatusBody,
  AdminAffStatusData,
} from "@/lib/types/api-contract";

const ACCOUNT_STATUSES = ["active", "suspended", "terminated"];

export function AffiliateAccountsView({ nav }: { nav: AdminNav }) {
  const [status, setStatus] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(page), size: "20" });
    if (status !== "all") sp.set("status", status);
    if (q) sp.set("q", q);
    return `/api/admin/affiliate/accounts?${sp.toString()}`;
  }, [status, q, page]);

  const { data, error, loading, refetch } = useApi<AdminAffAccountsData>(url);
  const rows = useMemo(() => data?.accounts ?? [], [data]);
  const total = data?.total ?? 0;
  const serverPage = data?.page ?? page;

  const [detailId, setDetailId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Affiliate Accounts"
        description="Review affiliates, correct sponsor relationships (audited) and suspend or terminate offenders."
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
                setQ(searchInput.trim());
              }}
            >
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search name, code, slug or email…"
                className="min-h-[44px] pl-9"
                aria-label="Search affiliates"
              />
            </form>
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
                {ACCOUNT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* table */}
          <div className="mt-4 overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={7} />
            ) : rows.length === 0 ? (
              <EmptyState title="No affiliate accounts found" hint="Try clearing filters or search." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Affiliate</TableHead>
                      <TableHead className="hidden sm:table-cell">Code / slug</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden md:table-cell">Sponsor</TableHead>
                      <TableHead className="text-right">Referrals</TableHead>
                      <TableHead className="text-right">Lifetime earnings</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">Activated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((a) => (
                      <TableRow key={a.id} className="cursor-pointer" onClick={() => setDetailId(a.id)}>
                        <TableCell>
                          <p className="font-medium">{a.displayName}</p>
                          <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <p className="font-mono text-xs font-semibold">{a.code}</p>
                          <p className="font-mono text-[11px] text-muted-foreground">/{a.slug}</p>
                        </TableCell>
                        <TableCell>
                          <StatusChip status={a.status} />
                          {a.suspendedReason ? (
                            <p className="mt-1 max-w-40 truncate text-[11px] text-muted-foreground" title={a.suspendedReason}>
                              {a.suspendedReason}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="hidden text-sm md:table-cell">{a.sponsorName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.referrals}</TableCell>
                        <TableCell className="text-right">
                          <Money minor={a.lifetimeEarningsMinor} bold />
                        </TableCell>
                        <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">
                          {fmtDate(a.activatedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="px-1 pb-1">
                  <Pager
                    page={serverPage}
                    size={20}
                    total={total}
                    onPrev={() => setPage((p) => Math.max(1, p - 1))}
                    onNext={() => setPage((p) => p + 1)}
                  />
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {detailId ? (
        <AccountSheet
          id={detailId}
          onClose={() => setDetailId(null)}
          onMutated={() => void refetch()}
          nav={nav}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- detail */

function AccountSheet({
  id,
  onClose,
  onMutated,
  nav,
}: {
  id: string;
  onClose: () => void;
  onMutated: () => void;
  nav: AdminNav;
}) {
  const { can } = useAdminCaps();
  const { data, error, loading, refetch } = useApi<AdminAffAccountDetailData>(`/api/admin/affiliate/accounts/${encodeURIComponent(id)}`);
  const [statusAction, setStatusAction] = useState<"suspend" | "terminate" | null>(null);
  const [reinstating, setReinstating] = useState(false);
  const [sponsorOpen, setSponsorOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const profile = data?.profile ?? null;

  const runStatus = async (action: "suspend" | "reinstate" | "terminate", reason?: string): Promise<boolean> => {
    if (!profile) return false;
    setBusy(true);
    try {
      const body: AdminAffStatusBody = reason ? { action, reason } : { action };
      const res = await apiSend<AdminAffStatusData>(`/api/admin/affiliate/accounts/${encodeURIComponent(profile.id)}/status`, "POST", body);
      toast.success(`Affiliate ${action === "reinstate" ? "reinstated" : action}`, {
        description: `Status is now “${res.status}” — the action was written to the audit log.`,
      });
      onMutated();
      void refetch();
      return true;
    } catch (e) {
      toast.error(`${action} failed`, { description: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg [scrollbar-width:thin]">
        {error ? (
          <div className="p-4">
            <ErrorState message={error} onRetry={() => void refetch()} />
          </div>
        ) : loading || !data ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2">
                {data.profile.displayName}
                <StatusChip status={data.profile.status} />
              </SheetTitle>
              <SheetDescription>
                <span className="font-mono">{data.profile.code}</span> · /{data.profile.slug} · {data.profile.email}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-8">
              {/* profile */}
              <section>
                <SectionTitle>Profile</SectionTitle>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border p-3 text-sm">
                  <InfoRow label="User">{data.profile.fullName || "—"}</InfoRow>
                  <InfoRow label="User since">{fmtDate(data.profile.userCreatedAt)}</InfoRow>
                  <InfoRow label="Activated">{fmtDate(data.profile.activatedAt)}</InfoRow>
                  <InfoRow label="Referrals">{data.referralCount}</InfoRow>
                  <InfoRow label="Sponsor" className="col-span-2">
                    {data.profile.sponsor ? (
                      <>
                        {data.profile.sponsor.displayName}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({data.profile.sponsorSource ?? "unknown"} ·{" "}
                          {data.profile.sponsorAssignedAt ? fmtDT(data.profile.sponsorAssignedAt) : "no timestamp"})
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">none</span>
                    )}
                  </InfoRow>
                  {data.profile.bio ? (
                    <InfoRow label="Bio" className="col-span-2">
                      <span className="text-muted-foreground">{data.profile.bio}</span>
                    </InfoRow>
                  ) : null}
                  {data.profile.suspendedReason ? (
                    <InfoRow label="Suspension reason" className="col-span-2">
                      <span className="text-red-600 dark:text-red-400">{data.profile.suspendedReason}</span>
                    </InfoRow>
                  ) : null}
                </div>
              </section>

              {/* balances */}
              <section>
                <SectionTitle>Balances (ledger-derived)</SectionTitle>
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat label="Pending" minor={data.balances.pendingMinor} />
                  <MiniStat label="Approved" minor={data.balances.approvedMinor} />
                  <MiniStat label="Available" minor={data.balances.availableMinor} tone="emerald" />
                  <MiniStat label="In payout" minor={data.balances.payoutInFlightMinor} tone="amber" />
                  <MiniStat label="Held" minor={data.balances.heldMinor} tone={data.balances.heldMinor > 0 ? "red" : undefined} />
                  <MiniStat label="Paid" minor={data.balances.paidMinor} />
                  <MiniStat label="Reversed" minor={data.balances.reversedMinor} />
                  <MiniStat label="Recovery" minor={data.balances.recoveryMinor} />
                  <MiniStat label="Requestable" minor={data.balances.requestableMinor} tone="emerald" />
                </div>
              </section>

              {/* actions */}
              {can("affiliate.manage") && profile ? (
                <section>
                  <SectionTitle>Review actions (audited)</SectionTitle>
                  <div className="flex flex-wrap gap-2">
                    {profile.status === "active" ? (
                      <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={() => setStatusAction("suspend")}>
                        <UserMinus className="h-3.5 w-3.5" /> Suspend…
                      </Button>
                    ) : null}
                    {profile.status === "suspended" ? (
                      <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={() => setReinstating(true)}>
                        <UserCheck className="h-3.5 w-3.5" /> Reinstate
                      </Button>
                    ) : null}
                    {profile.status !== "terminated" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-[44px] border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 sm:min-h-0 dark:border-red-900 dark:hover:bg-red-950/40"
                        disabled={busy}
                        onClick={() => setStatusAction("terminate")}
                      >
                        <UserX className="h-3.5 w-3.5" /> Terminate…
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">Terminated is terminal — no further status actions.</p>
                    )}
                  </div>
                  {profile.status === "active" || profile.status === "suspended" ? (
                    <Button variant="ghost" size="sm" className="mt-2 min-h-[44px] sm:min-h-0" disabled={busy} onClick={() => setSponsorOpen(true)}>
                      <ArrowRightLeft className="h-3.5 w-3.5" /> Correct sponsor…
                    </Button>
                  ) : null}
                </section>
              ) : null}

              {/* sponsor audit trail */}
              <section>
                <SectionTitle>Sponsor corrections audit ({data.sponsorAudit.length})</SectionTitle>
                {data.sponsorAudit.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No sponsor corrections recorded for this affiliate.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.sponsorAudit.slice(0, 10).map((a, i) => (
                      <li key={i} className="rounded-lg border p-2.5 text-xs">
                        <p className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono">{a.fromSponsorId ? a.fromSponsorId.slice(0, 8) : "none"}</span>
                          <span aria-hidden>→</span>
                          <span className="font-mono">{a.toSponsorId ? a.toSponsorId.slice(0, 8) : "cleared"}</span>
                          <span className="ml-auto text-muted-foreground">{fmtDT(a.createdAt)}</span>
                        </p>
                        <p className="mt-1 text-muted-foreground">{a.reason}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* recent commissions */}
              <section>
                <SectionTitle>
                  Recent commissions
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 gap-1 text-xs"
                    onClick={() => nav.navigate("affiliate-commissions", { affiliateId: data.profile.id })}
                  >
                    Inspect in Commissions <Users className="h-3 w-3" aria-hidden />
                  </Button>
                </SectionTitle>
                {data.commissions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No commissions posted yet.</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Order</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Pool</TableHead>
                          <TableHead className="text-right">Direct</TableHead>
                          <TableHead className="text-right">Sponsor</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.commissions.slice(0, 10).map((c) => (
                          <TableRow key={c.id}>
                            <TableCell>
                              <p className="font-mono text-xs font-semibold">{c.orderNumber}</p>
                              <p className="text-[10px] text-muted-foreground">{fmtDate(c.createdAt)}</p>
                            </TableCell>
                            <TableCell>
                              <StatusChip status={c.status} />
                            </TableCell>
                            <TableCell className="text-right">
                              <Money minor={c.poolMinor} />
                            </TableCell>
                            <TableCell className="text-right">
                              <Money minor={c.directMinor} muted />
                            </TableCell>
                            <TableCell className="text-right">
                              <Money minor={c.sponsorMinor} muted />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>

              {/* recent payouts */}
              <section>
                <SectionTitle>Recent payouts</SectionTitle>
                {data.payouts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No payouts requested yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.payouts.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm">
                        <div className="min-w-0">
                          <Money minor={p.amountMinor} bold />
                          <p className="text-[11px] text-muted-foreground">
                            requested {fmtDT(p.requestedAt)}
                            {p.processedAt ? ` · processed ${fmtDT(p.processedAt)}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <StatusChip status={p.status} />
                          {p.reference ? <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{p.reference}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>

      {/* suspend / terminate — reason ≥ 10 chars, audited */}
      <ReasonDialog
        open={statusAction !== null}
        onOpenChange={(o) => !o && setStatusAction(null)}
        title={statusAction === "terminate" ? "Terminate affiliate" : "Suspend affiliate"}
        description={
          statusAction === "terminate"
            ? "Termination is permanent: the affiliate stops earning and their held sponsor-role shares never return. Reason (min 10 characters) is written to the audit log."
            : "A suspended affiliate stops earning NEW commissions; their sponsor-role shares on other affiliates' in-flight pools are held (the direct promoter's 90% is never touched). Reason (min 10 characters) is written to the audit log."
        }
        placeholder="e.g. Self-referral ring suspected — order audit #1234"
        submitLabel={statusAction === "terminate" ? "Terminate" : "Suspend"}
        destructive
        loading={busy}
        onSubmit={(reason) => {
          if (reason.length < 10) {
            toast.error("Reason too short", { description: "A documented reason of at least 10 characters is required." });
            return;
          }
          const action = statusAction;
          if (!action) return;
          void runStatus(action, reason).then((ok) => {
            if (ok) setStatusAction(null);
          });
        }}
      />

      {/* reinstate — releases held sponsor-role entries with a fresh review window */}
      <ConfirmDialog
        open={reinstating}
        onOpenChange={(o) => !o && setReinstating(false)}
        title="Reinstate affiliate?"
        description={
          profile
            ? `${profile.displayName} returns to active. Their held entries re-join the lifecycle with a fresh review window (review_days).`
            : ""
        }
        confirmLabel="Reinstate"
        loading={busy}
        onConfirm={() => {
          setReinstating(false);
          void runStatus("reinstate");
        }}
      />

      {/* sponsor correction — code-based, reason ≥ 10 chars, double-confirmed */}
      {profile ? (
        <SponsorCorrectionDialog
          open={sponsorOpen}
          onOpenChange={setSponsorOpen}
          profile={profile}
          busy={busy}
          onDone={() => {
            onMutated();
            void refetch();
          }}
        />
      ) : null}
    </Sheet>
  );
}

/* -------------------------------------------------- sponsor correction */

function SponsorCorrectionDialog({
  open,
  onOpenChange,
  profile,
  busy,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AdminAffAccountProfile;
  busy: boolean;
  onDone: () => void;
}) {
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const trimmedReason = reason.trim();
  const valid = trimmedReason.length >= 10;

  const submit = async () => {
    setSaving(true);
    try {
      const body: AdminAffSponsorBody = {
        sponsorCode: code.trim() || null,
        reason: trimmedReason,
      };
      await apiSend<AdminAffSponsorData>(`/api/admin/affiliate/accounts/${encodeURIComponent(profile.id)}/sponsor`, "POST", body);
      toast.success("Sponsor corrected", {
        description: code.trim()
          ? `Future attributions follow sponsor “${code.trim()}” — existing commission snapshots are never rewritten.`
          : "Sponsor cleared — future attributions run without an upstream sponsor share.",
      });
      onOpenChange(false);
      setCode("");
      setReason("");
      onDone();
    } catch (e) {
      toast.error("Sponsor correction failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Fragment>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            onOpenChange(false);
            setConfirming(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Correct sponsor — {profile.displayName}</DialogTitle>
            <DialogDescription>
              The ONLY path that changes a sponsor relationship after activation. Enter the new sponsor&apos;s referral
              CODE, or leave empty to clear the sponsor entirely. Existing OrderItem/commission sponsor snapshots are
              never rewritten — only future attributions follow the correction.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`sponsor-code-${profile.id}`}>New sponsor code (empty = clear sponsor)</Label>
              <Input
                id={`sponsor-code-${profile.id}`}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. NOFO-SARAH-92"
                className="min-h-[44px] font-mono"
                autoComplete="off"
                disabled={saving}
              />
              <p className="text-[11px] text-muted-foreground">
                Current sponsor: {profile.sponsor ? profile.sponsor.displayName : "none"}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`sponsor-reason-${profile.id}`}>Reason (min 10 characters, audited)</Label>
              <Textarea
                id={`sponsor-reason-${profile.id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Member signed up under the wrong link at the roadshow — reassign per request #432"
                rows={3}
                className="resize-none"
                disabled={saving}
              />
              {!valid && trimmedReason.length > 0 ? (
                <p className="text-[11px] text-red-600 dark:text-red-400">
                  {10 - trimmedReason.length} more character{10 - trimmedReason.length === 1 ? "" : "s"} required.
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                setConfirming(false);
              }}
              disabled={saving}
              className="min-h-[44px] sm:min-h-0"
            >
              Cancel
            </Button>
            <Button disabled={!valid || saving} className="min-h-[44px] sm:min-h-0" onClick={() => setConfirming(true)}>
              Review correction…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => !o && setConfirming(false)}
        title="Apply sponsor correction?"
        description={
          code.trim()
            ? `${profile.displayName} will be re-assigned to the affiliate with referral code “${code.trim()}”. The change is audit-logged with your reason.`
            : `${profile.displayName}'s sponsor will be cleared (no upstream sponsor share on future commissions). The change is audit-logged with your reason.`
        }
        confirmLabel="Apply correction"
        destructive
        loading={saving || busy}
        onConfirm={() => void submit()}
      />
    </Fragment>
  );
}

/* -------------------------------------------------------------- bits */

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

function InfoRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="break-words text-sm">{children}</p>
    </div>
  );
}

function MiniStat({ label, minor, tone }: { label: string; minor: number; tone?: "amber" | "emerald" | "red" }) {
  return (
    <div className="rounded-lg border p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-sm font-semibold tabular-nums",
          tone === "amber" && "text-amber-700 dark:text-amber-400",
          tone === "emerald" && "text-emerald-700 dark:text-emerald-400",
          tone === "red" && "text-red-600 dark:text-red-400"
        )}
      >
        <Money minor={minor} />
      </p>
    </div>
  );
}

"use client";
// SUP-01 Support Tickets — queue with status filter, thread dialog with reply,
// status + priority controls.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { LifeBuoy, MessageSquare, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiSend, useApi } from "./use-api";
import { qs } from "./nav";
import type {
  AdminTicketDetailData,
  AdminTicketPatchBody,
  AdminTicketReplyBody,
  AdminTicketReplyData,
  AdminTicketRow,
  AdminTicketSummary,
} from "@/lib/types/api-contract";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Pager,
  StatusChip,
  TableSkeleton,
  fmtDT,
  timeAgo,
} from "./ui-bits";

const TICKET_STATUSES = ["open", "pending", "closed"];
const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"];

export function SupportView() {
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const url = useMemo(() => `/api/admin/tickets${qs({ status: status === "all" ? "" : status, page, size: 15 })}`, [status, page]);
  const { data, meta, error, loading, refetch } = useApi<AdminTicketRow[]>(url);
  const rows = data ?? [];

  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const thread = useApi<AdminTicketDetailData>(openId ? `/api/admin/tickets/${openId}` : null);
  const active = rows.find((t) => t.id === openId) ?? null;

  const sendReply = async () => {
    if (!openId || !reply.trim()) return;
    setSending(true);
    try {
      await apiSend<AdminTicketReplyData>(`/api/admin/tickets/${openId}/reply`, "POST", { body: reply.trim() } satisfies AdminTicketReplyBody);
      toast.success("Reply sent", { description: "Ticket moved to pending (awaiting seller)." });
      setReply("");
      void thread.refetch();
      void refetch();
    } catch (e) {
      toast.error("Reply failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  const patchTicket = async (patch: AdminTicketPatchBody) => {
    if (!openId) return;
    try {
      await apiSend<AdminTicketSummary>(`/api/admin/tickets/${openId}`, "PATCH", patch);
      toast.success("Ticket updated");
      void thread.refetch();
      void refetch();
    } catch (e) {
      toast.error("Update failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tickets"
        description="Seller support conversations — reply, re-prioritise, close."
        actions={
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="min-h-[44px] w-44" aria-label="Ticket status filter">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {TICKET_STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={5} cols={6} />
            ) : rows.length === 0 ? (
              <EmptyState title="No tickets" hint="Seller questions will queue here." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Subject</TableHead>
                      <TableHead className="hidden md:table-cell">Store / Seller</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden text-center sm:table-cell">Messages</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">Created</TableHead>
                      <TableHead className="hidden text-right xl:table-cell">Last activity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((t) => (
                      <TableRow key={t.id} className="cursor-pointer" onClick={() => setOpenId(t.id)}>
                        <TableCell>
                          <p className="max-w-[260px] truncate font-medium">{t.subject}</p>
                          {t.contextType ? (
                            <Badge variant="outline" className="mt-1 text-[10px]">re: {t.contextType}</Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <p className="text-sm font-medium">{t.store?.name ?? "—"}</p>
                          <p className="max-w-[200px] truncate text-xs text-muted-foreground">{t.sellerEmail ?? "—"}</p>
                        </TableCell>
                        <TableCell><StatusChip status={t.priority} /></TableCell>
                        <TableCell><StatusChip status={t.status} /></TableCell>
                        <TableCell className="hidden text-center sm:table-cell">
                          <span className="inline-flex items-center gap-1 text-sm tabular-nums">
                            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                            {t.messageCount ?? 0}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">{fmtDT(t.createdAt)}</TableCell>
                        <TableCell className="hidden text-right text-xs text-muted-foreground xl:table-cell">{timeAgo(t.updatedAt ?? t.lastMessage?.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pager
                  page={meta?.page ?? page}
                  size={meta?.size ?? 15}
                  total={meta?.total ?? rows.length}
                  onPrev={() => setPage((p) => Math.max(1, p - 1))}
                  onNext={() => setPage((p) => p + 1)}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* thread dialog */}
      <Dialog open={openId !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <LifeBuoy className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              {thread.data?.subject ?? active?.subject ?? "Ticket"}
              <StatusChip status={thread.data?.status ?? active?.status} />
              <StatusChip status={thread.data?.priority ?? active?.priority} />
            </DialogTitle>
            <DialogDescription>
              {thread.data?.store?.name ?? active?.store?.name ?? "—"}
              {thread.data?.sellerEmail ?? active?.sellerEmail ? ` · ${thread.data?.sellerEmail ?? active?.sellerEmail}` : ""}
            </DialogDescription>
          </DialogHeader>

          {/* thread */}
          <div className="min-h-[180px] flex-1 space-y-3 overflow-y-auto rounded-lg border bg-muted/20 p-3 [scrollbar-width:thin]">
            {thread.error ? (
              <p className="text-sm text-red-600 dark:text-red-400">{thread.error}</p>
            ) : thread.loading ? (
              Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />)
            ) : (thread.data?.messages ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No messages in this thread yet.</p>
            ) : (
              (thread.data?.messages ?? []).map((m) => {
                const isAdmin = m.authorType === "admin";
                return (
                  <div key={m.id} className={isAdmin ? "flex justify-end" : "flex justify-start"}>
                    <div
                      className={
                        isAdmin
                          ? "max-w-[80%] rounded-2xl rounded-br-md bg-teal-600 px-3.5 py-2.5 text-sm text-white shadow-sm dark:bg-teal-700"
                          : "max-w-[80%] rounded-2xl rounded-bl-md border bg-card px-3.5 py-2.5 text-sm shadow-sm"
                      }
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
                        {m.authorLabel} · {m.authorType}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
                      <p className="mt-1 text-right text-[10px] opacity-60">{fmtDT(m.createdAt)}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* controls */}
          <div className="space-y-3">
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
              placeholder="Write a reply to the seller…"
              className="resize-none"
              aria-label="Reply message"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-2">
                <Select
                  value={thread.data?.status ?? active?.status ?? "open"}
                  onValueChange={(v) => void patchTicket({ status: v as AdminTicketPatchBody["status"] })}
                >
                  <SelectTrigger className="min-h-[44px] w-36" aria-label="Ticket status">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    {TICKET_STATUSES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={thread.data?.priority ?? active?.priority ?? "normal"}
                  onValueChange={(v) => void patchTicket({ priority: v as AdminTicketPatchBody["priority"] })}
                >
                  <SelectTrigger className="min-h-[44px] w-36" aria-label="Ticket priority">
                    <SelectValue placeholder="Priority" />
                  </SelectTrigger>
                  <SelectContent>
                    {TICKET_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setOpenId(null)} className="min-h-[44px] sm:min-h-0">
                  Close
                </Button>
                <Button onClick={() => void sendReply()} disabled={sending || !reply.trim()} className="min-h-[44px] sm:min-h-0">
                  <Send className="h-4 w-4" /> {sending ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

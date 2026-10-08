"use client";
// CAT-01 Product Moderation — pending_review gallery + detail drawer with decisions.
import { useMemo, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useApi, apiSend } from "./use-api";
import { qs } from "./nav";
import type { AdminNav } from "./nav";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Pager,
  ReasonDialog,
  StatusChip,
  TypingConfirm,
  fmtDate,
} from "./ui-bits";

type AdminProductRow = {
  id: string;
  title: string;
  slug: string;
  priceMinor: number;
  status: string;
  description?: string | null;
  flagsJson?: string | null;
  flags?: string[];
  reportsCount?: number;
  createdAt?: string;
  store?: { id: string; name: string; slug: string } | null;
  storeName?: string | null;
  images?: { id: string; url: string }[];
  imageUrl?: string | null;
  category?: { name: string } | null;
};

function flagsOf(p: AdminProductRow): string[] {
  if (Array.isArray(p.flags)) return p.flags;
  try {
    const parsed: unknown = JSON.parse(p.flagsJson ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function firstImage(p: AdminProductRow): string | null {
  if (p.images && p.images.length > 0) return p.images[0].url;
  if (p.imageUrl) return p.imageUrl;
  return `/api/img/${encodeURIComponent(p.slug || p.id)}?w=400&h=300&label=${encodeURIComponent(p.title.slice(0, 12))}`;
}

export function ModerationView({ nav }: { nav: AdminNav }) {
  const [page, setPage] = useState(1);
  const url = useMemo(() => `/api/admin/products${qs({ status: "pending_review", page, size: "12" })}`, [page]);
  const { data, meta, error, loading, refetch } = useApi<AdminProductRow[]>(url);
  const rows = data ?? [];

  const [detail, setDetail] = useState<AdminProductRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdminProductRow | null>(null);
  const [banTarget, setBanTarget] = useState<AdminProductRow | null>(null);
  const [approveTarget, setApproveTarget] = useState<AdminProductRow | null>(null);
  const [busy, setBusy] = useState(false);

  const moderate = async (p: AdminProductRow, kind: "approve" | "reject" | "ban", reason?: string) => {
    setBusy(true);
    try {
      await apiSend(`/api/admin/products/${p.id}/${kind}`, "POST", kind === "approve" ? undefined : { reason });
      toast.success(`Product ${kind === "approve" ? "approved" : kind}`, { description: p.title });
      setDetail(null);
      setRejectTarget(null);
      setBanTarget(null);
      setApproveTarget(null);
      void refetch();
    } catch (e) {
      toast.error(`Failed to ${kind} product`, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Moderation"
        description="Products awaiting review before they can go live."
        actions={
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => void refetch()} disabled={loading}>
            Refresh
          </Button>
        }
      />

      {error ? (
        <Card className="py-0"><CardContent className="p-4"><ErrorState message={error} onRetry={() => void refetch()} /></CardContent></Card>
      ) : loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border">
              <div className="aspect-[4/3] animate-pulse bg-muted" />
              <div className="space-y-2 p-4"><div className="h-4 w-3/4 animate-pulse rounded bg-muted" /><div className="h-3 w-1/2 animate-pulse rounded bg-muted" /></div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card className="py-0"><CardContent className="p-4"><EmptyState title="Moderation queue is clear" hint="New or flagged products will appear here." /></CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {rows.map((p) => {
              const flags = flagsOf(p);
              return (
                <button
                  key={p.id}
                  onClick={() => setDetail(p)}
                  className="group overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
                >
                  <div className="relative aspect-[4/3] bg-muted">
                    <Image
                      src={firstImage(p) as string}
                      alt={p.title}
                      fill
                      unoptimized
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                      className="object-cover"
                    />
                    {flags.length > 0 ? (
                      <Badge className="absolute right-2 top-2 border-red-200 bg-red-600 text-white">
                        {flags.length} flag{flags.length === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="space-y-1.5 p-4">
                    <p className="line-clamp-1 text-sm font-semibold">{p.title}</p>
                    <p className="line-clamp-1 text-xs text-muted-foreground">{p.store?.name ?? p.storeName ?? "—"}</p>
                    <div className="flex items-center justify-between pt-1">
                      <Money minor={p.priceMinor} bold />
                      <span className="text-[11px] text-muted-foreground">{fmtDate(p.createdAt)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <Pager page={meta?.page ?? page} size={meta?.size ?? 12} total={meta?.total ?? rows.length} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
        </>
      )}

      {/* detail drawer */}
      <Drawer open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DrawerContent className="max-h-[92vh]">
          {detail ? (
            <div className="mx-auto w-full max-w-2xl overflow-y-auto p-4 [scrollbar-width:thin]">
              <DrawerHeader className="px-0 pt-0">
                <DrawerTitle className="text-left">{detail.title}</DrawerTitle>
                <DrawerDescription className="text-left">
                  {detail.store?.name ?? detail.storeName ?? "—"} · listed {fmtDate(detail.createdAt)}
                </DrawerDescription>
              </DrawerHeader>

              <div className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:thin]">
                {(detail.images && detail.images.length > 0
                  ? detail.images.map((i) => i.url)
                  : [firstImage(detail) as string]
                ).map((u, i) => (
                  <div key={i} className="relative h-40 w-40 shrink-0 overflow-hidden rounded-lg border bg-muted">
                    <Image src={u} alt={`${detail.title} image ${i + 1}`} fill unoptimized sizes="160px" className="object-cover" />
                  </div>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Price</p><Money minor={detail.priceMinor} bold /></div>
                <div><p className="text-xs text-muted-foreground">Category</p><p>{detail.category?.name ?? "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Status</p><StatusChip status={detail.status} /></div>
                <div><p className="text-xs text-muted-foreground">Reports</p><p>{detail.reportsCount ?? 0}</p></div>
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground">Store</p>
                  <button
                    className="text-sm font-medium text-teal-700 underline-offset-2 hover:underline dark:text-teal-400"
                    onClick={() => nav.navigate("stores")}
                  >
                    {detail.store?.name ?? detail.storeName ?? "—"}
                  </button>
                </div>
              </div>

              {flagsOf(detail).length > 0 ? (
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground">Moderation flags</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {flagsOf(detail).map((f, i) => (
                      <Badge key={i} variant="outline" className="border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
                        {f}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {detail.description ? (
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground">Description</p>
                  <p className="mt-1 whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm">{detail.description}</p>
                </div>
              ) : null}

              <div className="mt-5 flex flex-col gap-2 pb-4 sm:flex-row">
                <Button className="min-h-[44px] flex-1 bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => setApproveTarget(detail)}>
                  Approve
                </Button>
                <Button variant="outline" className="min-h-[44px] flex-1" disabled={busy} onClick={() => setRejectTarget(detail)}>
                  Reject…
                </Button>
                <Button variant="outline" className="min-h-[44px] flex-1 border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40" disabled={busy} onClick={() => setBanTarget(detail)}>
                  Ban…
                </Button>
              </div>
            </div>
          ) : null}
        </DrawerContent>
      </Drawer>

      <ConfirmDialog
        open={approveTarget !== null}
        onOpenChange={(o) => !o && setApproveTarget(null)}
        title="Approve product?"
        description={approveTarget ? `“${approveTarget.title}” will become active and buyable.` : ""}
        confirmLabel="Approve"
        loading={busy}
        onConfirm={() => approveTarget && void moderate(approveTarget, "approve")}
      />

      <ReasonDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title="Reject product"
        description={rejectTarget ? `“${rejectTarget.title}” will be returned to the seller with your reason.` : ""}
        submitLabel="Reject"
        destructive
        loading={busy}
        onSubmit={(reason) => rejectTarget && void moderate(rejectTarget, "reject", reason)}
      />

      <TypingConfirm
        open={banTarget !== null}
        onOpenChange={(o) => !o && setBanTarget(null)}
        title="Ban product"
        description="Policy violation — the product is removed from sale permanently."
        expected={banTarget?.id ?? ""}
        confirmLabel="Ban product"
        loading={busy}
        onConfirm={() => banTarget && void moderate(banTarget, "ban", "Banned by admin")}
      />
    </div>
  );
}

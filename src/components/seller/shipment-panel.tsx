"use client";
// Task 14-a — Shipment bits for the seller surface: read-only shipment panel on
// the order detail (courier, AWB, status chip, ETA window, label download),
// shipment status chip + small shared helpers.
//
// Data source note: GET /api/store/orders/[id] does NOT include the shipment
// relation, but GET /api/store/shipping/quote?orderId= returns a `shipment`
// brief (status/awb/courier/eta) for any store order — so the panel reads the
// quote endpoint for platform bookings and falls back to the order's manual
// tracking fields. Ship/deliver dialogs trigger a parent refetch which bumps
// `refreshKey` to re-pull this panel.
import { Copy, Download, PackageCheck, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { authHeaders } from "@/lib/session-client";
import { toast } from "sonner";
import { fmtDate, useApi } from "./ui-bits";

// ---------------------------------------------------------------- types

export type ShipmentBrief = {
  status: string | null;
  awbNumber: string | null;
  courierName: string | null;
  etaFrom: string | null;
  etaTo: string | null;
} | null;

type QuoteEnvelope = {
  shipment: ShipmentBrief;
  destination: { state: string; city: string | null; zone: string };
  parcel: { weightGrams: number; itemCount: number };
};

// ---------------------------------------------------------------- chip

const SHIPMENT_CHIP: Record<string, string> = {
  pending_booking: "bg-muted text-muted-foreground border-border",
  booked: "bg-amber-100 text-amber-800 border-amber-200",
  picked_up: "bg-amber-100 text-amber-800 border-amber-200",
  in_transit: "bg-teal-100 text-teal-800 border-teal-200",
  out_for_delivery: "bg-teal-100 text-teal-800 border-teal-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  exception: "bg-rose-100 text-rose-800 border-rose-200",
  returned: "bg-rose-100 text-rose-800 border-rose-200",
};

export function ShipmentStatusChip({ status, className }: { status: string | null | undefined; className?: string }) {
  const s = (status ?? "").toLowerCase();
  if (!s) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        SHIPMENT_CHIP[s] ?? "bg-muted text-muted-foreground border-border",
        className
      )}
    >
      {s.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

/** "12 – 14 Oct 2026" style ETA window (or single date when from === to). */
export function fmtEtaRange(from: string | Date | null | undefined, to: string | Date | null | undefined): string {
  if (!from && !to) return "—";
  if (from && to) {
    const f = fmtDate(from);
    const t = fmtDate(to);
    return f === t ? f : `${f} – ${t}`;
  }
  return fmtDate(from ?? to);
}

// ---------------------------------------------------------------- label download

/** Fetch the AWB label with the seller session and save it as an SVG file. */
export async function downloadOrderLabel(orderId: string, awb: string | null | undefined): Promise<void> {
  const res = await fetch(`/api/store/orders/${orderId}/label?download=1`, { cache: "no-store", headers: authHeaders() });
  if (!res.ok) {
    toast.error("Label unavailable — only platform bookings have a downloadable AWB");
    return;
  }
  const svg = await res.text();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `AWB-${awb || orderId}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- panel

export default function ShipmentPanel({
  orderId,
  trackingNumber,
  trackingProvider,
  deliveredAt,
  refreshKey = 0,
}: {
  orderId: string;
  trackingNumber: string | null;
  trackingProvider: string | null;
  deliveredAt: string | null;
  refreshKey?: number;
}) {
  const { data, loading } = useApi<QuoteEnvelope>(`/api/store/shipping/quote?orderId=${orderId}`, [refreshKey]);
  const shipment = data?.shipment ?? null;
  const isPlatform = !!shipment?.awbNumber;
  const isManual = !isPlatform && !!trackingNumber;

  // Nothing shipped yet — no panel (the ship dialog handles that stage).
  if (!isPlatform && !isManual) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Truck className="h-4 w-4 text-primary" /> Shipment
          {shipment?.status ? <ShipmentStatusChip status={shipment.status} className="ml-1" /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {loading && !data ? (
          <>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-56" />
          </>
        ) : isPlatform && shipment ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-xs text-muted-foreground">Courier</p>
                <p className="font-medium">{shipment.courierName ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">AWB</p>
                <p className="flex items-center gap-1 font-mono text-[13px] font-medium">
                  <span className="truncate">{shipment.awbNumber}</span>
                  <button
                    type="button"
                    aria-label="Copy AWB number"
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(shipment.awbNumber ?? "");
                        toast.success("AWB copied");
                      } catch {
                        toast.error("Could not copy");
                      }
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">ETA window</p>
                <p className="font-medium">{fmtEtaRange(shipment.etaFrom, shipment.etaTo)}</p>
              </div>
              {deliveredAt ? (
                <div>
                  <p className="text-xs text-muted-foreground">Delivered</p>
                  <p className="flex items-center gap-1 font-medium text-emerald-700">
                    <PackageCheck className="h-3.5 w-3.5" /> {fmtDate(deliveredAt)}
                  </p>
                </div>
              ) : null}
            </div>
            <Separator className="my-1" />
            <p className="text-xs text-muted-foreground">
              Booked on the NOMOFEE platform — the courier timeline advances automatically and the buyer can track it live.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-[44px] gap-1.5"
              onClick={() => void downloadOrderLabel(orderId, shipment.awbNumber)}
            >
              <Download className="h-3.5 w-3.5" /> Download AWB label (SVG)
            </Button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-xs text-muted-foreground">Courier / provider</p>
                <p className="font-medium capitalize">{trackingProvider ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Tracking number</p>
                <p className="font-mono text-[13px] font-medium">{trackingNumber}</p>
              </div>
            </div>
            {deliveredAt ? (
              <p className="flex items-center gap-1 font-medium text-emerald-700">
                <PackageCheck className="h-3.5 w-3.5" /> Delivered {fmtDate(deliveredAt)}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Shipped manually — booked outside the platform, so courier updates are not tracked here.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

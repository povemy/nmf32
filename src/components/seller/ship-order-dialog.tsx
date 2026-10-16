"use client";
// Task 14-a — ShipOrderDialog: seller marks an order shipped with two modes.
//  • Platform booking — GET /api/store/shipping/quote?orderId= renders rate
//    cards (courier / service / price / ETA); booking POSTs
//    /api/store/orders/[id]/ship {mode:"platform", rateId} which books the
//    mock courier, returns the AWB + label. Success view shows the AWB and a
//    label download link (GET /api/store/orders/[id]/label?download=1).
//  • Manual — provider + tracking number POSTs {mode:"manual", ...}.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiSend, useApi, formatMinor } from "./ui-bits";
import { fmtEtaRange, downloadOrderLabel, ShipmentStatusChip } from "./shipment-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  Clock3,
  Download,
  Loader2,
  Package,
  PenLine,
  Truck,
  Weight,
} from "lucide-react";

// ---------------------------------------------------------------- types

type QuoteRate = {
  rateId: string;
  providerId: string;
  courierName: string;
  serviceLevel: string;
  priceMinor: number;
  etaFromDays: number;
  etaToDays: number;
};

type QuoteData = {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  shipment: { status: string; awbNumber: string | null; courierName: string | null; etaFrom: string | null; etaTo: string | null } | null;
  destination: { state: string; city: string | null; zone: string };
  parcel: { weightGrams: number; itemCount: number };
  rates: QuoteRate[];
};

type ShipResult = {
  id: string;
  status: string;
  trackingNumber: string | null;
  trackingProvider: string | null;
  shipmentStatus: string | null;
  shipment: {
    awbNumber: string;
    courierName: string;
    etaFrom: string | null;
    etaTo: string | null;
    labelUrl: string | null;
  } | null;
};

export function etaDaysText(fromDays: number, toDays: number): string {
  if (fromDays === toDays) return `${fromDays} working day${fromDays === 1 ? "" : "s"}`;
  return `${fromDays}–${toDays} working days`;
}

function serviceLabel(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- dialog

export default function ShipOrderDialog({
  open,
  onOpenChange,
  order,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  order: { id: string; orderNumber: string };
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"platform" | "manual">("platform");
  const [result, setResult] = useState<ShipResult | null>(null);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [tracking, setTracking] = useState("");
  const [busy, setBusy] = useState(false);
  const [labelBusy, setLabelBusy] = useState(false);

  const quoteUrl = open && mode === "platform" && !result ? `/api/store/shipping/quote?orderId=${order.id}` : null;
  const { data: quote, loading: quoteLoading, error: quoteError } = useApi<QuoteData>(quoteUrl);

  // Fresh state every time the dialog opens (per-order instance, kept mounted).
  useEffect(() => {
    if (open) {
      setMode("platform");
      setResult(null);
      setSelectedRateId(null);
      setProvider("");
      setTracking("");
    }
  }, [open]);

  const bookPlatform = async () => {
    if (!selectedRateId) {
      toast.error("Pick a courier option first");
      return;
    }
    setBusy(true);
    try {
      const res = await apiSend<ShipResult>("POST", `/api/store/orders/${order.id}/ship`, {
        mode: "platform",
        rateId: selectedRateId,
      });
      setResult(res);
      toast.success(`${order.orderNumber} shipped — ${res.shipment?.courierName ?? "courier"} booked`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not book the shipment");
    } finally {
      setBusy(false);
    }
  };

  const shipManual = async () => {
    if (!provider.trim() || !tracking.trim()) {
      toast.error("Courier and tracking number are required");
      return;
    }
    setBusy(true);
    try {
      const res = await apiSend<ShipResult>("POST", `/api/store/orders/${order.id}/ship`, {
        mode: "manual",
        provider: provider.trim(),
        trackingNumber: tracking.trim(),
      });
      setResult(res);
      toast.success(`${order.orderNumber} marked shipped — customer notified`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record the shipment");
    } finally {
      setBusy(false);
    }
  };

  const saveLabel = async () => {
    setLabelBusy(true);
    try {
      await downloadOrderLabel(order.id, result?.shipment?.awbNumber);
    } finally {
      setLabelBusy(false);
    }
  };

  const finish = () => {
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ship {order.orderNumber}</DialogTitle>
        </DialogHeader>

        {result ? (
          <SuccessView result={result} labelBusy={labelBusy} onDownloadLabel={saveLabel} onDone={finish} />
        ) : (
          <div className="space-y-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as "platform" | "manual")}>
              <TabsList className="flex w-full">
                <TabsTrigger value="platform" className="min-h-[44px] flex-1 gap-1.5">
                  <Truck className="h-4 w-4" /> Platform booking
                </TabsTrigger>
                <TabsTrigger value="manual" className="min-h-[44px] flex-1 gap-1.5">
                  <PenLine className="h-4 w-4" /> Manual
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === "platform" ? (
              <PlatformBookingPanel
                quote={quote ?? null}
                loading={quoteLoading}
                error={quoteError}
                selectedRateId={selectedRateId}
                onSelect={setSelectedRateId}
                busy={busy}
                onBook={bookPlatform}
              />
            ) : (
              <div className="space-y-3.5">
                <div className="space-y-1.5">
                  <Label htmlFor="ship-provider">Courier / provider *</Label>
                  <Input
                    id="ship-provider"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="CityLink, J&T, PosLaju…"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ship-tracking">Tracking number *</Label>
                  <Input
                    id="ship-tracking"
                    value={tracking}
                    onChange={(e) => setTracking(e.target.value)}
                    placeholder="CL123456789"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Booked outside NOMOFEE — we email the customer, fire your <code>order.shipped</code> webhooks and show
                  the tracking number on the order.
                </p>
                <Button
                  onClick={shipManual}
                  disabled={busy}
                  className="w-full min-h-[44px] gap-2 bg-brand-gradient-deep text-white hover:opacity-90"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />} Confirm shipment
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- platform panel

function PlatformBookingPanel({
  quote,
  loading,
  error,
  selectedRateId,
  onSelect,
  busy,
  onBook,
}: {
  quote: QuoteData | null;
  loading: boolean;
  error: string | null;
  selectedRateId: string | null;
  onSelect: (rateId: string) => void;
  busy: boolean;
  onBook: () => void;
}) {
  if (error) {
    return (
      <div className="space-y-3">
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">Could not load courier rates: {error}</p>
        <p className="text-xs text-muted-foreground">Switch to the Manual tab to record the shipment by hand.</p>
      </div>
    );
  }

  if (loading || !quote) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 rounded-xl border p-3 text-xs text-muted-foreground">
          <Weight className="h-4 w-4" /> Weighing parcel…
        </div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const chosen = quote.rates.find((r) => r.rateId === selectedRateId) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" /> {quote.parcel.itemCount} item{quote.parcel.itemCount === 1 ? "" : "s"} ·{" "}
          {quote.parcel.weightGrams >= 1000 ? `${(quote.parcel.weightGrams / 1000).toFixed(2)} kg` : `${quote.parcel.weightGrams} g`}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="h-3.5 w-3.5" /> To {quote.destination.city || quote.destination.state || "—"} ({quote.destination.zone})
        </span>
      </div>

      {quote.shipment?.awbNumber ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          A platform booking already exists for this order ({quote.shipment.courierName} · AWB {quote.shipment.awbNumber}).
        </p>
      ) : null}

      <div className="max-h-72 space-y-2 overflow-y-auto pr-1" role="radiogroup" aria-label="Courier options">
        {quote.rates.map((r) => {
          const selected = r.rateId === selectedRateId;
          return (
            <button
              key={r.rateId}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(r.rateId)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors min-h-[44px]",
                selected ? "border-primary bg-brand-gradient-soft ring-1 ring-primary" : "border-border hover:bg-muted/50"
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
                  selected ? "border-primary" : "border-muted-foreground/40"
                )}
                aria-hidden
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{r.courierName}</span>
                <span className="block text-xs text-muted-foreground">
                  {serviceLabel(r.serviceLevel)} · {etaDaysText(r.etaFromDays, r.etaToDays)}
                </span>
              </span>
              <span className="text-sm font-semibold tabular-nums">{formatMinor(r.priceMinor)}</span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        The platform books the courier, generates the AWB label and lets the buyer track the parcel live.
        {chosen ? <> You picked <strong>{chosen.courierName}</strong> at {formatMinor(chosen.priceMinor)}.</> : null}
      </p>

      <Button
        onClick={onBook}
        disabled={busy || !selectedRateId}
        className="w-full min-h-[44px] gap-2 bg-brand-gradient-deep text-white hover:opacity-90"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />} Book courier & mark shipped
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- success view

function SuccessView({
  result,
  labelBusy,
  onDownloadLabel,
  onDone,
}: {
  result: ShipResult;
  labelBusy: boolean;
  onDownloadLabel: () => void;
  onDone: () => void;
}) {
  const s = result.shipment;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
        <div>
          <p className="text-sm font-semibold text-emerald-800">Order shipped</p>
          <p className="text-xs text-emerald-700">The customer has been notified by email.</p>
        </div>
        {result.shipmentStatus ? <ShipmentStatusChip status={result.shipmentStatus} className="ml-auto" /> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        {s ? (
          <>
            <div>
              <p className="text-xs text-muted-foreground">Courier</p>
              <p className="font-medium">{s.courierName}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">AWB number</p>
              <p className="font-mono text-[13px] font-medium">{s.awbNumber}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Estimated delivery</p>
              <p className="font-medium">{fmtEtaRange(s.etaFrom, s.etaTo)}</p>
            </div>
          </>
        ) : (
          <>
            <div>
              <p className="text-xs text-muted-foreground">Courier / provider</p>
              <p className="font-medium capitalize">{result.trackingProvider ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Tracking number</p>
              <p className="font-mono text-[13px] font-medium">{result.trackingNumber}</p>
            </div>
          </>
        )}
      </div>

      {s?.labelUrl ? (
        <Button type="button" variant="outline" onClick={onDownloadLabel} disabled={labelBusy} className="w-full min-h-[44px] gap-2">
          {labelBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download AWB label (SVG)
        </Button>
      ) : null}

      <Button onClick={onDone} className="w-full min-h-[44px] bg-brand-gradient-deep text-white hover:opacity-90">
        Done
      </Button>
    </div>
  );
}

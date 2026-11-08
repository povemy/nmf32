"use client";
// Task 14-a / TASK 10-b seller part — Voucher manager: claimable store-scope
// vouchers (kind discount: flat | percent with optional cap · freeshipping),
// usage stats, region + expiry, the store's free-shipping cost-recovery
// option (fsPriceAdjustMinor) and a create dialog.
// APIs: GET/POST /api/store/vouchers.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  apiSend,
  EmptyState,
  MoneyInput,
  RowsSkeleton,
  StatusChip,
  fmtDate,
  formatMinor,
  useApi,
} from "./ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, MapPin, Plus, TicketPercent, Truck } from "lucide-react";
import type { SellerVoucherCreateBody, SellerVoucherCreateData, SellerVoucherPanelRow, SellerVouchersPanelData } from "@/lib/types/api-contract";

// ---------------------------------------------------------------- types

function voucherValue(v: SellerVoucherPanelRow): string {
  if (v.kind === "freeshipping") return "Free shipping";
  if (v.percentOff != null) {
    return v.maxDiscountMinor != null
      ? `${v.percentOff}% off · cap ${formatMinor(v.maxDiscountMinor)}`
      : `${v.percentOff}% off`;
  }
  return `${formatMinor(v.discountMinor)} off`;
}

// ---------------------------------------------------------------- panel

export default function SellerVouchers() {
  const { data, loading, refetch } = useApi<SellerVouchersPanelData>("/api/store/vouchers");
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Claimable vouchers shoppers grab from your storefront &amp; the voucher centre — redeemed at checkout.
        </p>
        <Button onClick={() => setCreateOpen(true)} className="min-h-[44px] gap-1.5 bg-brand-gradient-deep text-white hover:opacity-90">
          <Plus className="h-4 w-4" /> New voucher
        </Button>
      </div>

      {/* free-shipping cost recovery (read-only display) */}
      {data ? (
        <Card>
          <CardContent className="flex items-start gap-3 p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-gradient-soft">
              <Truck className="h-4 w-4 text-primary" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-medium">Free-shipping cost recovery</p>
              <p className="text-xs text-muted-foreground">
                When a shopper redeems one of your free-shipping vouchers, the group shipping fee is waived and the
                platform records your price-adjust option of{" "}
                <strong className="tabular-nums">{formatMinor(data.fsPriceAdjustMinor)}</strong> per order to help
                recover the cost. Adjust it from Store Settings → shipping.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {loading ? (
        <RowsSkeleton rows={3} />
      ) : (data?.vouchers ?? []).length === 0 ? (
        <EmptyState
          icon={<TicketPercent className="h-8 w-8" />}
          title="No vouchers yet"
          hint="Create a claimable discount or free-shipping voucher — shoppers claim it first, then redeem at checkout."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Voucher</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Min spend</TableHead>
                <TableHead>Claims / used</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.vouchers ?? []).map((v) => {
                const expired = v.expiryAt ? new Date(v.expiryAt).getTime() < Date.now() : false;
                return (
                  <TableRow key={v.id}>
                    <TableCell>
                      <p className="font-mono text-sm font-semibold">{v.code}</p>
                      <p className="max-w-44 truncate text-xs text-muted-foreground">{v.title}</p>
                    </TableCell>
                    <TableCell className="text-sm">{voucherValue(v)}</TableCell>
                    <TableCell className="text-sm tabular-nums">{v.minSpendMinor > 0 ? formatMinor(v.minSpendMinor) : "—"}</TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {v.claimedCount}
                      {v.quota != null ? ` / ${v.quota}` : " / ∞"}
                      <span className="block text-[10px] text-muted-foreground">{v.usedCount} redeemed</span>
                    </TableCell>
                    <TableCell>
                      {v.kind === "freeshipping" || v.regionLimit === "peninsular" ? (
                        <Badge variant="outline" className="gap-1 border-teal-200 bg-teal-50 text-[11px] text-teal-800">
                          <MapPin className="h-3 w-3" /> West MY
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">All Malaysia</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {v.startsAt ? `${fmtDate(v.startsAt)} → ` : ""}
                      {v.expiryAt ? fmtDate(v.expiryAt) : "no end"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch checked={v.isActive && !expired} disabled aria-label={`${v.code} active`} />
                        <StatusChip status={expired ? "closed" : v.isActive ? "active" : "draft"} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateVoucherDialog open={createOpen} onOpenChange={setCreateOpen} onDone={refetch} />
    </div>
  );
}

// ---------------------------------------------------------------- create dialog

function CreateVoucherDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"discount" | "freeshipping">("discount");
  const [discountType, setDiscountType] = useState<"flat" | "percent">("percent");
  const [discountMinor, setDiscountMinor] = useState(0);
  const [percentOff, setPercentOff] = useState("10");
  const [maxDiscountMinor, setMaxDiscountMinor] = useState<number | null>(null);
  const [minSpendMinor, setMinSpendMinor] = useState(0);
  const [quota, setQuota] = useState("");
  const [expiry, setExpiry] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setKind("discount");
      setDiscountType("percent");
      setDiscountMinor(0);
      setPercentOff("10");
      setMaxDiscountMinor(null);
      setMinSpendMinor(0);
      setQuota("");
      setExpiry("");
      setCode("");
    }
  }, [open]);

  const submit = async () => {
    if (title.trim().length < 3) {
      toast.error("Give the voucher a name (3+ characters)");
      return;
    }
    if (!expiry) {
      toast.error("An expiry date is required");
      return;
    }
    // End of the chosen day, local time → ISO.
    const expiryAt = new Date(`${expiry}T23:59:59`).toISOString();
    if (new Date(expiryAt).getTime() <= Date.now()) {
      toast.error("Expiry must be in the future");
      return;
    }

    const body: SellerVoucherCreateBody = {
      title: title.trim(),
      kind,
      minSpendMinor,
      quota: quota ? Number(quota) : null,
      expiryAt,
      code: code.trim() ? code.trim().toUpperCase() : undefined,
    };
    if (kind === "discount") {
      if (discountType === "flat") {
        if (discountMinor <= 0) {
          toast.error("Flat discount must be more than RM 0");
          return;
        }
        body.discountMinor = discountMinor;
      } else {
        const p = Number(percentOff);
        if (!Number.isFinite(p) || p < 1 || p > 90) {
          toast.error("Percent off must be between 1 and 90");
          return;
        }
        body.percentOff = p;
        if (maxDiscountMinor != null) body.maxDiscountMinor = maxDiscountMinor;
      }
    }

    setBusy(true);
    try {
      const res = await apiSend<SellerVoucherCreateData>("POST", "/api/store/vouchers", body);
      toast.success(`Voucher ${res.voucher.code} created`);
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the voucher");
    } finally {
      setBusy(false);
    }
  };

  const today = new Date();
  const minDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New claimable voucher</DialogTitle>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="vc-title">Name *</Label>
            <Input
              id="vc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Raya 12% off storewide"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger aria-label="Voucher kind" className="min-h-[44px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="discount">Discount</SelectItem>
                  <SelectItem value="freeshipping">Free shipping</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {kind === "discount" ? (
              <div className="space-y-1.5">
                <Label>Discount type</Label>
                <Select value={discountType} onValueChange={(v) => setDiscountType(v as typeof discountType)}>
                  <SelectTrigger aria-label="Discount type" className="min-h-[44px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percent">Percent off</SelectItem>
                    <SelectItem value="flat">Flat amount off</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {kind === "discount" && discountType === "percent" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="vc-percent">Percent (1–90) *</Label>
                <Input
                  id="vc-percent"
                  inputMode="numeric"
                  value={percentOff}
                  onChange={(e) => setPercentOff(e.target.value.replace(/[^0-9]/g, ""))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Cap (optional)</Label>
                <MoneyInput
                  valueMinor={maxDiscountMinor}
                  onChangeMinor={(m) => setMaxDiscountMinor(m > 0 ? m : null)}
                  placeholder="no cap"
                />
              </div>
            </div>
          ) : null}

          {kind === "discount" && discountType === "flat" ? (
            <div className="space-y-1.5">
              <Label>Amount off (RM) *</Label>
              <MoneyInput valueMinor={discountMinor} onChangeMinor={setDiscountMinor} />
            </div>
          ) : null}

          {kind === "freeshipping" ? (
            <p className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-xs text-teal-800">
              Free-shipping vouchers are seller-funded and valid for West Malaysia (peninsular) addresses only — the
              region is applied automatically.
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Min spend (RM)</Label>
              <MoneyInput valueMinor={minSpendMinor} onChangeMinor={setMinSpendMinor} placeholder="0.00" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vc-quota">Claim quota</Label>
              <Input
                id="vc-quota"
                inputMode="numeric"
                value={quota}
                onChange={(e) => setQuota(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="unlimited"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="vc-expiry">Expiry *</Label>
              <Input
                id="vc-expiry"
                type="date"
                min={minDate}
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vc-code">Code (optional)</Label>
              <Input
                id="vc-code"
                className="font-mono uppercase"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="auto-generated"
              />
            </div>
          </div>

          <Button onClick={submit} disabled={busy} className="w-full min-h-[44px] gap-2 bg-brand-gradient-deep text-white hover:opacity-90">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create voucher
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

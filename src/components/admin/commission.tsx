"use client";
// FIN-01 Commission Settings (w/ live example math) + FIN-04 Commission Simulator.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toMinor, formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { apiSend, useApi, useDebounced } from "./use-api";
import { EmptyState, ErrorState, Money, PageHeader, TONE_CLASS } from "./ui-bits";

type SettingsBody = {
  defaultPercent: number;
  appliesToShipping: boolean;
  basePriceRule: "paid_price" | "list_price";
  fixedFeeMinor: number;
  minCommissionMinor: number;
  payoutHoldDays: number;
  holdReleaseRule: "days_after_paid" | "days_after_delivered";
  graceDaysAfterDelivered: number;
};

type SimTrace = {
  rule_source: string;
  source_id?: string;
  holiday_id?: string;
  percent: number;
  base: number;
  percent_part: number;
  fixed_fee_allocated: number;
  discount_allocated: number;
  shipping_allocated: number;
  flags: string[];
};

type SimResult = {
  commissionMinor: number;
  sellerNetMinor: number;
  holdDays: number;
  trace: SimTrace;
};

type SimBody = {
  priceMinor: number;
  qty: number;
  discountMinor: number;
  shippingMinor: number;
  categoryId?: string | null;
  sellerId?: string | null;
  productId?: string | null;
};

/* ---------------------------------------------------------------- FIN-01 */

const emptyForm = {
  defaultPercent: "0",
  fixedFee: "0.00",
  minCommission: "0.00",
  appliesToShipping: false,
  basePriceRule: "paid_price",
  payoutHoldDays: "7",
  holdReleaseRule: "days_after_paid",
  graceDays: "2",
};

export function CommissionSettingsView() {
  const { data, error, loading, refetch } = useApi<SettingsBody>("/api/admin/commission/settings");
  const [form, setForm] = useState<typeof emptyForm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // example math inputs
  const [exPrice, setExPrice] = useState("120.00");
  const [exDiscount, setExDiscount] = useState("0");
  const [exShipping, setExShipping] = useState("8.90");

  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const debouncedEx = useDebounced(`${exPrice}|${exDiscount}|${exShipping}`, 450);

  useEffect(() => {
    if (data && !form) {
      setForm({
        defaultPercent: String(data.defaultPercent),
        fixedFee: (data.fixedFeeMinor / 100).toFixed(2),
        minCommission: (data.minCommissionMinor / 100).toFixed(2),
        appliesToShipping: data.appliesToShipping,
        basePriceRule: data.basePriceRule,
        payoutHoldDays: String(data.payoutHoldDays),
        holdReleaseRule: data.holdReleaseRule,
        graceDays: String(data.graceDaysAfterDelivered),
      });
    }
  }, [data, form]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const [price, discount, shipping] = debouncedEx.split("|");
      try {
        const res = await apiSend<SimResult>("/api/admin/commission/simulate", "POST", {
          priceMinor: toMinor(price || "0"),
          qty: 1,
          discountMinor: toMinor(discount || "0"),
          shippingMinor: toMinor(shipping || "0"),
        });
        if (!cancelled) {
          setSimResult(res);
          setSimError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setSimResult(null);
          setSimError(e instanceof Error ? e.message : "Simulation unavailable");
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [debouncedEx]);

  const diffRows = useMemo(() => {
    if (!data || !form) return [];
    return [
      { label: "defaultPercent", from: `${data.defaultPercent}%`, to: `${form.defaultPercent}%`, changed: Number(form.defaultPercent) !== data.defaultPercent },
      { label: "fixedFee", from: formatMinor(data.fixedFeeMinor), to: formatMinor(toMinor(form.fixedFee)), changed: toMinor(form.fixedFee) !== data.fixedFeeMinor },
      { label: "minCommission", from: formatMinor(data.minCommissionMinor), to: formatMinor(toMinor(form.minCommission)), changed: toMinor(form.minCommission) !== data.minCommissionMinor },
      { label: "appliesToShipping", from: String(data.appliesToShipping), to: String(form.appliesToShipping), changed: form.appliesToShipping !== data.appliesToShipping },
      { label: "basePriceRule", from: data.basePriceRule, to: form.basePriceRule, changed: form.basePriceRule !== data.basePriceRule },
      { label: "payoutHoldDays", from: `${data.payoutHoldDays}d`, to: `${form.payoutHoldDays}d`, changed: Number(form.payoutHoldDays) !== data.payoutHoldDays },
      { label: "holdReleaseRule", from: data.holdReleaseRule, to: form.holdReleaseRule, changed: form.holdReleaseRule !== data.holdReleaseRule },
      { label: "graceDaysAfterDelivered", from: `${data.graceDaysAfterDelivered}d`, to: `${form.graceDays}d`, changed: Number(form.graceDays) !== data.graceDaysAfterDelivered },
    ];
  }, [data, form]);

  const dirty = useMemo(() => diffRows.some((r) => r.changed), [diffRows]);

  const save = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    try {
      await apiSend("/api/admin/commission/settings", "PUT", {
        defaultPercent: Number(form.defaultPercent),
        fixedFeeMinor: toMinor(form.fixedFee),
        minCommissionMinor: toMinor(form.minCommission),
        appliesToShipping: form.appliesToShipping,
        basePriceRule: form.basePriceRule,
        payoutHoldDays: Number(form.payoutHoldDays),
        holdReleaseRule: form.holdReleaseRule,
        graceDaysAfterDelivered: Number(form.graceDays),
      });
      toast.success("Commission settings saved", { description: "Audited server-side; affects future orders." });
      setConfirmOpen(false);
      void refetch();
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [form, refetch]);

  if (error) {
    return <Card className="py-0"><CardContent className="p-4"><ErrorState message={error} onRetry={() => void refetch()} /></CardContent></Card>;
  }
  if (loading || !data || !form) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <Card className="py-0"><CardContent className="h-72 p-4"><div className="h-full w-full animate-pulse rounded-lg bg-muted" /></CardContent></Card>
      </div>
    );
  }

  // local estimate with unsaved values (client-side M09 core math)
  const exBase = Math.max(
    0,
    toMinor(exPrice || "0") - toMinor(exDiscount || "0") + (form.appliesToShipping ? toMinor(exShipping || "0") : 0)
  );
  const exPercentPart = Math.round(exBase * Number(form.defaultPercent || "0")) / 100;
  const exCommission = Math.round(exPercentPart) + toMinor(form.fixedFee || "0");
  const exNet = exBase + toMinor(exShipping || "0") - exCommission;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Commission"
        description="Global M09 engine defaults. Resolution: fee holiday → product → category → seller → global."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={() => setConfirmOpen(true)} disabled={!dirty}>
            {dirty ? "Save changes…" : "Saved"}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Card className="py-0 xl:col-span-3">
          <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
            <CardTitle className="text-base">Global settings</CardTitle>
            <CardDescription>Money fields are entered in RM and stored as integer minor units.</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Default commission %</Label>
                <Input inputMode="decimal" value={form.defaultPercent} onChange={(e) => setForm({ ...form, defaultPercent: e.target.value })} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Fixed fee per order (RM)</Label>
                <Input inputMode="decimal" value={form.fixedFee} onChange={(e) => setForm({ ...form, fixedFee: e.target.value })} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Min commission per order (RM)</Label>
                <Input inputMode="decimal" value={form.minCommission} onChange={(e) => setForm({ ...form, minCommission: e.target.value })} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Payout hold days</Label>
                <Input inputMode="numeric" value={form.payoutHoldDays} onChange={(e) => setForm({ ...form, payoutHoldDays: e.target.value })} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Grace days after delivered</Label>
                <Input inputMode="numeric" value={form.graceDays} onChange={(e) => setForm({ ...form, graceDays: e.target.value })} className="min-h-[44px]" />
              </div>
              <div className="flex items-end gap-3 pb-1.5">
                <Switch id="ship" checked={form.appliesToShipping} onCheckedChange={(v) => setForm({ ...form, appliesToShipping: v })} />
                <Label htmlFor="ship" className="text-sm">Commission applies to shipping</Label>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Base price rule</Label>
                <RadioGroup value={form.basePriceRule} onValueChange={(v) => setForm({ ...form, basePriceRule: v })} className="gap-2">
                  {["paid_price", "list_price"].map((v) => (
                    <div key={v} className="flex min-h-[44px] items-center gap-2 rounded-lg border px-3">
                      <RadioGroupItem value={v} id={`bp-${v}`} />
                      <Label htmlFor={`bp-${v}`} className="cursor-pointer text-sm font-normal">
                        {v === "paid_price" ? "Paid price (after discounts)" : "List price (before discounts)"}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Hold release rule</Label>
                <RadioGroup value={form.holdReleaseRule} onValueChange={(v) => setForm({ ...form, holdReleaseRule: v })} className="gap-2">
                  {["days_after_paid", "days_after_delivered"].map((v) => (
                    <div key={v} className="flex min-h-[44px] items-center gap-2 rounded-lg border px-3">
                      <RadioGroupItem value={v} id={`hr-${v}`} />
                      <Label htmlFor={`hr-${v}`} className="cursor-pointer text-sm font-normal">
                        {v === "days_after_paid" ? "Days after payment" : "Days after delivery"}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* live example math */}
        <Card className="py-0 xl:col-span-2">
          <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
            <CardTitle className="text-base">Example math</CardTitle>
            <CardDescription>Live simulation against saved settings (debounced).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Price RM</Label>
                <Input inputMode="decimal" value={exPrice} onChange={(e) => setExPrice(e.target.value)} className="min-h-[40px]" />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Discount RM</Label>
                <Input inputMode="decimal" value={exDiscount} onChange={(e) => setExDiscount(e.target.value)} className="min-h-[40px]" />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Shipping RM</Label>
                <Input inputMode="decimal" value={exShipping} onChange={(e) => setExShipping(e.target.value)} className="min-h-[40px]" />
              </div>
            </div>

            {simError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {simError}
              </div>
            ) : simResult ? (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Server trace (saved settings)</p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Commission</span>
                  <Money minor={simResult.commissionMinor} bold />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Seller net</span>
                  <Money minor={simResult.sellerNetMinor} bold />
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Badge variant="outline" className={cn(TONE_CLASS.teal, "capitalize")}>{(simResult.trace?.rule_source ?? "global").replace(/_/g, " ")}</Badge>
                  <Badge variant="outline">{simResult.trace?.percent ?? 0}%</Badge>
                  <Badge variant="outline">base {formatMinor(simResult.trace?.base ?? 0)}</Badge>
                  <Badge variant="outline">hold {simResult.holdDays}d</Badge>
                  {(simResult.trace?.flags ?? []).map((f) => (
                    <Badge key={f} variant="outline" className={cn(TONE_CLASS.amber)}>{f.replace(/_/g, " ")}</Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {dirty ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Estimated with unsaved changes</p>
                <div className="mt-1.5 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Commission</span>
                  <Money minor={exCommission} bold />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Seller net</span>
                  <Money minor={exNet} bold />
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {confirmOpen ? (
        <SettingsDiffDialog rows={diffRows} saving={saving} onClose={() => setConfirmOpen(false)} onSave={() => void save()} />
      ) : null}
    </div>
  );
}

function SettingsDiffDialog({
  rows,
  saving,
  onClose,
  onSave,
}: {
  rows: { label: string; from: string; to: string; changed: boolean }[];
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border bg-background p-4 shadow-xl sm:p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Confirm new commission settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">Changed rows are highlighted; the save is audited.</p>
        <div className="mt-4 max-h-[50vh] overflow-y-auto rounded-lg border [scrollbar-width:thin]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>New</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.label} className={cn(r.changed && "bg-amber-50/70 dark:bg-amber-950/25")}>
                  <TableCell className="font-mono text-xs">{r.label}</TableCell>
                  <TableCell className="text-sm tabular-nums text-muted-foreground">{r.from}</TableCell>
                  <TableCell className="text-sm font-medium tabular-nums">{r.to}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving} className="min-h-[44px] sm:min-h-0">Cancel</Button>
          <Button onClick={onSave} disabled={saving} className="min-h-[44px] sm:min-h-0">{saving ? "Saving…" : "Save settings"}</Button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- FIN-04 */

type SimCategory = { id: string; name: string };
type SimSeller = { id: string; displayName: string };

export function SimulatorView() {
  const [price, setPrice] = useState("89.90");
  const [qty, setQty] = useState("1");
  const [discount, setDiscount] = useState("0");
  const [shipping, setShipping] = useState("0");
  const [categoryId, setCategoryId] = useState("none");
  const [sellerId, setSellerId] = useState("none");

  const cats = useApi<SimCategory[]>("/api/admin/categories");
  const sellers = useApi<SimSeller[]>("/api/admin/sellers?size=100");

  const body: SimBody = useMemo(
    () => ({
      priceMinor: toMinor(price || "0"),
      qty: Math.max(1, Number(qty || "1")),
      discountMinor: toMinor(discount || "0"),
      shippingMinor: toMinor(shipping || "0"),
      categoryId: categoryId === "none" ? null : categoryId,
      sellerId: sellerId === "none" ? null : sellerId,
      productId: null,
    }),
    [price, qty, discount, shipping, categoryId, sellerId]
  );
  const debouncedBody = useDebounced(JSON.stringify(body), 450);

  const [result, setResult] = useState<SimResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setRunning(true);
      setErr(null);
      try {
        const res = await apiSend<SimResult>("/api/admin/commission/simulate", "POST", JSON.parse(debouncedBody) as SimBody);
        if (!cancelled) setResult(res);
      } catch (e) {
        if (!cancelled) {
          setResult(null);
          setErr(e instanceof Error ? e.message : "Simulation failed");
        }
      } finally {
        if (!cancelled) setRunning(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [debouncedBody]);

  return (
    <div className="space-y-4">
      <PageHeader title="Commission Simulator" description="Pure what-if tool — nothing is persisted." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="py-0">
          <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
            <CardTitle className="text-base">Inputs</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 p-4 pt-0 sm:p-6 sm:pt-0">
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Price (RM)</Label><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="min-h-[44px]" /></div>
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Qty</Label><Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className="min-h-[44px]" /></div>
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Discount (RM)</Label><Input inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} className="min-h-[44px]" /></div>
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Shipping (RM)</Label><Input inputMode="decimal" value={shipping} onChange={(e) => setShipping(e.target.value)} className="min-h-[44px]" /></div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs text-muted-foreground">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger className="min-h-[44px]" aria-label="Category"><SelectValue placeholder="Any" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="none">— any —</SelectItem>
                  {(cats.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs text-muted-foreground">Seller</Label>
              <Select value={sellerId} onValueChange={setSellerId}>
                <SelectTrigger className="min-h-[44px]" aria-label="Seller"><SelectValue placeholder="Any" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="none">— any —</SelectItem>
                  {(sellers.data ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.displayName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card className="py-0">
          <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
            <CardTitle className="flex items-center gap-2 text-base">
              Results
              {running ? <span className="h-2 w-2 animate-pulse rounded-full bg-teal-500" aria-label="computing" /> : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
            {err ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{err}</div>
            ) : result ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Commission</p>
                    <p className="mt-1 text-base font-bold text-teal-700 dark:text-teal-400 sm:text-lg">{formatMinor(result.commissionMinor)}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Seller net</p>
                    <p className="mt-1 text-base font-bold text-emerald-700 dark:text-emerald-400 sm:text-lg">{formatMinor(result.sellerNetMinor)}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Hold</p>
                    <p className="mt-1 text-base font-bold sm:text-lg">{result.holdDays}d</p>
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rule trace</p>
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableBody>
                        <SimRow k="rule_source" v={result.trace?.rule_source} chip />
                        <SimRow k="percent" v={result.trace ? `${result.trace.percent}%` : undefined} />
                        <SimRow k="base" v={result.trace ? formatMinor(result.trace.base) : undefined} />
                        <SimRow k="percent_part" v={result.trace ? formatMinor(result.trace.percent_part) : undefined} />
                        <SimRow k="fixed_fee_allocated" v={result.trace ? formatMinor(result.trace.fixed_fee_allocated) : undefined} />
                        <SimRow k="discount_allocated" v={result.trace ? formatMinor(result.trace.discount_allocated) : undefined} />
                        <SimRow k="shipping_allocated" v={result.trace ? formatMinor(result.trace.shipping_allocated) : undefined} />
                        <SimRow k="flags" v={result.trace?.flags?.length ? result.trace.flags.join(", ") : undefined} />
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState title="Adjust inputs" hint="The simulator recomputes as you type." />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SimRow({ k, v, chip }: { k: string; v?: string; chip?: boolean }) {
  return (
    <TableRow>
      <TableCell className="w-44 font-mono text-xs text-muted-foreground">{k}</TableCell>
      <TableCell>
        {v ? (
          chip ? (
            <Badge variant="outline" className={cn(TONE_CLASS.teal, "capitalize")}>{v.replace(/_/g, " ")}</Badge>
          ) : (
            <span className="text-sm tabular-nums">{v}</span>
          )
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

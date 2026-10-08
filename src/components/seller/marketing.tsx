"use client";
// Task 2-d — SD-11 Coupons (store scope): list, create dialog, toggle active,
// delete. Same rules as admin coupons but scoped to this store.
import { useState } from "react";
import {
  apiSend,
  EmptyState,
  MoneyInput,
  RowsSkeleton,
  StatusChip,
  fmtDate,
  formatMinor,
  runMutation,
  useApi,
} from "./ui-bits";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Plus, Tag, Trash2 } from "lucide-react";

type Coupon = {
  id: string;
  code: string;
  description: string | null;
  type: "percent" | "fixed" | "freeship" | string;
  percent: number | null;
  amountMinor: number | null;
  minSpendMinor: number;
  maxRedemptions: number | null;
  perCustomerLimit: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  timesUsed: number;
  createdAt: string;
};

export default function SellerCoupons() {
  const { data, loading, refetch } = useApi<Coupon[]>("/api/store/coupons");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Coupon | null>(null);

  const toggle = async (c: Coupon, next: boolean) => {
    const ok = await runMutation(
      () => apiSend("PATCH", `/api/store/coupons/${c.id}`, { isActive: next }),
      `${c.code} ${next ? "activated" : "paused"}`
    );
    if (ok) refetch();
  };

  const remove = async () => {
    if (!confirmDelete) return;
    const ok = await runMutation(() => apiSend("DELETE", `/api/store/coupons/${confirmDelete.id}`), `Coupon ${confirmDelete.code} deleted`);
    setConfirmDelete(null);
    if (ok) refetch();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Discounts shoppers can apply at checkout on your storefront.</p>
        <Button onClick={() => setCreateOpen(true)} className="min-h-[44px] gap-1.5">
          <Plus className="h-4 w-4" /> New coupon
        </Button>
      </div>

      {loading ? (
        <RowsSkeleton rows={3} />
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          icon={<Tag className="h-8 w-8" />}
          title="No coupons yet"
          hint="Percentage, fixed-amount or free-shipping coupons — great for launch promos."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Min spend</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <p className="font-mono text-sm font-semibold">{c.code}</p>
                    {c.description ? <p className="max-w-40 truncate text-xs text-muted-foreground">{c.description}</p> : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    {c.type === "percent" ? `${c.percent}% off` : c.type === "fixed" ? `${formatMinor(c.amountMinor ?? 0)} off` : "Free shipping"}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">{c.minSpendMinor > 0 ? formatMinor(c.minSpendMinor) : "—"}</TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {c.timesUsed}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}
                    <span className="block text-[10px] text-muted-foreground">{c.perCustomerLimit}× per customer</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.startsAt ? fmtDate(c.startsAt) : "start —"}
                    {" → "}
                    {c.endsAt ? fmtDate(c.endsAt) : "no end"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch checked={c.isActive} onCheckedChange={(v) => toggle(c, v)} aria-label={`Toggle ${c.code}`} />
                      <StatusChip status={c.isActive ? "active" : "draft"} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-rose-500" aria-label={`Delete ${c.code}`} onClick={() => setConfirmDelete(c)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateCouponDialog open={createOpen} onOpenChange={setCreateOpen} onDone={refetch} />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete coupon {confirmDelete?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Shoppers will no longer be able to redeem it. Past usage stats remain in orders.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep coupon</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 text-white hover:bg-rose-700" onClick={remove}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------- create dialog

function CreateCouponDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [type, setType] = useState<"percent" | "fixed" | "freeship">("percent");
  const [percent, setPercent] = useState("10");
  const [amountMinor, setAmountMinor] = useState(0);
  const [minSpendMinor, setMinSpendMinor] = useState(0);
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body: Record<string, unknown> = {
      code: code.trim().toUpperCase(),
      type,
      description: description || null,
      minSpendMinor,
      maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
    };
    if (type === "percent") body.percent = Number(percent);
    if (type === "fixed") body.amountMinor = amountMinor;
    setBusy(true);
    const ok = await runMutation(() => apiSend("POST", "/api/store/coupons", body), `Coupon ${code.toUpperCase()} created`);
    setBusy(false);
    if (ok) {
      setCode("");
      setDescription("");
      setPercent("10");
      setAmountMinor(0);
      setMinSpendMinor(0);
      setMaxRedemptions("");
      onOpenChange(false);
      onDone();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New coupon</DialogTitle>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cp-code">Code * (A-Z, 0-9)</Label>
              <Input id="cp-code" className="font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="RAYA20" />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
                <SelectTrigger aria-label="Coupon type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">Percent off</SelectItem>
                  <SelectItem value="fixed">Fixed amount off</SelectItem>
                  <SelectItem value="freeship">Free shipping</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {type === "percent" ? (
            <div className="space-y-1.5">
              <Label htmlFor="cp-percent">Percent (1–100) *</Label>
              <Input id="cp-percent" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value.replace(/[^0-9]/g, ""))} />
            </div>
          ) : null}
          {type === "fixed" ? (
            <div className="space-y-1.5">
              <Label>Amount off (RM) *</Label>
              <MoneyInput valueMinor={amountMinor} onChangeMinor={setAmountMinor} />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Min spend (RM)</Label>
              <MoneyInput valueMinor={minSpendMinor} onChangeMinor={setMinSpendMinor} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp-max">Max redemptions</Label>
              <Input id="cp-max" inputMode="numeric" value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value.replace(/[^0-9]/g, ""))} placeholder="unlimited" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-desc">Description</Label>
            <Input id="cp-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Raya promo — 20% off everything" />
          </div>
          <Button onClick={submit} disabled={busy || !code.trim()} className="w-full min-h-[44px] gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create coupon
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

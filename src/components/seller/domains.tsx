"use client";
// Task 2-d — SD-09 Domains: add (CNAME|NS), status stepper, DNS instructions
// with copy buttons, sandbox verify (active + SSL), delete.
import { useState } from "react";
import {
  apiSend,
  EmptyState,
  RowsSkeleton,
  StatusChip,
  fmtDate,
  runMutation,
  useApi,
} from "./ui-bits";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { BadgeCheck, Copy, Globe, Info, Loader2, Lock, ShieldCheck, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SellerDomainBody, SellerDomainDeleteData, SellerDomainRow, SellerDomainVerifiedData } from "@/lib/types/api-contract";

const STEPS = ["pending", "verifying", "verified", "active"];

export default function SellerDomains({ storeSlug }: { storeSlug: string }) {
  const { data, loading, refetch } = useApi<SellerDomainRow[]>("/api/store/domains");
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SellerDomainRow | null>(null);

  const verify = async (d: SellerDomainRow) => {
    const ok = await runMutation(
      () => apiSend<SellerDomainVerifiedData>("POST", `/api/store/domains/${d.id}/verify`),
      `${d.domain} verified — SSL certificate issued`
    );
    if (ok) refetch();
  };

  const remove = async () => {
    if (!confirmDelete) return;
    const ok = await runMutation(() => apiSend<SellerDomainDeleteData>("DELETE", `/api/store/domains/${confirmDelete.id}`), "Domain removed");
    setConfirmDelete(null);
    if (ok) refetch();
  };

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription className="text-xs">
          Your default subdomain <span className="font-mono font-semibold">{storeSlug || "your-store"}.nomofee.site</span> is
          always reachable — custom domains are optional extras for branding.
        </AlertDescription>
      </Alert>

      <div className="flex justify-end">
        <Button onClick={() => setAddOpen(true)} className="min-h-[44px] gap-1.5">
          <Globe className="h-4 w-4" /> Connect domain
        </Button>
      </div>

      {loading ? (
        <RowsSkeleton rows={2} />
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          icon={<Globe className="h-8 w-8" />}
          title="No custom domains yet"
          hint="Connect a domain you own (e.g. shop.yourbrand.com) and point DNS at NOMOFEE. Free SSL is issued on verification."
        />
      ) : (
        <div className="space-y-3">
          {(data ?? []).map((d) => (
            <Card key={d.id}>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    <Globe className="h-4 w-4 text-primary" /> {d.domain}
                    {d.mode === "ns" ? (
                      <span className="rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">nameservers</span>
                    ) : (
                      <span className="rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">cname</span>
                    )}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">Added {fmtDate(d.createdAt)}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {d.sslStatus === "issued" ? (
                    <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                      <Lock className="h-3 w-3" /> SSL issued
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      <Lock className="h-3 w-3" /> SSL {d.sslStatus}
                    </span>
                  )}
                  <Button variant="outline" size="sm" className="h-8" onClick={() => verify(d)} disabled={d.status === "active"}>
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Verify now
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-rose-500"
                    aria-label={`Delete ${d.domain}`}
                    onClick={() => setConfirmDelete(d)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* stepper */}
                <ol className="flex items-center gap-1.5">
                  {STEPS.map((s, i) => {
                    const idx = STEPS.indexOf(d.status);
                    const done = idx >= i && idx !== -1;
                    return (
                      <li key={s} className="flex flex-1 items-center gap-1.5">
                        <span
                          className={cn(
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",
                            done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                          )}
                        >
                          {done ? <BadgeCheck className="h-3 w-3" /> : i + 1}
                        </span>
                        <span className={cn("text-[10px] capitalize", done ? "font-medium text-foreground" : "text-muted-foreground")}>{s}</span>
                        {i < STEPS.length - 1 ? <span className={cn("h-px flex-1", idx > i ? "bg-primary" : "bg-border")} /> : null}
                      </li>
                    );
                  })}
                </ol>
                <DnsInstructions domain={d} />
                {d.errorReason ? <p className="text-xs text-rose-600">{d.errorReason}</p> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AddDomainDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onDone={() => refetch()}
      />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmDelete?.domain}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your storefront will stop resolving on this domain (the default subdomain keeps working). DNS records at your
              registrar can be cleaned up afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep domain</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 text-white hover:bg-rose-700" onClick={remove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------- dns card

function DnsInstructions({ domain }: { domain: SellerDomainRow }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="rounded-xl border border-dashed bg-muted/30 p-3">
      <p className="text-xs font-semibold">DNS setup {domain.status === "active" ? "(done — for reference)" : ""}</p>
      {domain.mode === "ns" ? (
        <div className="mt-2 space-y-1.5 font-mono text-xs">
          {["ns1.nomofee.net", "ns2.nomofee.net"].map((ns) => (
            <div key={ns} className="flex items-center justify-between gap-2 rounded-lg bg-background px-2.5 py-1.5">
              <span>NS record → {ns}</span>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => copy(ns, ns)}>
                <Copy className="h-3 w-3" /> {copied === ns ? "Copied" : "Copy"}
              </Button>
            </div>
          ))}
          <p className="font-sans text-[11px] text-muted-foreground">Point your domain&apos;s nameservers at NOMOFEE (registrar &gt; nameserver settings).</p>
        </div>
      ) : (
        <div className="mt-2 space-y-1.5 font-mono text-xs">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-background px-2.5 py-1.5">
            <span>CNAME www → shops.nomofee.site</span>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => copy("shops.nomofee.site", "cname")}>
              <Copy className="h-3 w-3" /> {copied === "cname" ? "Copied" : "Copy target"}
            </Button>
          </div>
          <p className="font-sans text-[11px] text-muted-foreground">
            For the root domain use an ALIAS/ANAME record to the same target if your registrar supports it.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- add dialog

function AddDomainDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [domain, setDomain] = useState("");
  const [mode, setMode] = useState<"cname" | "ns">("cname");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const ok = await runMutation(
      () => apiSend<SellerDomainRow>("POST", "/api/store/domains", { domain: domain.trim(), mode } satisfies SellerDomainBody),
      "Domain added — now update DNS, then press Verify now"
    );
    setBusy(false);
    if (ok) {
      setDomain("");
      onOpenChange(false);
      onDone();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a custom domain</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dom-input">Domain *</Label>
            <Input id="dom-input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="shop.yourbrand.com" />
          </div>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as "cname" | "ns")} className="gap-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3" htmlFor="mode-cname">
              <RadioGroupItem value="cname" id="mode-cname" />
              <span>
                <span className="block text-sm font-medium">CNAME (recommended)</span>
                <span className="block text-xs text-muted-foreground">Add a CNAME record pointing at NOMOFEE. Fastest setup.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3" htmlFor="mode-ns">
              <RadioGroupItem value="ns" id="mode-ns" />
              <span>
                <span className="block text-sm font-medium">Nameservers (NS)</span>
                <span className="block text-xs text-muted-foreground">Hand over DNS management to NOMOFEE. Full control incl. email routing.</span>
              </span>
            </label>
          </RadioGroup>
          <p className="text-xs text-muted-foreground">
            Status starts at <StatusChip status="verifying" className="mx-0.5" /> — after updating DNS, press “Verify now”.
          </p>
          <Button onClick={submit} disabled={busy || !domain.trim()} className="w-full min-h-[44px] gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />} Add domain
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

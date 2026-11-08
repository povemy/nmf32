"use client";
// Task 2-d — SD-10 Integrations: pixel providers, webhooks (endpoints, masked
// secret + rotate, events, send-test), API keys (lite, client-side demo in
// sandbox). D1: the signing secret is shown exactly once (create/rotate) — the
// endpoint list only ever renders the masked form.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  apiSend,
  runMutation,
  StatusChip,
  fmtDateTime,
  useApi,
} from "./ui-bits";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { KeyRound, Loader2, Plug, Plus, RefreshCw, Send, Trash2, Webhook } from "lucide-react";
import type {
  IntegrationBody,
  IntegrationSaveData,
  SellerIntegrationRow,
  SellerWebhookBody,
  SellerWebhookCreateData,
  SellerWebhookDeleteData,
  SellerWebhookEndpoint,
  SellerWebhookPatchBody,
  SellerWebhookPatchData,
  SellerWebhookRotateData,
} from "@/lib/types/api-contract";

// ---------------------------------------------------------------- pixels

const PIXELS: { provider: IntegrationBody["provider"]; label: string; field: string; hint: string }[] = [
  { provider: "meta_pixel", label: "Meta Pixel", field: "pixelId", hint: "Facebook & Instagram ad tracking" },
  { provider: "ga4", label: "Google Analytics 4", field: "measurementId", hint: "Traffic & funnel analytics" },
  { provider: "tiktok_pixel", label: "TikTok Pixel", field: "pixelId", hint: "TikTok ads conversion tracking" },
  { provider: "gtm", label: "Google Tag Manager", field: "containerId", hint: "Manage all tags via GTM" },
];

function PixelCards() {
  const { data, refetch } = useApi<SellerIntegrationRow[]>("/api/store/integrations");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    const d: Record<string, string> = {};
    for (const i of data) {
      const def = PIXELS.find((p) => p.provider === i.provider);
      if (def) d[i.provider] = typeof i.config[def.field] === "string" ? String(i.config[def.field]) : "";
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setDrafts(d);
  }, [data]);

  const save = async (provider: IntegrationBody["provider"], isEnabled?: boolean) => {
    const def = PIXELS.find((p) => p.provider === provider)!;
    const current = data?.find((i) => i.provider === provider);
    const nextEnabled = isEnabled ?? current?.isEnabled ?? false;
    const id = drafts[provider]?.trim();
    if (nextEnabled && !id) {
      toast.error(`Enter a ${def.field} before enabling`);
      return;
    }
    const ok = await runMutation(
      () => apiSend<IntegrationSaveData>("PUT", "/api/store/integrations", { provider, config: { [def.field]: id ?? "" }, isEnabled: nextEnabled } satisfies IntegrationBody),
      `${def.label} ${nextEnabled ? "enabled" : "disabled"}`
    );
    if (ok) refetch();
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {PIXELS.map((p) => {
        const integration = data?.find((i) => i.provider === p.provider);
        return (
          <Card key={p.provider}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2"><Plug className="h-4 w-4 text-primary" /> {p.label}</span>
                <Switch
                  checked={integration?.isEnabled ?? false}
                  onCheckedChange={(v) => save(p.provider, v)}
                  aria-label={`Enable ${p.label}`}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input
                placeholder={`${p.field}`}
                value={drafts[p.provider] ?? ""}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [p.provider]: e.target.value }))}
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">{p.hint}</p>
                <Button variant="outline" size="sm" className="h-8" onClick={() => save(p.provider, integration?.isEnabled ?? false)}>
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- webhooks

const EVENT_CATALOG = [
  "order.created",
  "order.paid",
  "order.shipped",
  "order.delivered",
  "order.refunded",
  "product.updated",
  "stock.low",
  "payout.paid",
];

/** D1 — one-time secret reveal (create + rotate share it): copyable callout,
 *  same shape as the API-key show-once dialog below. */
function SecretOnceDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!secret} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Copy your signing secret now</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Store it now — you won&apos;t see it again. Verify payloads with the <code>x-nomofee-signature</code> header: lowercase hex HMAC-SHA256 of <code>{"${x-nomofee-timestamp}.${rawBody}"}</code> using this secret. Reject requests whose <code>x-nomofee-timestamp</code> is more than ±10 minutes from now.</p>
          <code className="block break-all rounded-lg bg-muted p-3 font-mono text-xs">{secret}</code>
          <Button
            variant="outline"
            className="w-full"
            onClick={async () => {
              if (!secret) return;
              try {
                await navigator.clipboard.writeText(secret);
                toast.success("Secret copied");
              } catch {
                toast.error("Could not copy");
              }
            }}
          >
            Copy secret
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WebhooksSection() {
  const { data, loading, refetch } = useApi<SellerWebhookEndpoint[]>("/api/store/webhooks");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SellerWebhookEndpoint | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

  const sendTest = async (ep: SellerWebhookEndpoint) => {
    // C2.8: the test is a REAL signed delivery — surface the endpoint's actual
    // answer instead of claiming a simulated send. (Route not covered by the
    // API contract; precise local response shape.)
    try {
      const res = await apiSend<{ status: string; responseCode: number | null; error: string | null; note: string }>(
        "POST",
        `/api/store/webhooks/${ep.id}/test`
      );
      if (res.status === "success") {
        toast.success(`Test delivered — endpoint answered ${res.responseCode ?? "2xx"}`);
      } else {
        toast.error(`Test not accepted (${res.status}${res.responseCode ? `, HTTP ${res.responseCode}` : ""}${res.error ? ` — ${res.error}` : ""})`);
      }
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test delivery failed");
    }
  };

  const toggleActive = async (ep: SellerWebhookEndpoint, next: boolean) => {
    const ok = await runMutation(() => apiSend<SellerWebhookPatchData>("PATCH", `/api/store/webhooks/${ep.id}`, { isActive: next } satisfies SellerWebhookPatchBody), `Endpoint ${next ? "enabled" : "paused"}`);
    if (ok) refetch();
  };

  // D1 — rotate: the response carries the new plaintext secret exactly once;
  // surface it in the one-time callout and refresh the (masked) list.
  const rotate = async (ep: SellerWebhookEndpoint) => {
    if (rotatingId) return;
    setRotatingId(ep.id);
    try {
      const res = await apiSend<SellerWebhookRotateData>("POST", `/api/store/webhooks/${ep.id}/rotate`);
      toast.success("Signing secret rotated");
      setRotatedSecret(res.secret);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rotate secret");
    } finally {
      setRotatingId(null);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Webhook className="h-4 w-4 text-primary" /> Webhooks</h3>
          <p className="text-xs text-muted-foreground">POST a signed JSON payload to your endpoints whenever these events happen.</p>
        </div>
        <Button variant="outline" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Add endpoint
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading endpoints…</p>
      ) : (data ?? []).length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No endpoints yet — add one to receive order events.
        </p>
      ) : (
        <div className="space-y-3">
          {(data ?? []).map((ep) => (
            <Card key={ep.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="break-all font-mono text-xs">{ep.url}</span>
                  <Switch checked={ep.isActive} onCheckedChange={(v) => toggleActive(ep, v)} aria-label="Toggle endpoint" />
                  <span className="ml-auto flex gap-1">
                    <Button variant="outline" size="sm" className="h-8 gap-1" onClick={() => sendTest(ep)}>
                      <Send className="h-3 w-3" /> Send test
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1"
                      onClick={() => rotate(ep)}
                      disabled={rotatingId === ep.id}
                      aria-label={`Rotate signing secret for ${ep.url}`}
                    >
                      {rotatingId === ep.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Rotate
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-rose-500" aria-label="Delete endpoint" onClick={() => setConfirmDelete(ep)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {ep.events.map((e) => (
                    <span key={e} className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px]">{e}</span>
                  ))}
                </div>
                <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Secret</span>
                  <code className="flex-1 truncate font-mono text-xs" title="Masked — rotate to get a new secret">{ep.secretMasked}</code>
                </div>
                {ep.deliveries.length > 0 ? (
                  <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border p-2">
                    {ep.deliveries.map((d) => (
                      <div key={d.id} className="flex items-center gap-2 text-xs">
                        {/* C2.8: honest chip — "pending" = queued/retrying, not sent */}
                        <StatusChip status={d.status} />
                        <span className="font-mono">{d.event}</span>
                        <span className="text-muted-foreground">{d.responseCode ?? "—"}</span>
                        {d.attempts > 1 ? (
                          <span className="text-muted-foreground" title="Attempts so far">×{d.attempts}</span>
                        ) : null}
                        <span className="ml-auto text-muted-foreground">{fmtDateTime(d.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No deliveries yet.</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateWebhookDialog open={createOpen} onOpenChange={setCreateOpen} onDone={refetch} />

      <SecretOnceDialog secret={rotatedSecret} onClose={() => setRotatedSecret(null)} />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete webhook endpoint?</AlertDialogTitle>
            <AlertDialogDescription>Events will stop being delivered to {confirmDelete?.url}. Delivery logs are removed too.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep endpoint</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700"
              onClick={async () => {
                if (!confirmDelete) return;
                const ok = await runMutation(() => apiSend<SellerWebhookDeleteData>("DELETE", `/api/store/webhooks/${confirmDelete.id}`), "Endpoint deleted");
                setConfirmDelete(null);
                if (ok) refetch();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CreateWebhookDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["order.paid", "order.shipped"]);
  const [busy, setBusy] = useState(false);
  // D1 — the create response reveals the signing secret exactly once.
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const submit = async () => {
    if (!/^https?:\/\/.+/.test(url.trim())) {
      toast.error("Enter a valid http(s) URL");
      return;
    }
    if (events.length === 0) {
      toast.error("Pick at least one event");
      return;
    }
    setBusy(true);
    try {
      const created = await apiSend<SellerWebhookCreateData>("POST", "/api/store/webhooks", { url: url.trim(), events } satisfies SellerWebhookBody);
      toast.success("Endpoint created — signing secret generated");
      setUrl("");
      onOpenChange(false);
      onDone();
      if (created?.secret) setNewSecret(created.secret);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add webhook endpoint</DialogTitle>
          </DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label htmlFor="wh-url">Payload URL *</Label>
              <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.yourapp.com/nomofee" />
            </div>
            <div className="space-y-1.5">
              <Label>Events ({events.length} selected)</Label>
              <div className="grid max-h-44 grid-cols-1 gap-1.5 overflow-y-auto rounded-xl border p-2.5 sm:grid-cols-2">
                {EVENT_CATALOG.map((e) => (
                  <label key={e} className="flex cursor-pointer items-center gap-2 text-xs">
                    <Checkbox
                      checked={events.includes(e)}
                      onCheckedChange={(v) => setEvents((prev) => (v ? [...prev, e] : prev.filter((x) => x !== e)))}
                      aria-label={e}
                    />
                    <span className="font-mono">{e}</span>
                  </label>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">The signing secret is shown once after creation — verify payloads with the <code>x-nomofee-signature</code> header (hex HMAC-SHA256 of <code>{"${x-nomofee-timestamp}.${rawBody}"}</code>; reject timestamps outside ±10 min). Failed deliveries are retried for up to 8 attempts over ~41 h.</p>
            <Button onClick={submit} disabled={busy} className="w-full min-h-[44px] gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create endpoint
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <SecretOnceDialog secret={newSecret} onClose={() => setNewSecret(null)} />
    </>
  );
}

// ---------------------------------------------------------------- api keys (lite)

type ApiKeyLite = { id: string; name: string; scope: "read" | "read-write"; token: string; createdAt: string };

const LS_KEY = "sm_seller_api_keys";

function loadKeys(): ApiKeyLite[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(LS_KEY) ?? "[]") as ApiKeyLite[];
  } catch {
    return [];
  }
}

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyLite[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "read-write">("read");
  const [showOnce, setShowOnce] = useState<ApiKeyLite | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
  useEffect(() => setKeys(loadKeys()), []);

  const persist = (next: ApiKeyLite[]) => {
    setKeys(next);
    window.localStorage.setItem(LS_KEY, JSON.stringify(next));
  };

  const create = () => {
    if (!name.trim()) {
      toast.error("Give the key a name");
      return;
    }
    const key: ApiKeyLite = {
      id: `key_${Math.random().toString(36).slice(2, 10)}`,
      name: name.trim(),
      scope,
      token: `smk_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
    };
    persist([...keys, key]);
    setShowOnce(key);
    setCreateOpen(false);
    setName("");
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4 text-primary" /> API keys</h3>
          <p className="text-xs text-muted-foreground">For custom integrations hitting the store API. Sandbox note: keys live in your browser only (demo).</p>
        </div>
        <Button variant="outline" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Create key
        </Button>
      </div>

      {keys.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-2 rounded-xl border p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{k.name}</p>
                <p className="font-mono text-xs text-muted-foreground">smk_••••{k.token.slice(-4)} · {k.scope}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-rose-500"
                aria-label={`Revoke ${k.name}`}
                onClick={() => persist(keys.filter((x) => x.id !== k.id))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Create API key</DialogTitle></DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label htmlFor="ak-name">Key name *</Label>
              <Input id="ak-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Inventory sync script" />
            </div>
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as "read" | "read-write")}>
                <SelectTrigger aria-label="Scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">read — GET endpoints only</SelectItem>
                  <SelectItem value="read-write">read-write — full store API</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={create} className="w-full min-h-[44px]">Generate key</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* show-once dialog */}
      <Dialog open={!!showOnce} onOpenChange={(o) => !o && setShowOnce(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Copy your key now</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">This is the only time the full token is shown. Store it somewhere safe.</p>
            <code className="block break-all rounded-lg bg-muted p-3 font-mono text-xs">{showOnce?.token}</code>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                if (!showOnce) return;
                try {
                  await navigator.clipboard.writeText(showOnce.token);
                  toast.success("Token copied");
                } catch {
                  toast.error("Could not copy");
                }
              }}
            >
              Copy token
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default function SellerIntegrations() {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Tracking pixels</h3>
          <p className="text-xs text-muted-foreground">Fired on your storefront pages and checkout events (after approval).</p>
        </div>
        <PixelCards />
      </section>
      <WebhooksSection />
      <ApiKeysSection />
    </div>
  );
}

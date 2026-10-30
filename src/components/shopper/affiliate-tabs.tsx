"use client";
// ============================================================================
// Affiliate Hub tabs (Task 2-A) — Links, Collections, Showcase, Network,
// Earnings, Payouts. Every mutation surfaces sonner toasts; every empty state
// is honest; every money figure is formatted from minor units via lib/money.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  Eye,
  Info,
  Link2,
  Plus,
  Search,
  Share2,
  Store,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { EmptyState, type ShopperCtx } from "./ui-bits";
import {
  affGet,
  affPost,
  affPatch,
  affDelete,
  CHANNEL_LABEL,
  collectionUrl,
  CopyButton,
  dateShort,
  dateTimeShort,
  deriveStores,
  LINK_CHANNELS,
  LINK_TYPE_LABEL,
  money,
  Pager,
  promoLinkUrl,
  ratePercent,
  referralJoinUrl,
  SectionCard,
  showcaseUrl,
  StatCard,
  StatusChip,
  TabError,
  TabSkeleton,
  useDiscoverSearch,
  type AffiliateProfileT,
  type AffiliateSettingsT,
  type CollectionRowT,
  type DiscoverProductT,
  type EarningsResT,
  type LinkRowT,
  type NetworkResT,
  type PayoutsResT,
  type HubOverviewT,
} from "./affiliate-shared";

// ============================================================================
// LINKS TAB
// ============================================================================

export function LinksTab({ onCreate }: { onCreate: () => void }) {
  const [links, setLinks] = useState<LinkRowT[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await affGet<{ links: LinkRowT[] }>("/api/affiliate/links");
      setLinks(d.links ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load your links");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStatus = async (link: LinkRowT) => {
    const next = link.status === "active" ? "archived" : "active";
    setBusyId(link.id);
    try {
      await affPatch(`/api/affiliate/links/${link.id}`, { status: next });
      toast.success(next === "archived" ? "Link archived" : "Link reactivated");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  if (err) return <TabError message={err} onRetry={() => void load()} />;
  if (links === null) return <TabSkeleton rows={2} />;

  const visible = links.filter((l) => (showArchived ? true : l.status === "active"));
  const activeCount = links.filter((l) => l.status === "active").length;

  return (
    <div className="space-y-4">
      <SectionCard
        title={`Your links (${activeCount} active)`}
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
              className={cn(
                "min-h-[44px] rounded-full border px-3 text-xs font-bold transition-colors",
                showArchived ? "border-teal-700 bg-teal-700 text-white" : "border-border bg-card text-muted-foreground hover:bg-muted"
              )}
            >
              {showArchived ? "Hiding nothing" : "Show archived"}
            </button>
            <Button type="button" className="min-h-[44px] gap-1.5 bg-brand-gradient text-white" onClick={onCreate}>
              <Plus className="h-4 w-4" aria-hidden /> New link
            </Button>
          </div>
        }
      >
        {visible.length === 0 ? (
          <EmptyState
            icon={Link2}
            title={links.length === 0 ? "No links yet" : "Nothing here"}
            hint={
              links.length === 0
                ? "Every link you create carries your attribution — share it anywhere and eligible sales earn commission."
                : "All your links are archived. Reactivate one or create a new link."
            }
            action={
              <Button type="button" className="min-h-[44px] bg-brand-gradient text-white" onClick={onCreate}>
                Create a link
              </Button>
            }
          />
        ) : (
          <ul className="space-y-2.5">
            {visible.map((l) => (
              <li key={l.id} className="rounded-xl border bg-background/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10px] font-bold text-teal-800">
                    {LINK_TYPE_LABEL[l.type] ?? l.type}
                  </Badge>
                  <p className="min-w-0 flex-1 truncate text-sm font-bold text-slate-900">{l.target.title}</p>
                  <StatusChip status={l.status} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {CHANNEL_LABEL[l.channel] ?? l.channel}
                  </span>
                  {l.label ? <span className="truncate text-[11px] text-muted-foreground">“{l.label}”</span> : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px] text-slate-600" title={promoLinkUrl(l.code)}>
                    {promoLinkUrl(l.code)}
                  </code>
                  <CopyButton text={promoLinkUrl(l.code)} label="Copy link" />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    {l.clicks.toLocaleString()} click{l.clicks === 1 ? "" : "s"} · last click {l.lastClickAt ? dateShort(l.lastClickAt) : "never"} · created {dateShort(l.createdAt)}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-[36px] gap-1 px-2 text-[11px] text-rose-700 hover:bg-rose-50"
                    disabled={busyId === l.id}
                    onClick={() => void toggleStatus(l)}
                  >
                    {l.status === "active" ? (
                      <>
                        <Archive className="h-3.5 w-3.5" aria-hidden /> Archive
                      </>
                    ) : (
                      <>
                        <ArchiveRestore className="h-3.5 w-3.5" aria-hidden /> Reactivate
                      </>
                    )}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

// ============================================================================
// LINK CREATE DIALOG (shared by Links tab + Discover cards)
// ============================================================================

type LinkTargetPick =
  | { kind: "product"; productId: string; title: string }
  | { kind: "store"; storeId: string; title: string }
  | { kind: "collection"; collectionId: string; title: string }
  | { kind: "showcase" };

export function LinkCreateDialog({
  open,
  onOpenChange,
  preset,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Product preset coming from a Discover card. */
  preset: DiscoverProductT | null;
  onCreated?: () => void;
}) {
  const [type, setType] = useState<"product" | "store" | "collection" | "showcase">("product");
  const [channel, setChannel] = useState<string>("other");
  const [label, setLabel] = useState("");
  const [pick, setPick] = useState<LinkTargetPick | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Product search picker
  const search = useDiscoverSearch(open && type === "product");
  // Store picker — public directory (ids) + participating flags from discover
  const [stores, setStores] = useState<{ id: string; slug: string; name: string; participating: boolean }[] | null>(null);
  // Collection picker
  const [collections, setCollections] = useState<CollectionRowT[] | null>(null);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setInitialized(true);
    setError(null);
    if (preset) {
      setType("product");
      setPick({ kind: "product", productId: preset.productId, title: preset.title });
    } else {
      setType("product");
      setPick(null);
    }
    setLabel("");
    setChannel("other");
  }, [open, preset]);

  // Load store directory + collection list lazily.
  useEffect(() => {
    if (!open || !initialized) return;
    let alive = true;
    if (type === "store" && stores === null) {
      void (async () => {
        try {
          const [dir, disc] = await Promise.all([
            affGet<{ id: string; name: string; slug: string }[]>("/api/market/stores"),
            affGet<{ rows: DiscoverProductT[] }>("/api/affiliate/discover?size=48"),
          ]);
          if (!alive) return;
          const participating = new Set(deriveStores(disc.rows ?? []).map((s) => s.slug));
          setStores(
            dir.map((s) => ({ id: s.id, slug: s.slug, name: s.name, participating: participating.has(s.slug) })).sort((a, b) => Number(b.participating) - Number(a.participating) || a.name.localeCompare(b.name))
          );
        } catch {
          if (alive) setStores([]);
        }
      })();
    }
    if (type === "collection" && collections === null) {
      affGet<{ collections: CollectionRowT[] }>("/api/affiliate/collections")
        .then((d) => alive && setCollections((d.collections ?? []).filter((c) => c.status === "published")))
        .catch(() => alive && setCollections([]));
    }
    return () => {
      alive = false;
    };
  }, [open, initialized, type, stores, collections]);

  const submit = async () => {
    setError(null);
    if (type !== "showcase" && !pick) {
      setError("Choose a target for this link first.");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { type, channel, label: label.trim() || undefined };
      if (pick?.kind === "product") body.productId = pick.productId;
      if (pick?.kind === "store") body.storeId = pick.storeId;
      if (pick?.kind === "collection") body.collectionId = pick.collectionId;
      await affPost<{ link: { code: string } }>("/api/affiliate/links", body);
      toast.success("Link created — copy the share URL from your Links tab");
      onOpenChange(false);
      onCreated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create affiliate link</DialogTitle>
          <DialogDescription>
            Every click on this link records your attribution for 30 days. Sales from eligible products earn you
            commission.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Link type">
            {(["product", "store", "collection", "showcase"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setType(t);
                  setPick(null);
                }}
                aria-pressed={type === t}
                className={cn(
                  "min-h-[44px] rounded-lg border px-1 text-[11px] font-bold transition-colors",
                  type === t ? "border-teal-700 bg-teal-700 text-white" : "border-border bg-card text-muted-foreground hover:bg-muted"
                )}
              >
                {LINK_TYPE_LABEL[t]}
              </button>
            ))}
          </div>

          {/* ---- target picker ---- */}
          {type === "product" ? (
            <div className="space-y-2">
              <Label htmlFor="lc-search" className="text-xs font-bold text-slate-700">
                Find a participating product
              </Label>
              <Input
                id="lc-search"
                value={search.q}
                onChange={(e) => search.setQ(e.target.value)}
                placeholder={preset ? preset.title : "Search products…"}
                className="min-h-[44px]"
              />
              {preset && pick?.kind === "product" && pick.productId === preset.productId ? (
                <p className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-800">
                  Pre-selected: {preset.title}
                </p>
              ) : null}
              <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border p-1.5" role="listbox" aria-label="Product results">
                {search.loading ? (
                  <p className="p-3 text-center text-xs text-muted-foreground">Searching…</p>
                ) : (search.rows ?? []).length === 0 ? (
                  <p className="p-3 text-center text-xs text-muted-foreground">No participating products found.</p>
                ) : (
                  search.rows!.map((p) => (
                    <button
                      key={p.productId}
                      type="button"
                      role="option"
                      aria-selected={pick?.kind === "product" && pick.productId === p.productId}
                      onClick={() => setPick({ kind: "product", productId: p.productId, title: p.title })}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border p-2 text-left transition-colors",
                        pick?.kind === "product" && pick.productId === p.productId ? "border-teal-700 bg-teal-50" : "border-transparent hover:bg-muted"
                      )}
                    >
                      <ProductThumb p={p} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold">{p.title}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {p.storeName} · {money(p.priceMinor)} · {ratePercent(p.rateBps)}
                        </span>
                      </span>
                      {pick?.kind === "product" && pick.productId === p.productId ? <Check className="h-4 w-4 shrink-0 text-teal-700" aria-hidden /> : null}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : type === "store" ? (
            <div className="space-y-2">
              <Label className="text-xs font-bold text-slate-700">Pick a store</Label>
              <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border p-1.5" role="listbox" aria-label="Store results">
                {stores === null ? (
                  <p className="p-3 text-center text-xs text-muted-foreground">Loading stores…</p>
                ) : stores.length === 0 ? (
                  <p className="p-3 text-center text-xs text-muted-foreground">No live stores found.</p>
                ) : (
                  stores.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="option"
                      aria-selected={pick?.kind === "store" && pick.storeId === s.id}
                      onClick={() => setPick({ kind: "store", storeId: s.id, title: s.name })}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border p-2 text-left transition-colors",
                        pick?.kind === "store" && pick.storeId === s.id ? "border-teal-700 bg-teal-50" : "border-transparent hover:bg-muted"
                      )}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-teal-50 text-teal-700">
                        <Store className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold">{s.name}</span>
                        <span className={cn("text-[10px] font-bold", s.participating ? "text-emerald-700" : "text-amber-700")}>
                          {s.participating ? "Participating in affiliate programme" : "Participation unknown — may be rejected"}
                        </span>
                      </span>
                      {pick?.kind === "store" && pick.storeId === s.id ? <Check className="h-4 w-4 shrink-0 text-teal-700" aria-hidden /> : null}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : type === "collection" ? (
            <div className="space-y-2">
              <Label className="text-xs font-bold text-slate-700">Pick a published collection</Label>
              <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border p-1.5" role="listbox" aria-label="Collection results">
                {collections === null ? (
                  <p className="p-3 text-center text-xs text-muted-foreground">Loading collections…</p>
                ) : collections.length === 0 ? (
                  <p className="p-3 text-center text-xs text-muted-foreground">
                    No published collections yet — publish one in the Collections tab first.
                  </p>
                ) : (
                  collections.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={pick?.kind === "collection" && pick.collectionId === c.id}
                      onClick={() => setPick({ kind: "collection", collectionId: c.id, title: c.title })}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border p-2 text-left transition-colors",
                        pick?.kind === "collection" && pick.collectionId === c.id ? "border-teal-700 bg-teal-50" : "border-transparent hover:bg-muted"
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold">{c.title}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {c.items.length} item{c.items.length === 1 ? "" : "s"} · /?affc={c.slug}
                        </span>
                      </span>
                      {pick?.kind === "collection" && pick.collectionId === c.id ? <Check className="h-4 w-4 shrink-0 text-teal-700" aria-hidden /> : null}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5 text-xs font-semibold text-teal-800">
              Your link will open your public showcase page — the recommendation hub for everything you share.
            </p>
          )}

          {/* ---- channel + label ---- */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-bold text-slate-700">Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger className="min-h-[44px]" aria-label="Channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINK_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CHANNEL_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lc-label" className="text-xs font-bold text-slate-700">
                Label (optional)
              </Label>
              <Input id="lc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. TikTok bio — March" className="min-h-[44px]" maxLength={80} />
            </div>
          </div>

          {error ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={() => void submit()} className="min-h-[44px] bg-brand-gradient text-white">
              {busy ? "Creating…" : "Create link"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProductThumb({ p }: { p: DiscoverProductT }) {
  return (
    <span className="block h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted">
      {p.image ? <img src={p.image} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
    </span>
  );
}

// ============================================================================
// COLLECTIONS TAB
// ============================================================================

export function CollectionsTab({ ctx }: { ctx: ShopperCtx }) {
  const [collections, setCollections] = useState<CollectionRowT[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await affGet<{ collections: CollectionRowT[] }>("/api/affiliate/collections");
      setCollections(d.collections ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load your collections");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every setState runs after the awaited fetch, never synchronously
    void load();
  }, [load]);

  if (err) return <TabError message={err} onRetry={() => void load()} />;
  if (collections === null) return <TabSkeleton rows={2} />;

  const editing = collections.find((c) => c.id === editingId) ?? null;

  return (
    <div className="space-y-4">
      {editing ? (
        <CollectionEditor
          collection={editing}
          ctx={ctx}
          onClose={() => setEditingId(null)}
          onChanged={() => void load()}
        />
      ) : null}

      <SectionCard
        title={`Collections (${collections.length})`}
        action={<CreateCollectionButton onCreated={() => void load()} />}
      >
        <p className="pb-3 text-[11px] leading-snug text-muted-foreground">
          Curated product lists on your public page. Editing membership bumps the collection version so past clicks
          keep their click-time snapshot — never rewritten.
        </p>
        {collections.length === 0 ? (
          <EmptyState
            icon={Plus}
            title="No collections yet"
            hint="Group the products you recommend into a curated, shareable page — e.g. “Tech finds under RM100”."
            action={<CreateCollectionButton onCreated={() => void load()} inline />}
          />
        ) : (
          <ul className="space-y-2.5">
            {collections.map((c) => (
              <li key={c.id} className="rounded-xl border bg-background/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-bold text-slate-900">{c.title}</p>
                  <StatusChip status={c.status} />
                </div>
                {c.description ? <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{c.description}</p> : null}
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  {c.items.length} item{c.items.length === 1 ? "" : "s"} · v{c.version} · updated {dateShort(c.updatedAt)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" className="min-h-[36px] gap-1 text-[11px]" onClick={() => setEditingId(c.id)}>
                    <Eye className="h-3.5 w-3.5" aria-hidden /> Manage
                  </Button>
                  {c.status === "published" ? (
                    <>
                      <CopyButton text={collectionUrl(c.slug)} label="Copy page link" />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-[36px] gap-1 text-[11px]"
                        onClick={() => ctx.nav({ name: "aff-collection", slug: c.slug })}
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Preview
                      </Button>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Info className="h-3.5 w-3.5" aria-hidden /> Publish to get a shareable page
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function CreateCollectionButton({ onCreated, inline }: { onCreated: () => void; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await affPost<{ collection: { id: string } }>("/api/affiliate/collections", {
        title: title.trim(),
        description: description.trim() || undefined,
      });
      toast.success("Collection created as a draft");
      setOpen(false);
      setTitle("");
      setDescription("");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the collection");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        className={cn("min-h-[44px] gap-1.5 bg-brand-gradient text-white", inline && "mt-1")}
        onClick={() => setOpen(true)}
      >
        <Plus className="h-4 w-4" aria-hidden /> New collection
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>A draft only you can see until you publish it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cc-title" className="text-xs font-bold text-slate-700">
                Title
              </Label>
              <Input id="cc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Raya picks under RM50" className="min-h-[44px]" maxLength={80} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-desc" className="text-xs font-bold text-slate-700">
                Description (optional)
              </Label>
              <Textarea id="cc-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[70px]" maxLength={500} />
            </div>
            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={busy || title.trim().length < 3} onClick={() => void submit()} className="min-h-[44px] bg-brand-gradient text-white">
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CollectionEditor({
  collection,
  ctx,
  onClose,
  onChanged,
}: {
  collection: CollectionRowT;
  ctx: ShopperCtx;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const search = useDiscoverSearch(true);

  const patch = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy("patch");
    try {
      await affPatch(`/api/affiliate/collections/${collection.id}`, body);
      toast.success(okMsg);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    if (!window.confirm(`Archive “${collection.title}”? Its share links stop resolving and links pointing at it are archived too.`)) return;
    setBusy("archive");
    try {
      await affDelete(`/api/affiliate/collections/${collection.id}`);
      toast.success("Collection archived");
      onClose();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setBusy(null);
    }
  };

  const memberIds = new Set(collection.items.map((i) => i.productId));
  const addable = (search.rows ?? []).filter((r) => !memberIds.has(r.productId));
  const orderedIds = collection.items.map((i) => i.productId);

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...orderedIds];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    void patch({ order: next }, "Order updated");
  };

  return (
    <SectionCard
      title="Edit collection"
      action={
        <Button type="button" variant="ghost" size="sm" className="min-h-[36px] text-xs" onClick={onClose}>
          Close editor
        </Button>
      }
      className="border-teal-300/70 bg-teal-50/30"
    >
      <div className="space-y-4">
        {/* metadata */}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor="ce-title" className="text-xs font-bold text-slate-700">
                Title
              </Label>
              <Input id="ce-title" value={title} onChange={(e) => setTitle(e.target.value)} className="min-h-[44px]" maxLength={80} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ce-desc" className="text-xs font-bold text-slate-700">
                Description
              </Label>
              <Textarea id="ce-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[64px]" maxLength={500} />
            </div>
          </div>
          <div className="flex flex-col justify-between gap-2">
            <StatusChip status={collection.status} />
            <p className="text-[11px] text-muted-foreground tabular-nums">v{collection.version}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            disabled={busy !== null || (title.trim() === collection.title && description === (collection.description ?? ""))}
            onClick={() => void patch({ title: title.trim(), description }, "Collection saved")}
          >
            Save details
          </Button>
          {collection.status === "draft" ? (
            <Button
              type="button"
              className="min-h-[44px] bg-brand-gradient text-white"
              disabled={busy !== null || collection.items.length === 0}
              onClick={() => void patch({ status: "published" }, "Collection published")}
            >
              Publish
            </Button>
          ) : (
            <Button type="button" variant="outline" className="min-h-[44px]" disabled={busy !== null} onClick={() => void patch({ status: "draft" }, "Collection unpublished")}>
              Unpublish
            </Button>
          )}
          {collection.status === "published" ? (
            <>
              <CopyButton text={collectionUrl(collection.slug)} label="Copy page link" className="h-10 min-h-[44px] px-3" />
              <Button type="button" variant="outline" className="min-h-[44px] gap-1.5" onClick={() => ctx.nav({ name: "aff-collection", slug: collection.slug })}>
                <ExternalLink className="h-4 w-4" aria-hidden /> Preview page
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            className="min-h-[44px] gap-1.5 text-rose-700 hover:bg-rose-50"
            disabled={busy !== null}
            onClick={() => void archive()}
          >
            <Trash2 className="h-4 w-4" aria-hidden /> Archive
          </Button>
        </div>
        {collection.status === "draft" && collection.items.length === 0 ? (
          <p className="text-[11px] text-amber-700">Add at least one product before publishing.</p>
        ) : null}
        <p className="text-[11px] leading-snug text-muted-foreground">
          Share this page as a plain link for browsing. For money-grade attribution, create a promotional link of type
          “Collection” in the Links tab and share that URL instead — clicks then record your commission scope.
        </p>

        {/* items */}
        <div>
          <p className="pb-2 text-xs font-extrabold uppercase tracking-wide text-slate-500">Items ({collection.items.length}/60)</p>
          {collection.items.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No products yet — add some below.</p>
          ) : (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1" aria-label="Collection items">
              {collection.items.map((it, idx) => (
                <li key={it.productId} className="flex items-center gap-2 rounded-lg border bg-background p-2">
                  <span className="w-5 shrink-0 text-center text-[11px] font-bold text-muted-foreground tabular-nums">{idx + 1}</span>
                  <span className="block h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted">
                    {it.image ? <img src={it.image} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">{it.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {it.storeName} · {money(it.priceMinor)}
                      {it.eligible ? ` · ${ratePercent(it.rateBps)}` : " · no longer eligible"}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-0.5">
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={idx === 0 || busy !== null} onClick={() => move(idx, -1)} aria-label="Move up">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={idx === collection.items.length - 1 || busy !== null} onClick={() => move(idx, 1)} aria-label="Move down">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-rose-700"
                      disabled={busy !== null}
                      onClick={() => void patch({ removeProductIds: [it.productId] }, "Product removed")}
                      aria-label={`Remove ${it.title}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* add via discover search */}
        <div className="space-y-2 rounded-lg border bg-background/70 p-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search.q} onChange={(e) => search.setQ(e.target.value)} placeholder="Search participating products to add…" className="min-h-[44px] pl-9" aria-label="Search products to add" />
          </div>
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {search.loading ? (
              <p className="p-2 text-center text-xs text-muted-foreground">Searching…</p>
            ) : addable.length === 0 ? (
              <p className="p-2 text-center text-xs text-muted-foreground">Nothing new to add from this search.</p>
            ) : (
              addable.map((p) => (
                <div key={p.productId} className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-muted">
                  <ProductThumb p={p} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">{p.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {p.storeName} · {money(p.priceMinor)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-[36px] shrink-0 gap-1 text-[11px]"
                    disabled={busy !== null || collection.items.length >= 60}
                    onClick={() => void patch({ addProductIds: [p.productId] }, "Product added")}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden /> Add
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ============================================================================
// SHOWCASE TAB (public-page manager)
// ============================================================================

export function ShowcaseTab({ ctx, profile }: { ctx: ShopperCtx; profile: AffiliateProfileT }) {
  const [collections, setCollections] = useState<CollectionRowT[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await affGet<{ collections: CollectionRowT[] }>("/api/affiliate/collections");
      setCollections(d.collections ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load collections");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every setState runs after the awaited fetch, never synchronously
    void load();
  }, [load]);

  const published = (collections ?? []).filter((c) => c.status === "published");

  return (
    <div className="space-y-4">
      <SectionCard title="Your public page">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-brand-gradient text-lg font-extrabold text-white" aria-hidden>
            {profile.avatarUrl ? <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" /> : (profile.displayName || "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-extrabold text-slate-900">{profile.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">
              @{profile.slug} · activated {dateShort(profile.activatedAt)}
            </p>
            {profile.bio ? <p className="pt-1 text-xs leading-snug text-slate-600">{profile.bio}</p> : null}
            {profile.sponsorName ? (
              <p className="pt-1 text-[11px] text-muted-foreground">Sponsor: @{profile.sponsorName} (permanent)</p>
            ) : null}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px] text-slate-600" title={showcaseUrl(profile.slug)}>
            {showcaseUrl(profile.slug)}
          </code>
          <CopyButton text={showcaseUrl(profile.slug)} label="Copy showcase link" />
          <Button type="button" variant="outline" className="min-h-[44px] gap-1.5" onClick={() => ctx.nav({ name: "aff-showcase", slug: profile.slug })}>
            <Eye className="h-4 w-4" aria-hidden /> Preview page
          </Button>
        </div>
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          This is your public affiliate recommendation page — visitors see it as a curated suggestion list, clearly
          framed as “not a store”. Only published collections appear on it.
        </p>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          Display name, bio and page address are set at activation; the platform does not currently expose profile
          editing after activation — contact support for corrections.
        </p>
      </SectionCard>

      <SectionCard title="Referral join link">
        <p className="pb-2 text-[11px] leading-snug text-muted-foreground">
          When someone signs up through this link, they become your direct referral — you earn 10% of their commission
          pool on eligible sales (subject to the platform sponsor switch).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px] text-slate-600" title={referralJoinUrl(profile.code)}>
            {referralJoinUrl(profile.code)}
          </code>
          <CopyButton text={referralJoinUrl(profile.code)} label="Copy join link" />
        </div>
      </SectionCard>

      <SectionCard title={`Published collections (${published.length})`}>
        {err ? (
          <TabError message={err} onRetry={() => void load()} />
        ) : collections === null ? (
          <TabSkeleton rows={1} />
        ) : published.length === 0 ? (
          <EmptyState icon={Share2} title="Nothing published yet" hint="Publish a collection to feature it on your public showcase page." />
        ) : (
          <ul className="space-y-2">
            {published.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-background/60 p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-bold">{c.title}</p>
                  <p className="truncate text-[11px] text-muted-foreground tabular-nums">
                    {c.items.length} item{c.items.length === 1 ? "" : "s"} · /?affc={c.slug}
                  </p>
                </div>
                <CopyButton text={collectionUrl(c.slug)} label="Copy" />
                <Button type="button" variant="outline" size="sm" className="min-h-[36px] gap-1 text-[11px]" onClick={() => ctx.nav({ name: "aff-collection", slug: c.slug })}>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Preview
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

// ============================================================================
// NETWORK TAB (strictly one level)
// ============================================================================

export function NetworkTab({ settings, joinCode }: { settings: AffiliateSettingsT; joinCode: string }) {
  const [page, setPage] = useState(1);
  const [net, setNet] = useState<NetworkResT | null>(null);
  const [ovw, setOvw] = useState<HubOverviewT["network"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setErr(null);
    try {
      const [n, o] = await Promise.all([
        affGet<NetworkResT>(`/api/affiliate/network?page=${p}`),
        affGet<HubOverviewT>("/api/affiliate/overview?days=90"),
      ]);
      setNet(n);
      setOvw(o.network);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load your network");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page);
  }, [page, load]);

  if (err) return <TabError message={err} onRetry={() => void load(page)} />;
  if (loading || !net) return <TabSkeleton />;

  const joinUrl = referralJoinUrl(joinCode);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Direct referrals" value={(net.total ?? 0).toLocaleString()} hint="People who joined via your link" tone="brand" />
        <StatCard label="Activated affiliates" value={(ovw?.activatedAffiliates ?? 0).toLocaleString()} hint="Currently active" />
        <StatCard label="With sales" value={(ovw?.affiliatesWithSales ?? 0).toLocaleString()} hint="Generated eligible sales" />
        <StatCard
          label="Sponsor earnings"
          value={money(net.sponsorEarningsMinor)}
          hint={settings.sponsorEnabled ? "10% of their commission pools" : "Sponsor override disabled"}
        />
      </div>
      {!settings.sponsorEnabled && net.sponsorEarningsMinor === 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-600">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          The sponsor override is disabled platform-wide, so referral sponsorship is not generating earnings right now.
          Your referrals still count — historical sponsor entries (if any) are shown above; nothing is estimated.
        </p>
      ) : null}

      <SectionCard title="Direct referrals" badge={<Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10px] font-semibold text-teal-800">One level only</Badge>}>
        {net.total === 0 ? (
          <EmptyState
            icon={Users}
            title="No referrals yet"
            hint="Share your join link — when someone activates through it, they appear here (display name only, never private details)."
            action={<CopyButton text={joinUrl} label="Copy join link" className="h-10 min-h-[44px] px-3" />}
          />
        ) : (
          <>
            <ul className="divide-y">
              {net.referrals.map((r, i) => (
                <li key={`${r.slug}-${i}`} className="flex flex-wrap items-center gap-2 py-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-50 text-sm font-extrabold text-teal-800" aria-hidden>
                    {(r.displayName || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{r.displayName}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      @{r.slug} · joined {dateShort(r.activatedAt)}
                    </p>
                  </div>
                  <StatusChip status={r.status} />
                  {r.generatedSales ? (
                    <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] font-semibold text-emerald-800">
                      Has sales
                    </Badge>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">No sales yet</span>
                  )}
                </li>
              ))}
            </ul>
            <Pager
              page={net.page}
              size={20}
              total={net.total}
              rowCount={net.referrals.length}
              onPrev={() => setPage((p) => Math.max(1, p - 1))}
              onNext={() => setPage((p) => p + 1)}
            />
          </>
        )}
      </SectionCard>

      <p className="text-[11px] leading-snug text-muted-foreground">
        Privacy by design: this list shows display names only — never emails, phone numbers, addresses or payout data —
        and never a second generation. There is no downline tree.
      </p>
    </div>
  );
}

// ============================================================================
// EARNINGS TAB
// ============================================================================

const EARNING_STATUSES = ["pending", "approved", "available", "paid", "reversed", "held"] as const;

export function EarningsTab({ settings }: { settings: AffiliateSettingsT }) {
  const [role, setRole] = useState<"direct" | "sponsor">("direct");
  const [status, setStatus] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<EarningsResT | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const sp = new URLSearchParams({ role, page: String(page) });
      if (status !== "all") sp.set("status", status);
      setData(await affGet<EarningsResT>(`/api/affiliate/earnings?${sp.toString()}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load your earnings");
    } finally {
      setLoading(false);
    }
  }, [role, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset page when the role/status filter changes.
  useEffect(() => {
    setPage(1);
  }, [role, status]);

  if (err) return <TabError message={err} onRetry={() => void load()} />;

  const rows = data?.rows ?? [];
  const b = data?.balances;
  const sponsorDisabledNote = role === "sponsor" && settings.sponsorEnabled === false && (data?.total ?? 0) === 0;

  return (
    <div className="space-y-4">
      {/* segmented role control */}
      <div className="flex rounded-full border border-slate-200/70 bg-slate-100/80 p-1" role="tablist" aria-label="Earnings role">
        {(
          [
            { key: "direct", label: "Personal promotion (90%)" },
            { key: "sponsor", label: "Sponsor (10%)" },
          ] as const
        ).map((r) => (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={role === r.key}
            onClick={() => setRole(r.key)}
            className={cn(
              "min-h-[44px] flex-1 rounded-full px-3 text-xs font-bold transition-colors sm:text-[13px]",
              role === r.key ? "bg-brand-gradient text-white shadow-glow-cyan-sm" : "text-slate-500 hover:text-slate-800"
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* authoritative balance summary */}
      {b ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Requestable" value={money(b.requestableMinor)} tone="brand" />
          <StatCard label="Available" value={money(b.availableMinor)} />
          <StatCard label="Pending" value={money(b.pendingMinor)} tone="warn" />
          <StatCard label="Approved" value={money(b.approvedMinor)} />
          <StatCard label="Paid out" value={money(b.paidMinor)} />
          <StatCard label="Reversed" value={money(b.reversedMinor)} tone={b.reversedMinor > 0 ? "danger" : "default"} />
        </div>
      ) : null}

      {sponsorDisabledNote ? (
        <SectionCard title="Sponsor earnings">
          <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            <div>
              <p className="text-xs font-bold text-slate-700">Sponsor override disabled</p>
              <p className="pt-1 text-[11px] leading-snug text-slate-600">
                The 10% sponsor share is switched off platform-wide, so no sponsor earnings are being generated. If you
                ever had sponsor entries while it was enabled, filter by status above to see them — this space never
                shows estimated or placeholder figures.
              </p>
            </div>
          </div>
        </SectionCard>
      ) : (
        <SectionCard
          title={role === "direct" ? "Personal promotion entries" : "Sponsor entries"}
          badge={<span className="text-[11px] text-muted-foreground tabular-nums">{(data?.total ?? 0).toLocaleString()} total</span>}
          action={
            <div className="flex max-w-full gap-1 overflow-x-auto pb-1" role="group" aria-label="Status filter">
              {(["all", ...EARNING_STATUSES] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  aria-pressed={status === s}
                  className={cn(
                    "min-h-[36px] shrink-0 rounded-full border px-2.5 text-[11px] font-bold capitalize transition-colors",
                    status === s ? "border-teal-700 bg-teal-700 text-white" : "border-border bg-card text-muted-foreground hover:bg-muted"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          }
        >
          {loading ? (
            <TabSkeleton rows={1} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No commission entries here"
              hint={
                role === "direct"
                  ? "When someone buys through your links, each eligible order item posts a commission entry here."
                  : "Sponsor entries appear when a referral of yours generates eligible sales."
              }
            />
          ) : (
            <>
              {/* desktop header */}
              <div className="hidden grid-cols-[1.2fr_1fr_0.6fr_0.9fr_0.9fr_1fr_0.8fr] gap-2 border-b pb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground lg:grid">
                <span>Order</span>
                <span>Date</span>
                <span>Rate</span>
                <span>Base</span>
                <span>Pool</span>
                <span>Your amount</span>
                <span>Status</span>
              </div>
              <ul className="divide-y">
                {rows.map((r) => (
                  <li key={r.id} className="grid gap-1 py-2.5 lg:grid-cols-[1.2fr_1fr_0.6fr_0.9fr_0.9fr_1fr_0.8fr] lg:items-center lg:gap-2">
                    <span className="text-xs font-bold text-slate-900">{r.orderNumber}</span>
                    <span className="text-[11px] text-muted-foreground">{dateShort(r.createdAt)}</span>
                    <span className="text-[11px] tabular-nums">{ratePercent(r.rateBps)}</span>
                    <span className="text-[11px] tabular-nums">{money(r.baseMinor)}</span>
                    <span className="text-[11px] tabular-nums">{money(r.poolMinor)}</span>
                    <span className="text-xs font-extrabold text-teal-800 tabular-nums">
                      {money(r.amountMinor)}
                      {r.reversedMinor > 0 ? <span className="ml-1 text-[10px] font-semibold text-rose-700">−{money(r.reversedMinor)} reversed</span> : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-1">
                      <StatusChip status={r.status} />
                      {r.holdReason ? <span className="text-[10px] text-amber-700">({r.holdReason})</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
              <Pager
                page={data?.page ?? page}
                size={20}
                total={data?.total ?? 0}
                rowCount={rows.length}
                onPrev={() => setPage((p) => Math.max(1, p - 1))}
                onNext={() => setPage((p) => p + 1)}
              />
            </>
          )}
          <p className="pt-3 text-[11px] leading-snug text-muted-foreground">
            Entries start <strong>pending</strong> while the order settles, become <strong>approved</strong>, then
            mature to <strong>available</strong> after the {settings.reviewDays}-day review window. <strong>Reversed</strong>{" "}
            entries were clawed back by refunds; late refunds after a payout book against future earnings (recovery).
          </p>
        </SectionCard>
      )}
    </div>
  );
}

// ============================================================================
// PAYOUTS TAB
// ============================================================================

export function PayoutsTab() {
  const [data, setData] = useState<PayoutsResT | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await affGet<PayoutsResT>("/api/affiliate/payouts"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load payouts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const request = async () => {
    setBusy(true);
    try {
      const r = await affPost<{ payoutId: string; amountMinor: number }>("/api/affiliate/payouts", {});
      toast.success(`Payout of ${money(r.amountMinor)} requested`, { description: "Finance reviews and executes transfers manually — you'll see the status here." });
      await load();
    } catch (e) {
      // Surface the server's message verbatim (BELOW_MIN_PAYOUT, PAYOUT_OPEN, …)
      toast.error(e instanceof Error ? e.message : "Payout request failed");
    } finally {
      setBusy(false);
    }
  };

  if (err) return <TabError message={err} onRetry={() => void load()} />;
  if (loading || !data) return <TabSkeleton />;

  const b = data.balances;
  const canRequest = b.requestableMinor >= data.minPayoutMinor && b.requestableMinor > 0;

  return (
    <div className="space-y-4">
      <SectionCard title="Balances" badge={<Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10px] font-semibold text-teal-800">Ledger-authoritative</Badge>}>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Requestable now" value={money(b.requestableMinor)} hint="Matured, unclaimed" tone="brand" />
            <StatCard label="Payout in flight" value={money(b.payoutInFlightMinor)} hint="Claimed by open requests" />
            <StatCard label="Pending + approved" value={money(b.pendingMinor + b.approvedMinor)} hint="Maturing" tone="warn" />
            <StatCard label="Paid out" value={money(b.paidMinor)} hint="Lifetime settled" />
            <StatCard label="Held" value={money(b.heldMinor)} hint="Under review" />
            <StatCard label="Recovery" value={money(b.recoveryMinor)} hint="Late refunds after payout" tone={b.recoveryMinor > 0 ? "danger" : "default"} />
            <StatCard label="Reversed" value={money(b.reversedMinor)} hint="Refund clawbacks" tone={b.reversedMinor > 0 ? "danger" : "default"} />
          </div>
          <div className="flex flex-col items-stretch gap-2 sm:w-56">
            <p className="text-center text-[11px] text-muted-foreground">
              Minimum payout: <strong className="text-slate-800 tabular-nums">{money(data.minPayoutMinor)}</strong>
            </p>
            <Button
              type="button"
              disabled={!canRequest || busy}
              onClick={() => void request()}
              className="min-h-[44px] bg-brand-gradient text-white shadow-glow-cyan-sm"
            >
              {busy ? "Requesting…" : "Request payout"}
            </Button>
            <p className="text-center text-[11px] leading-snug text-muted-foreground">
              {canRequest
                ? b.payoutInFlightMinor > 0
                  ? "You already have a payout in progress — the platform allows one open request at a time."
                  : "A manual, finance-reviewed transfer — no automated bank transfer is claimed."
                : `You need at least ${money(data.minPayoutMinor)} requestable to withdraw (currently ${money(b.requestableMinor)}).`}
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Payout history">
        {data.payouts.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No payouts yet"
            hint="When your requestable balance reaches the minimum, request a withdrawal here and track its status."
          />
        ) : (
          <ul className="divide-y">
            {data.payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-extrabold text-slate-900 tabular-nums">{money(p.amountMinor)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Requested {dateTimeShort(p.requestedAt)}
                    {p.processedAt ? ` · processed ${dateTimeShort(p.processedAt)}` : ""}
                    {p.method ? ` · ${p.method}` : ""}
                  </p>
                  {p.reference ? <p className="truncate text-[11px] text-slate-600">Reference: {p.reference}</p> : null}
                  {p.failReason ? <p className="text-[11px] font-medium text-rose-700">Reason: {p.failReason}</p> : null}
                  {p.note ? <p className="truncate text-[11px] text-muted-foreground">{p.note}</p> : null}
                </div>
                <StatusChip status={p.status} />
              </li>
            ))}
          </ul>
        )}
        <p className="pt-3 text-[11px] leading-snug text-muted-foreground">
          Status flow: requested → processing → paid, or failed/rejected with the reason shown. Payout history is never
          rewritten — late refunds after a payout appear as recovery instead.
        </p>
      </SectionCard>
    </div>
  );
}

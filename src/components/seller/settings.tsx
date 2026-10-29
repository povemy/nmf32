"use client";
// Task 2-d — SD-12 Store Settings: identity form, marketplace opt-in, social
// links, storefront link, policies shortcut to the Page Builder.
// nav-reorg — custom domains (SD-09) live here as the “Domains” tab,
// controlled through SellerNav.settingsTab.
import { useEffect, useState } from "react";
import { apiSend, CopyButton, fmtCommissionPercent, runMutation, StatusChip, useSellerTerms, type SellerNav, type SettingsTab, type StoreMe } from "./ui-bits";
import SellerDomains from "./domains";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ExternalLink, Globe, LayoutTemplate, Loader2, Megaphone, Save, Settings2, ShieldQuestion } from "lucide-react";
import { useApp } from "@/lib/app-store";

type IdentityForm = {
  name: string;
  tagline: string;
  description: string;
  supportEmail: string;
  supportPhone: string;
  whatsapp: string;
  instagram: string;
  facebook: string;
  tiktok: string;
};

export default function SellerSettings({
  storeMe,
  refreshStoreMe,
  onNavigate,
  settingsTab,
  storeSlug,
}: {
  storeMe: StoreMe | null;
  refreshStoreMe: () => Promise<void>;
  onNavigate: (n: SellerNav) => void;
  settingsTab?: SettingsTab;
  storeSlug: string;
}) {
  // nav-reorg — Domains is a tab of Store Settings. Tab state is controlled
  // through SellerNav (never local) so future deep links (e.g. a “connect your
  // domain” onboarding step) can land here directly.
  if (!storeMe) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <Tabs value={settingsTab ?? "general"} onValueChange={(v) => onNavigate({ view: "settings", settingsTab: v as SettingsTab })}>
      <TabsList className="mb-4">
        <TabsTrigger value="general" className="min-h-[44px] gap-1.5">
          <Settings2 className="h-3.5 w-3.5" aria-hidden /> General
        </TabsTrigger>
        <TabsTrigger value="domains" className="min-h-[44px] gap-1.5">
          <Globe className="h-3.5 w-3.5" aria-hidden /> Domains
        </TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="mt-0">
        <GeneralSettings storeMe={storeMe} refreshStoreMe={refreshStoreMe} onNavigate={onNavigate} />
      </TabsContent>
      <TabsContent value="domains" className="mt-0">
        <SellerDomains storeSlug={storeSlug} />
      </TabsContent>
    </Tabs>
  );
}

function GeneralSettings({
  storeMe,
  refreshStoreMe,
  onNavigate,
}: {
  storeMe: StoreMe;
  refreshStoreMe: () => Promise<void>;
  onNavigate: (n: SellerNav) => void;
}) {
  const [form, setForm] = useState<IdentityForm>({
    name: "",
    tagline: "",
    description: "",
    supportEmail: "",
    supportPhone: "",
    whatsapp: "",
    instagram: "",
    facebook: "",
    tiktok: "",
  });
  const [optIn, setOptIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [policyPageId, setPolicyPageId] = useState<string | null>(null);
  // ADDENDUM #8 — live commission % for the marketplace opt-in copy (was "8%").
  const { terms } = useSellerTerms();
  const setSurface = useApp((s) => s.setSurface);
  const setActiveStoreSlug = useApp((s) => s.setActiveStoreSlug);

  // hydrate once store data arrives (social links are not exposed by /api/store/me,
  // so those three inputs start empty and are only sent when non-blank)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setForm({
      name: storeMe.store.name ?? "",
      tagline: storeMe.store.tagline ?? "",
      description: storeMe.store.description ?? "",
      supportEmail: storeMe.store.supportEmail ?? "",
      supportPhone: storeMe.store.supportPhone ?? "",
      whatsapp: storeMe.store.whatsapp ?? "",
      instagram: "",
      facebook: "",
      tiktok: "",
    });
    setOptIn(storeMe.store.marketplaceOptIn);
  }, [storeMe]);

  // policies page lookup (for the “Edit in builder” shortcut)
  useEffect(() => {
    fetch("/api/store/pages", { cache: "no-store" })
      .then((r) => r.json())
      .then((body) => {
        const pages = body?.data as { id: string; pageType: string }[] | undefined;
        const policy = pages?.find((p) => p.pageType === "policy" || p.pageType === "policies");
        setPolicyPageId(policy?.id ?? null);
      })
      .catch(() => {});
  }, []);

  const set = (patch: Partial<IdentityForm>) => setForm((prev) => ({ ...prev, ...patch }));

  const saveIdentity = async () => {
    if (!form.name.trim()) return runMutation(() => Promise.reject(new Error("Store name cannot be empty")), "");
    setBusy(true);
    const ok = await runMutation(
      () => {
        const payload: Record<string, unknown> = {
          name: form.name.trim(),
          tagline: form.tagline,
          description: form.description,
          supportEmail: form.supportEmail,
          supportPhone: form.supportPhone,
          whatsapp: form.whatsapp,
        };
        const social: Record<string, string> = {};
        if (form.instagram.trim()) social.instagram = form.instagram.trim();
        if (form.facebook.trim()) social.facebook = form.facebook.trim();
        if (form.tiktok.trim()) social.tiktok = form.tiktok.trim();
        if (Object.keys(social).length > 0) payload.social = social;
        return apiSend("PATCH", "/api/store/settings", payload);
      },
      "Store identity saved"
    );
    setBusy(false);
    if (ok) await refreshStoreMe();
  };

  const saveOptIn = async (next: boolean) => {
    setOptIn(next);
    const ok = await runMutation(
      () => apiSend("PATCH", "/api/store/settings", { marketplaceOptIn: next }),
      next ? "Store listed on the NOMOFEE marketplace" : "Store removed from marketplace listings"
    );
    if (!ok) setOptIn(!next);
  };

  const storefrontUrl = `/${storeMe.store.slug}`;

  return (
    <div className="space-y-6">
      {/* storefront card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <ExternalLink className="h-4 w-4 text-primary" /> Storefront
            <StatusChip status={storeMe.store.status} />
            <span className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => {
                  setActiveStoreSlug(storeMe.store.slug);
                  setSurface("shopper");
                }}
              >
                Open
              </Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          <code className="rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs">{storefrontUrl}</code>
          <CopyButton text={storefrontUrl} label="Copy link" />
          <span className="text-xs text-muted-foreground">Share this with customers — custom domains live in the Domains tab.</span>
        </CardContent>
      </Card>

      {/* identity */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><Settings2 className="h-4 w-4 text-primary" /> Store identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="st-name">Store name *</Label>
              <Input id="st-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-tag">Tagline</Label>
              <Input id="st-tag" value={form.tagline} onChange={(e) => set({ tagline: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-desc">Description</Label>
            <Textarea id="st-desc" rows={3} value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div className="grid gap-3.5 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="st-email">Support email</Label>
              <Input id="st-email" type="email" value={form.supportEmail} onChange={(e) => set({ supportEmail: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-phone">Support phone</Label>
              <Input id="st-phone" value={form.supportPhone} onChange={(e) => set({ supportPhone: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-wa">WhatsApp (intl, no +)</Label>
              <Input id="st-wa" value={form.whatsapp} onChange={(e) => set({ whatsapp: e.target.value })} placeholder="60123456789" />
            </div>
          </div>
          <div className="grid gap-3.5 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="st-ig">Instagram URL</Label>
              <Input id="st-ig" value={form.instagram} onChange={(e) => set({ instagram: e.target.value })} placeholder="https://instagram.com/…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-fb">Facebook URL</Label>
              <Input id="st-fb" value={form.facebook} onChange={(e) => set({ facebook: e.target.value })} placeholder="https://facebook.com/…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-tt">TikTok URL</Label>
              <Input id="st-tt" value={form.tiktok} onChange={(e) => set({ tiktok: e.target.value })} placeholder="https://tiktok.com/@…" />
            </div>
          </div>
          <div className="flex items-center justify-end">
            <Button onClick={saveIdentity} disabled={busy} className="min-h-[44px] gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save changes
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Logo, banner and theme live in the <button className="font-medium text-primary underline" onClick={() => onNavigate({ view: "builder" })}>Page Builder</button>.
          </p>
        </CardContent>
      </Card>

      {/* marketplace opt-in */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><Megaphone className="h-4 w-4 text-primary" /> Marketplace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
            <div>
              <p className="text-sm font-medium">List products on the NOMOFEE marketplace</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                When on, your active products can appear in marketplace search and collections — free discovery,
                same {terms ? fmtCommissionPercent(terms.commissionPercent) : "platform"} commission. Your storefront stays live either way. Approval of your store is still
                required before listings go out.
              </p>
            </div>
            <Switch checked={optIn} onCheckedChange={saveOptIn} aria-label="Marketplace opt-in" />
          </div>
        </CardContent>
      </Card>

      {/* policies */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><ShieldQuestion className="h-4 w-4 text-primary" /> Store policies</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Shipping, returns and privacy policies live on the “Policies” page — edit its rich text sections in the builder.
          </p>
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => (policyPageId ? onNavigate({ view: "builder", pageId: policyPageId }) : onNavigate({ view: "builder" }))}
          >
            <LayoutTemplate className="h-4 w-4" /> Edit in builder
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

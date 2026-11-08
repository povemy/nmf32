"use client";
// Task 2-d — SEL-ONB onboarding wizard: 1 Store identity → 2 KYC documents →
// 3 Bank account → 4 Review & submit. Data persists via /api/store/* endpoints.
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { motion } from "framer-motion";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { apiGet, apiSend, runMutation, StatusChip, useSellerTerms, type BankAccount, type StoreMe } from "./ui-bits";
import type {
  BankAccountBody,
  BankAccountPublic,
  OnboardingBody,
  OnboardingData,
  SellerSettingsBody,
  SellerSettingsData,
  ThemeBody,
  ThemeData,
} from "@/lib/types/api-contract";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  BadgeCheck,
  Building2,
  Check,
  ClipboardCheck,
  FileCheck2,
  Loader2,
  Paintbrush,
  Send,
  Store,
  Upload,
  X,
} from "lucide-react";

const BANKS = ["Maybank", "CIMB", "Public Bank", "Bank Rakyat", "Hong Leong"];
const TEMPLATES = [
  { key: "aurora", label: "Aurora", color: "#0f766e", hint: "Calm teal — best for home & living" },
  { key: "sunset", label: "Sunset", color: "#c2410c", hint: "Warm orange — food, crafts, apparel" },
  { key: "rose", label: "Rose", color: "#9f1239", hint: "Deep rose — beauty & boutique" },
];

const DOC_TYPES = [
  { key: "ic_front", label: "IC / Passport (front)", hint: "Photo of your national ID" },
  { key: "ic_selfie", label: "Selfie with IC", hint: "Holding your ID next to your face" },
  { key: "business_reg", label: "Business registration", hint: "SSM cert — skip if sole trader below threshold" },
];

const STEP_LABELS = ["Store identity", "KYC documents", "Bank account", "Review & submit"];

export default function OnboardingWizard({ onStatusChanged }: { onStatusChanged: () => Promise<void> }) {
  const me = useApp((s) => s.me);
  const seller = me.loaded && "seller" in me ? me.seller : null;

  const [storeMe, setStoreMe] = useState<StoreMe | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  // step 1 state
  const [identity, setIdentity] = useState({ name: "", tagline: "", description: "", whatsapp: "", logoUrl: "" });
  const [primaryColor, setPrimaryColor] = useState(TEMPLATES[0].color);

  // step 2 state (simulated uploads — names only, gated client-side)
  const [docs, setDocs] = useState<Record<string, string>>({});
  const [docInput, setDocInput] = useState<Record<string, string>>({});

  // step 3 state
  const [bank, setBank] = useState({ holderName: "", bankName: "", accountNumber: "" });
  const [accounts, setAccounts] = useState<BankAccount[]>([]);

  const refresh = useCallback(async () => {
    try {
      const d = await apiGet<StoreMe>("/api/store/me");
      setStoreMe(d);
      setAccounts(await apiGet<BankAccountPublic[]>("/api/store/bank-accounts").catch(() => []));
      return d;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    refresh().then((d) => {
      if (!d) return;
      setIdentity({
        name: d.store.name ?? "",
        tagline: d.store.tagline ?? "",
        description: d.store.description ?? "",
        whatsapp: d.store.whatsapp ?? "",
        logoUrl: d.store.logoUrl ?? "",
      });
      const themeColor = TEMPLATES.find((t) => t.color === parseThemeColor(d.store.theme))?.color ?? TEMPLATES[0].color;
      setPrimaryColor(themeColor);
    });
  }, [refresh]);

  const docsComplete = DOC_TYPES.every((d) => docs[d.key]);
  const bankComplete = accounts.length > 0;
  const identityComplete = !!(identity.name.trim() && identity.tagline.trim());
  const stepDone = [identityComplete, docsComplete, bankComplete, false];

  const canNext = [identityComplete, docsComplete, bankComplete, true][step];

  const saveIdentity = async () => {
    setBusy(true);
    const ok = await runMutation(async () => {
      const slugSeed = identity.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "logo";
      const logoUrl = identity.logoUrl || `/api/img/${slugSeed}-logo?w=200&h=200&label=${encodeURIComponent(identity.name.trim())}`;
      await apiSend<SellerSettingsData>("PATCH", "/api/store/settings", {
        name: identity.name.trim(),
        tagline: identity.tagline.trim(),
        description: identity.description,
        whatsapp: identity.whatsapp,
        logoUrl,
      } satisfies SellerSettingsBody);
      await apiSend<ThemeData>("PUT", "/api/store/theme", { theme: { primaryColor } } satisfies ThemeBody);
    }, "Store identity saved");
    setBusy(false);
    return ok;
  };

  const addBank = async () => {
    if (!bank.holderName.trim() || !bank.bankName || bank.accountNumber.replace(/\s+/g, "").length < 4) {
      // rely on per-field hints; simple guard
      return runMutation(() => Promise.reject(new Error("Fill holder name, bank and account number (min 4 digits)")), "");
    }
    return runMutation(async () => {
      await apiSend<BankAccountPublic>("POST", "/api/store/bank-accounts", bank satisfies BankAccountBody);
      setAccounts(await apiGet<BankAccountPublic[]>("/api/store/bank-accounts"));
      setBank({ holderName: "", bankName: "", accountNumber: "" });
    }, "Bank account added — admin will verify it");
  };

  const submitForReview = async () => {
    setBusy(true);
    const ok = await runMutation(
      () => apiSend<OnboardingData>("POST", "/api/store/onboarding", { action: "submit" } satisfies OnboardingBody),
      "Submitted! Our team will review your store shortly."
    );
    setBusy(false);
    if (ok) {
      await refresh();
      await onStatusChanged(); // seller.status flips to pending_review → shell re-routes
    }
  };

  const gotoStep = async (next: number) => {
    if (next > step && step === 0) {
      const ok = await saveIdentity();
      if (!ok) return;
      await refresh();
    }
    setStep(Math.max(0, Math.min(3, next)));
  };

  const progress = useMemo(() => Math.round(((step + 1) / 4) * 100), [step]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-muted/30">
      <div className="mx-auto w-full max-w-4xl p-4 sm:p-8">
        {/* header */}
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Store className="h-4.5 w-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-bold leading-tight">Set up your store</h1>
            <p className="text-xs text-muted-foreground">
              {seller?.storeName ?? "Your store"} · 4 quick steps, data saves as you go
            </p>
          </div>
        </div>

        {storeMe?.seller.status === "rejected" && storeMe.seller.rejectReason ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>
              <span className="font-semibold">Your previous submission was rejected: </span>
              {storeMe.seller.rejectReason} — update the details below and submit again.
            </AlertDescription>
          </Alert>
        ) : null}

        {/* progress */}
        <div className="mt-5 space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Step {step + 1} of 4 — {STEP_LABELS[step]}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[220px_1fr]">
          {/* step rail */}
          <ol className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {STEP_LABELS.map((label, i) => (
              <li key={label} className="shrink-0 lg:shrink">
                <button
                  onClick={() => i < step && setStep(i)}
                  disabled={i > step}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors",
                    i === step && "border-primary bg-primary/5 text-primary font-medium",
                    i < step && "border-border bg-card text-foreground hover:bg-muted",
                    i > step && "border-border/60 bg-card/50 text-muted-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      i < step ? "bg-emerald-100 text-emerald-700" : i === step ? "bg-primary text-primary-foreground" : "bg-muted"
                    )}
                  >
                    {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
                  </span>
                  <span className="whitespace-nowrap lg:whitespace-normal">{label}</span>
                </button>
              </li>
            ))}
          </ol>

          {/* step panels */}
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.18 }}
            className="min-w-0"
          >
            {step === 0 && (
              <IdentityStep
                identity={identity}
                setIdentity={setIdentity}
                primaryColor={primaryColor}
                setPrimaryColor={setPrimaryColor}
                busy={busy}
              />
            )}
            {step === 1 && (
              <KycStep docs={docs} setDocs={setDocs} docInput={docInput} setDocInput={setDocInput} />
            )}
            {step === 2 && (
              <BankStep bank={bank} setBank={setBank} accounts={accounts} onAdd={addBank} busy={busy} />
            )}
            {step === 3 && (
              <ReviewStep
                storeMe={storeMe}
                identity={identity}
                primaryColor={primaryColor}
                docs={docs}
                accounts={accounts}
                identityComplete={identityComplete}
                busy={busy}
                onSubmit={submitForReview}
              />
            )}

            {/* footer nav */}
            <div className="mt-5 flex items-center justify-between gap-3">
              <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={step === 0 || busy}>
                Back
              </Button>
              {step < 3 ? (
                <Button
                  onClick={() => gotoStep(step + 1)}
                  disabled={!canNext || busy}
                  className="min-h-[44px] gap-2"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {step === 0 ? "Save & continue" : "Continue"}
                </Button>
              ) : (
                <Button onClick={submitForReview} disabled={busy || !identityComplete} className="min-h-[44px] gap-2">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Submit for review
                </Button>
              )}
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

function parseThemeColor(themeJson: string | undefined): string | null {
  try {
    const t = themeJson ? JSON.parse(themeJson) : {};
    return typeof t.primaryColor === "string" ? t.primaryColor : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- step 1

function IdentityStep({
  identity,
  setIdentity,
  primaryColor,
  setPrimaryColor,
  busy,
}: {
  identity: { name: string; tagline: string; description: string; whatsapp: string; logoUrl: string };
  setIdentity: Dispatch<SetStateAction<{ name: string; tagline: string; description: string; whatsapp: string; logoUrl: string }>>;
  primaryColor: string;
  setPrimaryColor: (c: string) => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4 rounded-2xl border bg-card p-5">
      <div>
        <h2 className="font-semibold">Store identity</h2>
        <p className="text-xs text-muted-foreground">This is what shoppers see on your storefront.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="onb-name">Store name *</Label>
          <Input id="onb-name" value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} placeholder="Lumina Living" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="onb-wa">WhatsApp number</Label>
          <Input id="onb-wa" value={identity.whatsapp} onChange={(e) => setIdentity({ ...identity, whatsapp: e.target.value })} placeholder="60123456789" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="onb-tag">Tagline *</Label>
        <Input id="onb-tag" value={identity.tagline} onChange={(e) => setIdentity({ ...identity, tagline: e.target.value })} placeholder="Calm, functional objects for better days." />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="onb-desc">Description</Label>
        <Textarea id="onb-desc" rows={3} value={identity.description} onChange={(e) => setIdentity({ ...identity, description: e.target.value })} placeholder="Tell shoppers what you sell and where you ship from…" />
      </div>

      {/* logo preview */}
      <div className="flex items-center gap-3 rounded-xl border border-dashed p-3">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg text-primary-foreground"
          style={{ backgroundColor: primaryColor }}
        >
          {identity.name ? (
            <img src={`/api/img/${encodeURIComponent(identity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}-logo?w=96&h=96&label=Logo`} alt="Store logo preview" className="h-full w-full object-cover" />
          ) : (
            <Paintbrush className="h-5 w-5" />
          )}
        </span>
        <div className="text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Logo is auto-generated</p>
          <p>A placeholder logo is created from your store name — you can change it anytime in Settings.</p>
        </div>
      </div>

      {/* template picker */}
      <div className="space-y-2">
        <Label>Pick a look (template)</Label>
        <div className="grid gap-3 sm:grid-cols-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setPrimaryColor(t.color)}
              className={cn(
                "rounded-xl border p-3 text-left transition-all",
                primaryColor === t.color ? "border-primary ring-2 ring-primary/30" : "hover:border-muted-foreground/40"
              )}
            >
              <span className="block h-10 w-full rounded-lg" style={{ backgroundColor: t.color }} />
              <span className="mt-2 block text-sm font-medium">{t.label}</span>
              <span className="block text-xs text-muted-foreground">{t.hint}</span>
              {primaryColor === t.color ? (
                <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary">
                  <BadgeCheck className="h-3.5 w-3.5" /> Selected
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Saved as your theme primary color — customize everything later in the Page Builder.</p>
      </div>
      {busy ? <p className="text-xs text-muted-foreground">Saving…</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- step 2

function KycStep({
  docs,
  setDocs,
  docInput,
  setDocInput,
}: {
  docs: Record<string, string>;
  setDocs: Dispatch<SetStateAction<Record<string, string>>>;
  docInput: Record<string, string>;
  setDocInput: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  return (
    <div className="space-y-4 rounded-2xl border bg-card p-5">
      <div>
        <h2 className="font-semibold">KYC documents</h2>
        <p className="text-xs text-muted-foreground">
          Simulated upload for this demo — type a file name and attach it. Our team reviews these documents
          during the approval step; nothing is uploaded anywhere.
        </p>
      </div>
      <div className="space-y-3">
        {DOC_TYPES.map((d) => (
          <div key={d.key} className="rounded-xl border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{d.label}</p>
                <p className="text-xs text-muted-foreground">{d.hint}</p>
              </div>
              {docs[d.key] ? <StatusChip status="approved" /> : <StatusChip status="pending" />}
            </div>
            {docs[d.key] ? (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs">
                <FileCheck2 className="h-3.5 w-3.5 text-emerald-600" />
                <span className="truncate">{docs[d.key]}</span>
                <button
                  aria-label={`Remove ${d.label}`}
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  onClick={() => setDocs((prev) => ({ ...prev, [d.key]: "" }))}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <Input
                  placeholder="e.g. my-ic-front.jpg"
                  value={docInput[d.key] ?? ""}
                  onChange={(e) => setDocInput((prev) => ({ ...prev, [d.key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (docInput[d.key] ?? "").trim()) {
                      setDocs((prev) => ({ ...prev, [d.key]: (docInput[d.key] ?? "").trim() }));
                    }
                  }}
                  className="h-9 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 gap-1.5"
                  disabled={!(docInput[d.key] ?? "").trim()}
                  onClick={() => setDocs((prev) => ({ ...prev, [d.key]: (docInput[d.key] ?? "").trim() }))}
                >
                  <Upload className="h-3.5 w-3.5" /> Attach
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {DOC_TYPES.filter((d) => docs[d.key]).length} of 3 documents attached — all three are required to continue.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- step 3

function BankStep({
  bank,
  setBank,
  accounts,
  onAdd,
  busy,
}: {
  bank: { holderName: string; bankName: string; accountNumber: string };
  setBank: Dispatch<SetStateAction<{ holderName: string; bankName: string; accountNumber: string }>>;
  accounts: BankAccount[];
  onAdd: () => Promise<boolean>;
  busy: boolean;
}) {
  const digits = bank.accountNumber.replace(/\s+/g, "");
  const valid = !!(bank.holderName.trim() && bank.bankName && digits.length >= 4);
  // ADDENDUM #8 — live hold window (was hardcoded "7-day").
  const { terms } = useSellerTerms();
  return (
    <div className="space-y-4 rounded-2xl border bg-card p-5">
      <div>
        <h2 className="font-semibold">Bank account</h2>
        <p className="text-xs text-muted-foreground">
          {terms
            ? terms.holdDays > 0
              ? `Payouts are transferred here after the ${terms.holdDays}-day clearing hold.`
              : "Payouts are transferred here once orders are paid (no clearing hold)."
            : "Payouts are transferred here after the clearing hold."}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bank-holder">Account holder name *</Label>
          <Input id="bank-holder" value={bank.holderName} onChange={(e) => setBank({ ...bank, holderName: e.target.value })} placeholder="Lumina Living Sdn Bhd" />
        </div>
        <div className="space-y-1.5">
          <Label>Bank *</Label>
          <Select value={bank.bankName} onValueChange={(v) => setBank({ ...bank, bankName: v })}>
            <SelectTrigger aria-label="Bank name">
              <SelectValue placeholder="Select bank" />
            </SelectTrigger>
            <SelectContent>
              {BANKS.map((b) => (
                <SelectItem key={b} value={b}>{b}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="bank-acc">Account number *</Label>
        <Input id="bank-acc" inputMode="numeric" value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value.replace(/[^0-9\s]/g, "") })} placeholder="1622 3810 5543" />
        {bank.accountNumber && digits.length < 4 ? <p className="text-xs text-rose-600">At least 4 digits.</p> : null}
      </div>
      <Button type="button" variant="outline" onClick={onAdd} disabled={!valid || busy} className="gap-2 min-h-[44px]">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
        Add bank account
      </Button>

      {accounts.length > 0 ? (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3 py-2.5">
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium">{a.bankName} · {a.accountNumberMasked}</p>
                <p className="truncate text-xs text-muted-foreground">{a.holderName}</p>
              </div>
              {a.verified ? <StatusChip status="verified" /> : <StatusChip status="pending" />}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No account added yet — add one to continue.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- step 4

function ReviewStep({
  storeMe,
  identity,
  primaryColor,
  docs,
  accounts,
  identityComplete,
  busy,
  onSubmit,
}: {
  storeMe: StoreMe | null;
  identity: { name: string; tagline: string; description: string };
  primaryColor: string;
  docs: Record<string, string>;
  accounts: BankAccount[];
  identityComplete: boolean;
  busy: boolean;
  onSubmit: () => void;
}) {
  const checklist = [
    { label: "Store identity saved", done: identityComplete },
    { label: "KYC documents attached (3/3)", done: DOC_TYPES.every((d) => docs[d.key]) },
    { label: "Bank account added", done: accounts.length > 0 },
    { label: "Profile completed", done: storeMe?.onboarding.checklist.profile ?? false },
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-primary-foreground" style={{ backgroundColor: primaryColor }}>
            {(identity.name || "S").slice(0, 1).toUpperCase()}
          </span>
          <div>
            <p className="font-semibold">{identity.name || "Your store"}</p>
            <p className="text-xs text-muted-foreground">{identity.tagline || "No tagline yet"}</p>
          </div>
          <span className="ml-auto h-6 w-6 rounded-full" style={{ backgroundColor: primaryColor }} aria-hidden />
        </div>
        {identity.description ? <p className="mt-3 text-sm text-muted-foreground">{identity.description}</p> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border bg-card p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold"><FileCheck2 className="h-4 w-4 text-primary" /> KYC documents</p>
          <ul className="mt-2 space-y-1.5 text-xs">
            {DOC_TYPES.map((d) => (
              <li key={d.key} className="flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">{d.label}</span>
                {docs[d.key] ? <span className="truncate font-medium">{docs[d.key]}</span> : <span className="text-rose-600">missing</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border bg-card p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold"><Building2 className="h-4 w-4 text-primary" /> Bank account</p>
          {accounts.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-xs">
              {accounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{a.bankName} · {a.accountNumberMasked}</span>
                  {a.verified ? <StatusChip status="verified" /> : <StatusChip status="pending" />}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-rose-600">No bank account added — go back to step 3.</p>
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-4">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><ClipboardCheck className="h-4 w-4 text-primary" /> Ready to submit?</p>
        <ul className="mt-2 space-y-1.5">
          {checklist.map((c) => (
            <li key={c.label} className="flex items-center gap-2 text-sm">
              <span className={cn("flex h-4.5 w-4.5 items-center justify-center rounded-full", c.done ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground")}>
                <Check className="h-3 w-3" />
              </span>
              <span className={c.done ? "" : "text-muted-foreground"}>{c.label}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Submitting locks your details for review (usually 1–2 business days). You can keep editing products while you wait.
        </p>
        <Button onClick={onSubmit} disabled={busy} className="mt-4 w-full min-h-[44px] gap-2 sm:w-auto">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Submit for review
        </Button>
      </div>
    </div>
  );
}

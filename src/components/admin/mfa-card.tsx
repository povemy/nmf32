"use client";
// ============================================================================
// MfaCard (C4) — compact "Security / Two-factor authentication" management
// card for the signed-in administrator. Mounted at the top of the Settings
// view (system.tsx). Talks to /api/admin/mfa/{status,enroll,confirm,disable};
// every mutation re-authenticates with the CURRENT password (server-side).
//
// Flow (phase is derived from GET status, with a local override while a
// setup/recovery/signed-out transition is in flight):
//   off        → [Enable] (password) → shows base32 secret + otpauth:// URL as
//                copyable text (the ONLY time the secret exists in plaintext)
//   setup      → [Verify & enable] (password + 6-digit code) → recovery codes
//                revealed ONCE with a copy-all button; ALL sessions (incl.
//                this one) are revoked server-side → fresh MFA login required
//   resume     → unconfirmed enrollment found after a reload: verify with the
//                code from the app it was provisioned in, or restart enrollment
//   enabled    → [Disable] (password + authenticator/recovery code); sessions
//                are revoked server-side here too.
//
// NEVER logs or persists the secret, otpauth URL or recovery codes.
// ============================================================================
import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiSend, useApi } from "./use-api";
import type {
  AdminMfaStatus,
  MfaConfirmBody,
  MfaConfirmData,
  MfaDisableBody,
  MfaDisableData,
  MfaEnrollBody,
  MfaEnrollData,
} from "@/lib/types/api-contract";

/** "abcdefghij" → "abcde-fghij" (matches the login panel's recovery input). */
function groupCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error("Copy failed", { description: "Select the text and copy it manually." });
  }
}

function CopyButton({ text, label, disabled }: { text: string; label: string; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-[36px] gap-1.5"
      disabled={disabled}
      onClick={() => void copyText(text, label)}
    >
      <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
    </Button>
  );
}

/** Monospace copyable text block (secret / otpauth URL — text only, no QR). */
function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <CopyButton text={value} label={label} />
      </div>
      <code className="block max-w-full overflow-x-auto whitespace-nowrap rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground">
        {value}
      </code>
    </div>
  );
}

export function MfaCard() {
  // Server truth: GET /api/admin/mfa/status (useApi handles load/error/refetch).
  const { data, error, loading, refetch } = useApi<AdminMfaStatus>("/api/admin/mfa/status");
  // Local phase override while a transition is in flight — the derived phase
  // below covers every steady state.
  const [override, setOverride] = useState<"setup" | "recovery" | "signedout" | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<MfaEnrollData | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  const phase: "loading" | "error" | "off" | "setup" | "resume" | "enabled" | "recovery" | "signedout" =
    override ??
    (loading && !data
      ? "loading"
      : error
        ? "error"
        : data?.confirmed
          ? "enabled"
          : data?.enrolled
            ? "resume"
            : "off");

  /** POST enroll — requires the current password. */
  const enroll = async () => {
    if (busy || !password) return;
    setBusy(true);
    try {
      const data = await apiSend<MfaEnrollData>("/api/admin/mfa/enroll", "POST", { password } satisfies MfaEnrollBody);
      setSetup(data);
      setCode("");
      setOverride("setup");
      toast.success("Enrollment started", { description: "Add the key to your authenticator app, then verify a code." });
    } catch (e) {
      toast.error("Could not start enrollment", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** POST confirm — password + live TOTP code; reveals recovery codes ONCE. */
  const confirm = async () => {
    if (busy || !password || !code.trim()) return;
    setBusy(true);
    try {
      const data = await apiSend<MfaConfirmData>("/api/admin/mfa/confirm", "POST", { password, code: code.trim() } satisfies MfaConfirmBody);
      setRecoveryCodes(data.recoveryCodes ?? []);
      setOverride("recovery");
      toast.success("Two-factor authentication enabled", {
        description: "All sessions were signed out — sign in again with your authenticator.",
      });
    } catch (e) {
      toast.error("Could not confirm enrollment", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** POST disable — password + authenticator/recovery code. */
  const disable = async () => {
    if (busy || !password || !code.trim()) return;
    setBusy(true);
    try {
      await apiSend<MfaDisableData>("/api/admin/mfa/disable", "POST", { password, code: code.trim() } satisfies MfaDisableBody);
      setOverride("signedout");
      toast.success("Two-factor authentication disabled", {
        description: "All sessions were signed out — sign in again with your password.",
      });
    } catch (e) {
      toast.error("Could not disable", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** Leave the setup step — re-derive the phase from the server truth. */
  const cancelSetup = () => {
    setOverride(null);
    setSetup(null);
    setCode("");
    void refetch();
  };

  const statusBadge =
    phase === "enabled" ? (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
        <ShieldCheck className="h-3 w-3" aria-hidden /> On
      </span>
    ) : phase === "setup" || phase === "resume" ? (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
        Setup pending
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
        <ShieldOff className="h-3 w-3" aria-hidden /> Off
      </span>
    );

  return (
    <Card className="py-0">
      <CardHeader className="px-4 pb-0 pt-4 sm:px-6 sm:pt-5">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Security · Two-factor authentication
          {statusBadge}
        </CardTitle>
        <CardDescription>
          Protect your administrator account with a TOTP authenticator app (30s codes). A current-password check is required
          for every change; all active sessions are signed out when the security posture changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {phase === "loading" ? (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground sm:px-6">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading security status…
            </div>
          ) : phase === "error" ? (
            <div className="space-y-2 px-4 py-4 text-sm sm:px-6">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              <Button variant="outline" size="sm" className="min-h-[36px]" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          ) : phase === "recovery" ? (
            <div className="space-y-3 px-4 py-4 sm:px-6">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                <strong>Two-factor authentication is now enabled.</strong> You have been signed out everywhere — your next
                sign-in asks for an authenticator code. Store these recovery codes now: they are shown only once and each
                works a single time.
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs text-muted-foreground">Recovery codes (one-time)</Label>
                <CopyButton text={recoveryCodes.map(groupCode).join("\n")} label="All recovery codes" />
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-2">
                {recoveryCodes.map((c) => (
                  <code
                    key={c}
                    className="block rounded-lg border bg-muted/50 px-3 py-1.5 font-mono text-xs tracking-wider text-foreground"
                  >
                    {groupCode(c)}
                  </code>
                ))}
              </div>
            </div>
          ) : phase === "signedout" ? (
            <div className="px-4 py-4 text-sm sm:px-6">
              <p className="text-sm">
                Two-factor authentication is <strong>disabled</strong> and every session (including this one) has been signed
                out. Sign in again with your password.
              </p>
            </div>
          ) : phase === "setup" && setup ? (
            <div className="space-y-3 px-4 py-4 sm:px-6">
              <p className="text-xs text-muted-foreground">
                Add the key below to your authenticator app (Google Authenticator, 1Password, Aegis…), then verify with the
                6-digit code it generates. Prefer scanning? Copy the <span className="font-mono">otpauth://</span> URL into
                an app that accepts provisioning links.
              </p>
              <CopyRow label="Secret (base32)" value={setup.secretBase32} />
              <CopyRow label="otpauth URL" value={setup.otpauthUrl} />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-confirm-password" className="text-xs text-muted-foreground">Current password</Label>
                  <Input
                    id="mfa-confirm-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-h-[44px]"
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-confirm-code" className="text-xs text-muted-foreground">Authenticator code</Label>
                  <Input
                    id="mfa-confirm-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="123456"
                    maxLength={6}
                    className="min-h-[44px] font-mono tracking-widest"
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button className="min-h-[44px] gap-1.5" disabled={busy || !password || code.length !== 6} onClick={() => void confirm()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                  {busy ? "Verifying…" : "Verify & enable"}
                </Button>
                <Button variant="ghost" className="min-h-[44px]" disabled={busy} onClick={cancelSetup}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : phase === "resume" ? (
            <div className="space-y-3 px-4 py-4 sm:px-6">
              <p className="text-xs text-muted-foreground">
                An enrollment was started but never verified. Verify it with a code from the app you provisioned, or restart
                the setup (a fresh secret is generated and the old one is replaced).
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-resume-password" className="text-xs text-muted-foreground">Current password</Label>
                  <Input
                    id="mfa-resume-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-h-[44px]"
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-resume-code" className="text-xs text-muted-foreground">Authenticator code</Label>
                  <Input
                    id="mfa-resume-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="123456"
                    maxLength={6}
                    className="min-h-[44px] font-mono tracking-widest"
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button className="min-h-[44px] gap-1.5" disabled={busy || !password || code.length !== 6} onClick={() => void confirm()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                  {busy ? "Verifying…" : "Verify & enable"}
                </Button>
                <Button variant="outline" className="min-h-[44px]" disabled={busy || !password} onClick={() => void enroll()}>
                  {busy ? "Restarting…" : "Restart enrollment"}
                </Button>
              </div>
            </div>
          ) : phase === "enabled" ? (
            <div className="space-y-3 px-4 py-4 sm:px-6">
              <p className="text-xs text-muted-foreground">
                Your sign-ins require an authenticator code (or a recovery code). To disable two-factor authentication,
                confirm your current password plus a valid code.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-disable-password" className="text-xs text-muted-foreground">Current password</Label>
                  <Input
                    id="mfa-disable-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-h-[44px]"
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-disable-code" className="text-xs text-muted-foreground">
                    Authenticator or recovery code
                  </Label>
                  <Input
                    id="mfa-disable-code"
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456 / abcde-fghij"
                    className="min-h-[44px] font-mono"
                    disabled={busy}
                  />
                </div>
              </div>
              <Button
                variant="outline"
                className="min-h-[44px] gap-1.5 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
                disabled={busy || !password || !code.trim()}
                onClick={() => void disable()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldOff className="h-4 w-4" aria-hidden />}
                {busy ? "Disabling…" : "Disable two-factor"}
              </Button>
            </div>
          ) : (
            <div className="space-y-3 px-4 py-4 sm:px-6">
              <p className="text-xs text-muted-foreground">
                Your account is protected by password only. Enable TOTP two-factor authentication to require a 6-digit
                authenticator code (or one-time recovery codes) at every sign-in.
              </p>
              <div className="max-w-sm space-y-1.5">
                <Label htmlFor="mfa-enroll-password" className="text-xs text-muted-foreground">Current password</Label>
                <Input
                  id="mfa-enroll-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="min-h-[44px]"
                  disabled={busy}
                />
              </div>
              <Button className="min-h-[44px] gap-1.5" disabled={busy || !password} onClick={() => void enroll()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
                {busy ? "Starting…" : "Enable two-factor"}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

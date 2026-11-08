"use client";
// ============================================================================
// Shopper password recovery (WORK ORDER 1) — the forgot/reset flow mounted
// inside the shopper auth dialog ("Forgot password?" from the sign-in tab).
//
// Flow (mirrors the server's three-step contract):
//   1. REQUEST  POST /api/auth/forgot-password { email }
//      — uniform response (no account-existence disclosure); the user is told
//      a code was sent IF the address belongs to an account.
//   2. VERIFY   POST /api/auth/verify-recovery { email, code }
//      — exactly-once code consume; returns the short-lived "prg:v1:" reset
//      grant, held in component state ONLY (never localStorage — same
//      posture as the guest-checkout verified-email token).
//   3. RESET    POST /api/auth/reset-password { token, newPassword }
//      — sets the new password (server revokes every live session), then the
//      panel hands control back to the sign-in tab with the email prefilled.
//
// The grant lives only as long as this panel's step state; leaving the panel
// (Back / dialog close) drops it. Wrong code → the server's uniform 401
// message. Expired/used grant → INVALID_GRANT with a restart affordance.
// ============================================================================
import { useState } from "react";
import { ArrowLeft, KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson, ApiFail } from "@/components/shopper/ui-bits";
import type {
  ForgotPasswordBody,
  ForgotPasswordData,
  ResetPasswordBody,
  ResetPasswordData,
  VerifyRecoveryBody,
  VerifyRecoveryData,
} from "@/lib/types/api-contract";

type Step =
  | { phase: "request" }
  | { phase: "reset"; email: string }
  | { phase: "done"; email: string };

export function PasswordRecoveryPanel({ onBackToLogin }: { onBackToLogin: (email?: string) => void }) {
  const [step, setStep] = useState<Step>({ phase: "request" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Step 1 — request the recovery code (uniform server response). */
  const submitRequest = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await postJson<ForgotPasswordData>("/api/auth/forgot-password", {
        email: email.trim(),
      } satisfies ForgotPasswordBody);
      setNotice(res.message);
      setStep({ phase: "reset", email: email.trim().toLowerCase() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a recovery code");
    } finally {
      setBusy(false);
    }
  };

  /** Steps 2+3 — verify the code, then immediately consume the minted grant
   *  with the new password. The grant never leaves this function's scope. */
  const submitReset = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const normalizedCode = code.replace(/[^0-9]/g, "");
    if (normalizedCode.length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    if (newPassword.length < 8) {
      setError("The new password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Step 2: verify the recovery code → single-use reset grant.
      const verified = await postJson<VerifyRecoveryData>("/api/auth/verify-recovery", {
        email: step.phase === "reset" ? step.email : email.trim().toLowerCase(),
        code: normalizedCode,
      } satisfies VerifyRecoveryBody);
      // Step 3: consume the grant with the new password (server revokes all
      // live sessions of the account).
      const done = await postJson<ResetPasswordData>("/api/auth/reset-password", {
        token: verified.token,
        newPassword,
      } satisfies ResetPasswordBody);
      setNotice(done.message);
      setStep({ phase: "done", email: verified.email });
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      if (err instanceof ApiFail && (err.code === "INVALID" || err.code === "INVALID_GRANT")) {
        // Wrong/expired/replayed code or grant — the uniform messages are
        // safe to surface verbatim; a used grant sends the user back to step 1.
        setError(err.message);
        if (err.code === "INVALID_GRANT") setStep({ phase: "request" });
      } else {
        setError(err instanceof Error ? err.message : "Could not reset the password");
      }
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setStep({ phase: "request" });
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setNotice(null);
  };

  // ---- Step 1: email entry ------------------------------------------------
  if (step.phase === "request") {
    return (
      <div className="w-full space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-teal-200 bg-teal-50/70 px-3 py-3 dark:border-teal-900 dark:bg-teal-950/40">
          <Mail className="mt-0.5 h-5 w-5 shrink-0 text-teal-700 dark:text-teal-300" aria-hidden />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-teal-900 dark:text-teal-200">Reset your password</p>
            <p className="mt-0.5 text-xs text-teal-800/90 dark:text-teal-300/90">
              Enter your account email — we&apos;ll send a 6-digit recovery code. The code expires in 15 minutes.
            </p>
          </div>
        </div>
        <form onSubmit={submitRequest} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="recovery-email">Email</Label>
            <Input
              id="recovery-email"
              type="email"
              required
              placeholder="you@example.com"
              autoComplete="email"
              className="min-h-[44px]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
          <Button type="submit" disabled={busy} className="w-full min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110 gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} Send recovery code
          </Button>
        </form>
        <button
          type="button"
          onClick={() => onBackToLogin()}
          className="flex w-full items-center justify-center gap-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground min-h-[44px]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to sign in
        </button>
      </div>
    );
  }

  // ---- Done: password changed --------------------------------------------
  if (step.phase === "done") {
    return (
      <div className="w-full space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-3 dark:border-emerald-900 dark:bg-emerald-950/40">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">Password changed</p>
            <p className="mt-0.5 text-xs text-emerald-800/90 dark:text-emerald-300/90">
              {notice ?? "Your password has been changed and all other sessions were signed out."}
            </p>
          </div>
        </div>
        <Button
          onClick={() => onBackToLogin(step.email)}
          className="w-full min-h-[44px] bg-teal-700 text-white hover:bg-teal-800 gap-2"
        >
          <KeyRound className="h-4 w-4" aria-hidden /> Sign in with the new password
        </Button>
      </div>
    );
  }

  // ---- Step 2: code + new password ----------------------------------------
  return (
    <div className="w-full space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-teal-200 bg-teal-50/70 px-3 py-3 dark:border-teal-900 dark:bg-teal-950/40">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-teal-700 dark:text-teal-300" aria-hidden />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-teal-900 dark:text-teal-200">Enter your recovery code</p>
          <p className="mt-0.5 text-xs text-teal-800/90 dark:text-teal-300/90">
            {notice
              ? "Check your inbox — the code expires in 15 minutes and works once."
              : "The 6-digit code was sent to your email; it expires in 15 minutes and works once."}{" "}
            Sending to <span className="font-semibold">{step.email}</span>.
          </p>
        </div>
      </div>
      <form onSubmit={submitReset} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="recovery-code">Recovery code</Label>
          <Input
            id="recovery-code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            maxLength={6}
            className="min-h-[44px] text-center text-lg tracking-[0.4em]"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recovery-new-password">New password</Label>
          <Input
            id="recovery-new-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="New password (min 8 characters)"
            className="min-h-[44px]"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recovery-confirm-password">Confirm new password</Label>
          <Input
            id="recovery-confirm-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Repeat the new password"
            className="min-h-[44px]"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        <Button type="submit" disabled={busy} className="w-full min-h-[44px] bg-brand-gradient-deep text-white hover:brightness-110 gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Reset password
        </Button>
      </form>
      <button
        type="button"
        onClick={restart}
        className="flex w-full items-center justify-center gap-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground min-h-[44px]"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Use a different email / send a new code
      </button>
    </div>
  );
}

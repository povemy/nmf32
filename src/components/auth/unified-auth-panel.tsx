"use client";
// ============================================================================
// UnifiedAuthPanel (P11) — ONE reusable login form shared by all three portal
// surfaces (shopper auth dialog, seller auth screen, admin login card).
//
// The user NEVER picks a portal before submitting: POST /api/auth/unified-login
// resolves the account type on the SERVER across the admin/seller/shopper
// tables. When the same credentials verify in more than one table the endpoint
// answers 409 ACCOUNT_TYPE_AMBIGUOUS (no session) and this panel renders an
// inline portal picker limited to the server-verified types; picking one
// resubmits with an explicit `portal` disambiguation hint.
//
// MFA (C4): when the server verifies an enrolled admin's password it answers
// 200 { mfaRequired: true, challenge, email } — NO token. The panel then swaps
// the credential form for a second step (6-digit authenticator code, or a
// 10-character recovery code via a toggle) and POSTs /api/auth/mfa/verify with
// { challenge, code }. On success that route returns the NORMAL login success
// shape, which feeds the exact same post-login handling as the password path
// (setSessionToken + onAuthed) — authorization stays entirely server-side.
//
// On success the panel stores the session token (localStorage bridge for
// cookie-less contexts, exactly like the previous per-portal forms) and hands
// routing to the host via onAuthed(userType, res) — every portal decides its
// own post-login flow. Authorization itself is NEVER inferred client-side:
// the admin console stays protected by requireAdmin on every admin API.
//
// Below the form sits the sandbox-only DevAccountsPanel (see that file for the
// production-safety model) — hosts get it automatically and must not render
// it anywhere else (e.g. NOT on register tabs).
// ============================================================================

import { useId, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authHeaders, clearDeviceCartToken, knownCartToken, setSessionToken } from "@/lib/session-client";
import { DevAccountsPanel } from "./dev-accounts-panel";

export type UnifiedUserType = "admin" | "seller" | "shopper";

/** POST /api/auth/unified-login success payload (envelope `data`). */
export type UnifiedLoginResponse = {
  userType: UnifiedUserType;
  token: string;
  admin?: { id: string; email: string; name: string; role: string } | null;
  seller?: {
    id: string;
    email: string;
    fullName: string;
    displayName: string;
    status: string;
    storeId: string | null;
    storeSlug: string | null;
    storeName: string | null;
  } | null;
  shopper?: { id: string; email: string; fullName: string; phone: string | null } | null;
  isAffiliate?: boolean;
  claimed?: { addressesClaimed: number; ordersClaimed: number };
  /** FINAL CLOSURE §2 — false until email ownership is verified; guest-order
   *  claiming is gated server-side on the same proof. */
  emailVerified?: boolean;
};

type LoginFail = {
  status: number;
  code: string;
  message: string;
  /** Present only on 409 ACCOUNT_TYPE_AMBIGUOUS — the server-verified tables. */
  types?: UnifiedUserType[];
  /** MFA step only: wrong-code attempts left before a lockout (server detail). */
  attemptsRemaining?: number;
  /** MFA step only: seconds to wait when locked / rate-limited (server detail). */
  retryAfterSeconds?: number;
};

type LoginResult =
  | { ok: true; data: UnifiedLoginResponse }
  | { ok: "mfa"; mfa: { challenge: string; email: string } }
  | { ok: false; fail: LoginFail };

type MfaVerifyResult = { ok: true; data: UnifiedLoginResponse } | { ok: false; fail: LoginFail };

/** Pull the optional MFA detail fields out of an error envelope. */
function mfaFailDetails(raw: unknown): { attemptsRemaining?: number; retryAfterSeconds?: number } {
  const details = (raw ?? {}) as { attemptsRemaining?: unknown; retryAfterSeconds?: unknown };
  const attemptsRemaining = typeof details.attemptsRemaining === "number" ? details.attemptsRemaining : undefined;
  const retryAfterSeconds = typeof details.retryAfterSeconds === "number" ? details.retryAfterSeconds : undefined;
  return { attemptsRemaining, retryAfterSeconds };
}

async function requestUnifiedLogin(
  email: string,
  password: string,
  portal?: UnifiedUserType
): Promise<LoginResult> {
  try {
    // CART FIX: attach the KNOWN guest cart token (never mint one) so the
    // server's mergeGuestCartForShopper() can fold this device's guest cart
    // into the account even where the sm_cart cookie is unavailable (sandboxed
    // iframe previews). No token yet → header omitted, merge is a no-op.
    const cartToken = knownCartToken();
    const res = await fetch("/api/auth/unified-login", {
      method: "POST",
      cache: "no-store",
      // authHeaders always carries the X-SM-Client origin-gate marker the
      // route requires (plus any stale Bearer, which login simply ignores).
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(cartToken ? { "X-Cart-Token": cartToken } : {}),
      },
      body: JSON.stringify(portal ? { email, password, portal } : { email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
      error?: { code?: string; message?: string; details?: { types?: unknown } & Record<string, unknown> };
    };
    if (res.ok && body.data) {
      const d = body.data;
      // C4 MFA contract: enrolled admin, password verified, NO token yet —
      // the panel must collect an authenticator / recovery code first.
      if (d.mfaRequired === true && typeof d.challenge === "string" && d.challenge !== "") {
        return { ok: "mfa", mfa: { challenge: d.challenge, email: typeof d.email === "string" ? d.email : "" } };
      }
      if (typeof d.token === "string" && d.token !== "") {
        return { ok: true, data: d as unknown as UnifiedLoginResponse };
      }
    }
    const rawTypes = body.error?.details?.types;
    const types = Array.isArray(rawTypes)
      ? rawTypes.filter((t): t is UnifiedUserType => t === "admin" || t === "seller" || t === "shopper")
      : undefined;
    return {
      ok: false,
      fail: {
        status: res.status,
        code: body.error?.code ?? "ERROR",
        message: body.error?.message ?? `Sign in failed (${res.status})`,
        types,
      },
    };
  } catch {
    return {
      ok: false,
      fail: {
        status: 0,
        code: "NETWORK",
        message: "Could not reach the sign-in service — check your connection and try again.",
      },
    };
  }
}

/** POST /api/auth/mfa/verify { challenge, code } (C4). On success the response
 *  is the NORMAL login success shape — identical post-login handling. */
async function requestMfaVerify(challenge: string, code: string): Promise<MfaVerifyResult> {
  try {
    const res = await fetch("/api/auth/mfa/verify", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ challenge, code }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    if (res.ok && body.data && typeof body.data.token === "string" && body.data.token !== "") {
      return { ok: true, data: body.data as unknown as UnifiedLoginResponse };
    }
    const { attemptsRemaining, retryAfterSeconds } = mfaFailDetails(body.error?.details);
    return {
      ok: false,
      fail: {
        status: res.status,
        code: body.error?.code ?? "ERROR",
        message: body.error?.message ?? `Verification failed (${res.status})`,
        attemptsRemaining,
        retryAfterSeconds,
      },
    };
  } catch {
    return {
      ok: false,
      fail: {
        status: 0,
        code: "NETWORK",
        message: "Could not reach the sign-in service — check your connection and try again.",
      },
    };
  }
}

/** Ambiguity-picker labels: button action + the destination surface name. */
const PORTAL_LABELS: Record<UnifiedUserType, { action: string; dest: string }> = {
  seller: { action: "Continue as Seller", dest: "Seller Centre" },
  shopper: { action: "Continue as Buyer", dest: "Marketplace" },
  admin: { action: "Continue as Admin", dest: "Admin Console" },
};

/** Human phrasing of a failed MFA verification, from the server's failure
 *  envelope. 401 INVALID → attempts left; 429 / LOCKED → retry-after. */
function mfaFailureMessage(fail: LoginFail): string {
  if (fail.status === 429 || fail.code === "LOCKED" || fail.code === "RATE_LIMITED") {
    const seconds = fail.retryAfterSeconds;
    if (seconds != null && seconds > 0) return `Too many attempts — try again in ${seconds}s.`;
    return fail.message;
  }
  if (fail.attemptsRemaining != null && fail.attemptsRemaining > 0) {
    const noun = fail.attemptsRemaining === 1 ? "attempt" : "attempts";
    return `${fail.message} ${fail.attemptsRemaining} ${noun} left before a short lock.`;
  }
  return fail.message;
}

export function UnifiedAuthPanel({
  onAuthed,
  submitLabel = "Sign in",
  initialEmail,
}: {
  /** Called once the server has minted a session; owns all portal routing. */
  onAuthed: (userType: UnifiedUserType, res: UnifiedLoginResponse) => void | Promise<void>;
  /** Optional per-surface button label (defaults to the neutral "Sign in"). */
  submitLabel?: string;
  /** WORK ORDER 1 — prefilled email (e.g. returning from a successful
   *  password reset, so the shopper only types the new password). */
  initialEmail?: string;
}) {
  const idPrefix = useId();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState<{ message: string; types: UnifiedUserType[] } | null>(null);

  // ---- C4 MFA second step state -----------------------------------------
  const [mfa, setMfa] = useState<{ challenge: string; email: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaExpired, setMfaExpired] = useState(false);

  /** Editing the credentials invalidates a standing ambiguity prompt. */
  const resetAmbiguous = () => setAmbiguous(null);

  /** Shared post-login handling — the password path and the MFA path land in
   *  the exact same place (token bridge + host routing). */
  const completeLogin = async (data: UnifiedLoginResponse) => {
    // localStorage bridge for cookie-less contexts (cross-site iframe
    // preview panels) — mirrors the previous per-portal login forms.
    setSessionToken(data.token);
    // PHASE 2.2 guest checkout restoration — a SHOPPER sign-in folds the
    // device's guest cart into the account cart server-side
    // (mergeGuestCartForShopper) and retires the server's cart-token cookie.
    // Retire the client-side twin (localStorage + in-memory memo) here too:
    // while signed in the X-Cart-Token header is ignored, and after sign-out
    // a stale token would name the now ACCOUNT-bound cart row — every
    // add-to-cart would mint an orphan guest cart the header can never read
    // back. A fresh guest token is minted lazily after the next sign-out.
    if (data.userType === "shopper") clearDeviceCartToken();
    await onAuthed(data.userType, data);
  };

  const submit = async (portal?: UnifiedUserType) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestUnifiedLogin(email.trim(), password, portal);
      if (result.ok === true) {
        await completeLogin(result.data);
        return;
      }
      if (result.ok === "mfa") {
        // Password verified against a confirmed enrollment — collect the
        // second factor before any session exists.
        setMfa(result.mfa);
        setMfaCode("");
        setMfaError(null);
        setMfaExpired(false);
        setUseRecoveryCode(false);
        return;
      }
      if (result.fail.code === "ACCOUNT_TYPE_AMBIGUOUS" && result.fail.types && result.fail.types.length > 0) {
        setAmbiguous({ message: result.fail.message, types: result.fail.types });
      } else {
        setAmbiguous(null);
        setError(result.fail.message);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Submit the MFA second step. The code is normalized client-side
   *  (recovery codes are shown grouped "abcde-fghij" — separators stripped). */
  const submitMfa = async () => {
    if (mfaBusy || !mfa) return;
    const normalized = mfaCode.replace(/[^a-zA-Z0-9]/g, "");
    if (!useRecoveryCode && !/^\d{6}$/.test(normalized)) {
      setMfaError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    if (useRecoveryCode && normalized.length !== 10) {
      setMfaError("A recovery code is 10 characters (shown as two groups of 5).");
      return;
    }
    setMfaBusy(true);
    setMfaError(null);
    try {
      const result = await requestMfaVerify(mfa.challenge, normalized);
      if (result.ok) {
        await completeLogin(result.data);
        return;
      }
      const expired = /EXPIRED/.test(result.fail.code) || result.fail.status === 410;
      setMfaExpired(expired);
      setMfaError(expired ? "Your sign-in challenge expired — please start again." : mfaFailureMessage(result.fail));
    } finally {
      setMfaBusy(false);
    }
  };

  /** Leave the MFA step (the challenge token lives only in state — dropped). */
  const backToCredentials = () => {
    setMfa(null);
    setMfaCode("");
    setMfaError(null);
    setMfaExpired(false);
    setUseRecoveryCode(false);
  };

  // ---- MFA step (replaces the credential form until verified) -----------
  if (mfa) {
    return (
      <div className="w-full space-y-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitMfa();
          }}
          className="space-y-4"
        >
          <div className="flex items-start gap-3 rounded-lg border border-teal-200 bg-teal-50/70 px-3 py-3 dark:border-teal-900 dark:bg-teal-950/40">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-teal-700 dark:text-teal-300" aria-hidden />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-teal-900 dark:text-teal-200">Two-factor authentication</p>
              <p className="mt-0.5 text-xs text-teal-800/90 dark:text-teal-300/90">
                {useRecoveryCode
                  ? "Enter one of your 10-character recovery codes. Each code works once."
                  : "Enter the 6-digit code from your authenticator app."}
                {mfa.email ? (
                  <>
                    {" "}
                    Signing in as <span className="font-semibold">{mfa.email}</span>.
                  </>
                ) : null}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-mfa-code`}>{useRecoveryCode ? "Recovery code" : "Authenticator code"}</Label>
            {useRecoveryCode ? (
              <Input
                id={`${idPrefix}-mfa-code`}
                key="recovery"
                type="text"
                autoComplete="off"
                autoFocus
                value={mfaCode}
                onChange={(e) => {
                  setMfaCode(e.target.value);
                  setMfaExpired(false);
                }}
                placeholder="abcde-fghij"
                className="min-h-[44px] font-mono tracking-widest"
                disabled={mfaBusy}
                required
              />
            ) : (
              <Input
                id={`${idPrefix}-mfa-code`}
                key="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={mfaCode}
                onChange={(e) => {
                  setMfaCode(e.target.value.replace(/[^0-9]/g, ""));
                  setMfaExpired(false);
                }}
                placeholder="123456"
                maxLength={6}
                className="min-h-[44px] text-center font-mono text-lg tracking-[0.4em]"
                disabled={mfaBusy}
                required
              />
            )}
          </div>

          {mfaError ? (
            <p
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              role="alert"
            >
              {mfaError}
            </p>
          ) : null}

          <Button type="submit" className="min-h-[44px] w-full gap-2" disabled={mfaBusy}>
            {mfaBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
            {mfaBusy ? "Verifying…" : "Verify & sign in"}
          </Button>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setUseRecoveryCode((v) => !v);
                setMfaCode("");
                setMfaError(null);
                setMfaExpired(false);
              }}
              className="text-[11px] font-semibold text-teal-700 underline underline-offset-2 hover:text-teal-800 dark:text-teal-400 dark:hover:text-teal-300"
            >
              {useRecoveryCode ? "Use an authenticator code" : "Use a recovery code"}
            </button>
            <button
              type="button"
              onClick={backToCredentials}
              disabled={mfaBusy}
              className={
                mfaExpired
                  ? "text-[11px] font-semibold text-red-700 underline underline-offset-2 hover:text-red-800 disabled:opacity-60 dark:text-red-300 dark:hover:text-red-200"
                  : "text-[11px] font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
              }
            >
              {mfaExpired ? "Start again" : "Back to sign in"}
            </button>
          </div>
        </form>

        {/* Sandbox-only credential reference — renders nothing in production. */}
        <DevAccountsPanel />
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-email`}>Email</Label>
          <Input
            id={`${idPrefix}-email`}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              resetAmbiguous();
            }}
            placeholder="you@example.com"
            className="min-h-[44px]"
            disabled={busy}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-password`}>Password</Label>
          <div className="relative">
            <Input
              id={`${idPrefix}-password`}
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                resetAmbiguous();
              }}
              placeholder="••••••••"
              className="min-h-[44px] pr-12"
              disabled={busy}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              disabled={busy}
              className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </div>

        {error ? (
          <p
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {ambiguous ? (
          <div
            className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 dark:border-amber-900 dark:bg-amber-950/40"
            role="alert"
          >
            <p className="text-xs font-semibold text-amber-900 dark:text-amber-300">{ambiguous.message}</p>
            <div className="grid gap-2">
              {ambiguous.types.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={busy}
                  onClick={() => void submit(t)}
                  className="flex min-h-[44px] items-center justify-between gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-left text-xs font-bold text-slate-800 transition-colors hover:border-teal-600 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 dark:border-amber-800 dark:bg-card dark:text-slate-200 dark:hover:border-teal-700 dark:hover:bg-teal-950/40"
                >
                  <span className="min-w-0 truncate">
                    {PORTAL_LABELS[t].action}
                    {busy ? "…" : ""}
                  </span>
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {PORTAL_LABELS[t].dest}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setAmbiguous(null)}
              className="text-[11px] font-semibold text-amber-800 underline underline-offset-2 hover:text-amber-900 dark:text-amber-300"
            >
              Use different credentials
            </button>
          </div>
        ) : null}

        <Button type="submit" className="min-h-[44px] w-full gap-2" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
          {busy ? "Signing in…" : submitLabel}
        </Button>
      </form>

      {/* Sandbox-only credential reference — renders nothing in production. */}
      <DevAccountsPanel />
    </div>
  );
}

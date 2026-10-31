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
import { Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authHeaders, setSessionToken } from "@/lib/session-client";
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
};

type LoginFail = {
  status: number;
  code: string;
  message: string;
  /** Present only on 409 ACCOUNT_TYPE_AMBIGUOUS — the server-verified tables. */
  types?: UnifiedUserType[];
};

type LoginResult = { ok: true; data: UnifiedLoginResponse } | { ok: false; fail: LoginFail };

async function requestUnifiedLogin(
  email: string,
  password: string,
  portal?: UnifiedUserType
): Promise<LoginResult> {
  try {
    const res = await fetch("/api/auth/unified-login", {
      method: "POST",
      cache: "no-store",
      // authHeaders always carries the X-SM-Client origin-gate marker the
      // route requires (plus any stale Bearer, which login simply ignores).
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(portal ? { email, password, portal } : { email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: UnifiedLoginResponse;
      error?: { code?: string; message?: string; details?: { types?: unknown } };
    };
    if (res.ok && body.data?.token) {
      return { ok: true, data: body.data };
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

/** Ambiguity-picker labels: button action + the destination surface name. */
const PORTAL_LABELS: Record<UnifiedUserType, { action: string; dest: string }> = {
  seller: { action: "Continue as Seller", dest: "Seller Centre" },
  shopper: { action: "Continue as Buyer", dest: "Marketplace" },
  admin: { action: "Continue as Admin", dest: "Admin Console" },
};

export function UnifiedAuthPanel({
  onAuthed,
  submitLabel = "Sign in",
}: {
  /** Called once the server has minted a session; owns all portal routing. */
  onAuthed: (userType: UnifiedUserType, res: UnifiedLoginResponse) => void | Promise<void>;
  /** Optional per-surface button label (defaults to the neutral "Sign in"). */
  submitLabel?: string;
}) {
  const idPrefix = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState<{ message: string; types: UnifiedUserType[] } | null>(null);

  /** Editing the credentials invalidates a standing ambiguity prompt. */
  const resetAmbiguous = () => setAmbiguous(null);

  const submit = async (portal?: UnifiedUserType) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestUnifiedLogin(email.trim(), password, portal);
      if (result.ok) {
        // localStorage bridge for cookie-less contexts (cross-site iframe
        // preview panels) — mirrors the previous per-portal login forms.
        setSessionToken(result.data.token);
        await onAuthed(result.data.userType, result.data);
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

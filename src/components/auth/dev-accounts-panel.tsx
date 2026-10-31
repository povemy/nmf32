"use client";
// ============================================================================
// DevAccountsPanel — sandbox-only credential reference rendered beneath the
// unified login form (see unified-auth-panel.tsx).
//
// SAFETY MODEL (P12): every byte of data comes from GET /api/auth/dev-accounts,
// which is dual-gated SERVER-side (NODE_ENV=development AND
// NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS=true) and answers 404 — indistinguishable
// from a missing route — when either gate fails. This component holds NO
// bundled or cached credential data: if the endpoint 404s, errors, or returns
// an empty list it renders ABSOLUTELY NOTHING. Production therefore can never
// show a panel, not even an empty shell of one.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { webHeaders } from "@/lib/session-client";
import { cn } from "@/lib/utils";

type DevAccount = {
  type: "admin" | "seller" | "buyer" | "affiliate";
  label: string;
  email: string;
  password: string;
  role: string | null;
  status: string | null;
};

const TYPE_LABEL: Record<DevAccount["type"], string> = {
  admin: "Admin",
  seller: "Seller",
  buyer: "Buyer",
  affiliate: "Affiliate",
};

/** Clipboard write with a legacy textarea fallback (sandboxed iframes and
 *  non-secure contexts reject the async clipboard API). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Icon-only copy toggle — Copy → Check for ~1.5s after a successful copy. */
function CopyChip({ value, srLabel }: { value: string; srLabel: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    const ok = await copyToClipboard(value);
    setCopied(ok);
    if (!ok) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? `${srLabel} — copied` : srLabel}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="sr-only">{copied ? "Copied" : `Copy ${srLabel}`}</span>
    </button>
  );
}

/**
 * Renders nothing unless the dev-accounts endpoint verifiably returned
 * accounts for THIS request (fresh fetch on every mount — never cached).
 */
export function DevAccountsPanel() {
  const [accounts, setAccounts] = useState<DevAccount[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/dev-accounts", { cache: "no-store", headers: webHeaders() })
      .then(async (res) => {
        // 404 (production dual-gate) or any failure → no panel, ever.
        if (!res.ok) return null;
        const body = (await res.json().catch(() => null)) as { data?: { accounts?: DevAccount[] } } | null;
        const list = Array.isArray(body?.data?.accounts) ? body.data!.accounts! : [];
        return list.length > 0 ? list : null;
      })
      .then((list) => {
        if (alive && list) setAccounts(list);
      })
      .catch(() => {
        /* network failure — nothing to render */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!accounts) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-h-[44px] w-full items-center gap-2 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <span className="min-w-0 flex-1 text-xs font-bold text-amber-900 dark:text-amber-300">
              Development Test Accounts — Sandbox Only
            </span>
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 text-amber-700 transition-transform dark:text-amber-400", open && "rotate-180")}
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-amber-200/70 px-3 py-2.5 dark:border-amber-900/60">
            <p className="pb-2 text-[11px] leading-snug text-amber-800/90 dark:text-amber-300/80">
              Sandbox demo credentials — never available in production. Reference only: copy a value, then paste it into
              the form above.
            </p>
            <div className="max-h-64 overflow-y-auto pr-1 [scrollbar-width:thin] [scrollbar-color:rgba(20,184,166,0.45)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/30 hover:[&::-webkit-scrollbar-thumb]:bg-teal-600/50">
              <ul className="space-y-1.5">
                {accounts.map((a) => (
                  <li
                    key={`${a.type}-${a.email}`}
                    className="rounded-lg border border-amber-200/70 bg-white/70 px-2.5 py-2 dark:border-amber-900/50 dark:bg-card/60"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="shrink-0 text-[10px] font-semibold">
                        {TYPE_LABEL[a.type]}
                      </Badge>
                      <p className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-700 dark:text-slate-300" title={a.label}>
                        {a.label}
                      </p>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5">
                      <span className="flex min-w-0 items-center gap-0.5">
                        <span className="sr-only">{`Email for ${a.label}: `}</span>
                        <code className="truncate font-mono text-[11px] text-slate-600 dark:text-slate-400" title={a.email}>
                          {a.email}
                        </code>
                        <CopyChip value={a.email} srLabel={`email for ${a.label}`} />
                      </span>
                      <span className="flex min-w-0 items-center gap-0.5">
                        <span className="sr-only">{`Password for ${a.label}: `}</span>
                        <code className="truncate font-mono text-[11px] text-slate-600 dark:text-slate-400" title={a.password}>
                          {a.password}
                        </code>
                        <CopyChip value={a.password} srLabel={`password for ${a.label}`} />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

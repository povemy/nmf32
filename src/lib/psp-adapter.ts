// ============================================================================
// PSP PAYOUT ADAPTER — DORMANT SCAFFOLD (Round-2 item R2-P2)
// ============================================================================
// DORMANT SCAFFOLD — wired when a PSP contract exists. Hook point documented
// in docs/finance-audit-report.md §E and
// src/app/api/admin/payouts/[id]/sync/route.ts.
//
// ZERO WIRING BY DESIGN: no route, webhook, script or component imports this
// file yet (grep-verified at scaffold time). With the Setting
// `psp.payouts.mode` absent the resolved mode is "manual" — the pre-scaffold
// human flow (admin approve → finance marks paid/failed from bank evidence) —
// so default app behavior is byte-identical with or without this module.
//
// PHASES (what the provider actually executes):
//   "transfer"    — internal split/transfer settlement: a licensed PSP splits
//                   funds platform-internally (sub-account → platform ledger
//                   mirror; cf. the T2 GATEWAY→BANK_MAIN clearing model).
//   "bank_payout" — external bank transfer out to the seller's bank account
//                   (the step finance ops performs manually today).
//
// SERVER-ONLY CONVENTIONS (mirrors src/lib/psp.ts): pure helpers + types at
// module top level; `db` is imported LAZILY inside async functions so Prisma
// never enters a client bundle. Nothing here imports route helpers from
// src/lib/api.ts — failures are plain Errors; HTTP concerns belong to routes.
//
// GUARD RULES honored (agent-ctx/FIN-HARDENING-CHECKLIST.md):
//   #4  no invented PSP features — the only implementation is a deterministic
//       sandbox mock; real adapters are documented plug-in points, not fakes.
//   #5  no unsafe defaults — unknown provider state NEVER auto-succeeds (the
//       status map returns null → caller leaves the payout untouched).
//   #7  no new write paths — payout-state.ts is guard-only by FIN-2a design;
//       this module never writes a Payout row (see runPayoutViaAdapter).
//   #8  integer minor units (sen) only — validated on every submit input.
// ============================================================================

import { parseJson } from "./json";
import { mockPspAllowed } from "./psp";
import { canTransition } from "./payout-state";
import type { PayoutStatus } from "./payout-state";

// ---------------------------------------------------------------------------
// Modes, phases & the backing Setting
// ---------------------------------------------------------------------------

/** Phase of a provider-executed payout: internal split settlement vs external bank transfer. */
export type PspPayoutPhase = "transfer" | "bank_payout";

/** Payout execution mode. "manual" (the default) = the PSP is a human —
 *  admin approve + mark-paid, exactly the pre-scaffold flow. */
export type PspPayoutMode = "manual" | PspPayoutPhase;

/** Setting key holding the payout mode as a JSON string in Setting.valueJson
 *  (e.g. `"manual"`, `"transfer"`, `"bank_payout"`). Absent/unknown → manual. */
export const PSP_PAYOUT_MODE_SETTING_KEY = "psp.payouts.mode";

/**
 * Resolve the payout mode from Setting `psp.payouts.mode`.
 *
 * SAFE DEFAULT: ANY missing, malformed or unknown value resolves to "manual" —
 * never to a money-moving mode (guard rule 5). "manual" means the current
 * human flow (admin approve + mark-paid); no adapter is involved.
 */
export async function resolvePayoutMode(): Promise<PspPayoutMode> {
  const { db } = await import("./db");
  const row = await db.setting.findUnique({ where: { key: PSP_PAYOUT_MODE_SETTING_KEY } });
  // parseJson is the lib-level parse-or-fallback helper (the route-side twin
  // of parseMaybeJson in app/api/admin/_helpers — same pattern, importable
  // without pulling route code into a lib).
  const raw = parseJson<unknown>(row?.valueJson, "manual");
  return raw === "transfer" || raw === "bank_payout" || raw === "manual" ? raw : "manual";
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/** Provider-reported lifecycle status of a submitted instruction. */
export type PspProviderStatus = "pending" | "processed" | "failed";

/** Status answers from recovery/status queries may also be "unknown". */
export type PspRecoverStatus = PspProviderStatus | "unknown";

/** Minimal bank detail snapshot a payout adapter needs (no full account
 *  numbers ever leave the platform — the DB itself only keeps last4). */
export type PspPayoutBankSnapshot = {
  bankName: string | null;
  accountLast4: string | null;
  holderName: string | null;
};

export type PspPayoutSubmitInput = {
  payoutId: string;
  referenceNo: string;
  /** Integer minor units (sen) only — adapters must reject anything else. */
  amountMinor: number;
  currency: string;
  bank: PspPayoutBankSnapshot;
  /**
   * Explicit outbound idempotency key. When omitted, implementations derive
   * the phase-appropriate key from payoutId via
   * payoutTransferIdempotencyKey()/payoutBankIdempotencyKey().
   */
  idempotencyKey?: string;
};

export type PspSubmitResult = {
  /** true = the provider ACCEPTED the instruction for processing (outcome rides on providerStatus). */
  accepted: boolean;
  providerRef: string;
  providerStatus: PspProviderStatus;
  raw?: unknown;
};

export type PspRecoverResult = {
  providerStatus: PspRecoverStatus;
  raw?: unknown;
};

/**
 * The contract every payout provider adapter must satisfy. Kept minimal on
 * purpose: submit once (idempotently) + recover state later. A production
 * adapter adds auth/config privately in its own constructor — the platform
 * never needs more than this surface.
 */
export interface PspPayoutAdapter {
  submit(input: PspPayoutSubmitInput): Promise<PspSubmitResult>;
  recover(providerRef: string): Promise<PspRecoverResult>;
}

// ---------------------------------------------------------------------------
// Outbound idempotency keys (stable across retries, derived from payoutId)
// ---------------------------------------------------------------------------
// These are the keys a production adapter sends to the PSP (e.g. an HTTP
// `Idempotency-Key` header). They are deliberately a DIFFERENT namespace from
// the FIN-1 inbound ledger dedupKeys (`payout_initiated:payout:{id}` …):
// outbound keys dedupe OUR submission to the PROVIDER; ledger dedupKeys
// dedupe the provider's confirmation in OUR books.

export function payoutTransferIdempotencyKey(payoutId: string): string {
  return `payout_transfer:${payoutId}`;
}

export function payoutBankIdempotencyKey(payoutId: string): string {
  return `payout_bank:${payoutId}`;
}

// ---------------------------------------------------------------------------
// State recovery mapping (provider → payout state machine)
// ---------------------------------------------------------------------------

/**
 * Map a provider status onto the payout state machine (lib/payout-state.ts).
 *
 *   pending   → "processing"   (instruction accepted, money not settled)
 *   processed → "paid"         (settled — T4 semantics)
 *   failed    → "failed"       (T4f semantics)
 *   unknown   → null           (see below)
 *
 * HARD GUARD (checklist rule 5): `null` means "leave the payout untouched and
 * surface a finding". An unknown provider state must NEVER auto-succeed (nor
 * auto-fail) a payout — unknowns go to human review via the reconciliation
 * surface (admin payouts sync/sweep), never to a status flip.
 */
export function mapProviderStatusToPayoutStatus(s: PspRecoverStatus | string): PayoutStatus | null {
  switch (s) {
    case "pending":
      return "processing";
    case "processed":
      return "paid";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// MockPspTransferAdapter — deterministic SANDBOX-only implementation
// ---------------------------------------------------------------------------

// IN-MEMORY ONLY (process lifetime). The Map keyed by idempotency key returns
// the EXACT first response on replay ("same key = same response" — the
// contract a production adapter gets from PSP idempotency, e.g. Stripe's
// Idempotency-Key). PRODUCTION ADAPTERS MUST PERSIST THIS MAPPING DURABLY
// (provider-side or own DB) so retries survive process restarts and
// multi-instance deployments — the mock intentionally demonstrates the
// semantics, not the storage.
const mockSubmissionsByIdempotencyKey = new Map<string, PspSubmitResult>();
const mockStatusByProviderRef = new Map<string, PspProviderStatus>();

/** Deterministic sandbox outcome: payout ids ENDING in one of these hex chars
 *  fail; every other id settles pending → processed. Fixed set on purpose so
 *  future lifecycle probes can pick ids with a known outcome. */
const MOCK_FAILED_LAST_CHARS = new Set(["0", "4", "8", "c"]);

/** sandboxOnly guard — mirrors PSP_PROVIDERS.mock in src/lib/psp.ts: sandbox
 *  (NODE_ENV !== "production") always allowed; production ONLY when Setting
 *  `psp.mock.enabled` = true (the same mockPspAllowed() gate the payment /
 *  payout simulate endpoints enforce). Fail-closed. */
async function assertMockPspPayoutAllowed(): Promise<void> {
  if (!(await mockPspAllowed())) {
    throw new Error(
      "PSP_PAYOUT_SANDBOX_REFUSED: mock PSP payouts are disabled in production (Setting psp.mock.enabled !== true); the mock adapter is sandboxOnly by definition"
    );
  }
}

/** Integer-sen validation (guard rule 8) — no floats, no rounding, no zero/negative. */
function assertValidSubmitInput(input: PspPayoutSubmitInput): void {
  if (!input.payoutId || !input.referenceNo) {
    throw new Error("PSP_PAYOUT_INVALID_INPUT: payoutId and referenceNo are required");
  }
  if (!input.currency) {
    throw new Error("PSP_PAYOUT_INVALID_INPUT: currency is required");
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error(`PSP_PAYOUT_INVALID_AMOUNT: amountMinor must be a positive integer in minor units (got ${input.amountMinor})`);
  }
  // NOTE: bank.* may be null in the snapshot. The mock tolerates null bank
  // details so the sandbox lifecycle stays probeable; a PRODUCTION
  // bank_payout adapter MUST refuse to move money when they are missing.
}

export class MockPspTransferAdapter implements PspPayoutAdapter {
  constructor(private readonly phase: PspPayoutPhase) {}

  private idempotencyKeyFor(payoutId: string): string {
    return this.phase === "transfer"
      ? payoutTransferIdempotencyKey(payoutId)
      : payoutBankIdempotencyKey(payoutId);
  }

  async submit(input: PspPayoutSubmitInput): Promise<PspSubmitResult> {
    await assertMockPspPayoutAllowed();
    assertValidSubmitInput(input);

    const key = input.idempotencyKey ?? this.idempotencyKeyFor(input.payoutId);

    // IDEMPOTENT REPLAY: same key → the EXACT same response (same providerRef,
    // same providerStatus). A retry never creates a second transfer.
    const replay = mockSubmissionsByIdempotencyKey.get(key);
    if (replay) return replay;

    const providerRef = `mockpo_${this.phase}_${input.payoutId}`;
    const failed = MOCK_FAILED_LAST_CHARS.has(input.payoutId.slice(-1));
    // accepted=true means the instruction was taken; the outcome rides on
    // providerStatus. Non-failing ids go "pending" first — recover() then
    // resolves them "processed" (deterministic async settlement).
    const result: PspSubmitResult = {
      accepted: true,
      providerRef,
      providerStatus: failed ? "failed" : "pending",
      raw: { mock: true, phase: this.phase, idempotencyKey: key, referenceNo: input.referenceNo, amountMinor: input.amountMinor },
    };
    mockSubmissionsByIdempotencyKey.set(key, result);
    mockStatusByProviderRef.set(providerRef, result.providerStatus);
    return result;
  }

  async recover(providerRef: string): Promise<PspRecoverResult> {
    await assertMockPspPayoutAllowed();
    const submitted = mockStatusByProviderRef.get(providerRef);
    if (submitted === undefined) {
      // Unknown to the provider — MUST NOT be interpreted as success or
      // failure by the caller (mapProviderStatusToPayoutStatus → null).
      return { providerStatus: "unknown", raw: { mock: true, reason: "providerRef not found in the mock provider ledger" } };
    }
    // "processed after pending": a pending instruction deterministically
    // settles; a failed instruction stays failed.
    return {
      providerStatus: submitted === "pending" ? "processed" : submitted,
      raw: { mock: true, providerRef },
    };
  }
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

/**
 * Adapter factory for a payout mode. When `mode` is omitted the Setting is
 * resolved first (resolvePayoutMode()).
 *
 * Returns the sandbox MockPspTransferAdapter for "transfer"/"bank_payout".
 * REAL STRIPE/CURLEC/IPAY88 ADAPTERS PLUG IN HERE, behind the same
 * PspPayoutAdapter interface, once a PSP contract exists (docs/
 * finance-audit-report.md §E) — this is the single swap point; nothing else
 * in the platform should know which provider executes a payout.
 *
 * Throws a plain Error for "manual": the PSP is a human, there is nothing to
 * submit to. Callers must branch on resolvePayoutMode() BEFORE calling this —
 * the throw keeps that contract loud instead of silently no-op-ing.
 */
export async function getPayoutAdapter(mode?: PspPayoutMode): Promise<PspPayoutAdapter> {
  const resolved = mode ?? (await resolvePayoutMode());
  if (resolved === "transfer") return new MockPspTransferAdapter("transfer");
  if (resolved === "bank_payout") return new MockPspTransferAdapter("bank_payout");
  throw new Error(
    "PSP_PAYOUT_MODE_MANUAL: payout mode is 'manual' — the PSP is a human (admin approve + mark-paid); branch on resolvePayoutMode() before requesting an adapter"
  );
}

// ---------------------------------------------------------------------------
// runPayoutViaAdapter — FUTURE hook-point function (DORMANT)
// ---------------------------------------------------------------------------

export type PspPayoutRunResult = {
  mode: PspPayoutMode;
  submitted: boolean;
  providerRef?: string;
  providerStatus?: PspProviderStatus;
  /** PROPOSED payout status from mapProviderStatusToPayoutStatus — proposed
   *  ONLY. This dormant scaffold never writes the payout row (see finding). */
  payoutStatus?: PayoutStatus;
  finding?: string;
};

/**
 * FUTURE HOOK POINT — drive one payout through a PSP adapter. NOT imported by
 * any route/webhook yet; the wiring lands together with the real adapter
 * (docs/finance-audit-report.md §E).
 *
 * Contract (per checklist R2-P2):
 *  (a) load payout + bank account + wallet,
 *  (b) resolve mode,
 *  (c) manual → { submitted:false, finding:"manual-mode-no-adapter" },
 *  (d) only RESERVED payouts may be submitted — status must be "processing"
 *      (T3 posted at approve: the amount sits in PLATFORM:PAYOUT_CLEARING),
 *  (e) adapter.submit with the phase-appropriate outbound idempotency key,
 *  (f) NO write path from here. lib/payout-state.ts exposes only pure
 *      transition guards (canTransition/assertTransition) — by FIN-2a design
 *      every real status write is a conditional updateMany CLAIM inside the
 *      admin routes' / webhook processor's transaction, committed together
 *      with the T4/T4f ledger recipe. There is deliberately no safe
 *      transition helper that writes. Inventing a bare payout.update here
 *      would create an unclaimed write path that flips status WITHOUT the
 *      atomic ledger movement (status↔ledger desync) — so this function
 *      leaves the payout untouched and returns the proposed mapping plus a
 *      finding instead. The future PSP wiring must route confirmed states
 *      through the same claim pattern (see the sync route header comment).
 */
export async function runPayoutViaAdapter(payoutId: string): Promise<PspPayoutRunResult> {
  // (a) payout + its bank account + wallet. Lazy db import — server-only
  // convention of this module (Prisma never enters a client bundle).
  const { db } = await import("./db");
  const payout = await db.payout.findUnique({ where: { id: payoutId }, include: { bankAccount: true } });
  if (!payout) throw new Error(`PSP_PAYOUT_ADAPTER: payout ${payoutId} not found`);
  const wallet = await db.wallet.findUnique({ where: { id: payout.walletId } });
  if (!wallet) throw new Error(`PSP_PAYOUT_ADAPTER: wallet ${payout.walletId} for payout ${payoutId} not found`);

  // (b) mode.
  const mode = await resolvePayoutMode();

  // (c) manual → the PSP is a human; nothing to submit.
  if (mode === "manual") {
    return { mode, submitted: false, finding: "manual-mode-no-adapter" };
  }

  // (d) only reserved payouts may be submitted. "processing" = the reservation
  // exists (T3 moved SELLER:PAYABLE → PAYOUT_CLEARING at approve). A payout in
  // any other state either has no reservation or is already resolved.
  if (payout.status !== "processing") {
    return { mode, submitted: false, finding: `payout-not-processing:${payout.status}` };
  }

  // Bank snapshot — last4 only (the DB stores masked numbers; a full account
  // number never exists platform-side to leak).
  const bank: PspPayoutBankSnapshot = payout.bankAccount
    ? {
        bankName: payout.bankAccount.bankName,
        accountLast4: bankLast4(payout.bankAccount.accountNumberMasked),
        holderName: payout.bankAccount.holderName,
      }
    : { bankName: null, accountLast4: null, holderName: null };

  // (e) submit with the phase-appropriate outbound idempotency key.
  const adapter = await getPayoutAdapter(mode);
  const result = await adapter.submit({
    payoutId: payout.id,
    referenceNo: payout.referenceNo,
    amountMinor: payout.amountMinor,
    currency: wallet.currency,
    bank,
    idempotencyKey:
      mode === "transfer"
        ? payoutTransferIdempotencyKey(payout.id)
        : payoutBankIdempotencyKey(payout.id),
  });

  // (f) state mapping — never auto-succeed an unknown (guard rule 5).
  const mapped = mapProviderStatusToPayoutStatus(result.providerStatus);
  if (mapped === null) {
    return {
      mode,
      submitted: true,
      providerRef: result.providerRef,
      providerStatus: result.providerStatus,
      finding: "provider-status-unknown-payout-untouched",
    };
  }
  if (!canTransition(payout.status, mapped)) {
    return {
      mode,
      submitted: true,
      providerRef: result.providerRef,
      providerStatus: result.providerStatus,
      finding: `payout-transition-invalid:${payout.status}->${mapped}`,
    };
  }
  // Transition WOULD be legal, but this scaffold has no write path (see the
  // contract note above): surface the proposal for the future wiring.
  return {
    mode,
    submitted: true,
    providerRef: result.providerRef,
    providerStatus: result.providerStatus,
    payoutStatus: mapped,
    finding: "dormant-scaffold-no-write-path",
  };
}

/** Trailing digits of a masked account number, capped at 4 — the last4 the
 *  platform actually stores (`accountNumberMasked` = "****1234"). */
function bankLast4(masked: string | null | undefined): string | null {
  if (!masked) return null;
  const digits = masked.replace(/\D/g, "");
  return digits ? digits.slice(-4) : null;
}

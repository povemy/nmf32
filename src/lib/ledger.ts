// ============================================================================
// M10 WALLETS, LEDGER & PAYOUTS — double-entry engine (PART 3 M10)
// SIGN CONVENTION: seller wallet balance = SUM(credit) - SUM(debit) on
// SELLER:{walletId}:PAYABLE. Credits with available_at > now = pending.
// Every transaction MUST balance: sum(debit) == sum(credit).
//
// OPTION B NOTE (licensed-PSP split model): the platform does NOT custody
// buyer funds. SELLER:*:PAYABLE balances MIRROR the PSP's per-seller
// sub-balances, and the payout pipeline (T2 clear → bank transfer) records
// the settlement the PSP/finance ops actually executes. Commission lines
// equal the PSP application fee deducted at payment time (rate model under
// discussion per user decision — keep the mechanics, numbers are config).
// ============================================================================
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { parseJson, toJson } from "./json";

export const ACCOUNTS = {
  BANK_MAIN: "PLATFORM:BANK_MAIN",
  payoutClearing: () => "PLATFORM:PAYOUT_CLEARING",
  revenueCommission: () => "PLATFORM:REVENUE_COMMISSION",
  revenueAdjust: () => "PLATFORM:REVENUE_ADJUST",
  // AFFILIATE (Hub): seller-funded affiliate commission liability owed to
  // affiliates. Credited by the T1 4th line (pool per paid order); debited by
  // T5 affiliate reversals (refunds) and the affiliate payout recipes.
  affiliateLiability: () => "PLATFORM:AFFILIATE_LIABILITY",
  gateway: (provider: string) => `GATEWAY:${provider.toUpperCase()}`,
  sellerPayable: (walletId: string) => `SELLER:${walletId}:PAYABLE`,
};

export const ACCOUNT_META: Record<string, { name: string; type: "asset" | "liability" | "revenue" | "expense" }> = {
  "PLATFORM:BANK_MAIN": { name: "Platform Main Bank Account", type: "asset" },
  "PLATFORM:PAYOUT_CLEARING": { name: "Payout Clearing", type: "liability" },
  "PLATFORM:REVENUE_COMMISSION": { name: "Commission Revenue", type: "revenue" },
  "PLATFORM:REVENUE_ADJUST": { name: "Manual Adjustments Revenue", type: "revenue" },
  "PLATFORM:AFFILIATE_LIABILITY": { name: "Affiliate Commission Liability", type: "liability" },
};

export async function ensureAccount(code: string, walletId?: string | null) {
  await ensureAccountTx(code, walletId, db);
}

// F1 [Measured]: under concurrent same-seller confirmations, the unconditional
// `ledgerAccount.upsert` on the SHARED SELLER/GATEWAY/COMMISSION account rows
// was itself a hot-row write inside every Serializable tx (write-write SSI
// conflicts + extra roundtrips). Accounts are effectively immutable once
// created, so: read-first + per-process memo. The common case becomes a
// read (no write, no conflict domain growth) and 1 roundtrip instead of an
// upsert; first-creation still upserts (P2002-safe).
const ensuredAccounts = new Set<string>();

/** Same upsert, runnable on an explicit transaction client (FIN-1 atomicity). */
async function ensureAccountTx(code: string, walletId: string | null | undefined, tx: Prisma.TransactionClient) {
  if (ensuredAccounts.has(code)) return;
  const meta = ACCOUNT_META[code] ?? {
    name: code.startsWith("GATEWAY:") ? `Gateway ${code.slice(8)}` : code.startsWith("SELLER:") ? "Seller Payable" : code,
    type: code.startsWith("SELLER:") ? "liability" : code.startsWith("GATEWAY:") ? "asset" : "asset",
  };
  const existing = await tx.ledgerAccount.findUnique({ where: { code }, select: { code: true } });
  if (existing) {
    ensuredAccounts.add(code);
    return;
  }
  try {
    await tx.ledgerAccount.upsert({
      where: { code },
      create: { code, name: meta.name, type: meta.type, walletId: walletId ?? null },
      update: {},
    });
    ensuredAccounts.add(code);
  } catch (e) {
    // Raced creation from another tx — the row exists now; treat as ensured.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      ensuredAccounts.add(code);
      return;
    }
    throw e;
  }
}

export async function ensureWalletAccounts(walletId: string) {
  await ensureAccount(ACCOUNTS.sellerPayable(walletId), walletId);
}

export type LedgerLineInput = {
  accountCode: string;
  direction: "debit" | "credit";
  amountMinor: number;
  walletId?: string | null;
  availableAt?: Date | null;
  memo?: string | null;
};

// ---------------------------------------------------------------------------
// FIN-1 POSTING CORE — atomic + idempotent.
//
// ATOMICITY: every posting runs inside a single prisma.$transaction (lines,
// account upserts, wallet-cache refresh all commit or roll back together).
// Recipes called with an outer transaction client run INSIDE it — never
// nested — so a webhook/payout flow can group ledger + business writes.
//
// IDEMPOTENCY (dedupKey semantics — read before changing):
//   • dedupKey is an OPTIONAL caller/recipe-supplied unique helper key stored
//     on LedgerTransaction. When null/undefined the row is written with NULL —
//     Postgres unique indexes treat NULLs as distinct, so non-deduped postings
//     keep the legacy always-insert behavior (e.g. repeatable admin
//     adjustments).
//   • Recipes pass EXPLICIT keys only where a posting must happen EXACTLY
//     once per business event (T1 per order, T2 per settlement ref, T3/T4/T4f
//     per payout, T5 per refund row). Generic auto-keys are deliberately NOT
//     derived here: a (txnType,refType,refId) default would falsely dedup
//     legitimately-repeatable postings such as multi partial refunds per
//     order (refType=order for every refund) — that is why postRefund takes
//     the per-Refund-row refundId for its key.
//   • On a P2002 unique violation the EXISTING transaction is fetched and
//     returned with idempotentReplay:true (see wasReplay) instead of throwing
//     — duplicate webhook deliveries / double-clicked admins converge on the
//     original posting and never create a second one.
// ---------------------------------------------------------------------------

export type PostedTransaction = Prisma.LedgerTransactionGetPayload<{ include: { lines: true } }> & {
  /** True when the dedupKey already existed and the ORIGINAL posting was returned. */
  idempotentReplay?: boolean;
};

/** True when a posted result is actually the original txn replayed (dedup hit). */
export function wasReplay(t: PostedTransaction): boolean {
  return t.idempotentReplay === true;
}

/** Post a balanced double-entry transaction. Throws if unbalanced. */
export async function postTransaction(input: {
  txnType: string;
  refType?: string | null;
  refId?: string | null;
  description?: string | null;
  currency?: string;
  lines: LedgerLineInput[];
  occurredAt?: Date;
  /** Optional unique idempotency key (see block comment above). NULL = no dedup. */
  dedupKey?: string | null;
  /** Existing transaction client — when omitted the posting wraps itself in db.$transaction. */
  tx?: Prisma.TransactionClient;
}): Promise<PostedTransaction> {
  const run = async (tx: Prisma.TransactionClient): Promise<PostedTransaction> => {
    const debit = input.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
    const credit = input.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
    if (debit !== credit || debit === 0) {
      throw new Error(`LEDGER_UNBALANCED debit=${debit} credit=${credit} txn=${input.txnType}`);
    }
    for (const l of input.lines) await ensureAccountTx(l.accountCode, l.walletId ?? null, tx);
    // With a dedupKey we may need to RECOVER from a unique violation inside
    // this (possibly caller-provided) transaction. Postgres aborts the whole
    // tx on a failed statement (25P02 — even a SELECT is refused afterwards),
    // so the create is fenced with a SAVEPOINT: on P2002 we rewind to it and
    // the original row becomes readable again. Without this, the
    // replay-instead-of-throw contract below is unreachable inside a real tx.
    const sp = input.dedupKey
      ? `fin1_sp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
      : null;
    if (sp) await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      const created = await tx.ledgerTransaction.create({
        data: {
          txnType: input.txnType,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          description: input.description ?? null,
          occurredAt: input.occurredAt ?? new Date(),
          dedupKey: input.dedupKey ?? null,
          lines: {
            create: input.lines.map((l) => ({
              accountCode: l.accountCode,
              direction: l.direction,
              amountMinor: l.amountMinor,
              walletId: l.walletId ?? null,
              availableAt: l.availableAt ?? null,
              memo: l.memo ?? null,
              // Denormalized ref (FIN-1 helper columns) so ref-scoped line
              // queries don't need a join; mirrors the parent txn.
              refType: input.refType ?? null,
              refId: input.refId ?? null,
            })),
          },
        },
        include: { lines: true },
      });
      if (sp) await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return created;
    } catch (e) {
      // Idempotent replay: the dedupKey already exists → return the ORIGINAL
      // transaction instead of throwing (never double-post, never 500).
      if (input.dedupKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        if (sp) await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
        const existing = await tx.ledgerTransaction.findUnique({
          where: { dedupKey: input.dedupKey },
          include: { lines: true },
        });
        if (existing) return { ...existing, idempotentReplay: true };
      }
      throw e;
    }
  };
  return input.tx ? run(input.tx) : db.$transaction(run);
}

// ------------------------------------------------------------- WALLET TRUTH

export type WalletTruth = {
  pendingMinor: number;
  availableMinor: number;
  lifetimeEarnedMinor: number;
  lifetimeCommissionMinor: number;
};

/** Compute wallet balances from ledger lines (the source of truth). */
export async function walletTruth(walletId: string, tx?: Prisma.TransactionClient): Promise<WalletTruth> {
  const payable = ACCOUNTS.sellerPayable(walletId);
  const client = tx ?? db;
  const lines = await client.ledgerLine.findMany({
    where: { accountCode: payable },
    select: { direction: true, amountMinor: true, availableAt: true },
  });
  const now = new Date();
  let totalCredits = 0, maturedCredits = 0, totalDebits = 0, lifetimeCommission = 0;
  for (const l of lines) {
    if (l.direction === "credit") {
      totalCredits += l.amountMinor;
      if (!l.availableAt || l.availableAt <= now) maturedCredits += l.amountMinor;
    } else {
      totalDebits += l.amountMinor;
    }
  }
  // lifetime commission from revenue account lines tagged with this wallet? simpler: from txns T1 memo — use commission revenue lines with walletId
  const commissionLines = await client.ledgerLine.findMany({
    where: { accountCode: ACCOUNTS.revenueCommission(), walletId, direction: "credit" },
    select: { amountMinor: true },
  });
  lifetimeCommission = commissionLines.reduce((s, l) => s + l.amountMinor, 0);
  return {
    pendingMinor: totalCredits - maturedCredits,
    availableMinor: maturedCredits - totalDebits,
    lifetimeEarnedMinor: totalCredits - lifetimeCommission,
    lifetimeCommissionMinor: lifetimeCommission,
  };
}

/**
 * Refresh cached wallet columns from ledger truth (nightly invariant in prod;
 * on-write here). Pass the recipe's `tx` so the refresh reads uncommitted
 * lines and commits atomically with the posting itself.
 *
 * CONTENTION NOTE (measured): inside a Serializable tx this UPDATE on the
 * wallet row is the hot-row epicenter of same-seller payment-confirmation
 * storms (performance/REPORT.md §5.4 — 0/15 succeeded). Hot paths (webhook
 * confirmation) now pass no `tx` and run this AFTER the money tx commits —
 * the cache is a derived display value and payout authorization recomputes
 * truth independently, so a failed/late post-commit refresh is safe (the
 * invariant classifier reports time-maturity staleness as benign).
 */
export async function refreshWalletCache(walletId: string, tx?: Prisma.TransactionClient) {
  const truth = await walletTruth(walletId, tx);
  const client = tx ?? db;
  await client.wallet.update({
    where: { id: walletId },
    data: {
      pendingMinor: truth.pendingMinor,
      availableMinor: truth.availableMinor,
      lifetimeEarnedMinor: truth.lifetimeEarnedMinor,
      lifetimeCommissionMinor: truth.lifetimeCommissionMinor,
    },
  });
  return truth;
}

/**
 * Best-effort cache refresh for display surfaces: never throws — on failure
 * returns the last-known cache and the error, so a wallet PAGE never 500s
 * because a concurrent payment tx briefly holds the wallet row. Money
 * decisions never use this helper (they recompute truth transactionally).
 */
export async function safeRefreshWalletCache(walletId: string) {
  try {
    const truth = await refreshWalletCache(walletId);
    return { refreshed: true as const, truth, error: null };
  } catch (e) {
    const cached = await db.wallet.findUnique({ where: { id: walletId } });
    return {
      refreshed: false as const,
      truth: null,
      error: e instanceof Error ? e.message : String(e),
      cached,
    };
  }
}

// ------------------------------------------------------------- JOURNAL RECIPES

/**
 * T1 — order paid: DR GATEWAY:{p} total | CR SELLER:PAYABLE (available_at=paid+hold) | CR COMMISSION
 * [+ CR AFFILIATE_LIABILITY pool when the order carries affiliate attribution].
 * Dedup: exactly ONE T1 per order (`order_paid:order:{orderId}`) — a group
 * webhook pays each order once; duplicate deliveries replay harmlessly
 * (P2002 → original txn returned with idempotentReplay:true).
 *
 * AFFILIATE 4th line: `affiliateMinor` is the seller-funded commission pool
 * Σ(OrderItem.affiliatePoolMinor) — already subtracted from sellerNetMinor
 * by computeOrderCommissions, so credits sum to the total exactly:
 *   sellerNet + commission + affiliate === total  (Option B invariant v2).
 * Line omitted when affiliateMinor = 0 (legacy rows stay byte-compatible).
 */
export async function postOrderPaid(input: {
  orderId: string;
  orderNumber: string;
  walletId: string;
  provider: string;
  totalMinor: number;
  sellerNetMinor: number;
  commissionMinor: number;
  /** Seller-funded affiliate pool for this order (0 ⇒ no affiliate line). */
  affiliateMinor?: number;
  holdUntil: Date;
  currency?: string;
  occurredAt?: Date;
  tx?: Prisma.TransactionClient;
  /** Set false on hot paths (payment confirmation) that refresh the cache
   *  AFTER the money tx commits instead of inside it (see refreshWalletCache
   *  contention note). Default true preserves every other caller. */
  refreshCache?: boolean;
}) {
  const lines: LedgerLineInput[] = [
    { accountCode: ACCOUNTS.gateway(input.provider), direction: "debit", amountMinor: input.totalMinor, memo: `Order ${input.orderNumber}` },
    { accountCode: ACCOUNTS.sellerPayable(input.walletId), direction: "credit", amountMinor: input.sellerNetMinor, walletId: input.walletId, availableAt: input.holdUntil, memo: `Seller net for ${input.orderNumber}` },
    { accountCode: ACCOUNTS.revenueCommission(), direction: "credit", amountMinor: input.commissionMinor, walletId: input.walletId, memo: `Commission for ${input.orderNumber}` },
  ];
  if (input.affiliateMinor && input.affiliateMinor > 0) {
    lines.push({ accountCode: ACCOUNTS.affiliateLiability(), direction: "credit", amountMinor: input.affiliateMinor, memo: `Affiliate pool for ${input.orderNumber}` });
  }
  const t = await postTransaction({
    txnType: "order_paid",
    refType: "order",
    refId: input.orderId,
    description: `Order ${input.orderNumber} paid via ${input.provider}`,
    dedupKey: `order_paid:order:${input.orderId}`,
    lines,
    occurredAt: input.occurredAt,
    tx: input.tx,
  });
  if (input.refreshCache !== false) await refreshWalletCache(input.walletId, input.tx);
  return t;
}

/**
 * Setting key consulted by the webhook flow (FIN-2-b) before auto-invoking T2
 * after a successful T1. Default (absent/false) keeps T2 dormant — exactly
 * today's behavior. postOrderPaid deliberately does NOT auto-call T2: recipes
 * stay single-purpose; the CALLER decides settlement policy.
 */
export const AUTO_SETTLE_SETTING_KEY = "psp.split.auto_settle";

/** Dedup key builder for T2 so the FIN-2-b webhook wiring and this recipe can never drift. */
export function gatewaySettlementDedupKey(ref: string): string {
  return `gateway_settlement:settlement:${ref}`;
}

/**
 * T2 — gateway settlement: DR BANK_MAIN | CR GATEWAY:{p}
 *
 * INVOCATION (FIN-2-b, not wired here): the webhook flow calls this after T1
 * when Setting[AUTO_SETTLE_SETTING_KEY] is true or on an explicit
 * payment.settled PSP event. Until then this recipe has zero callers by
 * design (GATEWAY:* balances intentionally carry the unsettled PSP position).
 * Dedup: exactly ONE T2 per settlement ref via gatewaySettlementDedupKey().
 */
export async function postGatewaySettlement(input: { provider: string; amountMinor: number; ref: string; occurredAt?: Date; tx?: Prisma.TransactionClient }) {
  return postTransaction({
    txnType: "gateway_settlement",
    refType: "settlement",
    refId: input.ref,
    description: `Settlement ${input.ref} via ${input.provider}`,
    dedupKey: gatewaySettlementDedupKey(input.ref),
    lines: [
      { accountCode: ACCOUNTS.BANK_MAIN, direction: "debit", amountMinor: input.amountMinor, memo: input.ref },
      { accountCode: ACCOUNTS.gateway(input.provider), direction: "credit", amountMinor: input.amountMinor, memo: input.ref },
    ],
    occurredAt: input.occurredAt,
    tx: input.tx,
  });
}

/** T3 — payout initiated: DR SELLER:PAYABLE | CR PAYOUT_CLEARING */
export async function postPayoutInitiated(input: { walletId: string; payoutId: string; referenceNo: string; amountMinor: number; tx?: Prisma.TransactionClient; refreshCache?: boolean }) {
  const t = await postTransaction({
    txnType: "payout_initiated",
    refType: "payout",
    refId: input.payoutId,
    description: `Payout ${input.referenceNo} initiated`,
    dedupKey: `payout_initiated:payout:${input.payoutId}`,
    lines: [
      { accountCode: ACCOUNTS.sellerPayable(input.walletId), direction: "debit", amountMinor: input.amountMinor, walletId: input.walletId, memo: input.referenceNo },
      { accountCode: ACCOUNTS.payoutClearing(), direction: "credit", amountMinor: input.amountMinor, memo: input.referenceNo },
    ],
    tx: input.tx,
  });
  if (input.refreshCache !== false) await refreshWalletCache(input.walletId, input.tx);
  return t;
}

/** T4 — payout confirmed: DR PAYOUT_CLEARING | CR BANK_MAIN */
export async function postPayoutConfirmed(input: { walletId: string; payoutId: string; referenceNo: string; amountMinor: number; tx?: Prisma.TransactionClient }) {
  const t = await postTransaction({
    txnType: "payout_confirmed",
    refType: "payout",
    refId: input.payoutId,
    description: `Payout ${input.referenceNo} confirmed paid`,
    dedupKey: `payout_confirmed:payout:${input.payoutId}`,
    lines: [
      { accountCode: ACCOUNTS.payoutClearing(), direction: "debit", amountMinor: input.amountMinor, memo: input.referenceNo },
      { accountCode: ACCOUNTS.BANK_MAIN, direction: "credit", amountMinor: input.amountMinor, memo: input.referenceNo },
    ],
    tx: input.tx,
  });
  await refreshWalletCache(input.walletId, input.tx);
  return t;
}

/** T4f — payout failed: reverse T3 → DR PAYOUT_CLEARING | CR SELLER:PAYABLE */
export async function postPayoutFailed(input: { walletId: string; payoutId: string; referenceNo: string; amountMinor: number; reason: string; tx?: Prisma.TransactionClient }) {
  const t = await postTransaction({
    txnType: "payout_failed",
    refType: "payout",
    refId: input.payoutId,
    description: `Payout ${input.referenceNo} failed: ${input.reason}`,
    dedupKey: `payout_failed:payout:${input.payoutId}`,
    lines: [
      { accountCode: ACCOUNTS.payoutClearing(), direction: "debit", amountMinor: input.amountMinor, memo: input.referenceNo },
      { accountCode: ACCOUNTS.sellerPayable(input.walletId), direction: "credit", amountMinor: input.amountMinor, walletId: input.walletId, availableAt: new Date(), memo: `Reversal: ${input.reason}` },
    ],
    tx: input.tx,
  });
  await refreshWalletCache(input.walletId, input.tx);
  return t;
}

// ------------------------------------------------------- AFFILIATE PAYOUTS
// Manual controlled workflow (mirrors the seller payout recipes, but the
// liability side is PLATFORM:AFFILIATE_LIABILITY, never a seller wallet):
//   T-A3 approve  : DR AFFILIATE_LIABILITY | CR PAYOUT_CLEARING
//   T-A4 mark-paid: DR PAYOUT_CLEARING     | CR BANK_MAIN
//   T-A4f fail    : DR PAYOUT_CLEARING     | CR AFFILIATE_LIABILITY (release)
// Idempotency: exactly one posting per payout row per stage (dedupKeys).

/** T-A3 — affiliate payout approved: DR AFFILIATE_LIABILITY | CR PAYOUT_CLEARING */
export async function postAffiliatePayoutInitiated(input: { payoutId: string; affiliateId: string; amountMinor: number; tx?: Prisma.TransactionClient }) {
  return postTransaction({
    txnType: "affiliate_payout_initiated",
    refType: "affiliate_payout",
    refId: input.payoutId,
    description: `Affiliate payout ${input.payoutId} approved`,
    dedupKey: `affiliate_payout_initiated:affpayout:${input.payoutId}`,
    lines: [
      { accountCode: ACCOUNTS.affiliateLiability(), direction: "debit", amountMinor: input.amountMinor, memo: `Affiliate payout ${input.payoutId}` },
      { accountCode: ACCOUNTS.payoutClearing(), direction: "credit", amountMinor: input.amountMinor, memo: `Affiliate payout ${input.payoutId}` },
    ],
    tx: input.tx,
  });
}

/** T-A4 — affiliate payout confirmed paid: DR PAYOUT_CLEARING | CR BANK_MAIN */
export async function postAffiliatePayoutConfirmed(input: { payoutId: string; amountMinor: number; reference: string; tx?: Prisma.TransactionClient }) {
  return postTransaction({
    txnType: "affiliate_payout_confirmed",
    refType: "affiliate_payout",
    refId: input.payoutId,
    description: `Affiliate payout ${input.payoutId} paid (${input.reference})`,
    dedupKey: `affiliate_payout_confirmed:affpayout:${input.payoutId}`,
    lines: [
      { accountCode: ACCOUNTS.payoutClearing(), direction: "debit", amountMinor: input.amountMinor, memo: input.reference },
      { accountCode: ACCOUNTS.BANK_MAIN, direction: "credit", amountMinor: input.amountMinor, memo: input.reference },
    ],
    tx: input.tx,
  });
}

/** T-A4f — affiliate payout failed: reverse T-A3 → DR PAYOUT_CLEARING | CR AFFILIATE_LIABILITY */
export async function postAffiliatePayoutFailed(input: { payoutId: string; amountMinor: number; reason: string; tx?: Prisma.TransactionClient }) {
  return postTransaction({
    txnType: "affiliate_payout_failed",
    refType: "affiliate_payout",
    refId: input.payoutId,
    description: `Affiliate payout ${input.payoutId} failed: ${input.reason}`,
    dedupKey: `affiliate_payout_failed:affpayout:${input.payoutId}`,
    lines: [
      { accountCode: ACCOUNTS.payoutClearing(), direction: "debit", amountMinor: input.amountMinor, memo: `Affiliate payout ${input.payoutId}` },
      { accountCode: ACCOUNTS.affiliateLiability(), direction: "credit", amountMinor: input.amountMinor, memo: `Released: ${input.reason}` },
    ],
    tx: input.tx,
  });
}

/**
 * T5 — refund: DR SELLER:PAYABLE (seller share) + DR COMMISSION (reversal)
 * [+ DR AFFILIATE_LIABILITY (affiliate reversal)] | CR GATEWAY:{p}
 * Dedup: exactly ONE T5 per Refund ROW (`refund:refund:{refundId}`) — an order
 * may legally receive MULTIPLE partial refunds, so the key is per refund row,
 * NOT per order (a (txnType,order) key would false-dedup the 2nd partial).
 *
 * AFFILIATE: `affiliateReversalMinor` mirrors commissionReversalMinor —
 * derived proportionally from the frozen OrderItem.affiliatePoolMinor
 * snapshots, clamped to the remaining reversible pool. The seller share
 * shrinks by the same amount (the pool was carved from seller proceeds at
 * checkout, so a refund restores it symmetrically).
 */
export async function postRefund(input: {
  orderId: string;
  orderNumber: string;
  walletId: string;
  provider: string;
  amountMinor: number;
  commissionReversalMinor: number;
  /** Affiliate pool reversal for this refund (0 ⇒ no affiliate line). */
  affiliateReversalMinor?: number;
  /** C1.2 (Phase 2.2): the portion of the affiliate reversal whose liability
   *  already moved into PAYOUT_CLEARING (an APPROVED in-flight affiliate
   *  payout claimed the entries; T-A3 posted). That portion debits
   *  PAYOUT_CLEARING instead of AFFILIATE_LIABILITY so neither account goes
   *  negative and the clearing account nets to zero across T-A3 / this line /
   *  T-A4(-f) at the adjusted payout amount. Must be ≤ affiliateReversalMinor. */
  affiliateClearingMinor?: number;
  /** The Refund row driving this posting — required for its dedup key. */
  refundId: string;
  tx?: Prisma.TransactionClient;
}) {
  const affiliateReversal = Math.max(0, input.affiliateReversalMinor ?? 0);
  const affiliateClearing = Math.min(Math.max(0, input.affiliateClearingMinor ?? 0), affiliateReversal);
  const affiliateLiability = affiliateReversal - affiliateClearing;
  const sellerShare = input.amountMinor - input.commissionReversalMinor - affiliateReversal;
  const lines: LedgerLineInput[] = [
    { accountCode: ACCOUNTS.sellerPayable(input.walletId), direction: "debit", amountMinor: sellerShare, walletId: input.walletId, memo: `Refund seller share ${input.orderNumber}` },
    { accountCode: ACCOUNTS.revenueCommission(), direction: "debit", amountMinor: input.commissionReversalMinor, walletId: input.walletId, memo: `Commission reversal ${input.orderNumber}` },
  ];
  if (affiliateLiability > 0) {
    lines.push({ accountCode: ACCOUNTS.affiliateLiability(), direction: "debit", amountMinor: affiliateLiability, memo: `Affiliate reversal ${input.orderNumber}` });
  }
  if (affiliateClearing > 0) {
    // C1.2: liability for these entries was already parked in payout clearing
    // by T-A3 — reversing it out of AFFILIATE_LIABILITY would drive that
    // account negative; take it from the clearing account instead.
    lines.push({ accountCode: ACCOUNTS.payoutClearing(), direction: "debit", amountMinor: affiliateClearing, memo: `Affiliate reversal (in-flight payout) ${input.orderNumber}` });
  }
  lines.push({ accountCode: ACCOUNTS.gateway(input.provider), direction: "credit", amountMinor: input.amountMinor, memo: `Refund ${input.orderNumber}` });
  const t = await postTransaction({
    txnType: "refund",
    refType: "order",
    refId: input.orderId,
    description: `Refund for ${input.orderNumber}`,
    dedupKey: `refund:refund:${input.refundId}`,
    lines,
    tx: input.tx,
  });
  await refreshWalletCache(input.walletId, input.tx);
  return t;
}

/** T6 — admin adjustment: DR/CR SELLER:PAYABLE vs PLATFORM:REVENUE_ADJUST.
 *  Deliberately NO dedupKey: corrections are legitimately repeatable (each
 *  is a distinct business event). */
export async function postAdminAdjustment(input: {
  walletId: string;
  direction: "credit" | "debit"; // credit = add to seller balance
  amountMinor: number;
  reason: string;
  adminEmail: string;
  tx?: Prisma.TransactionClient;
}) {
  const payable = ACCOUNTS.sellerPayable(input.walletId);
  const lines: LedgerLineInput[] =
    input.direction === "credit"
      ? [
          { accountCode: ACCOUNTS.revenueAdjust(), direction: "debit", amountMinor: input.amountMinor, memo: input.reason },
          { accountCode: payable, direction: "credit", amountMinor: input.amountMinor, walletId: input.walletId, availableAt: new Date(), memo: input.reason },
        ]
      : [
          { accountCode: payable, direction: "debit", amountMinor: input.amountMinor, walletId: input.walletId, memo: input.reason },
          { accountCode: ACCOUNTS.revenueAdjust(), direction: "credit", amountMinor: input.amountMinor, memo: input.reason },
        ];
  const t = await postTransaction({
    txnType: "admin_adjustment",
    refType: "wallet",
    refId: input.walletId,
    description: `Manual adjustment by ${input.adminEmail}: ${input.reason}`,
    lines,
    tx: input.tx,
  });
  await refreshWalletCache(input.walletId, input.tx);
  return t;
}

// ------------------------------------------------------------- INVARIANTS

export type WalletCacheDrift = {
  walletId: string;
  cachedAvailable: number;
  cachedPending: number;
  truthAvailable: number;
  truthPending: number;
  /** available cache − truth, pending cache − truth (signed). */
  availableDelta: number;
  pendingDelta: number;
  /** Sum of holds whose availableAt matured after the cache's last write —
   *  the full explanation when classification is TIME_MATURITY. */
  maturedSinceLastWrite: number;
  lastCacheWriteAt: Date;
};

export type LedgerInvariantResult = {
  ok: boolean;
  /** HARD problems only: unbalanced transactions + hard cache drift. */
  problems: string[];
  /** CACHE_VALUE_DRIFT / unexplained staleness — totals differ or the
   *  staleness is NOT explained by holds maturing after the last write.
   *  Always investigated; never auto-dismissed. */
  hardDrift: WalletCacheDrift[];
  /** Benign, self-healing staleness: totals equal AND the cache equals
   *  ledger truth recomputed as-of its own last write — holds matured by
   *  clock afterwards. Money correctness is NOT affected (payout
   *  authorization recomputes truth transactionally). */
  timeMaturityStale: WalletCacheDrift[];
  txnCount: number;
  walletCount: number;
};

/**
 * Ledger invariants, classification-aware (mission: wallet-ledger drift).
 *
 * Wallet caches are event-driven derived values; hold credits mature by the
 * CLOCK (availableAt <= now) with no triggering write, so a cache frozen
 * since before a maturity is EXPECTED to disagree with truth-now while its
 * TOTAL stays correct. The invariant therefore separates:
 *   • unbalanced transactions            → hard, money correctness
 *   • totals-differ / unexplained drift  → hard (CACHE_VALUE_DRIFT)
 *   • explained time-maturity staleness  → benign, reported for visibility
 * (Health checks must distinguish these — a stale display cache is not a
 * lost-money event, and a nightly full-ledger scan on every poll is itself a
 * hazard; see /api/health for the TTL-wrapped consumption.)
 */
export async function runLedgerInvariants(): Promise<LedgerInvariantResult> {
  const problems: string[] = [];
  const txns = await db.ledgerTransaction.findMany({ include: { lines: true } });
  for (const t of txns) {
    const debit = t.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
    const credit = t.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
    if (debit !== credit) problems.push(`txn ${t.id} (${t.txnType}) unbalanced: D${debit} C${credit}`);
  }

  const wallets = await db.wallet.findMany();
  const payableCodes = wallets.map((w) => ACCOUNTS.sellerPayable(w.id));
  const lines = payableCodes.length
    ? await db.ledgerLine.findMany({
        where: { accountCode: { in: payableCodes } },
        select: { accountCode: true, direction: true, amountMinor: true, availableAt: true },
      })
    : [];
  const byWallet = new Map<string, { direction: string; amountMinor: number; availableAt: Date | null }[]>();
  for (const l of lines) {
    // accountCode embeds the walletId: SELLER:{walletId}:PAYABLE
    const wid = l.accountCode.slice("SELLER:".length, -":PAYABLE".length);
    const arr = byWallet.get(wid) ?? [];
    arr.push({ direction: l.direction, amountMinor: l.amountMinor, availableAt: l.availableAt });
    byWallet.set(wid, arr);
  }

  const hardDrift: WalletCacheDrift[] = [];
  const timeMaturityStale: WalletCacheDrift[] = [];
  const now = new Date();
  for (const w of wallets) {
    const wLines = byWallet.get(w.id) ?? [];
    let totalCredits = 0,
      maturedNow = 0,
      totalDebits = 0,
      maturedAtWrite = 0,
      maturedSinceWrite = 0;
    const writeAt = w.updatedAt;
    for (const l of wLines) {
      if (l.direction === "credit") {
        totalCredits += l.amountMinor;
        const matured = !l.availableAt || l.availableAt <= now;
        if (matured) maturedNow += l.amountMinor;
        if (!l.availableAt || l.availableAt <= writeAt) maturedAtWrite += l.amountMinor;
        else if (l.availableAt <= now) maturedSinceWrite += l.amountMinor;
      } else {
        totalDebits += l.amountMinor;
      }
    }
    // Truth as-of NOW and as-of the cache's last write. Debits apply in both
    // views (they are event-driven, not clock-driven).
    const truthNowAvail = maturedNow - totalDebits;
    const truthNowPend = totalCredits - maturedNow;
    const truthAtWriteAvail = maturedAtWrite - totalDebits;
    const truthAtWritePend = totalCredits - maturedAtWrite;

    if (truthNowAvail === w.availableMinor && truthNowPend === w.pendingMinor) continue; // MATCH

    const base: WalletCacheDrift = {
      walletId: w.id,
      cachedAvailable: w.availableMinor,
      cachedPending: w.pendingMinor,
      truthAvailable: truthNowAvail,
      truthPending: truthNowPend,
      availableDelta: w.availableMinor - truthNowAvail,
      pendingDelta: w.pendingMinor - truthNowPend,
      maturedSinceLastWrite: maturedSinceWrite,
      lastCacheWriteAt: writeAt,
    };
    const totalsEqual = w.availableMinor + w.pendingMinor === truthNowAvail + truthNowPend;
    if (totalsEqual && truthAtWriteAvail === w.availableMinor && truthAtWritePend === w.pendingMinor) {
      timeMaturityStale.push(base); // benign, clock-driven, self-heals on next event/read
    } else {
      hardDrift.push(base);
      problems.push(
        `wallet ${w.id} cache drift (${totalsEqual ? "UNEXPLAINED staleness" : "CACHE_VALUE_DRIFT — totals differ"}): available cache=${w.availableMinor} truth=${truthNowAvail}, pending cache=${w.pendingMinor} truth=${truthNowPend}`
      );
    }
  }
  return { ok: problems.length === 0, problems, hardDrift, timeMaturityStale, txnCount: txns.length, walletCount: wallets.length };
}

/** Payout statement snapshot builder (sales, commission, refunds, adjustments since last payout). */
export function buildPayoutStatement(params: {
  sellerName: string;
  periodFrom: Date;
  periodTo: Date;
  salesMinor: number;
  commissionMinor: number;
  refundsMinor: number;
  adjustmentsMinor: number;
  negativeCarryMinor: number;
  orderCount: number;
}) {
  return toJson({
    ...params,
    generatedAt: new Date().toISOString(),
    lines: [
      { label: "Sales (settled to available)", amountMinor: params.salesMinor },
      { label: "Platform commission", amountMinor: -params.commissionMinor },
      { label: "Refunds", amountMinor: -params.refundsMinor },
      { label: "Adjustments", amountMinor: params.adjustmentsMinor },
      { label: "Negative carry-forward", amountMinor: params.negativeCarryMinor },
    ],
  });
}

export function parseStatement(json: string) {
  return parseJson(json, { sellerName: "", periodFrom: "", periodTo: "", lines: [] as { label: string; amountMinor: number }[] });
}

// ------------------------------------------------------------- LEDGER-TRUTH STATEMENTS
// INTEGRITY RULE (user directive): every number printed on a payout statement
// must be DERIVED from ledger lines for the payout period — never decorated.
// The lines always reconcile to the payout amount via an explicit
// "Retained in wallet" balancing line, so Σ(lines) ≡ net payout.

export type LedgerStatement = {
  /** Parsed shape of the JSON string returned by buildLedgerStatementFromLedger
   *  (Payout.statementJson column stores the serialized form). */
  sellerName: string;
  periodFrom: string;
  periodTo: string;
  orderCount: number;
  reconciled: true;
  generatedAt: string;
  lines: { label: string; amountMinor: number }[];
};

/** Aggregate a wallet's ledger activity for [periodFrom, periodTo] and build a
 *  payout statement whose lines sum EXACTLY to `payoutAmountMinor`.
 *  Components (all from ledger truth):
 *    • sales        — payable credits from order_paid (seller net) + matching
 *                     commission-revenue credits (gross sales)
 *    • commission   — commission-revenue credits from order_paid in the period
 *    • refunds      — payable debits from refund txns + commission reversals
 *    • adjustments  — net admin_adjustment movement on the payable account
 *    • retained     — residual balancing line so Σ(lines) ≡ payout (holds, caps,
 *                     prior-balance carry)                                   */
export async function buildLedgerStatementFromLedger(params: {
  walletId: string;
  sellerName: string;
  payoutAmountMinor: number;
  orderCount: number;
  periodFrom: Date;
  periodTo: Date;
}): Promise<string> {
  const { walletId, sellerName, payoutAmountMinor, orderCount, periodFrom, periodTo } = params;
  const payable = ACCOUNTS.sellerPayable(walletId);
  const commissionAccount = ACCOUNTS.revenueCommission();

  // Wallet-scope lines in the period, joined to their txn type. Period is
  // evaluated on txn.occurredAt (business time) — rows are often backdated
  // (seed) or posted later (payout T3 lands after the statement snapshot).
  const lines = await db.ledgerLine.findMany({
    where: {
      OR: [{ accountCode: payable }, { accountCode: commissionAccount, walletId }],
      txn: { occurredAt: { gte: periodFrom, lte: periodTo } },
    },
    select: { accountCode: true, direction: true, amountMinor: true, txn: { select: { txnType: true } } },
  });

  let salesNet = 0; // payable credits from order_paid
  let commission = 0; // commission-revenue credits from order_paid
  let refundSellerShare = 0; // payable debits from refund txns
  let refundCommissionReversal = 0; // commission debits from refund txns
  let adjustments = 0; // admin_adjustment net (credits − debits on payable)

  for (const l of lines) {
    const type = l.txn.txnType;
    if (l.accountCode === payable) {
      if (l.direction === "credit") {
        if (type === "order_paid") salesNet += l.amountMinor;
        else if (type === "admin_adjustment") adjustments += l.amountMinor;
      } else {
        if (type === "refund") refundSellerShare += l.amountMinor;
        else if (type === "admin_adjustment") adjustments -= l.amountMinor;
      }
    } else if (l.accountCode === commissionAccount) {
      if (l.direction === "credit") {
        if (type === "order_paid") commission += l.amountMinor;
      } else if (type === "refund") {
        refundCommissionReversal += l.amountMinor;
      }
    }
  }

  const sales = salesNet + commission; // gross sales for the period
  const refunds = refundSellerShare + refundCommissionReversal;
  const netMovement = sales - commission - refunds + adjustments;
  // Balancing line so Σ(statement lines) ≡ net payout: when the period's net
  // movement exceeds the payout (pending holds, min-payout cap, prior carry),
  // the difference is "retained"; when a payout draws on prior balance, it's
  // a positive carry line. Either way the statement always reconciles.
  const retained = payoutAmountMinor - netMovement;

  const linesOut: { label: string; amountMinor: number }[] = [];
  if (sales !== 0) linesOut.push({ label: "Sales (settled to available)", amountMinor: sales });
  if (commission !== 0) linesOut.push({ label: "Platform commission", amountMinor: -commission });
  if (refunds !== 0) linesOut.push({ label: "Refunds", amountMinor: -refunds });
  if (adjustments !== 0) linesOut.push({ label: "Adjustments", amountMinor: adjustments });
  if (retained !== 0) linesOut.push({ label: "Retained in wallet (hold/cap — not paid out)", amountMinor: retained });

  return toJson({
    sellerName,
    periodFrom: periodFrom.toISOString(),
    periodTo: periodTo.toISOString(),
    orderCount,
    reconciled: true,
    generatedAt: new Date().toISOString(),
    lines: linesOut,
  });
}

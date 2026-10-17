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
import { db } from "./db";
import { parseJson, toJson } from "./json";

export const ACCOUNTS = {
  BANK_MAIN: "PLATFORM:BANK_MAIN",
  payoutClearing: () => "PLATFORM:PAYOUT_CLEARING",
  revenueCommission: () => "PLATFORM:REVENUE_COMMISSION",
  revenueAdjust: () => "PLATFORM:REVENUE_ADJUST",
  gateway: (provider: string) => `GATEWAY:${provider.toUpperCase()}`,
  sellerPayable: (walletId: string) => `SELLER:${walletId}:PAYABLE`,
};

export const ACCOUNT_META: Record<string, { name: string; type: "asset" | "liability" | "revenue" | "expense" }> = {
  "PLATFORM:BANK_MAIN": { name: "Platform Main Bank Account", type: "asset" },
  "PLATFORM:PAYOUT_CLEARING": { name: "Payout Clearing", type: "liability" },
  "PLATFORM:REVENUE_COMMISSION": { name: "Commission Revenue", type: "revenue" },
  "PLATFORM:REVENUE_ADJUST": { name: "Manual Adjustments Revenue", type: "revenue" },
};

export async function ensureAccount(code: string, walletId?: string | null) {
  const meta = ACCOUNT_META[code] ?? {
    name: code.startsWith("GATEWAY:") ? `Gateway ${code.slice(8)}` : code.startsWith("SELLER:") ? "Seller Payable" : code,
    type: code.startsWith("SELLER:") ? "liability" : code.startsWith("GATEWAY:") ? "asset" : "asset",
  };
  await db.ledgerAccount.upsert({
    where: { code },
    create: { code, name: meta.name, type: meta.type, walletId: walletId ?? null },
    update: {},
  });
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

/** Post a balanced double-entry transaction. Throws if unbalanced. */
export async function postTransaction(input: {
  txnType: string;
  refType?: string | null;
  refId?: string | null;
  description?: string | null;
  currency?: string;
  lines: LedgerLineInput[];
  occurredAt?: Date;
}) {
  const debit = input.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
  const credit = input.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
  if (debit !== credit || debit === 0) {
    throw new Error(`LEDGER_UNBALANCED debit=${debit} credit=${credit} txn=${input.txnType}`);
  }
  for (const l of input.lines) await ensureAccount(l.accountCode, l.walletId ?? null);
  return db.ledgerTransaction.create({
    data: {
      txnType: input.txnType,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      description: input.description ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      lines: {
        create: input.lines.map((l) => ({
          accountCode: l.accountCode,
          direction: l.direction,
          amountMinor: l.amountMinor,
          walletId: l.walletId ?? null,
          availableAt: l.availableAt ?? null,
          memo: l.memo ?? null,
        })),
      },
    },
    include: { lines: true },
  });
}

// ------------------------------------------------------------- WALLET TRUTH

export type WalletTruth = {
  pendingMinor: number;
  availableMinor: number;
  lifetimeEarnedMinor: number;
  lifetimeCommissionMinor: number;
};

/** Compute wallet balances from ledger lines (the source of truth). */
export async function walletTruth(walletId: string): Promise<WalletTruth> {
  const payable = ACCOUNTS.sellerPayable(walletId);
  const lines = await db.ledgerLine.findMany({
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
  const commissionLines = await db.ledgerLine.findMany({
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

/** Refresh cached wallet columns from ledger truth (nightly invariant in prod; on-write here). */
export async function refreshWalletCache(walletId: string) {
  const truth = await walletTruth(walletId);
  await db.wallet.update({
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

// ------------------------------------------------------------- JOURNAL RECIPES

/** T1 — order paid: DR GATEWAY:{p} total | CR SELLER:PAYABLE (available_at=paid+hold) | CR COMMISSION */
export async function postOrderPaid(input: {
  orderId: string;
  orderNumber: string;
  walletId: string;
  provider: string;
  totalMinor: number;
  sellerNetMinor: number;
  commissionMinor: number;
  holdUntil: Date;
  currency?: string;
  occurredAt?: Date;
}) {
  const t = await postTransaction({
    txnType: "order_paid",
    refType: "order",
    refId: input.orderId,
    description: `Order ${input.orderNumber} paid via ${input.provider}`,
    lines: [
      { accountCode: ACCOUNTS.gateway(input.provider), direction: "debit", amountMinor: input.totalMinor, memo: `Order ${input.orderNumber}` },
      { accountCode: ACCOUNTS.sellerPayable(input.walletId), direction: "credit", amountMinor: input.sellerNetMinor, walletId: input.walletId, availableAt: input.holdUntil, memo: `Seller net for ${input.orderNumber}` },
      { accountCode: ACCOUNTS.revenueCommission(), direction: "credit", amountMinor: input.commissionMinor, walletId: input.walletId, memo: `Commission for ${input.orderNumber}` },
    ],
    occurredAt: input.occurredAt,
  });
  await refreshWalletCache(input.walletId);
  return t;
}

/** T2 — gateway settlement: DR BANK_MAIN | CR GATEWAY:{p} */
export async function postGatewaySettlement(input: { provider: string; amountMinor: number; ref: string; occurredAt?: Date }) {
  return postTransaction({
    txnType: "gateway_settlement",
    refType: "settlement",
    refId: input.ref,
    description: `Settlement ${input.ref} via ${input.provider}`,
    lines: [
      { accountCode: ACCOUNTS.BANK_MAIN, direction: "debit", amountMinor: input.amountMinor, memo: input.ref },
      { accountCode: ACCOUNTS.gateway(input.provider), direction: "credit", amountMinor: input.amountMinor, memo: input.ref },
    ],
    occurredAt: input.occurredAt,
  });
}

/** T3 — payout initiated: DR SELLER:PAYABLE | CR PAYOUT_CLEARING */
export async function postPayoutInitiated(input: { walletId: string; payoutId: string; referenceNo: string; amountMinor: number }) {
  const t = await postTransaction({
    txnType: "payout_initiated",
    refType: "payout",
    refId: input.payoutId,
    description: `Payout ${input.referenceNo} initiated`,
    lines: [
      { accountCode: ACCOUNTS.sellerPayable(input.walletId), direction: "debit", amountMinor: input.amountMinor, walletId: input.walletId, memo: input.referenceNo },
      { accountCode: ACCOUNTS.payoutClearing(), direction: "credit", amountMinor: input.amountMinor, memo: input.referenceNo },
    ],
  });
  await refreshWalletCache(input.walletId);
  return t;
}

/** T4 — payout confirmed: DR PAYOUT_CLEARING | CR BANK_MAIN */
export async function postPayoutConfirmed(input: { walletId: string; payoutId: string; referenceNo: string; amountMinor: number }) {
  const t = await postTransaction({
    txnType: "payout_confirmed",
    refType: "payout",
    refId: input.payoutId,
    description: `Payout ${input.referenceNo} confirmed paid`,
    lines: [
      { accountCode: ACCOUNTS.payoutClearing(), direction: "debit", amountMinor: input.amountMinor, memo: input.referenceNo },
      { accountCode: ACCOUNTS.BANK_MAIN, direction: "credit", amountMinor: input.amountMinor, memo: input.referenceNo },
    ],
  });
  await refreshWalletCache(input.walletId);
  return t;
}

/** T4f — payout failed: reverse T3 → DR PAYOUT_CLEARING | CR SELLER:PAYABLE */
export async function postPayoutFailed(input: { walletId: string; payoutId: string; referenceNo: string; amountMinor: number; reason: string }) {
  const t = await postTransaction({
    txnType: "payout_failed",
    refType: "payout",
    refId: input.payoutId,
    description: `Payout ${input.referenceNo} failed: ${input.reason}`,
    lines: [
      { accountCode: ACCOUNTS.payoutClearing(), direction: "debit", amountMinor: input.amountMinor, memo: input.referenceNo },
      { accountCode: ACCOUNTS.sellerPayable(input.walletId), direction: "credit", amountMinor: input.amountMinor, walletId: input.walletId, availableAt: new Date(), memo: `Reversal: ${input.reason}` },
    ],
  });
  await refreshWalletCache(input.walletId);
  return t;
}

/** T5 — refund: DR SELLER:PAYABLE (seller share) + DR COMMISSION (reversal) | CR GATEWAY:{p} */
export async function postRefund(input: {
  orderId: string;
  orderNumber: string;
  walletId: string;
  provider: string;
  amountMinor: number;
  commissionReversalMinor: number;
}) {
  const sellerShare = input.amountMinor - input.commissionReversalMinor;
  const t = await postTransaction({
    txnType: "refund",
    refType: "order",
    refId: input.orderId,
    description: `Refund for ${input.orderNumber}`,
    lines: [
      { accountCode: ACCOUNTS.sellerPayable(input.walletId), direction: "debit", amountMinor: sellerShare, walletId: input.walletId, memo: `Refund seller share ${input.orderNumber}` },
      { accountCode: ACCOUNTS.revenueCommission(), direction: "debit", amountMinor: input.commissionReversalMinor, walletId: input.walletId, memo: `Commission reversal ${input.orderNumber}` },
      { accountCode: ACCOUNTS.gateway(input.provider), direction: "credit", amountMinor: input.amountMinor, memo: `Refund ${input.orderNumber}` },
    ],
  });
  await refreshWalletCache(input.walletId);
  return t;
}

/** T6 — admin adjustment: DR/CR SELLER:PAYABLE vs PLATFORM:REVENUE_ADJUST */
export async function postAdminAdjustment(input: {
  walletId: string;
  direction: "credit" | "debit"; // credit = add to seller balance
  amountMinor: number;
  reason: string;
  adminEmail: string;
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
  });
  await refreshWalletCache(input.walletId);
  return t;
}

// ------------------------------------------------------------- INVARIANTS

/** Nightly invariant (ICCO): every txn balanced; wallet cache == ledger truth. */
export async function runLedgerInvariants() {
  const problems: string[] = [];
  const txns = await db.ledgerTransaction.findMany({ include: { lines: true } });
  for (const t of txns) {
    const debit = t.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
    const credit = t.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
    if (debit !== credit) problems.push(`txn ${t.id} (${t.txnType}) unbalanced: D${debit} C${credit}`);
  }
  const wallets = await db.wallet.findMany();
  for (const w of wallets) {
    const truth = await walletTruth(w.id);
    if (truth.availableMinor !== w.availableMinor || truth.pendingMinor !== w.pendingMinor) {
      problems.push(`wallet ${w.id} cache drift: available cache=${w.availableMinor} truth=${truth.availableMinor}, pending cache=${w.pendingMinor} truth=${truth.pendingMinor}`);
    }
  }
  // clearing + gateway accounts must net to zero-ish (settlements outstand-ing)
  return { ok: problems.length === 0, problems, txnCount: txns.length, walletCount: wallets.length };
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

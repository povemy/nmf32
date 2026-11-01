// ============================================================================
// FEATURE FLAGS — dormant scaffolds
// ============================================================================
//
// ── NOMO FINANCE (NomoPay wallet · Nomo Coins · NomoPay Later) ─────────────
//
// DECISION (user, alongside the Option B payment pivot): the BUYER finance
// features are switched OFF for launch. The entire scaffold — Prisma model
// `ShopperWallet`, API routes `/api/me/wallet` + `/api/me/coins/claim`, the
// me-hub Wallet/Coin/NomoPay Later cards + WalletView, and the demo seed — is
// deliberately KEPT in the codebase.
//
//   • DO NOT DELETE any of it.
//   • DO NOT RECONNECT it in the UI while this flag is false.
//   • The wallet API returns a `disabled` envelope instead of touching
//     ShopperWallet; the claim endpoint rejects with FEATURE_DORMANT.
//   • Existing demo wallet rows are inert data — harmless.
//
// Flip this single flag to `true` to re-activate the whole suite AFTER:
//   1. the finance roadmap discussion (user) is concluded, and
//   2. a licensing review is done — a withdrawable wallet balance is
//      e-money territory (FSA 2013 / BNM), and pay-later is gated by the
//      Consumer Credit Act 2025 (SKP registration). Non-redeemable loyalty
//      points (coins spent only at checkout) are the safe first step.
//
// NOTE: the SELLER payout wallet + ledger (lib/ledger.ts) is NOT part of this
// flag — it is the accounting mirror of PSP settlements under Option B and
// stays active.
// ============================================================================
export const NOMO_FINANCE_ENABLED = false;
